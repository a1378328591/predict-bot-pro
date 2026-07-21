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
const ORDER_RATIO = 0.99; // 使用余额的99%
const MAX_ORDER_USD = 800; // 单笔买单最多使用金额
const CHECK_INTERVAL_MS = 3 * 60_000; // 3分钟执行一轮挂单
const HOURLY_CANCEL_INTERVAL_MS = 15 * 60_000; // 每15分钟撤掉现有挂单，避免长期排队被顶在后面
const MONITOR_INTERVAL_MS = 3_000; // 高频撤单监控
const POSITION_MONITOR_INTERVAL_MS = 3_000; // 高频持仓平仓监控
const START_TIME_REFRESH_INTERVAL_MS = 60_000; // 低频刷新开赛时间
const MARKET_DELAY_MS = 100; // 每个市场之间等待100ms
const OUTCOME_DELAY_MS = 50; // 同一市场每个outcome之间等待50ms
const MARKET_PAGE_SIZE = 100; // 分页拉取全部开放市场
const MIN_BUY_PRICE = 0.30; // 价格低于30不挂买单
const POLY_MIN_BID_USD = 100; // Polymarket 买一金额低于该值不挂/撤单
const MIN_REWARD_HOURLY_RATE = 30; // Predict 积分每小时低于该值不挂/撤单，设为0则不限制
const PRICE_TOLERANCE = 0.001; // Predict 高于 Polymarket 时允许的误差
const MAX_REWARD_SPREAD = 0.06; // PR积分要求买一/卖一点差不超过6个点
const MAX_CLOSE_SLIPPAGE = 0.03; // 平仓最多接受3个价差
const MIN_ORDER_VALUE_USD = 1; // Predict 最小下单金额
const MIN_BUY_SHARES = 100; // 本次买单份额低于100不挂，等于100可挂
const SELL_ORDER_REPRICE_THRESHOLD = 0.01; // 卖单高于成本、且买一低于成本至少1个点时撤单重挂
const MIN_REWARD_SELL_SHARES = 100; // 卖单达到100份才有积分奖励
const MIN_REWARD_SELL_QUANTITY_WEI = BigInt(MIN_REWARD_SELL_SHARES) * 10n ** 18n;
const EXPIRE_BEFORE_START_MS = 15 * 60 * 1000; // 开赛前15分钟订单失效
const CLOSE_BEFORE_START_MS = 20 * 60 * 1000; // 开赛前20分钟持仓按原逻辑退出，允许亏损
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
  "model",
  "IPO",
  "OpenAI",
  "ipo",
  "openai",
  "o/u",
  "-1.5",
  "-2.5",
  "-3.5",
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
const categoryCache = new Map();
const trackedOrders = new Map();
const cancelingOrders = new Set();
const cancelledStaleSellOrderIds = new Set();
const blockedMarkets = loadBlockedMarkets();
const latestMarketsById = new Map();
let latestActiveRewardMarketIds = new Set();
let latestActiveRewardMarketsFetchedAt = 0;
const latestStartTimesByMarketId = new Map();
let latestOpenOrders = [];
let latestOpenOrdersFetchedAt = 0;
let monitorRunning = false;
let hourlyCancelRunning = false;
let positionMonitorRunning = false;
let startTimeRefreshRunning = false;
let positionsResponseLogged = false;
const closingPositions = new Set();
const pendingCloseOrders = new Map();
const lastRewardSellPositionQuantities = new Map();
const MIN_POSITION_CLOSE_QUANTITY_WEI = 1n * 10n ** 18n;
let monitorLoopCount = 0;
let hourlyCancelLoopCount = 0;
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

async function getMarketCategory(categorySlug) {
  if (!categorySlug) return null;
  const key = String(categorySlug);
  if (categoryCache.has(key)) return categoryCache.get(key);

  try {
    const res = await fetch("https://api.predict.fun/v1/categories/" + encodeURIComponent(key), {
      headers: { "x-api-key": PREDICT_API_KEY },
    });
    if (!res.ok) throw new Error("category status " + res.status);
    const json = await res.json();
    const category = json.data ?? null;
    categoryCache.set(key, category);
    return category;
  } catch (e) {
    categoryCache.set(key, null);
    console.log("⚠️ 获取市场分类失败:", key, e.message);
    return null;
  }
}

function getPoliticalTagReason(category) {
  const tags = Array.isArray(category?.tags) ? category.tags : [];
  const tag = tags.find(item => normalizeName(item?.name) === "politics");
  if (!tag) return null;
  return "政治类市场 tag=" + tag.name;
}

async function getBlockedMarketReason(market) {
  const category = await getMarketCategory(market?.categorySlug);
  const tagReason = getPoliticalTagReason(category);
  if (tagReason) return tagReason;

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
  return order?.market?.id ?? order?.marketId ?? order?.order?.marketId;
}

function getOrderTokenId(order) {
  return order?.outcome?.onChainId ?? order?.tokenId ?? order?.order?.tokenId ?? order?.outcomeTokenId ?? order?.outcome?.tokenId ?? order?.outcomeId;
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

function logCancelCondition(condition, details) {
  console.log("📌 命中撤单条件:", condition, details || "");
}

function logElapsed(action, startedAt, details) {
  console.log("⏱️ " + action + "耗时:", (Date.now() - startedAt) + "ms", details || "");
}

function safeJson(value, maxLength = 1200) {
  try {
    const text = JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
    if (!text) return "";
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
  } catch (e) {
    return "[unserializable: " + e.message + "]";
  }
}

function getArraySummary(value) {
  if (!Array.isArray(value)) return { type: typeof value, length: null, sample: value ?? null };
  return { type: "array", length: value.length, sample: value.slice(0, 3) };
}

function logOrderbookDiagnostics(reason, market, outcome, book) {
  const position = getOutcomePosition(market, outcome);
  const summary = {
    reason,
    marketId: market?.id,
    outcome: outcome?.name,
    tokenId: outcome?.onChainId,
    outcomeId: outcome?.id,
    position,
    outcomesLength: Array.isArray(market?.outcomes) ? market.outcomes.length : null,
    bookKeys: Object.keys(book || {}),
    bids: getArraySummary(book?.bids),
    asks: getArraySummary(book?.asks),
    rawBook: book,
  };
  console.log("🧪 orderbook诊断 " + safeJson(summary, 5000));
}

function logInsufficientCollateralDiagnostics(existingOrders, market, outcome, tokenId, details) {
  const related = existingOrders
    .filter(order => {
      const marketIds = [order?.market?.id, order?.marketId, order?.order?.marketId].filter(value => value !== undefined && value !== null).map(String);
      return marketIds.includes(String(market.id));
    })
    .slice(0, 10)
    .map(order => ({
      keys: Object.keys(order || {}),
      orderKeys: Object.keys(order?.order || {}),
      outcomeKeys: Object.keys(order?.outcome || {}),
      id: getOrderId(order),
      side: getOrderSide(order),
      marketId: getOrderMarketId(order),
      tokenId: getOrderTokenId(order),
      outcomeId: getOrderOutcomeId(order),
      price: getOrderPrice(order),
      raw: order,
    }));

  console.log("🧪 余额不足诊断 marketId=" + market.id
    + " outcome=" + outcome.name
    + " tokenId=" + tokenId
    + " request=" + safeJson(details, 2000)
    + " sameMarketOpenOrders=" + safeJson(related, 7000));
}

function formatWei(value) {
  if (value === undefined || value === null) return "";
  const wei = BigInt(value);
  const whole = wei / 10n ** 18n;
  const fraction = (wei % (10n ** 18n)).toString().padStart(18, "0").slice(0, 6);
  return whole.toString() + "." + fraction;
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
    if (getOrderSide(order) === "SELL") return takerAmount / makerAmount;
    return makerAmount / takerAmount;
  }

  return null;
}

