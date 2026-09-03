import "dotenv/config";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// This process is deliberately self-contained. It only reuses the JWT helper;
// the global fetch wrapper keeps that helper behind the same local proxy.
const proxyUrl = process.env.FICLASH_PROXY_URL || "http://127.0.0.1:7890";
const proxyAgent = new HttpsProxyAgent(proxyUrl);

async function fetchViaProxy(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  const attempts = retryable ? 6 : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, agent: proxyAgent });
      if (response.ok || !retryable || ![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) return response;
      await sleep(Math.min(5_000, 500 * attempt));
    } catch (error) {
      lastError = error;
      if (!retryable || attempt === attempts) throw error;
      const delayMs = Math.min(5_000, 500 * attempt);
      console.warn(`代理 GET 第${attempt}次失败，${delayMs}ms后重试: ${error.code || error.message}`);
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("代理请求失败");
}

globalThis.fetch = fetchViaProxy;

const { getJwtTokenWithSDK } = await import("./getJwtTokenWithSDK.js");

const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT } = process.env;
const API_BASE_URL = "https://api.predict.fun";
const MARKET_ID = String(process.env.DOTA2_INGAME_MARKET_ID || "1636526");
const MARKET_CATEGORY = "dota2-vsn2-ts8-2026-08-23";
const MARKET_TITLE = "Match Winner";
const MIN_BID_SHARES = 22;
const POLL_INTERVAL_MS = Number(process.env.DOTA2_INGAME_INTERVAL_MS) || 3_000;
const POSITION_MONITOR_INTERVAL_MS = Number(process.env.DOTA2_INGAME_POSITION_INTERVAL_MS) || 2_000;
const BUY_ORDER_MONITOR_INTERVAL_MS = Number(process.env.DOTA2_INGAME_BUY_MONITOR_INTERVAL_MS) || 1_000;
const PERIODIC_BUY_CANCEL_INTERVAL_MS = Number(process.env.DOTA2_INGAME_BUY_CANCEL_INTERVAL_MS) || 11 * 60_000;
const ONE_SHARE_WEI = 10n ** 18n;
const ORDER_SHARES = parsePositiveBigInt(process.env.DOTA2_INGAME_ORDER_SHARES, 101n);
const POSITION_LIMIT_SHARES = parsePositiveBigInt(process.env.DOTA2_INGAME_POSITION_LIMIT_SHARES, 100n);
const MIN_BUY_ORDER_SHARES = parsePositiveBigInt(process.env.DOTA2_INGAME_MIN_BUY_ORDER_SHARES, 101n);
const MIN_NEW_BUY_ORDER_SHARES = 100n;
const TARGET_SHARES_WEI = POSITION_LIMIT_SHARES * ONE_SHARE_WEI;
const BUY_ORDER_CANCEL_THRESHOLD_SHARES = MIN_BUY_ORDER_SHARES;
const MIN_BUY_ORDER_REMAINING_WEI = BUY_ORDER_CANCEL_THRESHOLD_SHARES * ONE_SHARE_WEI;
const MIN_POSITION_CLOSE_WEI = ONE_SHARE_WEI;
const SELL_QUANTITY_TOLERANCE_WEI = ONE_SHARE_WEI;

let orderBuilder = null;
let stopping = false;
let stopPromise = null;
let placementRefreshRequested = true;
let wakePlacementLoop = null;
const cancelingOrderIds = new Set();
const closingPositions = new Set();
const pendingSellOrders = new Map();
const recoveredBuyPrices = new Map();

function parsePositiveBigInt(value, fallback) {
  try {
    const parsed = BigInt(String(value ?? fallback));
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestPlacementRefresh(reason) {
  placementRefreshRequested = true;
  console.log(`触发买单流程刷新 reason=${reason || "unknown"}`);
  wakePlacementLoop?.();
}

function waitForPlacementCycle() {
  if (placementRefreshRequested) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(), POLL_INTERVAL_MS);
    const finish = () => {
      clearTimeout(timer);
      if (wakePlacementLoop === finish) wakePlacementLoop = null;
      resolve();
    };
    wakePlacementLoop = finish;
    if (placementRefreshRequested) finish();
  });
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getOrderId(order) {
  return order?.id ?? order?.orderId ?? order?.hash ?? order?.order?.hash;
}

function getOrderMarketId(order) {
  return order?.market?.id ?? order?.marketId ?? order?.order?.marketId;
}

function getOrderTokenId(order) {
  return order?.outcome?.onChainId
    ?? order?.tokenId
    ?? order?.order?.tokenId
    ?? order?.outcomeTokenId
    ?? order?.outcome?.tokenId;
}

