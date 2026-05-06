import "dotenv/config";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "node:util";
import { Wallet, Contract, JsonRpcProvider } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import { getJwtTokenWithSDK } from "./getJwtTokenWithSDK.js";

const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT, RPC_URL } = process.env;

const LOG_FILE = "autoMarketMaker.log";
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function writeLog(args) {
  appendFileSync(LOG_FILE, format(...args) + "\n", "utf8");
}

console.log = (...args) => {
  writeLog(args);
  originalLog(...args);
};

console.error = (...args) => {
  writeLog(args);
  originalError(...args);
};

// ======== 配置 ========
const ORDER_RATIO = 0.95; // 使用余额的95%
const CHECK_INTERVAL_MS = 5 * 60_000; // 5分钟执行一轮挂单
const MONITOR_INTERVAL_MS = 3_000; // 高频撤单监控
const POSITION_MONITOR_INTERVAL_MS = 3_000; // 高频持仓平仓监控
const MARKET_DELAY_MS = 1_000; // 每个市场之间等待1秒
const OUTCOME_DELAY_MS = 500; // 同一市场每个outcome之间等待500ms
const MARKET_PAGE_SIZE = 100; // 分页拉取全部开放市场
const MIN_BUY_PRICE = 0.25; // 低于25不挂买单
const POLY_MIN_BID_USD = 1000; // Polymarket 买一金额低于该值不挂/撤单
const PRICE_TOLERANCE = 0.001; // Predict 高于 Polymarket 时允许的误差
const MAX_CLOSE_SLIPPAGE = 0.03; // 平仓最多接受3个价差
const EXPIRE_BEFORE_START_MS = 15 * 60 * 1000; // 开赛前15分钟订单失效
const BLOCKED_MARKETS_FILE = "blockedMarkets.json";

// SDK 初始化
let orderBuilder = null;
const rpcUrls = (RPC_URL || "").split(",").map(url => url.trim()).filter(Boolean);
const rpcProviders = new Map();
let rpcIndex = 0;
const polyMarketCache = new Map();
const trackedOrders = new Map();
const cancelingOrders = new Set();
const blockedMarkets = loadBlockedMarkets();
const latestMarketsById = new Map();
let latestOpenOrders = [];
let monitorRunning = false;
let positionMonitorRunning = false;
const closingPositions = new Set();

function loadBlockedMarkets() {
  try {
    if (!existsSync(BLOCKED_MARKETS_FILE)) return new Set();
    const ids = JSON.parse(readFileSync(BLOCKED_MARKETS_FILE, "utf8"));
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch (e) {
    console.log("⚠️ 读取黑名单失败:", e.message);
    return new Set();
  }
}

function blockMarket(marketId, reason) {
  if (marketId === undefined || marketId === null) return;
  const key = String(marketId);
  if (blockedMarkets.has(key)) return;
  blockedMarkets.add(key);
  writeFileSync(BLOCKED_MARKETS_FILE, JSON.stringify([...blockedMarkets], null, 2), "utf8");
  console.log("🚫 市场加入黑名单:", marketId, reason || "");
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

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function getOrderId(order) {
  return order?.id ?? order?.orderId ?? order?.hash ?? order?.order?.hash;
}

function getOrderMarketId(order) {
  return order?.market?.id ?? order?.marketId;
}

function getOrderTokenId(order) {
  return order?.outcome?.onChainId ?? order?.tokenId ?? order?.outcomeId ?? order?.order?.tokenId;
}

function getPositionMarketId(pos) {
  return pos?.market?.id ?? pos?.marketId;
}

function getPositionTokenId(pos) {
  return pos?.outcome?.onChainId ?? pos?.tokenId ?? pos?.outcomeId;
}

function getPositionQuantityWei(pos) {
  return BigInt(pos?.balance ?? pos?.amount ?? pos?.quantity ?? 0);
}

function getPositionBuyPrice(pos) {
  const candidates = [
    pos?.averagePrice,
    pos?.averageBuyPriceUsd,
    pos?.averageEntryPrice,
    pos?.avgPrice,
    pos?.avgEntryPrice,
    pos?.entryPrice,
    pos?.entryPricePerShare,
    pos?.price,
    pos?.costBasisPrice,
  ];

  for (const value of candidates) {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0 && price <= 1) return price;
  }

  return null;
}

async function initSDK() {
  if (orderBuilder) return orderBuilder;
  const signer = new Wallet(PRIVY_PRIVATE_KEY);
  orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, { predictAccount: PREDICT_ACCOUNT });
  return orderBuilder;
}

function maskRpcUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.slice(0, 12) + (parsed.pathname.length > 12 ? "..." : "");
  } catch {
    return "RPC_URL";
  }
}

function getProvider() {
  if (!rpcUrls.length) throw new Error("缺少 RPC_URL 环境变量");
  const url = rpcUrls[rpcIndex % rpcUrls.length];
  if (!rpcProviders.has(url)) {
    rpcProviders.set(url, new JsonRpcProvider(url, { name: "bnb", chainId: 56 }, { staticNetwork: true }));
  }
  return rpcProviders.get(url);
}

function switchRpc(reason) {
  if (rpcUrls.length <= 1) return;
  const oldUrl = rpcUrls[rpcIndex % rpcUrls.length];
  rpcIndex = (rpcIndex + 1) % rpcUrls.length;
  const newUrl = rpcUrls[rpcIndex % rpcUrls.length];
  console.log("⚠️ RPC切换:", maskRpcUrl(oldUrl), "=>", maskRpcUrl(newUrl), reason || "");
}

// 获取链上余额
async function getBalance() {
  const USDT = "0x55d398326f99059fF775485246999027B3197955";
  const attempts = Math.max(rpcUrls.length, 1);

  for (let i = 0; i < attempts; i++) {
    try {
      const provider = getProvider();
      const usdt = new Contract(USDT, ["function balanceOf(address) view returns (uint256)"], provider);
      return BigInt((await usdt.balanceOf(PREDICT_ACCOUNT)).toString());
    } catch (e) {
      switchRpc(e.message);
    }
  }

  console.log("⚠️ 所有RPC查询余额失败");
  return 0n;
}

// 获取全部活跃市场（按成交量排序，过滤BTC）
async function getMarkets() {
  try {
    const markets = [];
    let after = null;

    while (true) {
      const query = new URLSearchParams({
        first: String(MARKET_PAGE_SIZE),
        status: "OPEN",
        hasActiveRewards: "true",
        sort: "VOLUME_24H_DESC",
      });
      if (after) query.set("after", after);

      const url = "https://api.predict.fun/v1/markets?" + query.toString();
      const res = await fetch(url, { headers: { "x-api-key": PREDICT_API_KEY } });
      if (!res.ok) throw new Error("markets status " + res.status);
      const json = await res.json();
      const pageMarkets = json.data || [];

      for (const market of pageMarkets) {
        const title = (market.title || "").toLowerCase();
        if (!title.includes("btc") && !title.includes("bitcoin") && market.polymarketConditionIds?.length) {
          markets.push(market);
        }
      }

      if (!json.cursor || pageMarkets.length === 0) break;
      after = json.cursor;
    }

    for (const market of markets) latestMarketsById.set(String(market.id), market);
    return markets;
  } catch (e) {
    console.log("⚠️ 获取市场失败:", e.message);
    return [];
  }
}

async function getPolymarketMarket(conditionId) {
  if (polyMarketCache.has(conditionId)) return polyMarketCache.get(conditionId);

  const urls = [
    "https://gamma-api.polymarket.com/markets?condition_ids=" + encodeURIComponent(conditionId),
    "https://gamma-api.polymarket.com/markets?condition_id=" + encodeURIComponent(conditionId),
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      const items = Array.isArray(json) ? json : json.data;
      const market = items?.find(m => normalizeName(m.conditionId ?? m.condition_id) === normalizeName(conditionId)) ?? items?.[0];
      if (market) {
        polyMarketCache.set(conditionId, market);
        return market;
      }
    } catch (e) {}
  }

  polyMarketCache.set(conditionId, null);
  return null;
}

