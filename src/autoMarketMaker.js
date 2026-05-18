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
const START_TIME_REFRESH_INTERVAL_MS = 60_000; // 低频刷新开赛时间
const MARKET_DELAY_MS = 1_000; // 每个市场之间等待1秒
const OUTCOME_DELAY_MS = 500; // 同一市场每个outcome之间等待500ms
const MARKET_PAGE_SIZE = 100; // 分页拉取全部开放市场
const MIN_BUY_PRICE = 0.25; // 低于25不挂买单
const POLY_MIN_BID_USD = 200; // Polymarket 买一金额低于该值不挂/撤单
const PRICE_TOLERANCE = 0.001; // Predict 高于 Polymarket 时允许的误差
const MAX_CLOSE_SLIPPAGE = 0.03; // 平仓最多接受3个价差
const MIN_ORDER_VALUE_USD = 1; // Predict 最小下单金额
const EXPIRE_BEFORE_START_MS = 15 * 60 * 1000; // 开赛前15分钟订单失效
const EXPIRE_BEFORE_REWARD_END_MS = 60 * 1000; // 积分结束前1分钟订单失效/撤单
const POLY_MARKET_CACHE_TTL_MS = 30_000; // PM市场缓存30秒，避免错过开赛时间更新
const BLOCKED_MARKETS_FILE = "blockedMarkets.json";
const VOLATILE_MARKET_KEYWORDS = [
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "solana",
  "sol",
  "xrp",
  "doge",
  "dogecoin",
  "litecoin",
  "ltc",
  "crypto",
  "cryptocurrency",
];
const COMPANY_RANKING_KEYWORDS = ["largest company", "market cap", "market capitalization", "most valuable company"];
const POLITICAL_MARKET_KEYWORDS = [
  "politic",
  "election",
  "president",
  "prime minister",
  "government",
  "parliament",
  "congress",
  "senate",
  "supreme court",
  "trump",
  "biden",
  "iran",
  "israel",
  "gaza",
  "ukraine",
  "russia",
  "china",
  "taiwan",
  "pahlavi",
];
const MACRO_POLICY_KEYWORDS = [
  "fed rate",
  "interest rate",
  "rate hike",
  "rate cut",
  "fed funds",
  "fomc",
  "powell",
  "inflation",
  "cpi",
  "central bank",
];

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
let latestActiveRewardMarketIds = new Set();
let latestActiveRewardMarketsFetchedAt = 0;
const latestStartTimesByMarketId = new Map();
let latestOpenOrders = [];
let monitorRunning = false;
let positionMonitorRunning = false;
let startTimeRefreshRunning = false;
const closingPositions = new Set();
let monitorLoopCount = 0;
let positionMonitorLoopCount = 0;
let startTimeRefreshLoopCount = 0;

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

function parseDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function hasKeyword(text, keyword) {
  return new RegExp("(^|[^a-z0-9])" + keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)").test(text);
}

function hasCompanyRankingPattern(text) {
  return COMPANY_RANKING_KEYWORDS.some(keyword => text.includes(keyword));
}

function getPoliticalKeyword(text) {
  return POLITICAL_MARKET_KEYWORDS.find(keyword => hasKeyword(text, keyword));
}

function getMacroPolicyKeyword(text) {
  return MACRO_POLICY_KEYWORDS.find(keyword => text.includes(keyword));
}