function parseShareQuantityWei(value, rawWei = false) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "bigint") return value > 0n ? value : null;

  const text = String(value).trim();
  if (rawWei) {
    return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text) : null;
  }

  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const wholeWei = BigInt(match[1]) * 10n ** 18n;
  const fraction = (match[2] || "").slice(0, 18).padEnd(18, "0");
  const fractionWei = BigInt(fraction || "0");
  const quantityWei = wholeWei + fractionWei;
  return quantityWei > 0n ? quantityWei : null;
}

function parseOrderQuantityWei(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text) && text.length > 9) return parseShareQuantityWei(text, true);
  return parseShareQuantityWei(text);
}

function getOrderRemainingSellQuantityWei(order) {
  const rawRemainingCandidates = [
    order?.remainingQuantityWei,
    order?.remainingMakerAmount,
    order?.remainingMakerAmountWei,
    order?.order?.remainingQuantityWei,
    order?.order?.remainingMakerAmount,
    order?.order?.remainingMakerAmountWei,
  ];
  for (const value of rawRemainingCandidates) {
    const quantityWei = parseShareQuantityWei(value, true);
    if (quantityWei) return quantityWei;
  }

  const remainingQuantityCandidates = [
    order?.remainingQuantity,
    order?.remainingShares,
    order?.remainingSize,
    order?.order?.remainingQuantity,
    order?.order?.remainingShares,
    order?.order?.remainingSize,
    order?.quantity,
    order?.quantityWei,
    order?.size,
    order?.shares,
    order?.order?.quantity,
    order?.order?.quantityWei,
    order?.order?.size,
    order?.order?.shares,
  ];
  for (const value of remainingQuantityCandidates) {
    const quantityWei = parseOrderQuantityWei(value);
    if (quantityWei) return quantityWei;
  }

  const makerAmountCandidates = [order?.order?.makerAmount, order?.makerAmount];
  for (const value of makerAmountCandidates) {
    const quantityWei = parseShareQuantityWei(value, true);
    if (quantityWei) return quantityWei;
  }

  return null;
}

function getPositionMarketId(pos) {
  return pos?.market?.id ?? pos?.marketId;
}

function getPositionTokenId(pos) {
  return pos?.outcome?.onChainId ?? pos?.tokenId ?? pos?.outcomeId;
}

function getPositionOutcomeId(pos) {
  return pos?.outcome?.id ?? pos?.outcomeId;
}

function getPositionForMarketAndToken(positions, marketId, tokenId) {
  return positions.find(pos =>
    String(getPositionMarketId(pos)) === String(marketId)
    && String(getPositionTokenId(pos)) === String(tokenId)
  );
}

function getPositionQuantityWei(pos) {
  return BigInt(pos?.balance ?? pos?.amount ?? pos?.quantity ?? 0);
}

function getPositionBuyPrice(pos) {
  const averageBuyPriceUsd = Number(pos?.averageBuyPriceUsd);
  if (Number.isFinite(averageBuyPriceUsd) && averageBuyPriceUsd > 0 && averageBuyPriceUsd <= 1) return averageBuyPriceUsd;
  if (Number.isFinite(averageBuyPriceUsd) && averageBuyPriceUsd > 1 && averageBuyPriceUsd <= 100) return averageBuyPriceUsd / 100;

  const candidates = [
    pos?.averagePrice,
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

function getPositionDebugInfo(pos) {
  const priceFields = [
    "averagePrice",
    "averageBuyPriceUsd",
    "averageEntryPrice",
    "avgPrice",
    "avgEntryPrice",
    "entryPrice",
    "entryPricePerShare",
    "price",
    "costBasisPrice",
  ];
  const scalarFields = Object.fromEntries(
    Object.entries(pos || {}).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
  );
  return {
    scalarFields,
    priceCandidates: Object.fromEntries(priceFields.map(field => [field, pos?.[field]])),
    marketId: getPositionMarketId(pos),
    tokenId: getPositionTokenId(pos),
    quantityWei: getPositionQuantityWei(pos).toString(),
    outcome: pos?.outcome,
  };
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
        if (!await getBlockedMarketReason(market) && !getLowRewardRateReason(market) && market.polymarketConditionIds?.length) {
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

function getCurrentRewardHourlyRate(market) {
  const hourlyRate = Number(market?.rewards?.current?.hourlyRate);
  return Number.isFinite(hourlyRate) ? hourlyRate : null;
}

function getLowRewardRateReason(market) {
  if (MIN_REWARD_HOURLY_RATE <= 0) return null;
  const hourlyRate = getCurrentRewardHourlyRate(market);
  if (hourlyRate === null || hourlyRate >= MIN_REWARD_HOURLY_RATE) return null;
  return "积分过低 hourlyRate=" + hourlyRate + " min=" + MIN_REWARD_HOURLY_RATE;
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

function getCloseUrgencyReason(market) {
  const info = getKnownMarketStartInfo(market);
  if (!info) return null;
  if (info.startsAt.getTime() <= Date.now()) return "已开赛 source=" + info.source + " startsAt=" + info.startsAt.toISOString();
  const closeAt = new Date(info.startsAt.getTime() - CLOSE_BEFORE_START_MS);
  if (closeAt.getTime() > Date.now()) return null;
  return "开赛不足" + (CLOSE_BEFORE_START_MS / 60_000) + "分钟 source=" + info.source + " startsAt=" + info.startsAt.toISOString() + " closeAt=" + closeAt.toISOString();
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

async function getPolymarketOutcomeBestBid(market, outcome) {
  let bestBid = null;
  for (const conditionId of market?.polymarketConditionIds || []) {
    const polyMarket = await getPolymarketMarket(conditionId);
    if (!polyMarket) continue;

    const tokenId = findPolymarketTokenId(polyMarket, outcome);
    if (!tokenId) continue;

    const bid = getBestPolymarketBid(await getPolymarketBook(tokenId));
    if (bid && (!bestBid || bid.price > bestBid.price)) bestBid = bid;
  }
  return bestBid;
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
    const orders = [];
    let after = null;
    const seenCursors = new Set();

    while (true) {
      const query = new URLSearchParams({ status: "OPEN", first: "200" });
      if (after) query.set("after", after);

      const res = await fetch("https://api.predict.fun/v1/orders?" + query.toString(), {
        headers: { "x-api-key": PREDICT_API_KEY, "Authorization": "Bearer " + jwt }
      });
      if (!res.ok) throw new Error("orders status " + res.status);
      const json = await res.json();
      const pageOrders = json.data || [];
      orders.push(...pageOrders);

      if (!json.cursor || pageOrders.length === 0) break;
      if (seenCursors.has(json.cursor)) break;
      seenCursors.add(json.cursor);
      after = json.cursor;
    }

    latestOpenOrders = orders;
    latestOpenOrdersFetchedAt = Date.now();
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
    const json = await res.json();
    if (!positionsResponseLogged) {
      positionsResponseLogged = true;
      console.log("🔎 positions接口原始响应=" + JSON.stringify(json, (_, value) => typeof value === "bigint" ? value.toString() : value));
    }
    return json.data || [];
  } catch (e) { return []; }
}

// 取消订单
async function cancelOrder(orderId, reason) {
  const key = String(orderId);
  if (cancelingOrders.has(key)) return false;
  cancelingOrders.add(key);
  try {
    const jwt = await getJwtTokenWithSDK();
    const startedAt = Date.now();
    const res = await fetch("https://api.predict.fun/v1/orders/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PREDICT_API_KEY,
        "Authorization": "Bearer " + jwt,
      },
      body: JSON.stringify({ data: { ids: [String(orderId)] } }),
    });
    logElapsed("撤单请求", startedAt, "orderId=" + orderId + " status=" + res.status);
    if (!res.ok) throw new Error("remove status " + res.status + " " + (await res.text()).slice(0, 100));
    console.log("🧯 已撤单:", orderId, reason || "");
    return true;
  } catch (e) {
    cancelingOrders.delete(key);
    console.log("⚠️ 撤单失败:", orderId, reason || "", e.message);
    return false;
  }
}

async function cancelOrders(orderIds, reason) {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))]
    .filter(id => !cancelingOrders.has(id));
  if (!ids.length) return 0;

  for (const id of ids) cancelingOrders.add(id);
  try {
    const jwt = await getJwtTokenWithSDK();
    const startedAt = Date.now();
    const res = await fetch("https://api.predict.fun/v1/orders/remove", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": PREDICT_API_KEY,
        "Authorization": "Bearer " + jwt,
      },
      body: JSON.stringify({ data: { ids } }),
    });
    logElapsed("批量撤单请求", startedAt, "count=" + ids.length + " status=" + res.status);
    if (!res.ok) throw new Error("remove status " + res.status + " " + (await res.text()).slice(0, 100));
    console.log("🧯 批量已撤单:", ids.length, reason || "");
    return ids.length;
  } catch (e) {
    for (const id of ids) cancelingOrders.delete(id);
    console.log("⚠️ 批量撤单失败:", ids.length, reason || "", e.message);
    return 0;
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

  const startedAt = Date.now();
  const res = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": "Bearer " + await getJwtTokenWithSDK(),
    },
    body,
  });
  logElapsed("挂买单请求", startedAt, "marketId=" + market.id + " tokenId=" + outcome.onChainId + " status=" + res.status);

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(text.slice(0, 300));
    error.details = {
      side: "BUY",
      marketId: market.id,
      title: market.question || market.title || "",
      outcome: outcome.name,
      tokenId: outcome.onChainId,
      status: res.status,
      priceWei: String(priceWei),
      price: formatWei(priceWei),
      amountWei: String(amountWei),
      amount: formatWei(amountWei),
      quantityWei: String(quantityWei),
      quantity: formatWei(quantityWei),
      makerAmount: String(makerAmount),
      takerAmount: String(takerAmount),
      pricePerShare: String(pricePerShare),
      response: text.slice(0, 300),
    };
    throw error;
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

  const startedAt = Date.now();
  const res = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": "Bearer " + await getJwtTokenWithSDK(),
    },
    body,
  });
  logElapsed("挂卖单请求", startedAt, "marketId=" + (market?.id ?? "") + " tokenId=" + tokenId + " status=" + res.status);

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

  const startedAt = Date.now();
  const res = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": "Bearer " + await getJwtTokenWithSDK(),
    },
    body,
  });
  logElapsed("市价卖单请求", startedAt, "marketId=" + (market?.id ?? "") + " tokenId=" + tokenId + " status=" + res.status);

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