async function getPolymarketBook(tokenId) {
  try {
    const url = "https://clob.polymarket.com/book?token_id=" + encodeURIComponent(tokenId);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function getPolymarketStartAt(polyMarket) {
  const raw = polyMarket?.gameStartTime ?? polyMarket?.eventStartTime ?? polyMarket?.startDate ?? polyMarket?.startDateIso ?? polyMarket?.endDate ?? polyMarket?.events?.[0]?.startDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSportsLikeMarket(market) {
  const text = [market.categorySlug, market.marketVariant, market.title, market.question].join(" ").toLowerCase();
  return text.includes("sport") || text.includes("esport") || text.includes("nba") || text.includes("nfl") || text.includes("nhl") || text.includes("mlb") || text.includes("ufc") || text.includes("soccer") || text.includes("football") || text.includes("league") || text.includes("dota") || text.includes("cs2") || text.includes("valorant");
}

function findPolymarketTokenId(polyMarket, outcome) {
  const outcomes = parseArray(polyMarket?.outcomes);
  const tokenIds = parseArray(polyMarket?.clobTokenIds ?? polyMarket?.clob_token_ids);
  if (!tokenIds.length) return null;

  const nameIndex = outcomes.findIndex(name => normalizeName(name) === normalizeName(outcome.name));
  if (nameIndex >= 0 && tokenIds[nameIndex]) return String(tokenIds[nameIndex]);

  const indexSetIndex = Number(outcome.indexSet) - 1;
  if (indexSetIndex >= 0 && tokenIds[indexSetIndex]) return String(tokenIds[indexSetIndex]);

  return null;
}

function getBestPolymarketBid(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  let best = null;

  for (const bid of bids) {
    const price = Number(bid.price ?? bid[0]);
    const size = Number(bid.size ?? bid[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (!best || price > best.price) best = { price, size, valueUsd: price * size };
  }

  return best;
}

async function getPolymarketQuote(market, outcome) {
  for (const conditionId of market.polymarketConditionIds || []) {
    const polyMarket = await getPolymarketMarket(conditionId);
    if (!polyMarket) continue;

    const startsAt = getPolymarketStartAt(polyMarket);
    if (isSportsLikeMarket(market) && !startsAt) {
      return { ok: false, reason: "运动/电竞市场缺少开赛时间" };
    }

    const expiresAt = startsAt ? new Date(startsAt.getTime() - EXPIRE_BEFORE_START_MS) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "已接近开赛" };
    }

    const tokenId = findPolymarketTokenId(polyMarket, outcome);
    if (!tokenId) continue;

    const book = await getPolymarketBook(tokenId);
    const bestBid = getBestPolymarketBid(book);
    if (!bestBid) return { ok: false, reason: "Polymarket 无买一" };
    if (bestBid.valueUsd < POLY_MIN_BID_USD) {
      return { ok: false, reason: "Polymarket 买一金额不足 " + bestBid.valueUsd.toFixed(2) + "u" };
    }

    return { ok: true, price: bestBid.price, valueUsd: bestBid.valueUsd, expiresAt, tokenId, conditionId };
  }

  return { ok: false, reason: "无法映射 Polymarket token" };
}

// 获取当前挂单
async function getOpenOrders(throwOnError = false) {
  try {
    const jwt = await getJwtTokenWithSDK();
    const res = await fetch("https://api.predict.fun/v1/orders?status=OPEN&first=200", {
      headers: { "x-api-key": PREDICT_API_KEY, "Authorization": "Bearer " + jwt }
    });
    if (!res.ok) throw new Error("orders status " + res.status);
    const orders = (await res.json()).data || [];
    latestOpenOrders = orders;
    return orders;
  } catch (e) {
    if (throwOnError) throw e;
    return [];
  }
}

// 获取持仓
async function getPositions() {
  try {
    const jwt = await getJwtTokenWithSDK();
    const res = await fetch("https://api.predict.fun/v1/positions?first=100", {
      headers: { "x-api-key": PREDICT_API_KEY, "Authorization": "Bearer " + jwt }
    });
    return (await res.json()).data || [];
  } catch (e) { return []; }
}

// 取消订单
async function cancelOrder(orderId) {
  const key = String(orderId);
  if (cancelingOrders.has(key)) return;
  cancelingOrders.add(key);
  try {
    const jwt = await getJwtTokenWithSDK();
    const res = await fetch("https://api.predict.fun/v1/orders/" + orderId + "/cancel", {
      method: "POST",
      headers: { "x-api-key": PREDICT_API_KEY, "Authorization": "Bearer " + jwt }
    });
    if (!res.ok) throw new Error("cancel status " + res.status);
    console.log("🧯 已撤单:", orderId);
  } catch (e) {
    cancelingOrders.delete(key);
    console.log("⚠️ 撤单失败:", orderId, e.message);
  }
}

// 挂限价买单
async function placeBuyLimit(market, outcome, priceWei, amountWei, expiresAt) {
  const builder = await initSDK();
  const quantityWei = (amountWei * 10n ** 18n) / BigInt(priceWei);

  const { makerAmount, takerAmount, pricePerShare } = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: BigInt(priceWei),
    quantityWei,
  });

  const order = builder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
    expiresAt,
  });

  const typedData = builder.buildTypedData(order, {
    isNegRisk: market.isNegRisk || false,
    isYieldBearing: market.isYieldBearing || false,
  });

  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);

  const payload = {
    data: {
      order: { ...signedOrder, hash },
      pricePerShare,
      strategy: "LIMIT",
    }
  };
  const body = JSON.stringify(payload, (_, v) => typeof v === "bigint" ? v.toString() : v);

  const res = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": "Bearer " + await getJwtTokenWithSDK(),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 100));
  }
  return (await res.json()).data;
}

