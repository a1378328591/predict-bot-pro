import "dotenv/config";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { getJwtTokenWithSDK } from "../getJwtTokenWithSDK.js";
import { estimateTakerBuyCost } from "./predictTakerFee.js";

const API_BASE_URL = process.env.PREDICT_API_BASE_URL || "https://api.predict.fun";
const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT } = process.env;
const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "z_score_signals.jsonl");
const EXECUTIONS_FILE = resolve(DATA_DIR, "z_score_execution_log.jsonl");
const STATE_FILE = resolve(DATA_DIR, "z_score_executor_state.json");

const LIVE_TRADING = String(process.env.Z_LIVE_TRADING || "false").toLowerCase() === "true";
const FIXED_NOTIONAL_USD = positiveNumber(process.env.Z_EXECUTION_NOTIONAL_USD, 5);
const MAX_SIGNAL_AGE_MS = positiveInt(process.env.Z_EXECUTION_MAX_SIGNAL_AGE_MS, 3_000);
const MIN_REMAINING_SECONDS = positiveNumber(process.env.Z_EXECUTION_MIN_REMAINING_SECONDS, 10);
const MAX_ASK = positiveNumber(process.env.Z_EXECUTION_MAX_ASK, 0.95);
const ORDER_TIMEOUT_MS = positiveInt(process.env.Z_EXECUTION_ORDER_TIMEOUT_MS, 2_000);
const TAIL_INTERVAL_MS = positiveInt(process.env.Z_EXECUTION_TAIL_INTERVAL_MS, 500);
const HEARTBEAT_MS = positiveInt(process.env.Z_EXECUTION_HEARTBEAT_MS, 30_000);

const state = loadState();
let orderBuilder = null;
let tailOffset = 0;
let tailRemainder = "";
let signalRecordsSeen = 0;
let paperBuysSeen = 0;
let lastSignalAt = null;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { processed_signals: {} };
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { processed_signals: {} };
  } catch {
    return { processed_signals: {} };
  }
}

function saveState() {
  state.processed_signals = Object.fromEntries(Object.entries(state.processed_signals || {}).slice(-5_000));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function signalId(signal) {
  return `${signal?.features?.category_slug || ""}|${signal?.features?.observed_at_ms || signal?.observed_at || ""}`;
}

function logExecution(type, details) {
  const entry = { schema_version: 1, type, observed_at: new Date().toISOString(), ...details };
  appendFileSync(EXECUTIONS_FILE, JSON.stringify(entry) + "\n", "utf8");
  console.log(`${entry.observed_at} ${type} ${details.category_slug || ""} ${details.message || ""}`);
}

function requiredLiveConfig() {
  if (!PREDICT_API_KEY || !PRIVY_PRIVATE_KEY || !PREDICT_ACCOUNT) {
    throw new Error("Z_LIVE_TRADING=true requires PREDICT_API_KEY, PRIVY_PRIVATE_KEY, and PREDICT_ACCOUNT");
  }
}

async function getOrderBuilder() {
  if (orderBuilder) return orderBuilder;
  const signer = new Wallet(PRIVY_PRIVATE_KEY);
  orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, { predictAccount: PREDICT_ACCOUNT });
  return orderBuilder;
}