function getBlockedMarketReason(market) {
  const text = [market?.categorySlug, market?.marketVariant, market?.title, market?.question]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (hasCompanyRankingPattern(text)) return "公司/市值排名市场";
  const politicalKeyword = getPoliticalKeyword(text);
  if (politicalKeyword) return "政治/地缘政治关键词: " + politicalKeyword;
  const macroKeyword = getMacroPolicyKeyword(text);
  if (macroKeyword) return "宏观利率/央行关键词: " + macroKeyword;
  if (hasKeyword(text, "hit") || hasKeyword(text, "launch") || hasKeyword(text, "token") || text.includes("$") || text.includes("￥") || text.includes("¥") || text.includes("＄")) {
    return "波动市场关键词: hit/launch/token/货币符号";
  }
  const keyword = VOLATILE_MARKET_KEYWORDS.find(word => hasKeyword(text, word));
  if (!keyword) return null;
  return "波动市场关键词: " + keyword;
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

function getOrderSide(order) {
  return String(order?.side ?? order?.order?.side ?? "").toUpperCase();
}

function logCancelCondition(condition, details) {
  console.log("📌 命中撤单条件:", condition, details || "");
}

function getFirstValidDate(values) {
  for (const value of values) {
    const date = parseDateValue(value);
    if (date) return date;
  }
  return null;
}

function getEarliestDate(values) {
  return values.filter(Boolean).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

function parseOrderPrice(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "bigint") return Number(value) / 1e18;
  const text = String(value);
  const price = Number(text);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (price <= 1) return price;
  if (/^\d+$/.test(text) && text.length > 9) return price / 1e18;
  return null;
}

function getOrderPrice(order) {
  const candidates = [
    order?.price,
    order?.pricePerShare,
    order?.order?.pricePerShare,
  ];

  for (const value of candidates) {
    const price = parseOrderPrice(value);
    if (price) return price;
  }

  const makerAmount = Number(order?.order?.makerAmount ?? order?.makerAmount);
  const takerAmount = Number(order?.order?.takerAmount ?? order?.takerAmount);
  if (Number.isFinite(makerAmount) && Number.isFinite(takerAmount) && makerAmount > 0 && takerAmount > 0) {
    return makerAmount / takerAmount;
  }

  return null;
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

// 获取全部活跃市场（按成交量排序，过滤波动市场）
async function getMarkets() {
  try {
    const markets = [];
    const activeRewardMarketIds = new Set();
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
        activeRewardMarketIds.add(String(market.id));
        if (!getBlockedMarketReason(market) && market.polymarketConditionIds?.length) {
          markets.push(market);
        }
      }

      if (!json.cursor || pageMarkets.length === 0) break;
      after = json.cursor;
    }

    latestActiveRewardMarketIds = activeRewardMarketIds;
    latestActiveRewardMarketsFetchedAt = Date.now();
    for (const market of markets) latestMarketsById.set(String(market.id), market);
    return markets;
  } catch (e) {
    console.log("⚠️ 获取市场失败:", e.message);
    return [];
  }
}

async function getPolymarketMarket(conditionId, options = {}) {
  const cached = polyMarketCache.get(conditionId);
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < POLY_MARKET_CACHE_TTL_MS) {
    return cached.market;
  }

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
        polyMarketCache.set(conditionId, { market, fetchedAt: Date.now() });
        return market;
      }
    } catch (e) {}
  }

  polyMarketCache.set(conditionId, { market: null, fetchedAt: Date.now() });
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
  return getFirstValidDate([
    polyMarket?.gameStartTime,
    polyMarket?.eventStartTime,
    polyMarket?.startTime,
    polyMarket?.events?.[0]?.startTime,
    polyMarket?.events?.[0]?.eventDate,
  ]);
}

function getPredictStartAt(market) {
  return getFirstValidDate([
    market?.gameStartTime,
    market?.eventStartTime,
    market?.startTime,
    market?.events?.[0]?.startTime,
    market?.events?.[0]?.eventDate,
  ]);
}

function getRewardEndsAt(market) {
  return getFirstValidDate([
    market?.rewards?.current?.endsAt,
    market?.boostEndsAt,
  ]);
}

function getRewardCancelAt(market) {
  const rewardEndsAt = getRewardEndsAt(market);
  return rewardEndsAt ? new Date(rewardEndsAt.getTime() - EXPIRE_BEFORE_REWARD_END_MS) : null;
}