function getMarketDecimalPrecision(market) {
  const precision = Number(market?.decimalPrecision);
  if (Number.isInteger(precision) && precision >= 0 && precision <= 18) return precision;
  return 2;
}

function getMarketPriceTickWei(market) {
  return 10n ** BigInt(18 - getMarketDecimalPrecision(market));
}

function invertBinaryPrice(price, market) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) return null;
  const factor = 10 ** getMarketDecimalPrecision(market);
  return (factor - Math.round(numericPrice * factor)) / factor;
}

function getBestPredictBidFromBook(book, market, outcome) {
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) return invertBinaryPrice(getBestDirectPredictAskFromBook(book), market);
  return getBestDirectPredictBidFromBook(book);
}

function getBestPredictAskFromBook(book, market, outcome) {
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) return invertBinaryPrice(getBestDirectPredictBidFromBook(book), market);
  return getBestDirectPredictAskFromBook(book);
}

function getBestDirectPredictBidLevelFromBook(book) {
  const bids = Array.isArray(book?.bids) ? book.bids.map(parseDepthLevel).filter(Boolean) : [];
  const bestBid = bids.sort((a, b) => b.price - a.price)[0];
  return bestBid ? { ...bestBid, valueUsd: bestBid.price * bestBid.size } : null;
}

function getBestDirectPredictAskLevelFromBook(book) {
  const asks = Array.isArray(book?.asks) ? book.asks.map(parseDepthLevel).filter(Boolean) : [];
  const bestAsk = asks.sort((a, b) => a.price - b.price)[0];
  return bestAsk ? { ...bestAsk, valueUsd: bestAsk.price * bestAsk.size } : null;
}

function getBestDirectPredictBidFromBook(book) {
  return getBestDirectPredictBidLevelFromBook(book)?.price ?? null;
}

function getBestDirectPredictAskFromBook(book) {
  return getBestDirectPredictAskLevelFromBook(book)?.price ?? null;
}

function getBestPredictBidLevelFromBook(book, market, outcome) {
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) {
    const directAsk = getBestDirectPredictAskLevelFromBook(book);
    if (!directAsk) return null;
    const price = invertBinaryPrice(directAsk.price, market);
    return price === null ? null : { price, size: directAsk.size, valueUsd: price * directAsk.size };
  }
  return getBestDirectPredictBidLevelFromBook(book);
}

function getBestPredictAskLevelFromBook(book, market, outcome) {
  const position = getOutcomePosition(market, outcome);
  if (position === 1 && market?.outcomes?.length === 2) {
    const directBid = getBestDirectPredictBidLevelFromBook(book);
    if (!directBid) return null;
    const price = invertBinaryPrice(directBid.price, market);
    return price === null ? null : { price, size: directBid.size, valueUsd: price * directBid.size };
  }
  return getBestDirectPredictAskLevelFromBook(book);
}

function getRewardEligiblePredictAskFromBook(book, market, outcome) {
  return getBestPredictAskFromBook(book, market, outcome);
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
      .map(ask => ({ price: invertBinaryPrice(ask.price, market), size: ask.size }))
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
    ? book.asks.map(parseDepthLevel).filter(Boolean).map(ask => [invertBinaryPrice(ask.price, market), ask.size]).filter(([price]) => price !== null).sort((a, b) => b[0] - a[0])
    : [];
  const asks = Array.isArray(book?.bids)
    ? book.bids.map(parseDepthLevel).filter(Boolean).map(bid => [invertBinaryPrice(bid.price, market), bid.size]).filter(([price]) => price !== null).sort((a, b) => a[0] - b[0])
    : [];

  return { ...book, bids, asks };
}

function roundSellPriceWei(price, market) {
  const precision = getMarketDecimalPrecision(market);
  const scale = 10 ** precision;
  const units = Math.ceil(price * scale - 1e-9);
  return BigInt(units) * getMarketPriceTickWei(market);
}

