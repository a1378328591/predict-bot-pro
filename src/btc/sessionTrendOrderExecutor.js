import "dotenv/config";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getJwtTokenWithSDK } from "../getJwtTokenWithSDK.js";
import { liveQuoteRejectionReason, normalizedOutcomeBook, quoteForShares, sdkOrderbook } from "./sessionLiveOrderRules.js";
import { SESSION_TREND_FIXED_SHARES as FIXED_SHARES } from "./sessionTrendConfig.js";

const API_BASE_URL = "https://api.predict.fun";
const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT, FICLASH_PROXY_URL } = process.env;
const PROXY_AGENT = FICLASH_PROXY_URL ? new HttpsProxyAgent(FICLASH_PROXY_URL) : undefined;
const DATA_DIR = resolve("data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "session_trend_live_signals.jsonl");
const EXECUTIONS_FILE = resolve(DATA_DIR, "session_trend_execution_log.jsonl");
const STATE_FILE = resolve(DATA_DIR, "session_trend_executor_state.json");

// Live risk parameters stay in code. Only existing credentials are read from the environment.
const MIN_PRICE = 0.35;
const MAX_PRICE = 0.70;
const MAX_SPREAD = 0.02;
const MAX_SIGNAL_AGE_MS = 3_000;
const MIN_REMAINING_SECONDS = 20;
const TAIL_INTERVAL_MS = 250;
const HEARTBEAT_MS = 30_000;
const LIVE_EXECUTION_ENABLED = false;

const state = loadState();
state.processed_signals ??= {};
state.pending_orders ??= {};
state.traded_markets ??= {};
let orderBuilder = null;
let tailOffset = Number.isInteger(Number(state.tail_offset)) ? Number(state.tail_offset) : 0;
let tailRemainder = "";
let stopping = false;

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error(`Cannot read live executor state: ${STATE_FILE}`);
  }
}

function saveState() {
  state.processed_signals = Object.fromEntries(Object.entries(state.processed_signals).slice(-10_000));
  state.pending_orders = Object.fromEntries(Object.entries(state.pending_orders).slice(-10_000));
  state.traded_markets = Object.fromEntries(Object.entries(state.traded_markets).slice(-10_000));
  const temporaryFile = `${STATE_FILE}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporaryFile, STATE_FILE);
}

function requiredCredentials() {
  if (!PREDICT_API_KEY || !PRIVY_PRIVATE_KEY || !PREDICT_ACCOUNT) {
    throw new Error("Live trading requires PREDICT_API_KEY, PRIVY_PRIVATE_KEY, and PREDICT_ACCOUNT");
  }
}

function logExecution(type, details = {}) {
  const record = { schema_version: 1, type, observed_at: new Date().toISOString(), ...details };
  appendFileSync(EXECUTIONS_FILE, JSON.stringify(record) + "\n", "utf8");
  console.log(`${record.observed_at} ${type} ${details.category_slug || ""} ${details.message || ""}`);
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, API_BASE_URL), { ...options, agent: PROXY_AGENT });
  if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  if (body?.success === false) throw new Error(`API rejected ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body?.data ?? body;
}