function getRewardEndingReason(market) {
  const rewardEndsAt = getRewardEndsAt(market);
  const cancelAt = getRewardCancelAt(market);
  if (!rewardEndsAt || !cancelAt || cancelAt.getTime() > Date.now()) return null;
  return "积分即将结束 endsAt=" + rewardEndsAt.toISOString() + " cancelAt=" + cancelAt.toISOString();
}

function getKnownMarketStartInfo(market) {
  const candidates = [];
  const cached = latestStartTimesByMarketId.get(String(market?.id));
  if (cached?.startsAt) candidates.push(cached);

  const predictStartsAt = getPredictStartAt(market);
  if (predictStartsAt) candidates.push({ startsAt: predictStartsAt, source: "Predict" });

  return candidates.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null;
}

function rememberMarketStart(marketId, startsAt, source, conditionId) {
  if (!marketId || !startsAt) return;
  const key = String(marketId);
  const current = latestStartTimesByMarketId.get(key);
  if (current && current.startsAt.getTime() <= startsAt.getTime()) return;
  latestStartTimesByMarketId.set(key, { startsAt, source, conditionId, updatedAt: new Date() });
}

function getMarketStartedReason(market) {
  const info = getKnownMarketStartInfo(market);
  if (!info || info.startsAt.getTime() > Date.now()) return null;
  return "已开赛 source=" + info.source + " startsAt=" + info.startsAt.toISOString();
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
    rememberMarketStart(market.id, startsAt, "Polymarket", conditionId);
    if (isSportsLikeMarket(market) && !startsAt) {
      return { ok: false, reason: "运动/电竞市场缺少开赛时间" };
    }

    const startExpiresAt = startsAt ? new Date(startsAt.getTime() - EXPIRE_BEFORE_START_MS) : null;
    if (startExpiresAt && startExpiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: "已接近开赛" };
    }

    const rewardCancelAt = getRewardCancelAt(market);
    if (rewardCancelAt && rewardCancelAt.getTime() <= Date.now()) {
      return { ok: false, reason: getRewardEndingReason(market) || "积分即将结束" };
    }

    const expiresAt = getEarliestDate([startExpiresAt, rewardCancelAt]);

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
async function cancelOrder(orderId, reason) {
  const key = String(orderId);
  if (cancelingOrders.has(key)) return;
  cancelingOrders.add(key);
  try {
    const jwt = await getJwtTokenWithSDK();
    const res = await fetch("https://api.predict.fun/v1/orders/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PREDICT_API_KEY,
        "Authorization": "Bearer " + jwt,
      },
      body: JSON.stringify({ data: { ids: [String(orderId)] } }),
    });
    if (!res.ok) throw new Error("remove status " + res.status + " " + (await res.text()).slice(0, 100));
    console.log("🧯 已撤单:", orderId, reason || "");
  } catch (e) {
    cancelingOrders.delete(key);
    console.log("⚠️ 撤单失败:", orderId, reason || "", e.message);
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

async function placeSellMarketSmall(market, tokenId, quantityWei, book) {
  const builder = await initSDK();

  const { pricePerShare, makerAmount, takerAmount, slippageBps } = builder.getMarketOrderAmounts({
    side: Side.SELL,
    quantityWei,
  }, book);

  const order = builder.buildOrder("MARKET", {
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
      strategy: "MARKET",
      slippageBps,
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

function getOutcomePosition(market, outcome) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const byToken = outcomes.findIndex(item => String(item.onChainId) === String(outcome?.onChainId));
  if (byToken >= 0) return byToken;

  const indexSetIndex = Number(outcome?.indexSet) - 1;
  if (indexSetIndex >= 0) return indexSetIndex;

  return null;
}

function invertBinaryPrice(price) {
  if (!Number.isFinite(Number(price))) return null;
  return Number((1 - Number(price)).toFixed(6));
}

function getBestPredictBidFromBook(book, market, outcome) {
  const bids = Array.isArray(book?.bids) ? book.bids.map(parseDepthLevel).filter(Boolean) : [];
  const bestBid = bids.sort((a, b) => b.price - a.price)[0]?.price ?? null;
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) return invertBinaryPrice(getBestPredictAskFromBook(book));
  return bestBid;
}

function getBestPredictAskFromBook(book, market, outcome) {
  const asks = Array.isArray(book?.asks) ? book.asks.map(parseDepthLevel).filter(Boolean) : [];
  const bestAsk = asks.sort((a, b) => a.price - b.price)[0]?.price ?? null;
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) return invertBinaryPrice(getBestPredictBidFromBook(book));
  return bestAsk;
}

function getSellLiquidity(book, minPrice) {
  const bids = Array.isArray(book?.bids) ? book.bids.map(parseDepthLevel).filter(Boolean) : [];
  const usableBids = bids.filter(bid => bid.price >= minPrice).sort((a, b) => b.price - a.price);
  const size = usableBids.reduce((sum, bid) => sum + bid.size, 0);
  return { bestPrice: usableBids[0]?.price ?? null, size };
}

function getOutcomeSellLiquidity(book, market, outcome, minPrice) {
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) {
    const asks = Array.isArray(book?.asks) ? book.asks.map(parseDepthLevel).filter(Boolean) : [];
    const usableAsks = asks
      .map(ask => ({ price: invertBinaryPrice(ask.price), size: ask.size }))
      .filter(ask => ask.price !== null && ask.price >= minPrice)
      .sort((a, b) => b.price - a.price);
    const size = usableAsks.reduce((sum, ask) => sum + ask.size, 0);
    return { bestPrice: usableAsks[0]?.price ?? null, size };
  }

  return getSellLiquidity(book, minPrice);
}