function roundBuyPriceWei(price, market) {
  const precision = getMarketDecimalPrecision(market);
  const scale = 10 ** precision;
  const units = Math.floor(price * scale + 1e-9);
  return BigInt(units) * getMarketPriceTickWei(market);
}

function getCloseSellPriceWei({ market, buyPrice, bestBid, bestAsk, urgentCloseReason }) {
  if (!bestAsk) return { sellPriceWei: 0n, reason: "卖一为空" };

  const buyPriceWei = roundSellPriceWei(buyPrice, market);
  const bestAskPriceWei = roundSellPriceWei(bestAsk.price, market);
  if (urgentCloseReason) {
    return { sellPriceWei: bestAskPriceWei, reason: urgentCloseReason + "，按卖一退出" };
  }

  if (bestBid) {
    const bestBidPriceWei = roundBuyPriceWei(bestBid.price, market);
    if (bestBidPriceWei >= buyPriceWei) {
      const targetPriceWei = bestBidPriceWei + getMarketPriceTickWei(market);
      const step = (Number(getMarketPriceTickWei(market)) / 1e18).toFixed(getMarketDecimalPrecision(market));
      return { sellPriceWei: targetPriceWei > 10n ** 18n ? 10n ** 18n : targetPriceWei, reason: "买一不低于成本，按买一+" + step + "挂卖" };
    }
  }

  return { sellPriceWei: buyPriceWei, reason: "买一低于成本，按成本价挂卖" };
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

async function getBestAsk(marketId, market, outcome) {
  try {
    const book = await getPredictBook(marketId);
    return getRewardEligiblePredictAskFromBook(book, market, outcome);
  } catch (e) {
    console.log("  ⚠️ getBestAsk错误: " + e.message);
    return null;
  }
}

async function rememberFilledMarkets() {
  try {
    const positions = await getPositions();
    for (const pos of positions) {
      const bal = BigInt(pos.balance || 0);
      if (bal >= MIN_POSITION_CLOSE_QUANTITY_WEI) {
        const marketId = pos.market?.id ?? pos.marketId;
        console.log("🔎 检测到持仓准备拉黑 marketId=" + marketId + " tokenId=" + getPositionTokenId(pos) + " balance=" + bal.toString());
        blockMarket(marketId, "检测到持仓，疑似被塞订单");
      }
    }
    return positions;
  } catch (e) {
    return [];
  }
}

function getOpenSellOrders(openOrders, marketId, tokenId, outcomeId) {
  return openOrders.filter(order => {
    if (getOrderSide(order) !== "SELL" || String(getOrderMarketId(order)) !== String(marketId)) return false;
    const orderTokenId = getOrderTokenId(order);
    const orderOutcomeId = getOrderOutcomeId(order);
    return (orderTokenId && String(orderTokenId) === String(tokenId)) || (outcomeId && orderOutcomeId && String(orderOutcomeId) === String(outcomeId));
  });
}

function getOpenSellCoverage(openOrders, marketId, tokenId, outcomeId) {
  const orders = getOpenSellOrders(openOrders, marketId, tokenId, outcomeId);
  let quantityWei = 0n;

  for (const order of orders) {
    const orderQuantityWei = getOrderRemainingSellQuantityWei(order);
    if (!orderQuantityWei) {
      return { orders, quantityWei: null, unknownOrderId: getOrderId(order) };
    }
    quantityWei += orderQuantityWei;
  }

  return { orders, quantityWei, unknownOrderId: null };
}

function getOpenBuyOrdersForPosition(openOrders, marketId, tokenId, outcomeId) {
  return openOrders.filter(order => {
    if (getOrderSide(order) !== "BUY" || String(getOrderMarketId(order)) !== String(marketId)) return false;
    const orderTokenId = getOrderTokenId(order);
    const orderOutcomeId = getOrderOutcomeId(order);
    return (orderTokenId && String(orderTokenId) === String(tokenId)) || (outcomeId && orderOutcomeId && String(orderOutcomeId) === String(outcomeId));
  });
}

async function resetPositionSellOrdersForUrgentClose(openOrders, marketId, tokenId, outcomeId, closeKey) {
  const sellOrders = getOpenSellOrders(openOrders, marketId, tokenId, outcomeId);
  const sellOrderIds = sellOrders.map(getOrderId).filter(Boolean);
  if (sellOrderIds.length < sellOrders.length) {
    console.log("⚠️ 紧急平仓发现无法识别ID的卖单，跳过重挂 marketId=" + marketId + " tokenId=" + tokenId);
    return false;
  }

  if (sellOrderIds.length > 0) {
    const cancelled = await cancelOrders(sellOrderIds, "开赛临近，撤当前持仓卖单后按买一全仓退出 marketId=" + marketId + " tokenId=" + tokenId);
    if (cancelled < sellOrderIds.length) {
      console.log("⚠️ 紧急平仓卖单未全部撤掉，等待下一轮 marketId=" + marketId + " tokenId=" + tokenId + " cancelled=" + cancelled + " total=" + sellOrderIds.length);
      return false;
    }
    console.log("🧯 紧急平仓已撤当前持仓卖单 marketId=" + marketId + " tokenId=" + tokenId + " orders=" + cancelled);
  }

  pendingCloseOrders.delete(closeKey);
  return true;
}

function rememberPendingCloseOrder(closeKey, order, quantityWei) {
  pendingCloseOrders.set(closeKey, { orderId: getOrderId(order), quantityWei, createdAt: Date.now() });
}

function getPendingCloseOrder(closeKey) {
  const pending = pendingCloseOrders.get(closeKey);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > 60_000) {
    pendingCloseOrders.delete(closeKey);
    return null;
  }
  return pending;
}

