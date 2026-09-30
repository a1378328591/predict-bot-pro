import "dotenv/config";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getJwtTokenWithSDK } from "../getJwtTokenWithSDK.js";
import { estimateTakerBuyCost, estimateTakerSellProceeds } from "./predictTakerFee.js";

const API_BASE_URL = process.env.PREDICT_API_BASE_URL || "https://api.predict.fun";
const PROXY_AGENT = process.env.FICLASH_PROXY_URL ? new HttpsProxyAgent(process.env.FICLASH_PROXY_URL) : undefined;
const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT } = process.env;
const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "z_score_signals.jsonl");
const EXECUTIONS_FILE = resolve(DATA_DIR, "z_score_execution_log.jsonl");
const STATE_FILE = resolve(DATA_DIR, "z_score_executor_state.json");

const LIVE_TRADING = String(process.env.Z_LIVE_TRADING || "false").toLowerCase() === "true";
const FIXED_NOTIONAL_USD = positiveNumber(process.env.Z_EXECUTION_NOTIONAL_USD, 5);
const MAX_SIGNAL_AGE_MS = positiveInt(process.env.Z_EXECUTION_MAX_SIGNAL_AGE_MS, 3_000);
const MIN_REMAINING_SECONDS = positiveNumber(process.env.Z_EXECUTION_MIN_REMAINING_SECONDS, 2);
const MAX_ASK = positiveNumber(process.env.Z_EXECUTION_MAX_ASK, 0.95);
const ORDER_TIMEOUT_MS = positiveInt(process.env.Z_EXECUTION_ORDER_TIMEOUT_MS, 2_000);
const TAIL_INTERVAL_MS = positiveInt(process.env.Z_EXECUTION_TAIL_INTERVAL_MS, 500);
const HEARTBEAT_MS = positiveInt(process.env.Z_EXECUTION_HEARTBEAT_MS, 30_000);
const EXIT_EDGE_MARGIN = nonnegativeNumber(process.env.Z_EXIT_EDGE_MARGIN, 0.20);
const POSITION_REFRESH_MS = positiveInt(process.env.Z_POSITION_REFRESH_MS, 1_000);
const MIN_ORDER_EXPIRY_MS = positiveInt(process.env.Z_MIN_ORDER_EXPIRY_MS, 125_000);
const MIN_ENTRY_PROBABILITY = nonnegativeNumber(process.env.Z_MIN_ENTRY_PROBABILITY, 0.70);

const state = loadState();
state.pending_orders ??= {};
state.traded_markets ??= {};
let orderBuilder = null;
let tailOffset = 0;
let tailRemainder = "";
let stopping = false;
let signalRecordsSeen = 0;
let paperBuysSeen = 0;
let lastSignalAt = null;
let positionCache = { fetchedAt: 0, positions: [] };

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
    if (LIVE_TRADING) throw new Error(`Cannot read executor risk state: ${STATE_FILE}`);
    return { processed_signals: {} };
  }
}

function saveState() {
  state.processed_signals = Object.fromEntries(Object.entries(state.processed_signals || {}).slice(-5_000));
  state.pending_orders = Object.fromEntries(Object.entries(state.pending_orders || {}).slice(-5_000));
  state.traded_markets = Object.fromEntries(Object.entries(state.traded_markets || {}).slice(-5_000));
  const temporaryFile = `${STATE_FILE}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporaryFile, STATE_FILE);
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
  const response = await fetch(new URL(path, API_BASE_URL), { ...options, agent: PROXY_AGENT });
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

function quantityWei(value) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    const text = String(value);
    if (/^\d+$/.test(text)) return BigInt(text);
    return BigInt(Math.floor(Number(text) * 1e18));
  } catch {
    return 0n;
  }
}

function positionMarketId(position) {
  return position?.market?.id ?? position?.marketId;
}

function positionTokenId(position) {
  return position?.outcome?.onChainId ?? position?.tokenId ?? position?.outcomeId;
}

function positionQuantity(position) {
  return quantityWei(position?.balance ?? position?.amount ?? position?.quantity);
}

function strategyOwnedQuantity(position, tracked) {
  if (tracked?.baseline_quantity_wei === undefined) return 0n;
  const current = positionQuantity(position);
  const baseline = quantityWei(tracked?.baseline_quantity_wei);
  return current > baseline ? current - baseline : 0n;
}

async function fetchPositions() {
  if (Date.now() - positionCache.fetchedAt < POSITION_REFRESH_MS) return positionCache.positions;
  const jwt = await getJwtTokenWithSDK();
  const positions = [];
  const seenCursors = new Set();
  let after = null;
  while (true) {
    const query = new URLSearchParams({ first: "100" });
    if (after) query.set("after", after);
    const response = await fetch(new URL(`/v1/positions?${query}`, API_BASE_URL), {
      headers: { "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
      agent: PROXY_AGENT,
    });
    if (!response.ok) throw new Error(`${response.status} positions: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    if (body?.success === false || !Array.isArray(body?.data)) throw new Error("invalid_positions_response");
    positions.push(...body.data);
    if (!body.cursor || body.data.length === 0 || seenCursors.has(body.cursor)) break;
    seenCursors.add(body.cursor);
    after = body.cursor;
  }
  positionCache = { fetchedAt: Date.now(), positions };
  return positions;
}