function getOutcomeMarketBook(book, market, outcome) {
  const position = getOutcomePosition(market, outcome);
  if (position !== 1 || market?.outcomes?.length !== 2) return book;

  const bids = Array.isArray(book?.asks)
    ? book.asks.map(parseDepthLevel).filter(Boolean).map(ask => [invertBinaryPrice(ask.price), ask.size]).filter(([price]) => price !== null).sort((a, b) => b[0] - a[0])
    : [];
  const asks = Array.isArray(book?.bids)
    ? book.bids.map(parseDepthLevel).filter(Boolean).map(bid => [invertBinaryPrice(bid.price), bid.size]).filter(([price]) => price !== null).sort((a, b) => a[0] - b[0])
    : [];

  return { ...book, bids, asks };
}

function roundSellPriceWei(price) {
  const cents = Math.ceil(price * 100 - 1e-9);
  return BigInt(cents) * 10n ** 16n;
}

function roundBuyPriceWei(price) {
  const cents = Math.floor(price * 100 + 1e-9);
  return BigInt(cents) * 10n ** 16n;
}

// 获取订单簿买一价
async function getBestBid(marketId, market, outcome) {
  try {
    const book = await getPredictBook(marketId);
    return getBestPredictBidFromBook(book, market, outcome);
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
    const market = latestMarketsById.get(String(marketId)) ?? pos.market;
    const outcome = market?.outcomes?.find(item => String(item.onChainId) === String(tokenId)) ?? pos.outcome;
    const liquidity = getOutcomeSellLiquidity(book, market, outcome, minSellPrice);
    const quantity = Number(quantityWei) / 1e18;
    const orderValueUsd = quantity * minSellPrice;

    if (!liquidity.bestPrice || liquidity.size < quantity) {
      console.log("⚠️ 平仓流动性不足 marketId=" + marketId + " need=" + quantity.toFixed(4) + " have=" + liquidity.size.toFixed(4) + " min=" + minSellPrice.toFixed(3));
      return;
    }

    if (orderValueUsd < MIN_ORDER_VALUE_USD) {
      const marketBook = getOutcomeMarketBook(book, market, outcome);
      console.log("📤 小额持仓市价卖 marketId=" + marketId + " qty=" + quantity.toFixed(4) + " minSell=" + minSellPrice.toFixed(3) + " value=" + orderValueUsd.toFixed(4) + " minValue=" + MIN_ORDER_VALUE_USD + " bestBid=" + liquidity.bestPrice);
      await placeSellMarketSmall(market, tokenId, quantityWei, marketBook);
      return;
    }

    const sellPriceWei = roundSellPriceWei(minSellPrice);
    if (sellPriceWei <= 0n) return;
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
      positionMonitorLoopCount++;
      if (positionMonitorLoopCount % 10 === 1) {
        console.log("🫀 持仓监控运行中 positions=" + positions.length + " openOrders=" + openOrders.length);
      }
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
    const marketTitle = market?.question || market?.title || order?.market?.question || order?.market?.title || "";
    const orderSide = getOrderSide(order);
    const orderPrice = getOrderPrice(order);

    const blockedReason = getBlockedMarketReason(market ?? order.market);
    if (blockedReason) {
      blockMarket(marketId, blockedReason + " title=" + marketTitle);
      logCancelCondition("getBlockedMarketReason(market)", "marketId=" + marketId + " reason=" + blockedReason + " title=" + marketTitle);
      await cancelOrder(orderId, blockedReason + " marketId=" + marketId + " title=" + marketTitle);
      return;
    }

    if (latestActiveRewardMarketsFetchedAt && !latestActiveRewardMarketIds.has(String(marketId))) {
      logCancelCondition("!latestActiveRewardMarketIds.has(String(marketId))", "marketId=" + marketId + " title=" + marketTitle);
      await cancelOrder(orderId, "市场不在活跃积分列表 marketId=" + marketId + " title=" + marketTitle);
      return;
    }

    const rewardEndingReason = getRewardEndingReason(market ?? order.market);
    if (rewardEndingReason) {
      logCancelCondition("getRewardEndingReason(market)", "marketId=" + marketId + " " + rewardEndingReason + " title=" + marketTitle);
      await cancelOrder(orderId, rewardEndingReason + " marketId=" + marketId + " title=" + marketTitle);
      return;
    }

    const startedReason = getMarketStartedReason(market);
    if (startedReason) {
      logCancelCondition("getMarketStartedReason(market)", "marketId=" + marketId + " " + startedReason + " title=" + marketTitle);
      await cancelOrder(orderId, startedReason + " marketId=" + marketId + " title=" + marketTitle);
      return;
    }

    if (blockedMarkets.has(String(marketId))) {
      logCancelCondition("blockedMarkets.has(String(marketId))", "marketId=" + marketId + " title=" + marketTitle);
      await cancelOrder(orderId, "市场在黑名单 marketId=" + marketId + " title=" + marketTitle);
      return;
    }

    if (!market?.polymarketConditionIds?.length) {
      logCancelCondition("!market?.polymarketConditionIds?.length", "marketId=" + marketId + " title=" + marketTitle + " orderSide=" + orderSide + " orderPrice=" + orderPrice);
      await cancelOrder(orderId, "缺少Polymarket映射 marketId=" + marketId + " title=" + marketTitle + " orderSide=" + orderSide + " orderPrice=" + orderPrice);
      return;
    }

    const outcome = market.outcomes?.find(o => String(o.onChainId) === String(tokenId)) ?? order.outcome;
    if (!outcome) {
      logCancelCondition("!outcome", "marketId=" + marketId + " tokenId=" + tokenId + " title=" + marketTitle);
      await cancelOrder(orderId, "找不到outcome marketId=" + marketId + " tokenId=" + tokenId + " title=" + marketTitle);
      return;
    }

    const predictBidCacheKey = String(marketId) + "-" + String(tokenId);
    let predictBidPromise = predictBidCache.get(predictBidCacheKey);
    if (!predictBidPromise) {
      predictBidPromise = getBestBid(marketId, market, outcome);
      predictBidCache.set(predictBidCacheKey, predictBidPromise);
    }

    const [predictBid, polyQuote] = await Promise.all([
      predictBidPromise,
      getPolymarketQuote(market, outcome),
    ]);

    if (!polyQuote.ok) {
      logCancelCondition("!polyQuote.ok", "marketId=" + marketId + " outcome=" + outcome.name + " reason=" + polyQuote.reason + " predictBid=" + predictBid + " title=" + marketTitle);
      await cancelOrder(orderId, "Polymarket校验失败 marketId=" + marketId + " outcome=" + outcome.name + " reason=" + polyQuote.reason + " predictBid=" + predictBid + " title=" + marketTitle);
      return;
    }

    if (orderSide === "BUY" && orderPrice && predictBid && Number(predictBid) - orderPrice > PRICE_TOLERANCE) {
      logCancelCondition("orderSide === BUY && orderPrice && predictBid && Number(predictBid) - orderPrice > PRICE_TOLERANCE", "marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictBid=" + predictBid + " diff=" + (Number(predictBid) - orderPrice) + " tolerance=" + PRICE_TOLERANCE + " title=" + marketTitle);
      await cancelOrder(orderId, "买单已不是买一 marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictBid=" + predictBid + " diff=" + (Number(predictBid) - orderPrice) + " tolerance=" + PRICE_TOLERANCE + " title=" + marketTitle);
      return;
    }

    if (!predictBid || Number(predictBid) - polyQuote.price > PRICE_TOLERANCE) {
      const diff = predictBid ? Number(predictBid) - polyQuote.price : null;
      logCancelCondition("!predictBid || Number(predictBid) - polyQuote.price > PRICE_TOLERANCE", "marketId=" + marketId + " outcome=" + outcome.name + " predictBid=" + predictBid + " polyBid=" + polyQuote.price + " diff=" + diff + " tolerance=" + PRICE_TOLERANCE + " polyUsd=" + polyQuote.valueUsd.toFixed(2) + " title=" + marketTitle);
      await cancelOrder(orderId, "价格风控 marketId=" + marketId + " outcome=" + outcome.name + " predictBid=" + predictBid + " polyBid=" + polyQuote.price + " diff=" + diff + " tolerance=" + PRICE_TOLERANCE + " polyUsd=" + polyQuote.valueUsd.toFixed(2) + " title=" + marketTitle);
      return;
    }

  } catch (e) {
    logCancelCondition("monitorSingleOrder catch", "marketId=" + marketId + " tokenId=" + tokenId + " error=" + e.message);
    await cancelOrder(orderId, "监控异常 marketId=" + marketId + " tokenId=" + tokenId + " error=" + e.message);
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
      monitorLoopCount++;
      if (monitorLoopCount % 10 === 1) {
        console.log("🛰️ 挂单监控运行中 openOrders=" + openOrders.length + " tracked=" + trackedOrders.size + " blocked=" + blockedMarkets.size);
      }
      await monitorOpenOrders(openOrders);
    } catch (e) {
      console.log("⚠️ 高频监控异常:", e.message);
    } finally {
      monitorRunning = false;
    }

    await new Promise(r => setTimeout(r, MONITOR_INTERVAL_MS));
  }
}