async function closeSinglePosition(pos, openOrders) {
  const marketId = getPositionMarketId(pos);
  const tokenId = getPositionTokenId(pos);
  const outcomeId = getPositionOutcomeId(pos);
  const quantityWei = getPositionQuantityWei(pos);
  if (!marketId || !tokenId || quantityWei <= 0n) return;
  if (quantityWei < MIN_POSITION_CLOSE_QUANTITY_WEI) {
    console.log("⏭️ 持仓份额小于1，跳过平仓 marketId=" + marketId + " tokenId=" + tokenId + " quantity=" + (Number(quantityWei) / 1e18).toFixed(4));
    return;
  }

  const closeKey = String(marketId) + "-" + String(tokenId);
  if (closingPositions.has(closeKey)) return;
  if (quantityWei < MIN_REWARD_SELL_QUANTITY_WEI) lastRewardSellPositionQuantities.delete(closeKey);

  try {
    closingPositions.add(closeKey);
    console.log("🔎 平仓监控检测到持仓准备拉黑 marketId=" + marketId + " tokenId=" + tokenId + " quantityWei=" + quantityWei.toString());
    blockMarket(marketId, "检测到持仓，停止该市场后续挂买单");

    const market = latestMarketsById.get(String(marketId)) ?? pos.market;
    const outcome = market?.outcomes?.find(item => String(item.onChainId) === String(tokenId)) ?? pos.outcome;
    if (!market || !outcome) {
      console.log("⚠️ 无法识别持仓市场或outcome，放弃平仓 marketId=" + marketId + " tokenId=" + tokenId);
      return;
    }

    const openBuyOrders = getOpenBuyOrdersForPosition(openOrders, marketId, tokenId, outcomeId);
    if (openBuyOrders.length > 0) {
      const buyOrderIds = openBuyOrders.map(getOrderId).filter(Boolean);
      const cancelled = await cancelOrders(buyOrderIds, "检测到持仓，撤对应买单 marketId=" + marketId + " tokenId=" + tokenId);
      if (cancelled < buyOrderIds.length) {
        console.log("⚠️ 检测到持仓但对应买单未全部撤掉，等待下一轮 marketId=" + marketId + " tokenId=" + tokenId + " cancelled=" + cancelled + " total=" + buyOrderIds.length);
        return;
      }
    }

    const urgentCloseReason = getCloseUrgencyReason(market);
    let closeQuantityWei;
    if (urgentCloseReason) {
      const reset = await resetPositionSellOrdersForUrgentClose(openOrders, marketId, tokenId, outcomeId, closeKey);
      if (!reset) return;
      lastRewardSellPositionQuantities.delete(closeKey);
      closeQuantityWei = quantityWei;
    } else {
      let currentOpenOrders = openOrders;
      const previousRewardSellPositionQuantityWei = lastRewardSellPositionQuantities.get(closeKey);
      const positionChangedSinceRewardSell = previousRewardSellPositionQuantityWei === undefined || previousRewardSellPositionQuantityWei !== quantityWei;
      if (quantityWei >= MIN_REWARD_SELL_QUANTITY_WEI && positionChangedSinceRewardSell) {
        const smallSellOrders = getOpenSellOrders(currentOpenOrders, marketId, tokenId, outcomeId)
          .filter(order => {
            const orderQuantityWei = getOrderRemainingSellQuantityWei(order);
            return orderQuantityWei && orderQuantityWei < MIN_REWARD_SELL_QUANTITY_WEI;
          });
        const smallSellOrderIds = smallSellOrders.map(getOrderId).filter(Boolean);

        if (smallSellOrderIds.length < smallSellOrders.length) {
          console.log("⚠️ 积分卖单整理发现无法识别ID的小卖单，等待下一轮 marketId=" + marketId + " tokenId=" + tokenId);
          return;
        }
        if (smallSellOrderIds.length > 0) {
          const cancelled = await cancelOrders(smallSellOrderIds, "持仓达到积分门槛，撤不足" + MIN_REWARD_SELL_SHARES + "份的卖单后合并重挂 marketId=" + marketId + " tokenId=" + tokenId);
          if (cancelled < smallSellOrderIds.length) {
            console.log("⚠️ 积分卖单整理未全部撤掉，等待下一轮 marketId=" + marketId + " tokenId=" + tokenId + " cancelled=" + cancelled + " total=" + smallSellOrderIds.length);
            return;
          }
          const pendingCloseOrder = getPendingCloseOrder(closeKey);
          if (pendingCloseOrder?.orderId && smallSellOrderIds.some(orderId => String(orderId) === String(pendingCloseOrder.orderId))) {
            pendingCloseOrders.delete(closeKey);
          }
          currentOpenOrders = await getOpenOrders(true);
          console.log("🧹 持仓达到积分门槛，已撤不足" + MIN_REWARD_SELL_SHARES + "份卖单并刷新OPEN marketId=" + marketId + " tokenId=" + tokenId + " orders=" + cancelled);
        }
      }

      const sellCoverage = getOpenSellCoverage(currentOpenOrders, marketId, tokenId, outcomeId);
      const pendingCloseOrder = getPendingCloseOrder(closeKey);
      if (pendingCloseOrder) {
        const pendingOrderVisible = pendingCloseOrder.orderId && sellCoverage.orders.some(order => String(getOrderId(order)) === String(pendingCloseOrder.orderId));
        if (!pendingOrderVisible) {
          console.log("⏳ 等待新卖单出现在OPEN后再计算补单 marketId=" + marketId + " tokenId=" + tokenId + " pendingQtyWei=" + pendingCloseOrder.quantityWei.toString());
          return;
        }
        pendingCloseOrders.delete(closeKey);
      }

      if (sellCoverage.quantityWei === null) {
        console.log("⚠️ 无法识别现有卖单剩余份额，为避免重复卖出而跳过补单 marketId=" + marketId + " tokenId=" + tokenId + " orderId=" + (sellCoverage.unknownOrderId || "unknown"));
        return;
      }

      closeQuantityWei = quantityWei - sellCoverage.quantityWei;
      if (sellCoverage.quantityWei > 0n && closeQuantityWei > 0n) {
        console.log("📤 现有卖单覆盖部分持仓，补挂差额 marketId=" + marketId + " tokenId=" + tokenId + " positionWei=" + quantityWei.toString() + " listedWei=" + sellCoverage.quantityWei.toString() + " remainingWei=" + closeQuantityWei.toString());
      }
    }

    if (closeQuantityWei <= 0n) return;
    if (closeQuantityWei < MIN_POSITION_CLOSE_QUANTITY_WEI) {
      console.log("⏭️ 待补卖差额小于1份，保留尾差避免最小下单/精度错误 marketId=" + marketId + " tokenId=" + tokenId + " remainingWei=" + closeQuantityWei.toString());
      return;
    }
    const buyPrice = getPositionBuyPrice(pos);
    console.log("🔎 持仓字段 marketId=" + marketId + " tokenId=" + tokenId + " info=" + JSON.stringify(getPositionDebugInfo(pos), (_, value) => typeof value === "bigint" ? value.toString() : value));
    const averageBuyPriceUsd = pos?.averageBuyPriceUsd;
    const hasZeroAverageBuyPriceUsd = averageBuyPriceUsd !== undefined && averageBuyPriceUsd !== null && averageBuyPriceUsd !== "" && Number(averageBuyPriceUsd) === 0;
    if (!buyPrice && !hasZeroAverageBuyPriceUsd) {
      console.log("⚠️ 无法识别持仓买入价，放弃平仓 marketId=" + marketId);
      return;
    }

    const book = await getPredictBook(marketId);
    if (urgentCloseReason && hasZeroAverageBuyPriceUsd) {
      const predictBid = getBestPredictBidFromBook(book, market, outcome);
      if (!predictBid || predictBid <= 0) {
        console.log("⚠️ 紧急平仓成本价为0但 Predict 买一为空，放弃平仓 marketId=" + marketId + " tokenId=" + tokenId);
        return;
      }
      const sellPriceWei = roundBuyPriceWei(predictBid, market);
      if (sellPriceWei <= 0n) return;
      console.log("📤 紧急平仓成本价为0，按 Predict 买一全仓限价卖 marketId=" + marketId + " tokenId=" + tokenId + " qty=" + (Number(closeQuantityWei) / 1e18).toFixed(4) + " reason=" + urgentCloseReason + " predictBid=" + predictBid.toFixed(6) + " sellPrice=" + (Number(sellPriceWei) / 1e18).toFixed(6));
      const sellOrder = await placeSellLimit(market, tokenId, sellPriceWei, closeQuantityWei);
      rememberPendingCloseOrder(closeKey, sellOrder, closeQuantityWei);
      return;
    }

    if (urgentCloseReason) {
      const minSellPrice = Math.max(0.01, buyPrice - MAX_CLOSE_SLIPPAGE);
      const predictBid = getBestPredictBidFromBook(book, market, outcome);
      if (!predictBid || predictBid < minSellPrice) {
        console.log("⚠️ 紧急平仓买一低于最大允许滑点，放弃平仓 marketId=" + marketId + " bid=" + (predictBid?.toFixed(6) ?? "null") + " minSell=" + minSellPrice.toFixed(6) + " reason=" + urgentCloseReason);
        return;
      }

      const sellPriceWei = roundBuyPriceWei(predictBid, market);
      if (sellPriceWei <= 0n) return;
      const sellPrice = Number(sellPriceWei) / 1e18;
      if (sellPrice < minSellPrice) {
        console.log("⚠️ 紧急平仓买一按价格精度取整后低于最大允许滑点，放弃平仓 marketId=" + marketId + " bid=" + predictBid.toFixed(6) + " sellPrice=" + sellPrice.toFixed(6) + " minSell=" + minSellPrice.toFixed(6) + " reason=" + urgentCloseReason);
        return;
      }
      console.log("📤 紧急平仓按买一全仓限价卖 marketId=" + marketId + " tokenId=" + tokenId + " qty=" + (Number(closeQuantityWei) / 1e18).toFixed(4) + " buy=" + buyPrice.toFixed(6) + " minSell=" + minSellPrice.toFixed(6) + " bestBid=" + predictBid.toFixed(6) + " sellPrice=" + sellPrice.toFixed(6) + " reason=" + urgentCloseReason);
      const sellOrder = await placeSellLimit(market, tokenId, sellPriceWei, closeQuantityWei);
      rememberPendingCloseOrder(closeKey, sellOrder, closeQuantityWei);
      return;
    }

    if (hasZeroAverageBuyPriceUsd) {
      console.log("⚠️ 持仓成本价为0，非紧急状态不挂可能吃单的卖单 marketId=" + marketId + " tokenId=" + tokenId);
      return;
    }

    const bestAsk = getBestPredictAskLevelFromBook(book, market, outcome);
    const bestBid = getBestPredictBidLevelFromBook(book, market, outcome);
    const closePrice = getCloseSellPriceWei({ market, buyPrice, bestBid, bestAsk, urgentCloseReason: null });
    const sellPriceWei = closePrice.sellPriceWei;
    if (sellPriceWei <= 0n) return;

    const sellPrice = Number(sellPriceWei) / 1e18;
    if (bestBid && Number(bestBid.price) >= sellPrice - 1e-9) {
      console.log("⚠️ 平仓价会直接吃单，放弃平仓 marketId=" + marketId + " tokenId=" + tokenId + " bid=" + Number(bestBid.price).toFixed(6) + " sellPrice=" + sellPrice.toFixed(6) + " reason=" + closePrice.reason);
      return;
    }

    console.log("📤 非紧急持仓限价卖 marketId=" + marketId + " tokenId=" + tokenId + " qty=" + (Number(closeQuantityWei) / 1e18).toFixed(4) + " buyPrice=" + buyPrice.toFixed(6) + " bid=" + (bestBid ? Number(bestBid.price).toFixed(6) : "null") + " ask=" + Number(bestAsk.price).toFixed(6) + " sellPrice=" + sellPrice.toFixed(6) + " reason=" + closePrice.reason);
    const sellOrder = await placeSellLimit(market, tokenId, sellPriceWei, closeQuantityWei);
    rememberPendingCloseOrder(closeKey, sellOrder, closeQuantityWei);
    if (quantityWei >= MIN_REWARD_SELL_QUANTITY_WEI) {
      lastRewardSellPositionQuantities.set(closeKey, quantityWei);
    }
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
    const loopStartedAt = Date.now();
    let positionsCount = 0;
    let openOrdersCount = 0;
    try {
      const [positions, openOrders] = await Promise.all([getPositions(), getOpenOrders()]);
      positionsCount = positions.length;
      openOrdersCount = openOrders.length;
      positionMonitorLoopCount++;
      if (positionMonitorLoopCount % 10 === 1) {
        console.log("🫀 持仓监控运行中 positions=" + positions.length + " openOrders=" + openOrders.length);
      }
      await Promise.allSettled(positions.map(pos => closeSinglePosition(pos, openOrders)));
    } catch (e) {
      console.log("⚠️ 持仓监控异常:", e.message);
    } finally {
      positionMonitorRunning = false;
      logElapsed("持仓监控结束", loopStartedAt, "positions=" + positionsCount + " openOrders=" + openOrdersCount);
    }

    await new Promise(r => setTimeout(r, POSITION_MONITOR_INTERVAL_MS));
  }
}