async function api(path, options = {}) {
  const response = await fetch(new URL(path, API_BASE_URL), options);
  if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  if (body?.success === false) throw new Error(`API rejected ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body?.data ?? body;
}

async function fetchCategory(slug) {
  return api(`/v1/categories/${encodeURIComponent(slug)}`, { headers: { "x-api-key": PREDICT_API_KEY } });
}

async function fetchOrderbook(marketId) {
  return api(`/v1/markets/${encodeURIComponent(marketId)}/orderbook`, { headers: { "x-api-key": PREDICT_API_KEY } });
}

function parseLevel(level) {
  const price = Number(level?.price ?? level?.pricePerShare ?? level?.[0]);
  const size = Number(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && price <= 1 && size > 0 ? { price, size } : null;
}

function normalizedOutcomeBook(rawBook, market, outcome) {
  const bids = (rawBook?.bids || []).map(parseLevel).filter(Boolean).sort((a, b) => b.price - a.price);
  const asks = (rawBook?.asks || []).map(parseLevel).filter(Boolean).sort((a, b) => a.price - b.price);
  const index = (market?.outcomes || []).findIndex(item => String(item?.onChainId) === String(outcome?.onChainId));
  if (index !== 1 || market?.outcomes?.length !== 2) return { bids, asks };
  return {
    bids: asks.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => b.price - a.price),
    asks: bids.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => a.price - b.price),
  };
}

function getQuote(book, notional) {
  let spent = 0;
  let shares = 0;
  for (const level of book.asks) {
    const cost = Math.min(notional - spent, level.price * level.size);
    if (cost <= 0) break;
    spent += cost;
    shares += cost / level.price;
  }
  if (spent < notional - 1e-9 || !(shares > 0)) return null;
  const vwap = spent / shares;
  const costs = estimateTakerBuyCost(vwap, shares, spent);
  return {
    ask: book.asks[0]?.price ?? null,
    bid: book.bids[0]?.price ?? null,
    spread: book.asks[0] && book.bids[0] ? book.asks[0].price - book.bids[0].price : null,
    vwap,
    shares,
    notional_usd: spent,
    ...costs,
  };
}

function toWei(value) {
  return BigInt(Math.round(Number(value) * 1_000_000)) * 10n ** 12n;
}

function priceWei(price, market) {
  const precision = Number.isInteger(Number(market?.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
  const scale = 10 ** precision;
  const ticks = Math.ceil(price * scale - 1e-9);
  return BigInt(ticks) * 10n ** BigInt(18 - precision);
}

async function submitLimitBuy(category, market, outcome, quote) {
  const builder = await getOrderBuilder();
  const buyPriceWei = priceWei(quote.ask, market);
  const notionalWei = toWei(FIXED_NOTIONAL_USD);
  const quantityWei = (notionalWei * 10n ** 18n) / buyPriceWei;
  const amounts = builder.getLimitOrderAmounts({ side: Side.BUY, pricePerShareWei: buyPriceWei, quantityWei });
  const expiresAt = new Date(category.endsAt);
  const order = builder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
    expiresAt,
  });
  const typedData = builder.buildTypedData(order, { isNegRisk: market.isNegRisk || false, isYieldBearing: market.isYieldBearing || false });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  const jwt = await getJwtTokenWithSDK();
  const response = await api("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ data: { order: { ...signedOrder, hash }, pricePerShare: amounts.pricePerShare, strategy: "LIMIT" } }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return { response, quote, limit_price: Number(buyPriceWei) / 1e18 };
}

async function openOrderIds() {
  const jwt = await getJwtTokenWithSDK();
  const orders = await api("/v1/orders?status=OPEN&first=200", { headers: { "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` } });
  return new Set((orders || []).map(order => String(order?.id ?? order?.orderId ?? order?.hash ?? "")).filter(Boolean));
}

async function cancelOrder(orderId) {
  const jwt = await getJwtTokenWithSDK();
  await api("/v1/orders/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ data: { ids: [String(orderId)] } }),
  });
}