function getOrderOutcomeId(order) {
  return order?.outcome?.id ?? order?.outcomeId ?? order?.order?.outcomeId;
}

function getOrderSide(order) {
  const side = order?.side ?? order?.order?.side ?? "";
  if (side === 0 || side === "0") return "BUY";
  if (side === 1 || side === "1") return "SELL";
  return String(side).toUpperCase();
}

function parsePrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (price <= 1) return price;
  if (/^\d+$/.test(text) && text.length > 9) return price / 1e18;
  return null;
}

function getOrderPrice(order) {
  for (const value of [
    order?.price,
    order?.pricePerShare,
    order?.order?.pricePerShare,
  ]) {
    const price = parsePrice(value);
    if (price) return price;
  }

  const makerAmount = Number(order?.order?.makerAmount ?? order?.makerAmount);
  const takerAmount = Number(order?.order?.takerAmount ?? order?.takerAmount);
  if (!Number.isFinite(makerAmount) || !Number.isFinite(takerAmount) || makerAmount <= 0 || takerAmount <= 0) return null;
  return getOrderSide(order) === "SELL" ? takerAmount / makerAmount : makerAmount / takerAmount;
}

function parseQuantityWei(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    if (typeof value === "bigint") return value;
    const text = String(value);
    if (/^\d+$/.test(text)) {
      const integer = BigInt(text);
      return text.length <= 9 ? integer * ONE_SHARE_WEI : integer;
    }
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? BigInt(Math.floor(number * 1e18)) : null;
  } catch {
    return null;
  }
}

function getOrderQuantityWei(order) {
  const candidates = [
    order?.remainingQuantity,
    order?.remainingQuantityWei,
    order?.quantity,
    order?.quantityWei,
    order?.size,
    order?.shares,
    order?.order?.remainingQuantity,
    order?.order?.remainingQuantityWei,
    order?.order?.quantity,
    order?.order?.quantityWei,
  ];
  for (const value of candidates) {
    const quantity = parseQuantityWei(value);
    if (quantity !== null && quantity > 0n) return quantity;
  }

  // makerAmount is the share quantity for SELL orders, but not for BUY orders.
  if (getOrderSide(order) === "SELL") {
    const quantity = parseQuantityWei(order?.order?.makerAmount ?? order?.makerAmount);
    if (quantity !== null && quantity > 0n) return quantity;
  }
  return null;
}

function getOpenBuyReservedAmountWei(order) {
  if (getOrderSide(order) !== "BUY") return 0n;
  const price = getOrderPrice(order);
  const quantityWei = getOrderQuantityWei(order);
  if (price && quantityWei) {
    const priceWei = BigInt(Math.floor(price * 1e18 + 1e-9));
    return (quantityWei * priceWei) / ONE_SHARE_WEI;
  }

  const makerAmount = parseQuantityWei(order?.order?.makerAmount ?? order?.makerAmount);
  return makerAmount ?? 0n;
}

function parseWei(value) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    if (typeof value === "bigint") return value;
    const text = String(value);
    if (/^\d+$/.test(text)) return BigInt(text);
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? BigInt(Math.floor(number * 1e18)) : 0n;
  } catch {
    return 0n;
  }
}

function getPositionMarketId(position) {
  return position?.market?.id ?? position?.marketId;
}

function getPositionTokenId(position) {
  return position?.outcome?.onChainId ?? position?.tokenId ?? position?.outcomeId;
}

function getPositionOutcomeId(position) {
  return position?.outcome?.id ?? position?.outcomeId;
}

function getPositionQuantityWei(position) {
  return parseWei(position?.balance ?? position?.amount ?? position?.quantity);
}

function getPositionBuyPrice(position) {
  const averageBuyPriceUsd = Number(position?.averageBuyPriceUsd);
  if (Number.isFinite(averageBuyPriceUsd) && averageBuyPriceUsd > 0 && averageBuyPriceUsd <= 1) return averageBuyPriceUsd;
  if (Number.isFinite(averageBuyPriceUsd) && averageBuyPriceUsd > 1 && averageBuyPriceUsd <= 100) return averageBuyPriceUsd / 100;

  for (const value of [
    position?.averagePrice,
    position?.averageEntryPrice,
    position?.avgPrice,
    position?.avgEntryPrice,
    position?.entryPrice,
    position?.entryPricePerShare,
    position?.price,
    position?.costBasisPrice,
  ]) {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0 && price <= 1) return price;
  }
  return null;
}