function detectFilledTrackedOrders(openOrders, openOrdersFetchedAt = 0) {
  const openIds = new Set(openOrders.map(getOrderId).filter(Boolean).map(String));
  for (const [orderId, info] of trackedOrders.entries()) {
    if (openIds.has(orderId)) {
      if (info.missingCount) {
        info.missingCount = 0;
        console.log("🧭 跟踪挂单重新出现在OPEN orderId=" + orderId + " marketId=" + info.marketId + " tokenId=" + info.tokenId);
      }
      continue;
    }

    if (info.createdAt && openOrdersFetchedAt && info.createdAt >= openOrdersFetchedAt) {
      console.log("🧭 跳过成交检测: tracked订单比OPEN快照新 orderId=" + orderId + " marketId=" + info.marketId + " tokenId=" + info.tokenId + " trackedAt=" + info.createdAt + " openFetchedAt=" + openOrdersFetchedAt);
      continue;
    }

    trackedOrders.delete(orderId);
    if (cancelingOrders.has(orderId)) {
      console.log("🧭 跟踪挂单消失但属于主动撤单 orderId=" + orderId + " marketId=" + info.marketId + " tokenId=" + info.tokenId);
      cancelingOrders.delete(orderId);
      continue;
    }

    info.missingCount = (info.missingCount || 0) + 1;
    if (info.missingCount < 2) {
      console.log("🧭 跟踪挂单首次不在OPEN，等待下轮确认 orderId=" + orderId + " marketId=" + info.marketId + " tokenId=" + info.tokenId + " openOrders=" + openOrders.length + " openFetchedAt=" + openOrdersFetchedAt);
      continue;
    }

    console.log("🔎 跟踪挂单不在OPEN，按成交处理 orderId=" + orderId + " marketId=" + info.marketId + " tokenId=" + info.tokenId + " ageMs=" + (Date.now() - (info.createdAt || Date.now())) + " openOrders=" + openOrders.length + " openFetchedAt=" + openOrdersFetchedAt);
    blockMarket(info.marketId, "已跟踪挂单不再开放，按成交处理");
  }
}