function getSellQuote(book, targetShares) {
  let remaining = Number(targetShares);
  let proceeds = 0;
  let shares = 0;
  let limitPrice = null;
  for (const level of book.bids) {
    const filled = Math.min(remaining, level.size);
    if (!(filled > 0)) break;
    proceeds += filled * level.price;
    shares += filled;
    remaining -= filled;
    limitPrice = level.price;
  }
  if (remaining > 1e-9 || !(shares > 0)) return null;
  const vwap = proceeds / shares;
  const costs = estimateTakerSellProceeds(vwap, shares, proceeds);
  return { bid: book.bids[0]?.price ?? null, limitPrice, vwap, shares, ...costs, net_per_share: costs.net_proceeds_usd / shares };
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

function orderExpiresAt(category) {
  const marketEnd = new Date(category?.endsAt || 0).getTime();
  return new Date(Math.max(Number.isFinite(marketEnd) ? marketEnd : 0, Date.now() + MIN_ORDER_EXPIRY_MS));
}

async function submitLimitBuy(category, market, outcome, quote, onPrepared) {
  const builder = await getOrderBuilder();
  const buyPriceWei = priceWei(quote.ask, market);
  const notionalWei = toWei(FIXED_NOTIONAL_USD);
  const quantityWei = (notionalWei * 10n ** 18n) / buyPriceWei;
  const amounts = builder.getLimitOrderAmounts({ side: Side.BUY, pricePerShareWei: buyPriceWei, quantityWei });
  const expiresAt = orderExpiresAt(category);
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
  await onPrepared(hash);
  const jwt = await getJwtTokenWithSDK();
  const response = await api("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ data: { order: { ...signedOrder, hash }, pricePerShare: amounts.pricePerShare, strategy: "LIMIT" } }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return { response, quote, limit_price: Number(buyPriceWei) / 1e18, hash };
}

async function submitLimitSell(category, market, outcome, bid, quantity, onPrepared) {
  const builder = await getOrderBuilder();
  const precision = Number.isInteger(Number(market?.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
  const scale = 10 ** precision;
  const sellPriceWei = BigInt(Math.floor(Number(bid) * scale + 1e-9)) * 10n ** BigInt(18 - precision);
  const amounts = builder.getLimitOrderAmounts({ side: Side.SELL, pricePerShareWei: sellPriceWei, quantityWei: quantity });
  const order = builder.buildOrder("LIMIT", {
    side: Side.SELL,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
    expiresAt: orderExpiresAt(category),
  });
  const typedData = builder.buildTypedData(order, { isNegRisk: market.isNegRisk || false, isYieldBearing: market.isYieldBearing || false });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  await onPrepared(hash);
  const jwt = await getJwtTokenWithSDK();
  const response = await api("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ data: { order: { ...signedOrder, hash }, pricePerShare: amounts.pricePerShare, strategy: "LIMIT" } }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return { response, hash, limit_price: Number(sellPriceWei) / 1e18 };
}

async function openOrderIds() {
  const jwt = await getJwtTokenWithSDK();
  const orders = [];
  const seenCursors = new Set();
  let after = null;
  while (true) {
    const query = new URLSearchParams({ status: "OPEN", first: "200" });
    if (after) query.set("after", after);
    const response = await fetch(new URL(`/v1/orders?${query}`, API_BASE_URL), {
      headers: { "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
      agent: PROXY_AGENT,
    });
    if (!response.ok) throw new Error(`${response.status} open orders: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    if (body?.success === false || !Array.isArray(body?.data)) throw new Error("invalid_open_orders_response");
    orders.push(...body.data);
    if (!body.cursor || body.data.length === 0 || seenCursors.has(body.cursor)) break;
    seenCursors.add(body.cursor);
    after = body.cursor;
  }
  return new Set(orders.flatMap(order => [order?.id, order?.orderId, order?.hash, order?.order?.hash]).filter(Boolean).map(String));
}

async function cancelOrder(orderId) {
  const jwt = await getJwtTokenWithSDK();
  await api("/v1/orders/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ data: { ids: [String(orderId)] } }),
  });
}

async function recoverPendingOrders() {
  const pending = Object.entries(state.pending_orders || {}).filter(([, order]) => ["prepared", "submitted", "uncertain"].includes(order?.status));
  if (!pending.length) return;
  const openIds = await openOrderIds();
  for (const [hash, order] of pending) {
    const openIdentifier = [order.order_id, hash].filter(Boolean).map(String).find(identifier => openIds.has(identifier));
    if (openIdentifier) {
      await cancelOrder(order.order_id || hash);
      order.status = "cancel_requested_fill_unknown";
      order.recovered_at = new Date().toISOString();
      logExecution("RECOVERED_ORDER_CANCEL_REQUESTED", { category_slug: order.category_slug, order_id: order.order_id || hash, message: "Order may have partial fills; verify positions." });
    } else {
      order.status = "not_open_fill_unknown";
      order.recovered_at = new Date().toISOString();
      logExecution("RECOVERED_ORDER_NOT_OPEN", { category_slug: order.category_slug, order_id: order.order_id || hash, message: "Order is no longer open; verify final fills or positions." });
    }
  }
  saveState();
}

async function processModelUpdate(signal) {
  if (!LIVE_TRADING) return;
  const features = signal?.features || {};
  const slug = String(features.category_slug || "");
  const tracked = state.traded_markets?.[slug];
  if (!tracked || tracked.exit_complete || Date.now() - Number(features.observed_at_ms) > MAX_SIGNAL_AGE_MS) return;

  const activeSellOrders = Object.entries(state.pending_orders || {}).filter(([, order]) => order?.side === "SELL"
    && order?.category_slug === slug
    && ["prepared", "submitted", "uncertain", "cancel_requested_fill_unknown"].includes(order?.status));
  if (activeSellOrders.length) {
    const openIds = await openOrderIds();
    let stillOpen = false;
    for (const [hash, order] of activeSellOrders) {
      if ([order.order_id, hash].filter(Boolean).some(identifier => openIds.has(String(identifier)))) {
        stillOpen = true;
      } else if (Date.now() - new Date(order.prepared_at || 0).getTime() >= ORDER_TIMEOUT_MS * 2) {
        order.status = "not_open_fill_unknown";
      } else {
        stillOpen = true;
      }
    }
    saveState();
    if (stillOpen) return;
  }

  const category = await fetchCategory(slug);
  const market = (category.markets || []).find(item => String(item.id) === String(tracked.market_id));
  if (!market || String(market.tradingStatus).toUpperCase() !== "OPEN") return;
  const outcome = market.outcomes?.find(item => String(item.onChainId) === String(tracked.token_id));
  if (!outcome) return;

  const positions = await fetchPositions();
  const position = positions.find(item => String(positionMarketId(item)) === String(market.id)
    && String(positionTokenId(item)) === String(outcome.onChainId));
  const quantity = strategyOwnedQuantity(position, tracked);
  if (quantity <= 0n) {
    if (tracked.buy_confirmed) {
      tracked.exit_complete = true;
      tracked.exit_reason = "no_remaining_position";
      saveState();
    }
    return;
  }
  tracked.buy_confirmed = true;

  const rawBook = await fetchOrderbook(market.id);
  const book = normalizedOutcomeBook(rawBook, market, outcome);
  const shares = Number(quantity) / 1e18;
  const sellQuote = getSellQuote(book, shares);
  if (!sellQuote || !(sellQuote.bid > 0 && sellQuote.bid < 1)) return;
  const bid = sellQuote.bid;
  const netSellPerShare = sellQuote.net_per_share;
  const holdingDirection = String(tracked.direction).toLowerCase();
  const holdingProbability = holdingDirection === "up"
    ? Number(features.conservative_up_probability)
    : Number(features.conservative_down_probability);
  const oppositeHasEntryEdge = String(features.direction).toLowerCase() !== holdingDirection
    && Number.isFinite(Number(features.cost_per_share))
    && Number(features.conservative_probability) >= MIN_ENTRY_PROBABILITY
    && Number(features.conservative_probability) > Number(features.cost_per_share) + 0.01;
  const holdValueBelowExit = holdingProbability + EXIT_EDGE_MARGIN < netSellPerShare;
  if (!oppositeHasEntryEdge && !holdValueBelowExit) return;

  const exitReason = oppositeHasEntryEdge ? "opposite_model_edge" : "hold_value_below_exit_value";
  const submitted = await submitLimitSell(category, market, outcome, sellQuote.limitPrice, quantity, async hash => {
    state.pending_orders[hash] = {
      status: "prepared",
      side: "SELL",
      category_slug: slug,
      market_id: market.id,
      direction: holdingDirection,
      prepared_at: new Date().toISOString(),
    };
    tracked.last_exit_attempt_at = new Date().toISOString();
    tracked.last_exit_reason = exitReason;
    saveState();
  });
  const orderId = String(submitted.response?.id ?? submitted.response?.orderId ?? submitted.response?.hash ?? "");
  if (!orderId) throw new Error("sell_order_id_missing_from_response");
  state.pending_orders[submitted.hash].status = "submitted";
  state.pending_orders[submitted.hash].order_id = orderId;
  logExecution("MODEL_EXIT_SUBMITTED", {
    category_slug: slug,
    direction: holdingDirection,
    order_id: orderId,
    shares,
    bid,
    limit_price: sellQuote.limitPrice,
    holding_probability: holdingProbability,
    net_sell_per_share: netSellPerShare,
    sell_vwap: sellQuote.vwap,
    message: exitReason,
  });
  saveState();

  await sleep(ORDER_TIMEOUT_MS);
  const afterOpen = await openOrderIds();
  if (afterOpen.has(orderId)) {
    await cancelOrder(orderId);
    state.pending_orders[submitted.hash].status = "cancel_requested_fill_unknown";
    logExecution("MODEL_EXIT_CANCEL_REQUESTED", { category_slug: slug, order_id: orderId, message: "Exit order remained open; next model update will retry remaining position." });
  } else {
    state.pending_orders[submitted.hash].status = "not_open_fill_unknown";
    logExecution("MODEL_EXIT_CLOSED_OR_FILLED", { category_slug: slug, order_id: orderId, message: "Position endpoint will confirm any remaining quantity." });
  }
  positionCache.fetchedAt = 0;
  saveState();
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
    const provider = String(category?.variantData?.priceFeedProvider || "").toLowerCase();
    const resolutionProvider = String(category?.resolutionProvider || "").toLowerCase();
    const symbol = String(category?.variantData?.priceFeedSymbol || "").toLowerCase().replace(/[^a-z]/g, "");
    if (provider !== "chainlink" || resolutionProvider !== "chainlink" || symbol !== "btcusdt") throw new Error("unexpected_resolution_feed");
    const latestStartPrice = Number(category?.variantData?.startPrice);
    if (!(latestStartPrice > 0) || Math.abs(latestStartPrice - Number(features.start_price)) > 1e-8) throw new Error("chainlink_start_price_changed");
    const market = (category.markets || []).find(item => String(item.tradingStatus).toUpperCase() === "OPEN");
    const direction = String(features.direction || "").toLowerCase();
    const outcome = market?.outcomes?.find(item => String(item?.name || "").toLowerCase() === direction);
    if (!market || !outcome) throw new Error("market_or_outcome_not_found");
    if (new Date(category.endsAt).getTime() - Date.now() < MIN_REMAINING_SECONDS * 1_000) throw new Error("market_near_settlement");

    const rawBook = await fetchOrderbook(market.id);
    const quote = getQuote(normalizedOutcomeBook(rawBook, market, outcome), FIXED_NOTIONAL_USD);
    if (!quote || quote.ask > MAX_ASK) throw new Error("quote_invalid_or_ask_too_high");
    const requiredProbability = quote.cost_per_share + Number(signal?.strategy?.edge_margin || 0);
    if (Number(signal?.probability?.lower_bound) <= requiredProbability) throw new Error("latest_quote_removes_probability_edge");

    positionCache.fetchedAt = 0;
    const positionsBeforeBuy = await fetchPositions();
    const positionBeforeBuy = positionsBeforeBuy.find(item => String(positionMarketId(item)) === String(market.id)
      && String(positionTokenId(item)) === String(outcome.onChainId));
    const baselineQuantity = positionQuantity(positionBeforeBuy);

    const submitted = await submitLimitBuy(category, market, outcome, quote, async hash => {
      state.processed_signals[id] = "submission_reserved";
      state.traded_markets[slug] = {
        market_id: market.id,
        token_id: String(outcome.onChainId),
        direction,
        baseline_quantity_wei: baselineQuantity.toString(),
        entered_at: new Date().toISOString(),
        exit_complete: false,
      };
      state.pending_orders[hash] = {
        status: "prepared",
        signal_id: id,
        category_slug: slug,
        market_id: market.id,
        direction,
        fixed_notional_usd: FIXED_NOTIONAL_USD,
        prepared_at: new Date().toISOString(),
      };
      saveState();
    });
    const orderId = String(submitted.response?.id ?? submitted.response?.orderId ?? submitted.response?.hash ?? "");
    if (!orderId) throw new Error("order_id_missing_from_response");
    state.pending_orders[submitted.hash].status = "submitted";
    state.pending_orders[submitted.hash].order_id = orderId;
    saveState();
    logExecution("ORDER_SUBMITTED", { signal_id: id, category_slug: slug, direction, order_id: orderId, fixed_notional_usd: FIXED_NOTIONAL_USD, quote: submitted.quote, limit_price: submitted.limit_price });

    await sleep(ORDER_TIMEOUT_MS);
    const afterOpen = await openOrderIds();
    if (afterOpen.has(orderId)) {
      await cancelOrder(orderId);
      state.pending_orders[submitted.hash].status = "cancel_requested_fill_unknown";
      logExecution("ORDER_CANCEL_REQUESTED", { signal_id: id, category_slug: slug, direction, order_id: orderId, message: `Open after ${ORDER_TIMEOUT_MS}ms; partial fills are possible and must be verified.` });
      state.processed_signals[id] = "cancel_requested_fill_unknown";
    } else {
      state.pending_orders[submitted.hash].status = "not_open_fill_unknown";
      logExecution("ORDER_CLOSED_OR_FILLED", { signal_id: id, category_slug: slug, direction, order_id: orderId, message: "Verify final position with the Predict order/position APIs." });
      state.processed_signals[id] = "closed_or_filled";
    }
  } catch (error) {
    logExecution("ORDER_SKIPPED_OR_FAILED", { signal_id: id, category_slug: slug, message: error.message });
    state.processed_signals[id] = state.processed_signals[id] === "submission_reserved"
      ? `submission_uncertain:${error.message}`
      : `failed:${error.message}`;
    const pending = Object.values(state.pending_orders).find(order => order.signal_id === id && ["prepared", "submitted"].includes(order.status));
    if (pending) pending.status = "uncertain";
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
      if (signal?.type === "MODEL_UPDATE") await processModelUpdate(signal);
    } catch (error) {
      console.error("executor signal parse error:", error.message);
    }
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  tailOffset = existsSync(SIGNALS_FILE) ? statSync(SIGNALS_FILE).size : 0;
  if (LIVE_TRADING) await recoverPendingOrders();
  console.log(`Z executor started. LIVE_TRADING=${LIVE_TRADING}. Fixed notional=${FIXED_NOTIONAL_USD} USDT. Historical signals will not be replayed.`);
  let lastHeartbeatAt = 0;
  while (!stopping) {
    await readTail();
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = Date.now();
      console.log(`${new Date().toISOString()} EXECUTOR_HEARTBEAT live=${LIVE_TRADING} signal_records=${signalRecordsSeen} paper_buys=${paperBuysSeen} last_signal=${lastSignalAt || "none"}`);
    }
    await sleep(TAIL_INTERVAL_MS);
  }
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

main().catch(error => {
  console.error("Z executor failed to start:", error.message);
  process.exitCode = 1;
});