async function placeSellLimit(market, tokenId, priceWei, quantityWei) {
  const builder = await initSDK();

  const { makerAmount, takerAmount, pricePerShare } = builder.getLimitOrderAmounts({
    side: Side.SELL,
    pricePerShareWei: BigInt(priceWei),
    quantityWei,
  });

  const order = builder.buildOrder("LIMIT", {
    side: Side.SELL,
    tokenId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: market?.feeRateBps || 0,
  });

  const typedData = builder.buildTypedData(order, {
    isNegRisk: market?.isNegRisk || false,
    isYieldBearing: market?.isYieldBearing || false,
  });

  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);

  const payload = {
    data: {
      order: { ...signedOrder, hash },
      pricePerShare,
      strategy: "LIMIT",
    }
  };
  const body = JSON.stringify(payload, (_, v) => typeof v === "bigint" ? v.toString() : v);

  const res = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": "Bearer " + await getJwtTokenWithSDK(),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 100));
  }
  return (await res.json()).data;
}

async function getPredictBook(marketId) {
  const url = "https://api.predict.fun/v1/markets/" + marketId + "/orderbook";
  const res = await fetch(url, { headers: { "x-api-key": PREDICT_API_KEY } });
  if (!res.ok) throw new Error("orderbook status " + res.status);
  const json = await res.json();
  return json.data;
}