async function monitorSingleOrder(order, openOrders, predictBidCache, positions) {
  const orderId = getOrderId(order);
  const marketId = getOrderMarketId(order);
  const tokenId = getOrderTokenId(order);
  if (!orderId || !marketId || !tokenId) return;

  try {
    const market = latestMarketsById.get(String(marketId)) ?? order.market;
    const marketTitle = market?.question || market?.title || order?.market?.question || order?.market?.title || "";
    const orderSide = getOrderSide(order);
    const orderPrice = getOrderPrice(order);

    if (orderSide === "SELL") {
      if (cancelledStaleSellOrderIds.has(String(orderId))) return;

      const position = getPositionForMarketAndToken(positions, marketId, tokenId);
      const buyPrice = getPositionBuyPrice(position);
      const outcome = market?.outcomes?.find(o => String(o.onChainId) === String(tokenId)) ?? order.outcome;
      if (!market || !orderPrice || !buyPrice || !outcome) return;

      const predictBidCacheKey = String(marketId) + "-" + String(tokenId);
      let predictBidPromise = predictBidCache.get(predictBidCacheKey);
      if (!predictBidPromise) {
        predictBidPromise = getBestBid(marketId, market, outcome);
        predictBidCache.set(predictBidCacheKey, predictBidPromise);
      }
      const predictBid = await predictBidPromise;
      if (!predictBid) return;

      const sellPremium = orderPrice - buyPrice;
      const bidDrawdown = buyPrice - Number(predictBid);
      if (
        sellPremium < SELL_ORDER_REPRICE_THRESHOLD - 1e-9
        || bidDrawdown < SELL_ORDER_REPRICE_THRESHOLD - 1e-9
      ) return;

      const reason = "卖单高于成本且买一低于成本至少1点，撤单后由持仓监控按成本价重挂"
        + " marketId=" + marketId
        + " tokenId=" + tokenId
        + " orderPrice=" + orderPrice.toFixed(6)
        + " buyPrice=" + buyPrice.toFixed(6)
        + " predictBid=" + Number(predictBid).toFixed(6);
      const cancelled = await cancelOrder(orderId, reason);
      if (cancelled) cancelledStaleSellOrderIds.add(String(orderId));
      return;
    }

    const blockedReason = await getBlockedMarketReason(market ?? order.market);
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

    const lowRewardRateReason = getLowRewardRateReason(market ?? order.market);
    if (lowRewardRateReason) {
      logCancelCondition("getLowRewardRateReason(market)", "marketId=" + marketId + " " + lowRewardRateReason + " title=" + marketTitle);
      await cancelOrder(orderId, lowRewardRateReason + " marketId=" + marketId + " title=" + marketTitle);
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
    const predictAskPromise = getBestAsk(marketId, market, outcome);

    const [predictBid, predictAsk, polyQuote] = await Promise.all([
      predictBidPromise,
      predictAskPromise,
      getPolymarketQuote(market, outcome),
    ]);

    if (!polyQuote.ok) {
      logCancelCondition("!polyQuote.ok", "marketId=" + marketId + " outcome=" + outcome.name + " reason=" + polyQuote.reason + " predictBid=" + predictBid + " title=" + marketTitle);
      await cancelOrder(orderId, "Polymarket校验失败 marketId=" + marketId + " outcome=" + outcome.name + " reason=" + polyQuote.reason + " predictBid=" + predictBid + " title=" + marketTitle);
      return;
    }

    if (orderSide === "BUY" && !orderPrice) {
      logCancelCondition("orderSide === BUY && !orderPrice", "marketId=" + marketId + " outcome=" + outcome.name + " predictBid=" + predictBid + " predictAsk=" + predictAsk + " title=" + marketTitle);
      await cancelOrder(orderId, "买单价格缺失，无法校验积分点差 marketId=" + marketId + " outcome=" + outcome.name + " predictBid=" + predictBid + " predictAsk=" + predictAsk + " title=" + marketTitle);
      return;
    }

    if (orderSide === "BUY" && !predictAsk) {
      logCancelCondition("orderSide === BUY && !predictAsk", "marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictBid=" + predictBid + " ask=null title=" + marketTitle);
      await cancelOrder(orderId, "卖一为空，不符合积分点差条件 marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictBid=" + predictBid + " ask=null title=" + marketTitle);
      return;
    }

    if (orderSide === "BUY" && orderPrice && predictAsk && Number(predictAsk) - orderPrice > MAX_REWARD_SPREAD) {
      logCancelCondition("orderSide === BUY && orderPrice && predictAsk && Number(predictAsk) - orderPrice > MAX_REWARD_SPREAD", "marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictAsk=" + predictAsk + " spread=" + (Number(predictAsk) - orderPrice) + " max=" + MAX_REWARD_SPREAD + " title=" + marketTitle);
      await cancelOrder(orderId, "点差超过积分条件 marketId=" + marketId + " outcome=" + outcome.name + " orderPrice=" + orderPrice + " predictAsk=" + predictAsk + " spread=" + (Number(predictAsk) - orderPrice) + " max=" + MAX_REWARD_SPREAD + " title=" + marketTitle);
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

async function monitorOpenOrders(openOrders, openOrdersFetchedAt = 0, positions = []) {
  try {
    detectFilledTrackedOrders(openOrders, openOrdersFetchedAt);
    const predictBidCache = new Map();
    await Promise.allSettled(openOrders.map(order => monitorSingleOrder(order, openOrders, predictBidCache, positions)));
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
    const loopStartedAt = Date.now();
    let openOrdersCount = 0;
    try {
      if (latestMarketsById.size === 0) await getMarkets();
      let openOrders;
      try {
        openOrders = await getOpenOrders(true);
      } catch (e) {
        console.log("⚠️ 获取挂单失败，使用上一轮缓存尝试撤单:", e.message);
        openOrders = latestOpenOrders;
      }
      const openOrdersFetchedAt = latestOpenOrdersFetchedAt;
      openOrdersCount = openOrders.length;
      const positions = await rememberFilledMarkets();
      monitorLoopCount++;
      if (monitorLoopCount % 10 === 1) {
        console.log("🛰️ 挂单监控运行中 openOrders=" + openOrders.length + " tracked=" + trackedOrders.size + " blocked=" + blockedMarkets.size);
      }
      await monitorOpenOrders(openOrders, openOrdersFetchedAt, positions);
    } catch (e) {
      console.log("⚠️ 高频监控异常:", e.message);
    } finally {
      monitorRunning = false;
      logElapsed("挂单监控结束", loopStartedAt, "openOrders=" + openOrdersCount + " tracked=" + trackedOrders.size + " blocked=" + blockedMarkets.size);
    }

    await new Promise(r => setTimeout(r, MONITOR_INTERVAL_MS));
  }
}

async function hourlyCancelLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, HOURLY_CANCEL_INTERVAL_MS));

    if (hourlyCancelRunning) {
      console.log("⏭️ 小时撤单仍在运行，跳过本轮");
      continue;
    }

    hourlyCancelRunning = true;
    const loopStartedAt = Date.now();
    let openOrdersCount = 0;
    let cancelIdsCount = 0;
    try {
      const openOrders = await getOpenOrders(true);
      const orderIds = openOrders
        .filter(order => getOrderSide(order) === "BUY")
        .map(getOrderId)
        .filter(Boolean);
      openOrdersCount = openOrders.length;
      cancelIdsCount = orderIds.length;
      hourlyCancelLoopCount++;
      console.log("🕐 定时撤买单运行中 openOrders=" + openOrders.length + " buyIds=" + orderIds.length + " round=" + hourlyCancelLoopCount);
      await cancelOrders(orderIds, "定时刷新买单，避免长期排队");
    } catch (e) {
      console.log("⚠️ 小时撤单异常:", e.message);
    } finally {
      hourlyCancelRunning = false;
      logElapsed("小时撤单结束", loopStartedAt, "openOrders=" + openOrdersCount + " ids=" + cancelIdsCount);
    }
  }
}

async function refreshStartTimes() {
  const markets = [...latestMarketsById.values()];
  if (!markets.length) return { markets: 0, refreshed: 0 };

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

  return { markets: markets.length, refreshed };
}

async function startTimeRefreshLoop() {
  while (true) {
    if (startTimeRefreshRunning) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    startTimeRefreshRunning = true;
    const loopStartedAt = Date.now();
    let refreshedStats = { markets: 0, refreshed: 0 };
    try {
      if (latestMarketsById.size === 0) await getMarkets();
      refreshedStats = await refreshStartTimes();
    } catch (e) {
      console.log("⚠️ 开赛时间刷新异常:", e.message);
    } finally {
      startTimeRefreshRunning = false;
      logElapsed("开赛时间刷新结束", loopStartedAt, "markets=" + refreshedStats.markets + " pmStarts=" + refreshedStats.refreshed + " known=" + latestStartTimesByMarketId.size);
    }

    await new Promise(r => setTimeout(r, START_TIME_REFRESH_INTERVAL_MS));
  }
}