async function refreshStartTimes() {
  const markets = [...latestMarketsById.values()];
  if (!markets.length) return;

  let refreshed = 0;
  for (const market of markets) {
    const predictStartsAt = getPredictStartAt(market);
    rememberMarketStart(market.id, predictStartsAt, "Predict");

    for (const conditionId of market.polymarketConditionIds || []) {
      const polyMarket = await getPolymarketMarket(conditionId, { forceRefresh: true });
      const polyStartsAt = getPolymarketStartAt(polyMarket);
      rememberMarketStart(market.id, polyStartsAt, "Polymarket", conditionId);
      if (polyStartsAt) refreshed++;
    }

    await new Promise(r => setTimeout(r, 100));
  }

  startTimeRefreshLoopCount++;
  if (startTimeRefreshLoopCount % 5 === 1) {
    console.log("⏱️ 开赛时间刷新 markets=" + markets.length + " pmStarts=" + refreshed + " known=" + latestStartTimesByMarketId.size);
  }
}

async function startTimeRefreshLoop() {
  while (true) {
    if (startTimeRefreshRunning) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    startTimeRefreshRunning = true;
    try {
      if (latestMarketsById.size === 0) await getMarkets();
      await refreshStartTimes();
    } catch (e) {
      console.log("⚠️ 开赛时间刷新异常:", e.message);
    } finally {
      startTimeRefreshRunning = false;
    }

    await new Promise(r => setTimeout(r, START_TIME_REFRESH_INTERVAL_MS));
  }
}