function parseDepthLevel(level) {
  const price = Number(level?.price ?? level?.[0]);
  const size = Number(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
  return { price, size };
}

function getSellLiquidity(book, minPrice) {
  const bids = Array.isArray(book?.bids) ? book.bids.map(parseDepthLevel).filter(Boolean) : [];
  const usableBids = bids.filter(bid => bid.price >= minPrice).sort((a, b) => b.price - a.price);
  const size = usableBids.reduce((sum, bid) => sum + bid.size, 0);
  return { bestPrice: usableBids[0]?.price ?? null, size };
}

// 获取订单簿买一价
async function getBestBid(marketId) {
  try {
    const book = await getPredictBook(marketId);
    const bids = book?.bids;
    if (!bids || !bids.length) {
      console.log("  ⚠️ 无买单 marketId=" + marketId);
      return null;
    }
    const bestBid = bids.map(parseDepthLevel).filter(Boolean).sort((a, b) => b.price - a.price)[0];
    const price = bestBid?.price ?? null;
    console.log("  💰 买一价: " + price + " (" + bids.length + "个买单)");
    return price;
  } catch (e) { 
    console.log("  ⚠️ getBestBid错误: " + e.message);
    return null; 
  }
}

async function rememberFilledMarkets() {
  try {
    const positions = await getPositions();
    for (const pos of positions) {
      const bal = BigInt(pos.balance || 0);
      if (bal > 0n) blockMarket(pos.market?.id ?? pos.marketId, "检测到持仓，疑似被塞订单");
    }
  } catch (e) {}
}

function hasOpenSellOrder(openOrders, marketId, tokenId) {
  return openOrders.some(order => {
    const side = String(order?.side ?? order?.order?.side ?? "").toUpperCase();
    return side === "SELL" && String(getOrderMarketId(order)) === String(marketId) && String(getOrderTokenId(order)) === String(tokenId);
  });
}

async function closeSinglePosition(pos, openOrders) {
  const marketId = getPositionMarketId(pos);
  const tokenId = getPositionTokenId(pos);
  const quantityWei = getPositionQuantityWei(pos);
  if (!marketId || !tokenId || quantityWei <= 0n) return;

  const closeKey = String(marketId) + "-" + String(tokenId);
  if (closingPositions.has(closeKey)) return;

  try {
    closingPositions.add(closeKey);
    blockMarket(marketId, "检测到持仓，停止该市场后续挂买单");

    if (hasOpenSellOrder(openOrders, marketId, tokenId)) {
      console.log("📤 已有卖单，跳过重复平仓 marketId=" + marketId);
      return;
    }

    const buyPrice = getPositionBuyPrice(pos);
    if (!buyPrice) {
      console.log("⚠️ 无法识别持仓买入价，放弃平仓 marketId=" + marketId);
      return;
    }

    const minSellPrice = Math.max(0.01, buyPrice - MAX_CLOSE_SLIPPAGE);
    const book = await getPredictBook(marketId);
    const liquidity = getSellLiquidity(book, minSellPrice);
    const quantity = Number(quantityWei) / 1e18;

    if (!liquidity.bestPrice || liquidity.size < quantity) {
      console.log("⚠️ 平仓流动性不足 marketId=" + marketId + " need=" + quantity.toFixed(4) + " have=" + liquidity.size.toFixed(4) + " min=" + minSellPrice.toFixed(3));
      return;
    }

    const sellPriceWei = BigInt(Math.floor(minSellPrice * 1e18));
    if (sellPriceWei <= 0n) return;
    const market = latestMarketsById.get(String(marketId)) ?? pos.market;
    console.log("📤 平仓限价卖 marketId=" + marketId + " qty=" + quantity.toFixed(4) + " buy=" + buyPrice.toFixed(3) + " minSell=" + minSellPrice.toFixed(3) + " bestBid=" + liquidity.bestPrice);
    await placeSellLimit(market, tokenId, sellPriceWei, quantityWei);
  } catch (e) {
    console.log("⚠️ 平仓异常 marketId=" + marketId + ":", e.message);
  } finally {
    closingPositions.delete(closeKey);
  }
}

async function positionMonitorLoop() {
  while (true) {
    if (positionMonitorRunning) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    positionMonitorRunning = true;
    try {
      const [positions, openOrders] = await Promise.all([getPositions(), getOpenOrders()]);
      await Promise.allSettled(positions.map(pos => closeSinglePosition(pos, openOrders)));
    } catch (e) {
      console.log("⚠️ 持仓监控异常:", e.message);
    } finally {
      positionMonitorRunning = false;
    }

    await new Promise(r => setTimeout(r, POSITION_MONITOR_INTERVAL_MS));
  }
}

function detectFilledTrackedOrders(openOrders) {
  const openIds = new Set(openOrders.map(getOrderId).filter(Boolean).map(String));
  for (const [orderId, info] of trackedOrders.entries()) {
    if (openIds.has(orderId)) continue;
    trackedOrders.delete(orderId);
    if (cancelingOrders.has(orderId)) {
      cancelingOrders.delete(orderId);
      continue;
    }
    blockMarket(info.marketId, "已跟踪挂单不再开放，按成交处理");
  }
}

async function monitorSingleOrder(order, openOrders, predictBidCache) {
  const orderId = getOrderId(order);
  const marketId = getOrderMarketId(order);
  const tokenId = getOrderTokenId(order);
  if (!orderId || !marketId || !tokenId) return;

  try {
    const market = latestMarketsById.get(String(marketId)) ?? order.market;
    if (blockedMarkets.has(String(marketId))) {
      await cancelOrder(orderId);
      return;
    }

    if (!market?.polymarketConditionIds?.length) {
      await cancelOrder(orderId);
      return;
    }

    const outcome = market.outcomes?.find(o => String(o.onChainId) === String(tokenId)) ?? order.outcome;
    if (!outcome) {
      await cancelOrder(orderId);
      return;
    }

    let predictBidPromise = predictBidCache.get(String(marketId));
    if (!predictBidPromise) {
      predictBidPromise = getBestBid(marketId);
      predictBidCache.set(String(marketId), predictBidPromise);
    }

    const [predictBid, polyQuote] = await Promise.all([
      predictBidPromise,
      getPolymarketQuote(market, outcome),
    ]);

    if (!polyQuote.ok) {
      await cancelOrder(orderId);
      return;
    }

    if (!predictBid || Number(predictBid) - polyQuote.price > PRICE_TOLERANCE) {
      await cancelOrder(orderId);
    }
  } catch (e) {
    console.log("⚠️ 监控异常，保守撤单:", orderId, e.message);
    await cancelOrder(orderId);
  }
}

async function monitorOpenOrders(openOrders) {
  try {
    detectFilledTrackedOrders(openOrders);
    const predictBidCache = new Map();
    await Promise.allSettled(openOrders.map(order => monitorSingleOrder(order, openOrders, predictBidCache)));
  } catch (e) {
    console.log("⚠️ 监控总异常:", e.message);
  }
}

async function monitorLoop() {
  while (true) {
    if (monitorRunning) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    monitorRunning = true;
    try {
      if (latestMarketsById.size === 0) await getMarkets();
      let openOrders;
      try {
        openOrders = await getOpenOrders(true);
      } catch (e) {
        console.log("⚠️ 获取挂单失败，使用上一轮缓存尝试撤单:", e.message);
        openOrders = latestOpenOrders;
      }
      await rememberFilledMarkets();
      await monitorOpenOrders(openOrders);
    } catch (e) {
      console.log("⚠️ 高频监控异常:", e.message);
    } finally {
      monitorRunning = false;
    }

    await new Promise(r => setTimeout(r, MONITOR_INTERVAL_MS));
  }
}

// 处理单个市场 - 独立错误处理
async function processMarket(market, amountWei, existingOrders) {
  if (blockedMarkets.has(String(market.id))) {
    console.log("  🚫 黑名单跳过: " + market.title?.slice(0,20));
    return { new: 0, skip: 1 };
  }

  if (!market.polymarketConditionIds?.length) {
    return { new: 0, skip: 1 };
  }

  if (!market.outcomes || market.outcomes.length < 2) {
    return { new: 0, skip: 0 };
  }

  // 获取买一价
  const price = await getBestBid(market.id);
  if (!price || Number(price) < MIN_BUY_PRICE || Number(price) > 0.99) {
    console.log("  ⚠️ " + market.title?.slice(0,20) + " 价格无效: " + price);
    return { new: 0, skip: 0 };
  }
  console.log("  💰 价格有效: " + price + " for " + market.title?.slice(0,20));
  const priceWei = BigInt(Math.floor(parseFloat(price) * 1e18));

  let newOrders = 0;
  let skipOrders = 0;

  for (const outcome of market.outcomes) {
    const tokenId = outcome.onChainId;
    if (!tokenId) continue;

    // 检查是否已有该方向的挂单（简化检查）
    const existing = existingOrders.find(o => {
      const marketMatch = String(o.market?.id) === String(market.id) || String(o.marketId) === String(market.id);
      const outcomeMatch = String(o.outcome?.onChainId) === String(tokenId) || String(o.tokenId) === String(tokenId) || String(o.outcomeId) === String(tokenId);
      return marketMatch && outcomeMatch;
    });

    if (existing) {
      console.log("  ⏭️ 已有挂单跳过: " + outcome.name);
      skipOrders++;
      continue;
    }

    const polyQuote = await getPolymarketQuote(market, outcome);
    if (!polyQuote.ok) {
      console.log("  ⚠️ Polymarket 跳过: " + polyQuote.reason);
      skipOrders++;
      continue;
    }

    if (Number(price) - polyQuote.price > PRICE_TOLERANCE) {
      console.log("  ⚠️ Predict买一高于Polymarket Predict=" + price + " Poly=" + polyQuote.price);
      skipOrders++;
      continue;
    }

    // 挂单
    try {
      const expireText = polyQuote.expiresAt ? " expire=" + polyQuote.expiresAt.toISOString() : "";
      console.log("  🚀 " + market.title?.slice(0,15) + " " + outcome.name + " @ " + price + " polyUsd=" + polyQuote.valueUsd.toFixed(2) + expireText);
      const order = await placeBuyLimit(market, outcome, priceWei, amountWei, polyQuote.expiresAt ?? undefined);
      const orderId = getOrderId(order);
      if (orderId) trackedOrders.set(String(orderId), { marketId: market.id, tokenId });
      newOrders++;
      console.log("  ✅ 成功");
    } catch (e) {
      if (e.message.includes("insufficient")) {
        console.log("  ⚠️ 余额不足跳过");
      } else {
        console.log("  ❌ 失败: " + e.message.slice(0,50));
      }
    }
    await new Promise(r => setTimeout(r, OUTCOME_DELAY_MS));
  }

  return { new: newOrders, skip: skipOrders };
}

// 主循环
async function main() {
  console.log("\n🤖 Predict.fun 自动做市机器人启动");
  console.log("📊 全部开放市场 | 💰 " + (ORDER_RATIO*100) + "%余额 | ⏰ 5m | 🚫过滤BTC");
  await initSDK();
  monitorLoop().catch(e => console.error("💥 高频监控停止:", e));
  positionMonitorLoop().catch(e => console.error("💥 持仓监控停止:", e));

  while (true) {
    try {
      // 1. 获取余额
      const balance = await getBalance();
      const balUsdt = Number(balance) / 1e18;
      console.log("\n💰 余额: " + balUsdt.toFixed(2) + " USDT");

      if (balance < 1n * 10n ** 18n) {
        console.log("⚠️ 余额不足，等待...");
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
        continue;
      }

      // 2. 计算挂单金额 = 余额的95%
      const amountWei = (balance * BigInt(Math.floor(ORDER_RATIO * 100))) / 100n;
      console.log("📌 每单: " + (Number(amountWei)/1e18).toFixed(2) + " USDT (余额的95%)");

      // 3. 获取市场
      const markets = await getMarkets();
      console.log("📈 市场: " + markets.length + "个");

      // 4. 获取现有挂单
      const existingOrders = await getOpenOrders();
      console.log("📋 现有: " + existingOrders.length + "单");

      // 5. 批量挂单（每个市场独立）；撤单风控由高频监控循环独立执行
      let totalNew = 0;
      let totalSkip = 0;
      let processedMarkets = 0;

      for (const market of markets) {
        try {
          const result = await processMarket(market, amountWei, existingOrders);
          totalNew += result.new;
          totalSkip += result.skip;
          processedMarkets++;
        } catch (e) {
          // 单个市场错误不影响其他
        }
        await new Promise(r => setTimeout(r, MARKET_DELAY_MS));
      }

      console.log("✅ 处理: " + processedMarkets + "市场, 新挂: " + totalNew + "单, 跳过: " + totalSkip + "单");

    } catch (e) {
      console.error("❌ 主循环错误:", e.message);
    }

    console.log("⏳ 5分钟后继续...\n");
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch(e => {
  console.error("💥 致命错误:", e);
  process.exit(1);
});