async function authHeaders() {
  return { "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${await getJwtTokenWithSDK()}` };
}

const fetchCategory = slug => api(`/v1/categories/${encodeURIComponent(slug)}`, { headers: { "x-api-key": PREDICT_API_KEY } });
const fetchOrderbook = marketId => api(`/v1/markets/${encodeURIComponent(marketId)}/orderbook`, { headers: { "x-api-key": PREDICT_API_KEY } });

async function fetchCollection(path, label) {
  const response = await fetch(new URL(path, API_BASE_URL), { headers: await authHeaders(), agent: PROXY_AGENT });
  if (!response.ok) throw new Error(`${response.status} ${label}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  if (body?.success === false || !Array.isArray(body?.data)) throw new Error(`invalid_${label}_response`);
  return body.data;
}

const fetchOpenOrders = () => fetchCollection("/v1/orders?status=OPEN&first=200", "open_orders");
const fetchPositions = () => fetchCollection("/v1/positions?first=200", "positions");
const orderId = order => order?.id ?? order?.orderId ?? order?.hash ?? order?.order?.hash;
const orderMarketId = order => order?.market?.id ?? order?.marketId ?? order?.order?.marketId;
const positionMarketId = position => position?.market?.id ?? position?.marketId;

function quantityWei(value) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    const text = String(value);
    return /^\d+$/.test(text) ? BigInt(text) : BigInt(Math.floor(Number(text) * 1e18));
  } catch {
    return 0n;
  }
}

async function cancelOrder(id) {
  await api("/v1/orders/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ data: { ids: [String(id)] } }),
  });
}

async function getOrderBuilder() {
  if (!orderBuilder) orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, new Wallet(PRIVY_PRIVATE_KEY), { predictAccount: PREDICT_ACCOUNT });
  return orderBuilder;
}

const toWei = value => BigInt(Math.round(Number(value) * 1_000_000)) * 10n ** 12n;

async function submitMarketBuy(market, outcome, book, onPrepared) {
  const builder = await getOrderBuilder();
  const amounts = builder.getMarketOrderAmounts({
    side: Side.BUY,
    quantityWei: toWei(FIXED_SHARES),
  }, sdkOrderbook(book));
  const order = builder.buildOrder("MARKET", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
  });
  const typedData = builder.buildTypedData(order, { isNegRisk: market.isNegRisk || false, isYieldBearing: market.isYieldBearing || false });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  await onPrepared(hash);
  const response = await api("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({
      data: {
        order: { ...signedOrder, hash },
        pricePerShare: amounts.pricePerShare,
        strategy: "MARKET",
        slippageBps: amounts.slippageBps,
      },
    }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return {
    response,
    hash,
    vwap: Number(amounts.pricePerShare) / 1e18,
    lastPrice: Number(amounts.lastPrice) / 1e18,
    maxNotionalUsd: Number(amounts.makerAmount) / 1e18,
  };
}

async function recoverPendingOrders() {
  const pending = Object.entries(state.pending_orders).filter(([, order]) => ["prepared", "submitted", "uncertain"].includes(order?.status));
  if (!pending.length) return;
  const openOrders = await fetchOpenOrders();
  const openIds = new Set(openOrders.flatMap(order => [orderId(order), order?.hash, order?.order?.hash]).filter(Boolean).map(String));
  for (const [hash, order] of pending) {
    const open = [order.order_id, hash].filter(Boolean).map(String).find(value => openIds.has(value));
    if (open) {
      await cancelOrder(order.order_id || hash);
      order.status = "cancel_requested_fill_unknown";
      logExecution("RECOVERED_ORDER_CANCEL_REQUESTED", { category_slug: order.category_slug, order_id: order.order_id || hash });
    } else {
      order.status = "not_open_fill_unknown";
      logExecution("RECOVERED_ORDER_NOT_OPEN", { category_slug: order.category_slug, order_id: order.order_id || hash });
    }
  }
  saveState();
}

async function processSignal(signal) {
  const slug = String(signal?.category_slug || "");
  const id = `${slug}|${signal?.observed_at_ms || signal?.observed_at || ""}`;
  if (!slug || state.processed_signals[id] || state.traded_markets[slug]) return;
  state.processed_signals[id] = "validating";
  saveState();
  try {
    if (signal?.type !== "LIVE_BUY_SIGNAL" || signal?.execution_eligible !== true) throw new Error("not_live_execution_signal");
    if (Date.now() - Number(signal.observed_at_ms) > MAX_SIGNAL_AGE_MS) throw new Error("signal_too_old");
    if (Number(signal.remaining_seconds) < MIN_REMAINING_SECONDS) throw new Error("insufficient_remaining_time");
    const category = await fetchCategory(slug);
    const provider = String(category?.variantData?.priceFeedProvider || "").toLowerCase();
    const resolutionProvider = String(category?.resolutionProvider || "").toLowerCase();
    const symbol = String(category?.variantData?.priceFeedSymbol || "").toLowerCase().replace(/[^a-z]/g, "");
    if (provider !== "chainlink" || resolutionProvider !== "chainlink" || symbol !== "btcusdt") throw new Error("unexpected_resolution_feed");
    if (Math.abs(Number(category?.variantData?.startPrice) - Number(signal.start_price)) > 1e-8) throw new Error("chainlink_start_price_changed");
    const market = (category.markets || []).find(item => String(item.id) === String(signal.market_id));
    if (!market || String(market.tradingStatus).toUpperCase() !== "OPEN") throw new Error("market_not_open");
    if (new Date(category.endsAt).getTime() - Date.now() < MIN_REMAINING_SECONDS * 1_000) throw new Error("market_near_settlement");
    const direction = String(signal.direction || "").toLowerCase();
    const outcome = market.outcomes?.find(item => String(item.onChainId) === String(signal.quote?.outcome_on_chain_id) && String(item.name || "").toLowerCase() === direction);
    if (!outcome) throw new Error("outcome_identity_mismatch");
    const book = normalizedOutcomeBook(await fetchOrderbook(market.id), market, outcome);
    const quote = quoteForShares(book, FIXED_SHARES);
    const rejection = liveQuoteRejectionReason(quote, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE, maxSpread: MAX_SPREAD });
    if (rejection) throw new Error(rejection);
    const [positions, openOrders] = await Promise.all([fetchPositions(), fetchOpenOrders()]);
    if (positions.some(position => String(positionMarketId(position)) === String(market.id) && quantityWei(position?.balance ?? position?.amount ?? position?.quantity) > 0n)) throw new Error("existing_market_position");
    if (openOrders.some(order => String(orderMarketId(order)) === String(market.id))) throw new Error("existing_market_order");

    const submitted = await submitMarketBuy(market, outcome, book, async hash => {
      state.processed_signals[id] = "submission_reserved";
      state.traded_markets[slug] = { signal_id: id, market_id: market.id, direction, reserved_at: new Date().toISOString() };
      state.pending_orders[hash] = { status: "prepared", strategy: "MARKET", signal_id: id, category_slug: slug, market_id: market.id, direction, prepared_at: new Date().toISOString() };
      saveState();
    });
    const submittedOrderId = String(submitted.response?.id ?? submitted.response?.orderId ?? submitted.response?.hash ?? "");
    if (!submittedOrderId) throw new Error("order_id_missing_from_response");
    state.pending_orders[submitted.hash].status = "market_submitted";
    state.pending_orders[submitted.hash].order_id = submittedOrderId;
    state.processed_signals[id] = "market_submitted";
    logExecution("LIVE_ORDER_SUBMITTED", {
      signal_id: id,
      category_slug: slug,
      market_id: market.id,
      direction,
      order_id: submittedOrderId,
      strategy: "MARKET",
      shares: FIXED_SHARES,
      vwap: submitted.vwap,
      last_price: submitted.lastPrice,
      estimated_notional_usd: quote.notionalUsd,
      max_notional_usd: submitted.maxNotionalUsd,
    });
    saveState();
  } catch (error) {
    logExecution("LIVE_ORDER_SKIPPED_OR_FAILED", { signal_id: id, category_slug: slug, message: error.message });
    if (state.processed_signals[id] !== "submission_reserved") state.processed_signals[id] = `failed:${error.message}`;
    const pending = Object.values(state.pending_orders).find(order => order.signal_id === id && ["prepared", "submitted"].includes(order.status));
    if (pending) pending.status = "uncertain";
  }
  saveState();
}

async function readTail() {
  if (!existsSync(SIGNALS_FILE)) return;
  const size = statSync(SIGNALS_FILE).size;
  if (size < tailOffset) { tailOffset = 0; tailRemainder = ""; }
  if (size <= tailOffset) return;
  let chunk = "";
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(SIGNALS_FILE, { start: tailOffset, end: size - 1, encoding: "utf8" });
    stream.on("data", data => { chunk += data; });
    stream.on("end", resolveRead);
    stream.on("error", rejectRead);
  });
  tailOffset = size;
  state.tail_offset = tailOffset;
  const lines = (tailRemainder + chunk).split(/\r?\n/);
  tailRemainder = lines.pop() || "";
  for (const line of lines) {
    try {
      if (!line) continue;
      const signal = JSON.parse(line);
      if (signal?.type === "LIVE_BUY_SIGNAL") await processSignal(signal);
    } catch (error) {
      console.error("Live executor signal error:", error.message);
    }
  }
  saveState();
}

async function main() {
  if (!LIVE_EXECUTION_ENABLED) {
    console.log("BTC reversal live executor is disabled; no orders will be submitted.");
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  requiredCredentials();
  await recoverPendingOrders();
  console.log("SESSION TREND LIVE EXECUTOR STARTED. REAL ORDERS ARE ENABLED.");
  console.log(`MARKET buys; fixed shares=${FIXED_SHARES}; price=${MIN_PRICE}-${MAX_PRICE}; spread<=${MAX_SPREAD}; historical signals are rejected by age.`);
  let lastHeartbeatAt = 0;
  while (!stopping) {
    await readTail();
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      console.log(`${new Date().toISOString()} LIVE_EXECUTOR_HEARTBEAT processed=${Object.keys(state.processed_signals).length} traded_markets=${Object.keys(state.traded_markets).length}`);
    }
    await sleep(TAIL_INTERVAL_MS);
  }
  saveState();
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
main().catch(error => { console.error("Session trend live executor failed:", error.message); process.exitCode = 1; });