// 处理单个市场 - 独立错误处理
async function processMarket(market, amountWei, existingOrders) {
  if (blockedMarkets.has(String(market.id))) {
    return { new: 0, skip: 1 };
  }

  const blockedReason = getBlockedMarketReason(market);
  if (blockedReason) {
    blockMarket(market.id, blockedReason + " title=" + (market.question || market.title || ""));
    return { new: 0, skip: 1 };
  }

  if (getRewardEndingReason(market)) {
    return { new: 0, skip: 1 };
  }

  if (getMarketStartedReason(market)) {
    return { new: 0, skip: 1 };
  }

  if (!market.polymarketConditionIds?.length) {
    return { new: 0, skip: 1 };
  }

  if (!market.outcomes || market.outcomes.length < 2) {
    return { new: 0, skip: 0 };
  }

  let predictBook;
  try {
    predictBook = await getPredictBook(market.id);
  } catch (e) {
    return { new: 0, skip: 0 };
  }

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
      skipOrders++;
      continue;
    }

    const polyQuote = await getPolymarketQuote(market, outcome);
    if (!polyQuote.ok) {
      skipOrders++;
      continue;
    }

    const predictBid = getBestPredictBidFromBook(predictBook, market, outcome);
    const predictAsk = getBestPredictAskFromBook(predictBook, market, outcome);

    const price = predictBid ? Math.max(Number(predictBid), polyQuote.price) : polyQuote.price;
    if (price < MIN_BUY_PRICE || price > 0.99) {
      skipOrders++;
      continue;
    }

    if (predictAsk && predictAsk <= price + 1e-9) {
      skipOrders++;
      continue;
    }

    if (predictBid && Number(predictBid) - polyQuote.price > PRICE_TOLERANCE) {
      skipOrders++;
      continue;
    }

    const priceWei = roundBuyPriceWei(price);
    if (priceWei <= 0n) {
      skipOrders++;
      continue;
    }

    // 挂单
    try {
      const order = await placeBuyLimit(market, outcome, priceWei, amountWei, polyQuote.expiresAt ?? undefined);
      const orderId = getOrderId(order);
      if (orderId) trackedOrders.set(String(orderId), { marketId: market.id, tokenId });
      newOrders++;
      console.log("  ✅ 挂单成功 marketId=" + market.id + " outcome=" + outcome.name + " price=" + price);
    } catch (e) {
      if (e.message.includes("insufficient")) {
        console.log("  ⚠️ 挂单失败 marketId=" + market.id + " outcome=" + outcome.name + " reason=余额不足");
      } else {
        console.log("  ❌ 挂单失败 marketId=" + market.id + " outcome=" + outcome.name + " error=" + e.message.slice(0,50));
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
  startTimeRefreshLoop().catch(e => console.error("💥 开赛时间刷新停止:", e));

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