function parseDepthLevel(level) {
  const price = Number(level?.price ?? level?.[0]);
  const size = Number(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
  return { price, size };
}

function bestLevel(levels, sortAscending) {
  return parseArray(levels)
    .map(parseDepthLevel)
    .filter(Boolean)
    .sort((a, b) => sortAscending ? a.price - b.price : b.price - a.price)[0] ?? null;
}

function getOutcomeBidFromBook(book, market, outcome) {
  const outcomeIndex = market.outcomes.findIndex(item => String(item.onChainId) === String(outcome.onChainId));
  if (outcomeIndex === 0) {
    return bestLevel(book?.bids, false);
  }

  if (outcomeIndex === 1 && market.outcomes.length === 2) {
    const directAsk = bestLevel(book?.asks, true);
    if (!directAsk) return null;
    const precision = Number.isInteger(Number(market.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
    const factor = 10 ** precision;
    const price = (factor - Math.round(directAsk.price * factor)) / factor;
    return price > 0 ? { price, size: directAsk.size } : null;
  }

  return null;
}

function getOutcomeAskFromBook(book, market, outcome) {
  const outcomeIndex = market.outcomes.findIndex(item => String(item.onChainId) === String(outcome.onChainId));
  if (outcomeIndex === 0) return bestLevel(book?.asks, true);

  if (outcomeIndex === 1 && market.outcomes.length === 2) {
    const directBid = bestLevel(book?.bids, false);
    if (!directBid) return null;
    const precision = Number.isInteger(Number(market.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
    const factor = 10 ** precision;
    const price = (factor - Math.round(directBid.price * factor)) / factor;
    return price > 0 ? { price, size: directBid.size } : null;
  }

  return null;
}

function getMarketDecimalPrecision(market) {
  const precision = Number(market?.decimalPrecision);
  return Number.isInteger(precision) && precision >= 0 && precision <= 18 ? precision : 2;
}

function getMarketPriceTickWei(market) {
  return 10n ** BigInt(18 - getMarketDecimalPrecision(market));
}

function roundBuyPriceWei(price, market) {
  const precision = getMarketDecimalPrecision(market);
  const scale = 10 ** precision;
  return BigInt(Math.floor(price * scale + 1e-9)) * getMarketPriceTickWei(market);
}

function roundSellPriceWei(price, market) {
  const precision = getMarketDecimalPrecision(market);
  const scale = 10 ** precision;
  return BigInt(Math.ceil(price * scale - 1e-9)) * getMarketPriceTickWei(market);
}

function getCloseSellPriceWei({ market, buyPrice, bestBid, bestAsk }) {
  const buyPriceWei = roundSellPriceWei(buyPrice, market);
  if (bestBid) {
    const bestBidPriceWei = roundBuyPriceWei(bestBid.price, market);
    if (bestBidPriceWei >= buyPriceWei) {
      const targetPriceWei = bestBidPriceWei + getMarketPriceTickWei(market);
      const cappedPriceWei = targetPriceWei > ONE_SHARE_WEI ? ONE_SHARE_WEI : targetPriceWei;
      return { sellPriceWei: cappedPriceWei, reason: "买一不低于成本，按买一加一个tick挂卖" };
    }
  }

  return { sellPriceWei: buyPriceWei, reason: "买一低于成本，按成本价挂卖" };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, agent: proxyAgent });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text.slice(0, 200)}`);
  }
  const json = await response.json();
  if (json.success === false) throw new Error(`API success=false: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

function apiHeaders(jwt) {
  return {
    "x-api-key": PREDICT_API_KEY,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

async function getMarket() {
  const json = await requestJson(`${API_BASE_URL}/v1/markets/${MARKET_ID}`, {
    headers: apiHeaders(),
  });
  const market = json.data;
  if (!market || String(market.categorySlug) !== MARKET_CATEGORY || String(market.title) !== MARKET_TITLE) {
    throw new Error(`目标市场校验失败 marketId=${MARKET_ID}`);
  }
  if (!Array.isArray(market.outcomes) || market.outcomes.length !== 2) {
    throw new Error("目标市场不是二元比赛获胜者市场");
  }
  return market;
}

async function getPredictBook() {
  const json = await requestJson(`${API_BASE_URL}/v1/markets/${MARKET_ID}/orderbook`, {
    headers: apiHeaders(),
  });
  return json.data;
}

async function getOpenOrders(jwt = null) {
  jwt ||= await getJwtTokenWithSDK();
  const orders = [];
  let after = null;
  const seenCursors = new Set();

  while (true) {
    const query = new URLSearchParams({ status: "OPEN", first: "200" });
    if (after) query.set("after", after);
    const json = await requestJson(`${API_BASE_URL}/v1/orders?${query}`, {
      headers: apiHeaders(jwt),
    });
    const page = Array.isArray(json.data) ? json.data : [];
    orders.push(...page);
    if (!json.cursor || page.length === 0 || seenCursors.has(json.cursor)) break;
    seenCursors.add(json.cursor);
    after = json.cursor;
  }

  return orders;
}

async function getPositions(jwt = null) {
  jwt ||= await getJwtTokenWithSDK();
  const json = await requestJson(`${API_BASE_URL}/v1/positions?first=100`, {
    headers: apiHeaders(jwt),
  });
  return Array.isArray(json.data) ? json.data : [];
}

async function getFilledOrders(jwt = null) {
  jwt ||= await getJwtTokenWithSDK();
  const orders = [];
  let after = null;
  const seenCursors = new Set();

  while (true) {
    const query = new URLSearchParams({ status: "FILLED", first: "200" });
    if (after) query.set("after", after);
    const json = await requestJson(`${API_BASE_URL}/v1/orders?${query}`, {
      headers: apiHeaders(jwt),
    });
    const page = Array.isArray(json.data) ? json.data : [];
    orders.push(...page);
    if (!json.cursor || page.length === 0 || seenCursors.has(json.cursor)) break;
    seenCursors.add(json.cursor);
    after = json.cursor;
  }
  return orders;
}

async function recoverBuyPrice(position, jwt) {
  const key = getPositionKey(position);
  const cached = recoveredBuyPrices.get(key);
  if (cached && Date.now() - cached.updatedAt < 60_000) return cached.price;

  const tokenId = getPositionTokenId(position);
  const outcomeId = getPositionOutcomeId(position);
  const orders = await getFilledOrders(jwt);
  const latestBuy = orders
    .filter(order => getOrderSide(order) === "BUY" && String(getOrderMarketId(order)) === MARKET_ID)
    .filter(order => String(getOrderTokenId(order)) === String(tokenId)
      || (outcomeId && String(getOrderOutcomeId(order)) === String(outcomeId)))
    .sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")))[0];
  const price = getOrderPrice(latestBuy);
  if (!price || price <= 0 || price >= 1) return null;
  recoveredBuyPrices.set(key, { price, updatedAt: Date.now() });
  return price;
}

function getTargetBuyOrders(orders, outcome) {
  return orders.filter(order => {
    if (getOrderSide(order) !== "BUY" || String(getOrderMarketId(order)) !== MARKET_ID) return false;
    const tokenMatches = String(getOrderTokenId(order)) === String(outcome.onChainId);
    const outcomeMatches = outcome.id && String(getOrderOutcomeId(order)) === String(outcome.id);
    return tokenMatches || outcomeMatches;
  });
}

function getTargetSellOrders(orders, outcome) {
  return orders.filter(order => {
    if (getOrderSide(order) !== "SELL" || String(getOrderMarketId(order)) !== MARKET_ID) return false;
    const tokenMatches = String(getOrderTokenId(order)) === String(outcome.onChainId);
    const outcomeMatches = outcome.id && String(getOrderOutcomeId(order)) === String(outcome.id);
    return tokenMatches || outcomeMatches;
  });
}

function getPositionSharesWei(positions, outcome) {
  return positions
    .filter(position => String(getPositionMarketId(position)) === MARKET_ID)
    .filter(position => String(getPositionTokenId(position)) === String(outcome.onChainId)
      || (outcome.id && String(getPositionOutcomeId(position)) === String(outcome.id)))
    .reduce((total, position) => total + getPositionQuantityWei(position), 0n);
}

function getPositionForOutcome(positions, outcome) {
  return positions.find(position => String(getPositionMarketId(position)) === MARKET_ID
    && (String(getPositionTokenId(position)) === String(outcome.onChainId)
      || (outcome.id && String(getPositionOutcomeId(position)) === String(outcome.id))));
}

function getPositionKey(position) {
  return `${MARKET_ID}-${getPositionTokenId(position)}`;
}

function rememberPendingSell(key, order, quantityWei, price) {
  pendingSellOrders.set(key, {
    orderId: getOrderId(order),
    quantityWei,
    price,
    createdAt: Date.now(),
  });
}

function getPendingSell(key) {
  const pending = pendingSellOrders.get(key);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > 60_000) {
    pendingSellOrders.delete(key);
    return null;
  }
  return pending;
}

async function initSDK() {
  if (orderBuilder) return orderBuilder;
  if (!PRIVY_PRIVATE_KEY || !PREDICT_ACCOUNT || !PREDICT_API_KEY) {
    throw new Error("缺少 PREDICT_API_KEY / PRIVY_PRIVATE_KEY / PREDICT_ACCOUNT");
  }
  orderBuilder = await OrderBuilder.make(
    ChainId.BnbMainnet,
    new Wallet(PRIVY_PRIVATE_KEY),
    { predictAccount: PREDICT_ACCOUNT },
  );
  return orderBuilder;
}

async function getAvailableBuyBalanceWei(openOrders) {
  const builder = await initSDK();
  const balanceWei = await builder.balanceOf("USDT", PREDICT_ACCOUNT);
  const reservedWei = openOrders.reduce((total, order) => total + getOpenBuyReservedAmountWei(order), 0n);
  return balanceWei > reservedWei ? balanceWei - reservedWei : 0n;
}

async function placeBuyLimit(market, outcome, price, quantityWei) {
  const builder = await initSDK();
  const precision = Number.isInteger(Number(market.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
  const factor = 10 ** precision;
  const priceUnits = Math.floor(price * factor + 1e-9);
  const priceWei = BigInt(priceUnits) * (10n ** BigInt(18 - precision));

  const amounts = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: priceWei,
    quantityWei,
  });
  const order = builder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
  });
  const typedData = builder.buildTypedData(order, {
    isNegRisk: market.isNegRisk || false,
    isYieldBearing: market.isYieldBearing || false,
  });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  const body = JSON.stringify({
    data: {
      order: { ...signedOrder, hash },
      pricePerShare: amounts.pricePerShare,
      strategy: "LIMIT",
    },
  }, (_, value) => typeof value === "bigint" ? value.toString() : value);

  const jwt = await getJwtTokenWithSDK();
  const json = await requestJson(`${API_BASE_URL}/v1/orders`, {
    method: "POST",
    headers: { ...apiHeaders(jwt), "Content-Type": "application/json" },
    body,
  });
  return json.data;
}

async function placeSellLimit(market, outcome, priceWei, quantityWei) {
  const builder = await initSDK();
  const amounts = builder.getLimitOrderAmounts({
    side: Side.SELL,
    pricePerShareWei: priceWei,
    quantityWei,
  });
  const order = builder.buildOrder("LIMIT", {
    side: Side.SELL,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
  });
  const typedData = builder.buildTypedData(order, {
    isNegRisk: market.isNegRisk || false,
    isYieldBearing: market.isYieldBearing || false,
  });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  const jwt = await getJwtTokenWithSDK();
  const json = await requestJson(`${API_BASE_URL}/v1/orders`, {
    method: "POST",
    headers: { ...apiHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        order: { ...signedOrder, hash },
        pricePerShare: amounts.pricePerShare,
        strategy: "LIMIT",
      },
    }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return json.data;
}

async function cancelOrders(orders, reason) {
  const ids = [...new Set(orders.map(getOrderId).filter(Boolean).map(String))]
    .filter(id => !cancelingOrderIds.has(id));
  if (!ids.length) return 0;
  for (const id of ids) cancelingOrderIds.add(id);
  try {
    const jwt = await getJwtTokenWithSDK();
    await requestJson(`${API_BASE_URL}/v1/orders/remove`, {
      method: "POST",
      headers: { ...apiHeaders(jwt), "Content-Type": "application/json" },
      body: JSON.stringify({ data: { ids } }),
    });
    console.log(`撤销订单 ${ids.length} 个 reason=${reason}`);
    return ids.length;
  } finally {
    for (const id of ids) cancelingOrderIds.delete(id);
  }
}

function samePrice(left, right, market) {
  const precision = Number.isInteger(Number(market.decimalPrecision)) ? Number(market.decimalPrecision) : 2;
  return Math.round(left * 10 ** precision) === Math.round(right * 10 ** precision);
}

async function handleOutcome({ market, outcome, bid, openOrders, positions, availableBuyBalance }) {
  const direction = outcome.name || outcome.id || outcome.onChainId;
  const directionOrders = getTargetBuyOrders(openOrders, outcome);
  const positionWei = getPositionSharesWei(positions, outcome);
  const positionShares = Number(positionWei) / 1e18;

  if (positionWei >= TARGET_SHARES_WEI) {
    await cancelOrders(directionOrders, `${direction} 持仓已达到${POSITION_LIMIT_SHARES}shares`);
    console.log(`${direction} 持仓=${positionShares.toFixed(4)}，不挂买单`);
    return;
  }

  if (!bid || bid.size <= MIN_BID_SHARES || bid.price <= 0 || bid.price >= 1) {
    await cancelOrders(directionOrders, `${direction} 买一深度不满足条件`);
    console.log(`${direction} 买一不足条件 bid=${bid ? `${bid.price}@${bid.size}` : "空"}`);
    return;
  }

  const existingQuantityWei = directionOrders.length === 1 ? getOrderQuantityWei(directionOrders[0]) : null;
  const correctlyPriced = directionOrders.length === 1
    && samePrice(getOrderPrice(directionOrders[0]), bid.price, market)
    && (existingQuantityWei === null || existingQuantityWei >= MIN_BUY_ORDER_REMAINING_WEI);
  if (correctlyPriced) {
    console.log(`${direction} 保留买单 position=${positionShares.toFixed(4)} bid=${bid.price}@${bid.size}`);
    return;
  }

  if (directionOrders.length) {
    const releasedAmountWei = directionOrders.reduce((total, order) => total + getOpenBuyReservedAmountWei(order), 0n);
    const cancelled = await cancelOrders(directionOrders, `${direction} 买一价格变化，重新挂单`);
    if (cancelled === directionOrders.length) availableBuyBalance.value += releasedAmountWei;
    if (stopping) return;
  }

  if (stopping) return;
  const priceWei = roundBuyPriceWei(bid.price, market);
  const affordableShares = priceWei > 0n ? availableBuyBalance.value / priceWei : 0n;
  const actualShares = affordableShares < ORDER_SHARES ? affordableShares : ORDER_SHARES;
  if (actualShares <= MIN_NEW_BUY_ORDER_SHARES) {
    console.log(`${direction} 可用余额只能购买${actualShares}shares，不满足大于${MIN_NEW_BUY_ORDER_SHARES}shares，跳过挂单`);
    return;
  }

  const quantityWei = actualShares * ONE_SHARE_WEI;
  const placed = await placeBuyLimit(market, outcome, bid.price, quantityWei);
  availableBuyBalance.value -= actualShares * priceWei;
  console.log(`${direction} 挂买单 ${actualShares}shares price=${bid.price} bidSize=${bid.size} orderId=${getOrderId(placed) || "unknown"}`);
}

async function managePosition(market, position, openOrders, jwt) {
  const quantityWei = getPositionQuantityWei(position);
  if (quantityWei < MIN_POSITION_CLOSE_WEI) return;

  const tokenId = getPositionTokenId(position);
  const outcomeId = getPositionOutcomeId(position);
  const outcome = market.outcomes.find(item => String(item.onChainId) === String(tokenId))
    ?? market.outcomes.find(item => outcomeId && String(item.id) === String(outcomeId))
    ?? position.outcome;
  if (!tokenId || !outcome) {
    console.log(`无法识别持仓方向 tokenId=${tokenId || "unknown"}`);
    return;
  }

  const closeKey = getPositionKey(position);
  if (closingPositions.has(closeKey)) return;
  closingPositions.add(closeKey);

  try {
    const buyPrice = getPositionBuyPrice(position) ?? await recoverBuyPrice(position, jwt);
    if (!buyPrice) {
      console.log(`${outcome.name} 持仓暂不挂卖：无法识别成本价 shares=${(Number(quantityWei) / 1e18).toFixed(4)}`);
      return;
    }

    const book = await getPredictBook();
    const bestBid = getOutcomeBidFromBook(book, market, outcome);
    const bestAsk = getOutcomeAskFromBook(book, market, outcome);

    const closePrice = getCloseSellPriceWei({ market, buyPrice, bestBid, bestAsk });
    const sellPriceWei = closePrice.sellPriceWei;
    if (sellPriceWei <= 0n) return;
    const sellPrice = Number(sellPriceWei) / 1e18;
    if (bestBid && bestBid.price >= sellPrice - 1e-9) {
      console.log(`${outcome.name} 持仓暂不挂卖：目标价会吃买一 bid=${bestBid.price} sell=${sellPrice}`);
      return;
    }

    const sellOrders = getTargetSellOrders(openOrders, outcome);
    const pending = getPendingSell(closeKey);
    if (pending) {
      const visible = pending.orderId && sellOrders.some(order => String(getOrderId(order)) === String(pending.orderId));
      if (!visible) {
        console.log(`${outcome.name} 等待卖单出现在OPEN后再检查，orderId=${pending.orderId || "unknown"}`);
        return;
      }
      if (samePrice(pending.price, sellPrice, market) && pending.quantityWei + SELL_QUANTITY_TOLERANCE_WEI >= quantityWei) return;
      pendingSellOrders.delete(closeKey);
    }

    if (sellOrders.length === 1) {
      const existingPrice = getOrderPrice(sellOrders[0]);
      const existingQuantityWei = getOrderQuantityWei(sellOrders[0]);
      if (existingPrice && existingQuantityWei
        && samePrice(existingPrice, sellPrice, market)
        && existingQuantityWei + SELL_QUANTITY_TOLERANCE_WEI >= quantityWei) return;
    }

    if (sellOrders.length) {
      await cancelOrders(sellOrders, `${outcome.name} 持仓卖价或数量变化，重挂限价卖单`);
      pendingSellOrders.delete(closeKey);
    }

    console.log(`${outcome.name} 挂持仓卖单 shares=${(Number(quantityWei) / 1e18).toFixed(4)} cost=${buyPrice.toFixed(6)} bid=${bestBid?.price ?? "null"} ask=${bestAsk?.price ?? "null"} sell=${sellPrice} reason=${closePrice.reason}`);
    const sellOrder = await placeSellLimit(market, outcome, sellPriceWei, quantityWei);
    rememberPendingSell(closeKey, sellOrder, quantityWei, sellPrice);
  } catch (error) {
    console.error(`${outcome.name || tokenId} 持仓平仓失败:`, error.message);
  } finally {
    closingPositions.delete(closeKey);
  }
}

async function positionMonitorLoop() {
  while (!stopping) {
    try {
      const jwt = await getJwtTokenWithSDK();
      const [market, positions, openOrders] = await Promise.all([
        getMarket(),
        getPositions(jwt),
        getOpenOrders(jwt),
      ]);
      const targetPositions = positions.filter(position => String(getPositionMarketId(position)) === MARKET_ID);

      for (const position of targetPositions) await managePosition(market, position, openOrders, jwt);

      // Position sold out: remove any stale sell order for that direction.
      for (const outcome of market.outcomes) {
        const position = getPositionForOutcome(targetPositions, outcome);
        if (position && getPositionQuantityWei(position) > 0n) continue;
        const key = `${MARKET_ID}-${outcome.onChainId}`;
        const staleSells = getTargetSellOrders(openOrders, outcome);
        if (staleSells.length) await cancelOrders(staleSells, `${outcome.name} 持仓已归零，撤销残留卖单`);
        pendingSellOrders.delete(key);
      }
    } catch (error) {
      console.error("持仓监控异常:", error.message);
    }
    if (!stopping) await sleep(POSITION_MONITOR_INTERVAL_MS);
  }
}

async function buyOrderMonitorLoop() {
  while (!stopping) {
    try {
      const jwt = await getJwtTokenWithSDK();
      const [market, book, openOrders, positions] = await Promise.all([
        getMarket(),
        getPredictBook(),
        getOpenOrders(jwt),
        getPositions(jwt),
      ]);
      const smallBuyOrders = [];
      for (const outcome of market.outcomes) {
        const positionWei = getPositionSharesWei(positions, outcome);
        const directionOrders = getTargetBuyOrders(openOrders, outcome);
        const currentBid = getOutcomeBidFromBook(book, market, outcome);
        const invalidOrders = directionOrders.filter(order => {
          const quantityWei = getOrderQuantityWei(order);
          const orderPrice = getOrderPrice(order);
          const belowCurrentBid = currentBid && orderPrice !== null && orderPrice < currentBid.price - 1e-9;
          return belowCurrentBid
            || (quantityWei !== null && quantityWei < MIN_BUY_ORDER_REMAINING_WEI)
            || positionWei >= TARGET_SHARES_WEI;
        });
        smallBuyOrders.push(...invalidOrders);
      }
      if (smallBuyOrders.length) {
        const cancelled = await cancelOrders(smallBuyOrders, `买单低于当前买一、剩余低于${BUY_ORDER_CANCEL_THRESHOLD_SHARES}shares或持仓达到${POSITION_LIMIT_SHARES}shares`);
        if (cancelled > 0) requestPlacementRefresh("买单剩余份额不足，触发补挂判断");
      }
    } catch (error) {
      console.error("买单监控异常:", error.message);
    }
    if (!stopping) await sleep(BUY_ORDER_MONITOR_INTERVAL_MS);
  }
}

async function periodicBuyCancelLoop() {
  while (!stopping) {
    await sleep(PERIODIC_BUY_CANCEL_INTERVAL_MS);
    if (stopping) break;

    try {
      const openOrders = await getOpenOrders();
      const buyOrders = openOrders.filter(order => String(getOrderMarketId(order)) === MARKET_ID && getOrderSide(order) === "BUY");
      const cancelled = await cancelOrders(buyOrders, `定时刷新买单 interval=${PERIODIC_BUY_CANCEL_INTERVAL_MS}ms`);
      if (cancelled > 0) {
        requestPlacementRefresh(`定时撤销买单 ${cancelled} 个，触发补挂判断`);
      } else {
        console.log("定时买单刷新：当前没有需要撤销的目标买单");
      }
    } catch (error) {
      console.error("定时买单撤单子流程异常:", error.message);
    }
  }
}

async function buyPlacementLoop() {
  while (!stopping) {
    await waitForPlacementCycle();
    if (stopping) break;
    placementRefreshRequested = false;
    try {
      const market = await getMarket();
      if (market.tradingStatus !== "OPEN") {
        console.log(`挂买流程跳过：目标市场不可交易 tradingStatus=${market.tradingStatus || "unknown"}`);
      } else {
        await runCycle(market);
      }
    } catch (error) {
      console.error("挂买子流程异常，下一轮重试:", error.message);
    }
  }
}

async function runCycle(market) {
  const jwt = await getJwtTokenWithSDK();
  const [book, openOrders, positions] = await Promise.all([
    getPredictBook(),
    getOpenOrders(jwt),
    getPositions(jwt),
  ]);
  const availableBuyBalance = { value: await getAvailableBuyBalanceWei(openOrders) };

  for (const outcome of market.outcomes) {
    if (stopping) return;
    const bid = getOutcomeBidFromBook(book, market, outcome);
    try {
      await handleOutcome({ market, outcome, bid, openOrders, positions, availableBuyBalance });
    } catch (error) {
      console.error(`${outcome.name || outcome.id} 本轮操作失败:`, error.message);
    }
  }
}

async function shutdown(signal) {
  if (stopPromise) return stopPromise;
  stopping = true;
  wakePlacementLoop?.();
  stopPromise = (async () => {
    console.log(`收到 ${signal}，停止买入做市并撤销目标子市场买单，保留持仓卖单...`);
    try {
      const openOrders = await getOpenOrders();
      await cancelOrders(
        openOrders.filter(order => String(getOrderMarketId(order)) === MARKET_ID && getOrderSide(order) === "BUY"),
        "手动停止买入做市",
      );
      console.log("买入做市已停止，持仓卖单保留");
    } catch (error) {
      console.error("停止时撤买单失败，持仓卖单未主动撤销，请手动检查买单:", error.message);
    }
  })();
  await stopPromise;
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  if (!PREDICT_API_KEY) throw new Error("缺少 PREDICT_API_KEY");
  let proxyForLog = proxyUrl;
  try {
    const parsedProxy = new URL(proxyUrl);
    if (parsedProxy.password) parsedProxy.password = "***";
    if (parsedProxy.username) parsedProxy.username = "***";
    proxyForLog = parsedProxy.toString();
  } catch {}
  console.log(`Dota2 赛中做市启动 marketId=${MARKET_ID} proxy=${proxyForLog} interval=${POLL_INTERVAL_MS}ms`);
  const market = await getMarket();
  console.log(`目标子市场: ${market.question} | ${market.outcomes.map(outcome => outcome.name).join(" / ")}`);
  console.log(`参数: 每次挂=${ORDER_SHARES}shares | 持仓停止>=${POSITION_LIMIT_SHARES}shares | 买单剩余低于${BUY_ORDER_CANCEL_THRESHOLD_SHARES}shares撤单(配置阈值=${MIN_BUY_ORDER_SHARES}) | 定时撤买单=${PERIODIC_BUY_CANCEL_INTERVAL_MS}ms`);
  await initSDK();
  buyPlacementLoop().catch(error => console.error("挂买子流程停止:", error.message));
  buyOrderMonitorLoop().catch(error => console.error("买单监控子流程停止:", error.message));
  positionMonitorLoop().catch(error => console.error("持仓监控子流程停止:", error.message));
  periodicBuyCancelLoop().catch(error => console.error("定时买单撤单子流程停止:", error.message));

  while (!stopping) await sleep(1_000);
}

main().catch(error => {
  console.error("赛中做市启动失败:", error);
  process.exitCode = 1;
});