// 处理单个市场 - 独立错误处理
async function processMarket(market, amountWei, existingOrders) {
  if (blockedMarkets.has(String(market.id))) {
    return { new: 0, skip: 1 };
  }

  const blockedReason = await getBlockedMarketReason(market);
  if (blockedReason) {
    blockMarket(market.id, blockedReason + " title=" + (market.question || market.title || ""));
    return { new: 0, skip: 1 };
  }

  if (getRewardEndingReason(market)) {
    return { new: 0, skip: 1 };
  }

  if (getLowRewardRateReason(market)) {
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

    // 检查是否已有该 outcome 的挂单，避免同方向重复追加占用额度。
    const existing = existingOrders.find(o => {
      const marketMatch = String(getOrderMarketId(o)) === String(market.id);
      const orderTokenId = getOrderTokenId(o);
      const orderOutcomeId = getOrderOutcomeId(o);
      const outcomeMatch = (orderTokenId && String(orderTokenId) === String(tokenId)) || (outcome.id && orderOutcomeId && String(orderOutcomeId) === String(outcome.id));
      return marketMatch && outcomeMatch;
    });

    if (existing) {
      console.log("  ⏭️ 已有同outcome挂单，跳过追加 marketId=" + market.id + " outcome=" + outcome.name + " tokenId=" + tokenId + " orderId=" + (getOrderId(existing) || ""));
      skipOrders++;
      continue;
    }

    const polyQuote = await getPolymarketQuote(market, outcome);
    if (!polyQuote.ok) {
      skipOrders++;
      continue;
    }

    const predictBid = getBestPredictBidFromBook(predictBook, market, outcome);
    const predictAsk = getRewardEligiblePredictAskFromBook(predictBook, market, outcome);

    const price = predictBid ? Math.max(Number(predictBid), polyQuote.price) : polyQuote.price;
    if (price < MIN_BUY_PRICE || price > 0.99) {
      skipOrders++;
      continue;
    }

    const priceWei = roundBuyPriceWei(price, market);
    if (priceWei <= 0n) {
      skipOrders++;
      continue;
    }

    const buyPrice = Number(priceWei) / 1e18;
    if (!predictAsk) {
      console.log("  ⏭️ 卖一为空，不符合积分点差条件 marketId=" + market.id + " outcome=" + outcome.name + " buy=" + buyPrice.toFixed(3) + " ask=null max=" + MAX_REWARD_SPREAD);
      logOrderbookDiagnostics("predictAsk为空", market, outcome, predictBook);
      skipOrders++;
      continue;
    }

    if (predictAsk && predictAsk <= buyPrice + 1e-9) {
      skipOrders++;
      continue;
    }

    if (predictAsk && predictAsk - buyPrice > MAX_REWARD_SPREAD) {
      console.log("  ⏭️ 点差超过积分条件 marketId=" + market.id + " outcome=" + outcome.name + " buy=" + buyPrice.toFixed(3) + " ask=" + Number(predictAsk).toFixed(3) + " spread=" + (predictAsk - buyPrice).toFixed(3) + " max=" + MAX_REWARD_SPREAD);
      skipOrders++;
      continue;
    }

    if (predictBid && Number(predictBid) - polyQuote.price > PRICE_TOLERANCE) {
      skipOrders++;
      continue;
    }

    const quantity = Number(amountWei) / 1e18 / buyPrice;
    if (quantity < MIN_BUY_SHARES) {
      skipOrders++;
      continue;
    }

    // 挂单
    try {
      const order = await placeBuyLimit(market, outcome, priceWei, amountWei, polyQuote.expiresAt ?? undefined);
      const orderId = getOrderId(order);
      if (orderId) {
        trackedOrders.set(String(orderId), { marketId: market.id, tokenId, createdAt: Date.now() });
        console.log("🧾 跟踪新挂单 orderId=" + orderId + " marketId=" + market.id + " tokenId=" + tokenId + " outcome=" + outcome.name);
      }
      newOrders++;
      console.log("  ✅ 挂单成功 marketId=" + market.id + " outcome=" + outcome.name + " price=" + price);
    } catch (e) {
      const detail = e.details
        ? " side=" + e.details.side
          + " marketId=" + e.details.marketId
          + " title=" + e.details.title
          + " outcome=" + e.details.outcome
          + " tokenId=" + e.details.tokenId
          + " status=" + e.details.status
          + " price=" + e.details.price
          + " priceWei=" + e.details.priceWei
          + " amount=" + e.details.amount
          + " amountWei=" + e.details.amountWei
          + " quantity=" + e.details.quantity
          + " quantityWei=" + e.details.quantityWei
          + " makerAmount=" + e.details.makerAmount
          + " takerAmount=" + e.details.takerAmount
          + " pricePerShare=" + e.details.pricePerShare
          + " response=" + e.details.response
        : " marketId=" + market.id + " outcome=" + outcome.name;
      if (e.message.includes("insufficient")) {
        console.log("  ⚠️ 挂单失败 reason=余额不足" + detail);
        logInsufficientCollateralDiagnostics(existingOrders, market, outcome, tokenId, e.details ?? { message: e.message });
      } else {
        console.log("  ❌ 挂单失败 error=" + e.message.slice(0, 100) + detail);
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
  hourlyCancelLoop().catch(e => console.error("💥 小时撤单停止:", e));
  positionMonitorLoop().catch(e => console.error("💥 持仓监控停止:", e));
  startTimeRefreshLoop().catch(e => console.error("💥 开赛时间刷新停止:", e));

  while (true) {
    const mainLoopStartedAt = Date.now();
    try {
      // 1. 获取余额
      const balance = await getBalance();
      const balUsdt = Number(balance) / 1e18;
      console.log("\n💰 余额: " + balUsdt.toFixed(2) + " USDT");

      if (balance < 1n * 10n ** 18n) {
        console.log("⚠️ 余额不足，等待...");
        logElapsed("主循环结束", mainLoopStartedAt, "reason=余额不足 balance=" + balUsdt.toFixed(2));
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
        continue;
      }

      // 2. 计算挂单金额：余额比例与单笔上限取较小值
      const ratioAmountWei = (balance * BigInt(Math.floor(ORDER_RATIO * 100))) / 100n;
      const maxOrderWei = BigInt(Math.floor(MAX_ORDER_USD * 100)) * 10n ** 16n;
      const amountWei = ratioAmountWei < maxOrderWei ? ratioAmountWei : maxOrderWei;
      console.log("📌 每单: " + (Number(amountWei) / 1e18).toFixed(2) + " USDT (余额比例=" + (ORDER_RATIO * 100) + "%, 上限=" + MAX_ORDER_USD + ")");

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
      logElapsed("主循环结束", mainLoopStartedAt, "markets=" + processedMarkets + " new=" + totalNew + " skip=" + totalSkip);

    } catch (e) {
      console.error("❌ 主循环错误:", e.message);
      logElapsed("主循环结束", mainLoopStartedAt, "error=" + e.message);
    }

    console.log("⏳ 5分钟后继续...\n");
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch(e => {
  console.error("💥 致命错误:", e);
  process.exit(1);
});