async function processSignal(signal) {
  const id = signalId(signal);
  const features = signal?.features || {};
  const slug = features.category_slug;
  if (!id || !slug || state.processed_signals?.[id]) return;

  if (!LIVE_TRADING) {
    logExecution("EXECUTION_DISABLED", { signal_id: id, category_slug: slug, message: "Set Z_LIVE_TRADING=true to submit orders." });
    state.processed_signals[id] = "execution_disabled";
    saveState();
    return;
  }

  requiredLiveConfig();
  state.processed_signals[id] = "submitting";
  saveState();

  try {
    if (Date.now() - Number(features.observed_at_ms) > MAX_SIGNAL_AGE_MS) throw new Error("signal_too_old");
    if (Number(features.remaining_seconds) < MIN_REMAINING_SECONDS) throw new Error("insufficient_remaining_time");

    const category = await fetchCategory(slug);
    const market = (category.markets || []).find(item => String(item.tradingStatus).toUpperCase() === "OPEN") ?? category.markets?.[0];
    const direction = String(features.direction || "").toLowerCase();
    const outcome = market?.outcomes?.find(item => String(item?.name || "").toLowerCase() === direction);
    if (!market || !outcome) throw new Error("market_or_outcome_not_found");
    if (new Date(category.endsAt).getTime() - Date.now() < MIN_REMAINING_SECONDS * 1_000) throw new Error("market_near_settlement");

    const rawBook = await fetchOrderbook(market.id);
    const quote = getQuote(normalizedOutcomeBook(rawBook, market, outcome), FIXED_NOTIONAL_USD);
    if (!quote || quote.ask > MAX_ASK) throw new Error("quote_invalid_or_ask_too_high");
    const requiredProbability = quote.cost_per_share + Number(signal?.strategy?.edge_margin || 0);
    if (Number(signal?.probability?.lower_bound) <= requiredProbability) throw new Error("latest_quote_removes_probability_edge");

    const beforeOpen = await openOrderIds();
    const submitted = await submitLimitBuy(category, market, outcome, quote);
    const orderId = String(submitted.response?.id ?? submitted.response?.orderId ?? submitted.response?.hash ?? "");
    if (!orderId) throw new Error("order_id_missing_from_response");
    logExecution("ORDER_SUBMITTED", { signal_id: id, category_slug: slug, direction, order_id: orderId, fixed_notional_usd: FIXED_NOTIONAL_USD, quote: submitted.quote, limit_price: submitted.limit_price });

    await sleep(ORDER_TIMEOUT_MS);
    const afterOpen = await openOrderIds();
    if (afterOpen.has(orderId) && !beforeOpen.has(orderId)) {
      await cancelOrder(orderId);
      logExecution("ORDER_CANCELLED_UNFILLED", { signal_id: id, category_slug: slug, direction, order_id: orderId, message: `Not open for more than ${ORDER_TIMEOUT_MS}ms.` });
      state.processed_signals[id] = "cancelled_unfilled";
    } else {
      logExecution("ORDER_CLOSED_OR_FILLED", { signal_id: id, category_slug: slug, direction, order_id: orderId, message: "Verify final position with the Predict order/position APIs." });
      state.processed_signals[id] = "closed_or_filled";
    }
  } catch (error) {
    logExecution("ORDER_SKIPPED_OR_FAILED", { signal_id: id, category_slug: slug, message: error.message });
    state.processed_signals[id] = `failed:${error.message}`;
  }
  saveState();
}

async function readTail() {
  if (!existsSync(SIGNALS_FILE)) return;
  const size = statSync(SIGNALS_FILE).size;
  if (size < tailOffset) {
    tailOffset = 0;
    tailRemainder = "";
  }
  if (size <= tailOffset) return;
  let chunk = "";
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(SIGNALS_FILE, { start: tailOffset, end: size - 1, encoding: "utf8" });
    stream.on("data", data => { chunk += data; });
    stream.on("end", resolveRead);
    stream.on("error", rejectRead);
  });
  tailOffset = size;
  const lines = (tailRemainder + chunk).split(/\r?\n/);
  tailRemainder = lines.pop() || "";
  for (const line of lines) {
    try {
      const signal = JSON.parse(line);
      signalRecordsSeen += 1;
      lastSignalAt = signal.observed_at || null;
      if (signal?.type === "PAPER_BUY") paperBuysSeen += 1;
      if (signal?.type === "PAPER_BUY") await processSignal(signal);
    } catch (error) {
      console.error("executor signal parse error:", error.message);
    }
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  tailOffset = existsSync(SIGNALS_FILE) ? statSync(SIGNALS_FILE).size : 0;
  console.log(`Z executor started. LIVE_TRADING=${LIVE_TRADING}. Fixed notional=${FIXED_NOTIONAL_USD} USDT. Historical signals will not be replayed.`);
  let lastHeartbeatAt = 0;
  while (true) {
    await readTail();
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      console.log(`${new Date().toISOString()} EXECUTOR_HEARTBEAT live=${LIVE_TRADING} signal_records=${signalRecordsSeen} paper_buys=${paperBuysSeen} last_signal=${lastSignalAt || "none"}`);
    }
    await sleep(TAIL_INTERVAL_MS);
  }
}

main().catch(error => {
  console.error("Z executor failed to start:", error.message);
  process.exitCode = 1;
});
