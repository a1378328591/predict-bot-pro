import "dotenv/config";
import fetch from "node-fetch";
import { appendFileSync } from "node:fs";
import { Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { getJwtTokenWithSDK } from "./getJwtTokenWithSDK.js";

// This file intentionally contains the complete SSE strategy. It does not import
// any sports or generic market-maker implementation.
// ======== 运行凭证（只从运行环境读取，不要写入代码） ========
// Predict API Key，仅从运行环境读取，不写入代码。
const { PREDICT_API_KEY: API_KEY, PRIVY_PRIVATE_KEY: PRIVATE_KEY, PREDICT_ACCOUNT: ACCOUNT, RPC_URL } = process.env;
// ======== 固定运行配置（修改这里，不要再放到 .env） ========
// Predict API 基础地址。
const API_BASE_URL = "https://api.predict.fun";
// 成交风控使用的 GraphQL 地址。
const GRAPHQL_URL = "https://graphql.predict.fun/graphql";
// 查询买单资金余额使用的 BNB RPC，和 soccerMarketMaker.js 一样从 RPC_URL 读取。
const RPC_URLS = (RPC_URL || "").split(",").map(url => url.trim()).filter(Boolean);
// 直接实盘：真实提交 BUY、SELL 和撤单。
const LIVE_TRADING = true;
// 只按这些 category slug 选择市场；每个 category 取一个 OPEN 市场。
const CATEGORY_SLUG = [
  "sse-composite-index-up-or-down-on-september-3-2026",
];
// 北京时间允许挂 BUY 的时段，24 小时制；当前为凌晨1点到早上7点。
const QUOTE_WINDOWS = parseWindows("00:00-08:00");
// 距离市场结束少于该分钟数后停止新挂 BUY，但继续维护 SELL。
const STOP_BUY_BEFORE_CLOSE_MINUTES = 90;
// 主做市循环间隔；买单确认周期按该循环计数。
const LOOP_INTERVAL_MS = 30_000;
// 成交风控数据刷新间隔。
const MATCH_REFRESH_MS = 30_000;
// BUY 允许的最大买卖价差；0.06 表示 6 个百分点。
const MAX_SPREAD = 0.06;
// BUY 最低价格；低于 0.30 的价格不挂，避免单边行情下风险过高。
const MIN_BUY_PRICE = 0.30;
// 近 5 分钟最多允许的成交笔数，达到该值停止挂 BUY。
const MAX_RECENT_TRADES = 4;
// 近 5 分钟最多允许的成交总 shares。
const MAX_RECENT_VOLUME = 500;
// 近 5 分钟允许的单笔最大成交 shares。
const MAX_SINGLE_TRADE = 200;
// 每个方向单次挂 BUY 的 shares 数量。
const ORDER_SHARES = 110;
// BUY 最低提交数量；余额折算后低于该数量不挂 BUY。
const MIN_ORDER_SHARES = 100;
// 任一方向持仓超过该数量后停止该方向 BUY；降回该值或以下后恢复。
const POSITION_BUY_STOP_SHARES = 100;
// 单笔 SELL 达到该 shares 才能获得积分；持仓达到该数量后整理小卖单。
const MIN_REWARD_SELL_SHARES = 100;
// 持仓卖价相对买一使用的 tick 数，默认买一上方 1 tick。
const SELL_REFRESH_TICKS = 1;
// 买一必须连续稳定的主循环周期数，默认 3 个周期，约 90 秒。
const BUY_CONFIRM_CYCLES = 3;
// 买一最少 shares；低于该数量不挂 BUY。
const BUY_MIN_BID_SHARES = 100;
// 买方盘口至少需要的价格档位数，包含买一；默认买一及后两档。
const BUY_MIN_DEPTH_LEVELS = 3;
// 单轮允许相对已确认价格上调的最大 tick 数。
const BUY_MAX_REPRICE_TICKS = 2;
// BUY 挂单监控频率，默认每秒检查一次。
const ORDER_MONITOR_INTERVAL_MS = 3_000;
// 买一总量与自身挂单量相差不超过该 shares 时，认为可能只剩自己并撤单。
const ORDER_MONITOR_GAP_SHARES = 50;
// 持仓及 SELL 监控频率，默认每秒检查一次。
const POSITION_MONITOR_INTERVAL_MS = 6_000;
// 允许忽略的持仓/卖单链上数量尾差。
const SELL_QUANTITY_TOLERANCE_WEI = 1n * 10n ** 18n;
// 是否启用近 5 分钟成交风控。
const USE_MATCH_RISK = true;
// 日志文件路径。
const LOG_FILE = "sseCompositeMarketMakerDirect.log";

let orderBuilder;
const lastMarkets = new Map();
const lastMatchStats = new Map();
let rpcIndex = 0;
let cycleRunning = false;
let monitorRunning = false;
let positionMonitorRunning = false;
const buyStates = new Map();
const pendingPositionSells = new Map();
const cancelingOrderIds = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {}
}

function parseWindows(value) {
  return String(value).split(",").map(item => {
    const [start, end] = item.trim().split("-");
    if (!/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "")) return null;
    const toMinutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    // 允许 24:00 仅作为结束时间，表示当天最后一分钟之后的边界。
    return startMinutes >= 0 && startMinutes < 1440 && endMinutes >= 0 && endMinutes <= 1440
      ? { start: startMinutes, end: endMinutes }
      : null;
  }).filter(Boolean);
}

function shanghaiMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Number(parts.find(part => part.type === "hour")?.value) * 60
    + Number(parts.find(part => part.type === "minute")?.value);
}

function marketEndAt(market) {
  const values = [market?.endsAt, market?.endTime, market?.endDate, market?.closeTime, market?.settlementTime, market?.category?.endsAt];
  for (const value of values) {
    const numeric = Number(value);
    const date = typeof value === "number" || /^\d+$/.test(String(value || ""))
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value);
    if (value && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function inConfiguredWindow(date = new Date()) {
  const current = shanghaiMinutes(date);
  return QUOTE_WINDOWS.some(({ start, end }) => start <= end
    ? current >= start && current < end
    : current >= start || current < end);
}

function isBeforeSettlementCutoff(market, date = new Date()) {
  const endsAt = marketEndAt(market);
  return Boolean(endsAt && endsAt.getTime() - date.getTime() <= STOP_BUY_BEFORE_CLOSE_MINUTES * 60_000);
}

function canPlaceBuys(market, stats) {
  if (!inConfiguredWindow()) return { ok: false, reason: "不在配置挂买时段" };
  if (isBeforeSettlementCutoff(market)) return { ok: false, reason: "距离结算进入停止挂买区间" };
  if (USE_MATCH_RISK && stats.error) return { ok: false, reason: "成交风控数据获取失败" };
  if (USE_MATCH_RISK && (stats.trades >= MAX_RECENT_TRADES || stats.shares >= MAX_RECENT_VOLUME || stats.maxShares >= MAX_SINGLE_TRADE)) {
    return { ok: false, reason: `近5分钟成交拥挤 trades=${stats.trades} shares=${stats.shares.toFixed(1)} max=${stats.maxShares.toFixed(1)}` };
  }
  return { ok: true, reason: "" };
}

function parseLevel(level) {
  const price = Number(level?.price ?? level?.pricePerShare ?? level?.[0]);
  const size = Number(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && price <= 1 && size > 0
    ? { price, size }
    : null;
}

function normalizedBook(rawBook, market, outcome) {
  const bids = (rawBook?.bids || []).map(parseLevel).filter(Boolean).sort((a, b) => b.price - a.price);
  const asks = (rawBook?.asks || []).map(parseLevel).filter(Boolean).sort((a, b) => a.price - b.price);
  const index = (market?.outcomes || []).findIndex(item => String(item?.onChainId) === String(outcome?.onChainId));
  if (index !== 1 || market?.outcomes?.length !== 2) return { bids, asks };
  return {
    bids: asks.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => b.price - a.price),
    asks: bids.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => a.price - b.price),
  };
}

function quoteFromBook(rawBook, market, outcome) {
  const book = normalizedBook(rawBook, market, outcome);
  const followingBids = book.bids.slice(0, BUY_MIN_DEPTH_LEVELS);
  const bid = book.bids[0] || null;
  const ask = book.asks[0] || null;
  return {
    bid,
    ask,
    mid: bid && ask ? (bid.price + ask.price) / 2 : null,
    spread: bid && ask ? ask.price - bid.price : null,
    depth: followingBids.reduce((sum, level) => sum + level.size, 0),
    depthLevels: followingBids.length,
  };
}

function buyStateKey(market, outcome) {
  return `${market.id}:${outcome.id ?? outcome.onChainId}`;
}

function validateUpDownMarket(market) {
  const names = (market?.outcomes || []).slice(0, 2).map(outcome => outcome?.name);
  if (names.length !== 2 || !names.includes("Up") || !names.includes("Down")) {
    throw new Error(`市场 outcome 不是接口确认的 Up/Down: ${names.join(",")}`);
  }
}

function resetBuyState(market, outcome) {
  buyStates.delete(buyStateKey(market, outcome));
}

function confirmedBuyQuote(market, outcome, quote) {
  const key = buyStateKey(market, outcome);
  const state = buyStates.get(key) || {
    lastPrice: null,
    lastDepth: 0,
    stableCycles: 0,
    candidatePrice: null,
    confirmedPrice: null,
  };
  const currentPrice = quote.bid?.price ?? null;
  const currentTicks = currentPrice === null ? null : priceTicks(currentPrice, market);
  const lastTicks = state.lastPrice === null ? null : priceTicks(state.lastPrice, market);
  const priceChanged = currentTicks === null || lastTicks === null || currentTicks !== lastTicks;
  const depthChanged = state.lastDepth !== 0 && Math.abs(quote.depth - state.lastDepth) > BUY_MIN_BID_SHARES / 2;

  if (!quote.bid || quote.bid.size < BUY_MIN_BID_SHARES || quote.depthLevels < BUY_MIN_DEPTH_LEVELS) {
    state.stableCycles = 0;
    state.candidatePrice = null;
    state.confirmedPrice = null;
  } else if (priceChanged) {
    state.stableCycles = 1;
    state.candidatePrice = currentPrice;
    if (lastTicks !== null && currentTicks > lastTicks && quote.depth <= state.lastDepth) {
      state.stableCycles = 0;
    }
  } else {
    state.stableCycles += depthChanged ? 0 : 1;
  }

  if (state.stableCycles >= BUY_CONFIRM_CYCLES && state.candidatePrice !== null
    && (state.confirmedPrice === null || priceTicks(state.candidatePrice, market) <= priceTicks(state.confirmedPrice, market) + BigInt(BUY_MAX_REPRICE_TICKS))) {
    state.confirmedPrice = state.candidatePrice;
  }
  state.lastPrice = currentPrice;
  state.lastDepth = quote.depth;
  buyStates.set(key, state);

  if (state.confirmedPrice === null || !quote.ask) return null;
  if (currentTicks > priceTicks(state.confirmedPrice, market) + BigInt(BUY_MAX_REPRICE_TICKS)) return null;
  return quote;
}

function precision(market) {
  const value = Number(market?.decimalPrecision);
  return Number.isInteger(value) && value >= 0 && value <= 18 ? value : 2;
}

function tick(market) {
  return 10n ** BigInt(18 - precision(market));
}

function priceWei(price, market, mode = "floor") {
  const scale = 10 ** precision(market);
  const units = mode === "ceil" ? Math.ceil(price * scale - 1e-9) : Math.floor(price * scale + 1e-9);
  return BigInt(Math.max(0, units)) * tick(market);
}

function priceNumber(value) {
  return Number(value) / 1e18;
}

function priceTicks(price, market) {
  return priceWei(price, market, "floor") / tick(market);
}

function samePriceTick(left, right, market) {
  return priceTicks(left, market) === priceTicks(right, market);
}

function orderId(order) {
  return order?.id ?? order?.orderId ?? order?.hash ?? order?.order?.hash;
}

function orderMarketId(order) {
  return order?.order?.marketId ?? order?.market?.id ?? order?.marketId;
}

function orderTokenId(order) {
  return order?.order?.tokenId ?? order?.outcome?.onChainId ?? order?.tokenId ?? order?.outcomeTokenId;
}

function orderOutcomeId(order) {
  return order?.order?.outcomeId ?? order?.outcome?.id ?? order?.outcomeId;
}

function orderSide(order) {
  const side = order?.order?.side ?? order?.side;
  if (side === 0 || side === "0") return "BUY";
  if (side === 1 || side === "1") return "SELL";
  return String(side || "").toUpperCase();
}

function orderPrice(order) {
  const value = Number(order?.price ?? order?.pricePerShare ?? order?.order?.pricePerShare);
  if (Number.isFinite(value) && value > 0 && value <= 1) return value;
  const maker = Number(order?.order?.makerAmount ?? order?.makerAmount);
  const taker = Number(order?.order?.takerAmount ?? order?.takerAmount);
  if (!(maker > 0 && taker > 0)) return null;
  return orderSide(order) === "SELL" ? taker / maker : maker / taker;
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

function orderQuantity(order) {
  for (const value of [
    order?.remainingQuantity,
    order?.remainingQuantityWei,
    order?.quantity,
    order?.quantityWei,
    order?.size,
    order?.shares,
    order?.order?.remainingQuantity,
    order?.order?.quantity,
    orderSide(order) === "BUY" ? order?.order?.takerAmount : order?.order?.makerAmount,
  ]) {
    const parsed = quantityWei(value);
    if (parsed > 0n) return parsed;
  }
  return 0n;
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

function positionCost(position) {
  for (const value of [position?.averageBuyPriceUsd, position?.averagePrice, position?.averageEntryPrice, position?.avgPrice, position?.entryPrice]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) return parsed;
    if (Number.isFinite(parsed) && parsed > 1 && parsed <= 100) return parsed / 100;
  }
  return null;
}

function matchingOrder(order, marketId, tokenId, outcomeId) {
  if (String(orderMarketId(order)) !== String(marketId)) return false;
  const actualTokenId = orderTokenId(order);
  if (tokenId && actualTokenId) return String(actualTokenId) === String(tokenId);
  return Boolean(outcomeId && orderOutcomeId(order)) && String(orderOutcomeId(order)) === String(outcomeId);
}

function apiHeaders(auth = false) {
  const headers = { "x-api-key": API_KEY };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return headers;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 200)}`);
  return response;
}

async function api(path, options = {}) {
  const response = await request(new URL(path, API_BASE_URL), options);
  const body = await response.json();
  if (body?.success === false) throw new Error(`API rejected ${path}`);
  return body?.data ?? body;
}

async function getMarkets() {
  const results = await Promise.all(CATEGORY_SLUG.map(async categorySlug => {
    try {
      const category = await api(`/v1/categories/${encodeURIComponent(categorySlug)}`, { headers: apiHeaders() });
      const markets = Array.isArray(category?.markets) ? category.markets : [];
      const market = markets.find(item => String(item.tradingStatus || item.status).toUpperCase() === "OPEN") || markets[0];
      if (!market) {
        log("⚠️ 类别没有市场", `category=${categorySlug}`);
        return { categorySlug, market: null, unavailableReason: "类别没有市场" };
      }
      return { market: { ...market, category: { endsAt: category.endsAt }, categorySlug }, categorySlug, unavailableReason: null };
    } catch (error) {
      log("⚠️ 市场获取失败", `category=${categorySlug}`, error.message);
      return { categorySlug, market: null, unavailableReason: `市场获取失败: ${error.message}` };
    }
  }));
  return results;
}

async function getBook(marketId) {
  return api(`/v1/markets/${encodeURIComponent(marketId)}/orderbook`, { headers: apiHeaders() });
}

async function getOpenOrders() {
  const jwt = await getJwtTokenWithSDK();
  const result = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ status: "OPEN", first: "200" });
    if (after) query.set("after", after);
    const body = await api(`/v1/orders?${query}`, { headers: apiHeaders(jwt) });
    const rows = Array.isArray(body) ? body : [];
    result.push(...rows);
    if (rows.length === 0 || rows.length < 200) break;
    after = body.cursor;
    if (!after) break;
  }
  return result;
}

async function getPositions() {
  const jwt = await getJwtTokenWithSDK();
  const body = await api("/v1/positions?first=100", { headers: apiHeaders(jwt) });
  return Array.isArray(body) ? body : [];
}

async function getBalance() {
  if (!ACCOUNT || !RPC_URLS.length) {
    log("⚠️ 缺少 ACCOUNT 或 RPC_URL，无法查询买单余额");
    return 0n;
  }
  const token = "0x55d398326f99059fF775485246999027B3197955";
  const data = "0x70a08231" + ACCOUNT.slice(2).toLowerCase().padStart(64, "0");
  for (let attempt = 0; attempt < RPC_URLS.length; attempt += 1) {
    const url = RPC_URLS[rpcIndex % RPC_URLS.length];
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_call",
          params: [{ to: token, data }, "latest"],
        }),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      if (!body.result) throw new Error("RPC 返回缺少 result");
      return BigInt(body.result);
    } catch (error) {
      rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
      log("⚠️ 余额查询失败，切换 RPC", error.message);
    }
  }
  return 0n;
}

function buyCostWei(price, shares) {
  return BigInt(Math.ceil(price * shares * 1e18));
}

async function cancelOrders(orders, reason) {
  const ids = [...new Set(orders
    .filter(order => isConfiguredMarket(orderMarketId(order)))
    .map(orderId)
    .filter(Boolean)
    .map(String))]
    .filter(id => !cancelingOrderIds.has(id));
  if (!ids.length || !LIVE_TRADING) return 0;
  for (const id of ids) cancelingOrderIds.add(id);
  try {
    const jwt = await getJwtTokenWithSDK();
    await api("/v1/orders/remove", {
      method: "POST",
      headers: { ...apiHeaders(jwt), "Content-Type": "application/json" },
      body: JSON.stringify({ data: { ids } }),
    });
    log("🧹 撤单", `count=${ids.length}`, `ids=${ids.join(",")}`, `reason=${reason}`);
    return ids.length;
  } catch (error) {
    for (const id of ids) cancelingOrderIds.delete(id);
    throw error;
  }
}

async function createLimitOrder(market, side, tokenId, price, shares, expiresAt) {
  if (!LIVE_TRADING) return { id: `paper-${Date.now()}` };
  if (!PRIVATE_KEY || !ACCOUNT || !API_KEY) throw new Error("实盘需要 PREDICT_API_KEY / PRIVY_PRIVATE_KEY / PREDICT_ACCOUNT");
  orderBuilder ||= await OrderBuilder.make(ChainId.BnbMainnet, new Wallet(PRIVATE_KEY), { predictAccount: ACCOUNT });
  const pWei = priceWei(price, market, side === Side.SELL ? "ceil" : "floor");
  const qWei = BigInt(Math.floor(shares * 1e6)) * 10n ** 12n;
  const amounts = orderBuilder.getLimitOrderAmounts({ side, pricePerShareWei: pWei, quantityWei: qWei });
  const order = orderBuilder.buildOrder("LIMIT", {
    side,
    tokenId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const typedData = orderBuilder.buildTypedData(order, { isNegRisk: market.isNegRisk || false, isYieldBearing: market.isYieldBearing || false });
  const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
  const hash = orderBuilder.buildTypedDataHash(typedData);
  const jwt = await getJwtTokenWithSDK();
  return api("/v1/orders", {
    method: "POST",
    headers: { ...apiHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ data: { order: { ...signedOrder, hash }, pricePerShare: amounts.pricePerShare, strategy: "LIMIT" } }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
}

async function recentMatchStats(market) {
  const key = String(market.id);
  const cached = lastMatchStats.get(key) || { fetchedAt: 0, trades: 0, shares: 0, maxShares: 0, error: null };
  if (!USE_MATCH_RISK || Date.now() - cached.fetchedAt < MATCH_REFRESH_MS) return cached;
  const query = `query GetMatchEventLog($filter: MatchEventLogFilterInput, $pagination: ForwardPaginationInput) { matchEventLog(filter: $filter, pagination: $pagination) { edges { node { timestamp amountFilled } } } }`;
  const body = JSON.stringify({ query, variables: { pagination: { first: 100 }, filter: { marketId: String(market.id), categoryId: market.categorySlug || undefined } } });
  try {
    const response = await request(GRAPHQL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const json = await response.json();
    if (json.errors) throw new Error("成交接口返回 errors");
    const cutoff = Date.now() - 5 * 60_000;
    const rows = (json?.data?.matchEventLog?.edges || []).map(edge => edge.node).filter(row => new Date(row.timestamp).getTime() >= cutoff);
    const sizes = rows.map(row => Number(row.amountFilled) / 1e18).filter(Number.isFinite);
    const stats = { fetchedAt: Date.now(), trades: sizes.length, shares: sizes.reduce((sum, value) => sum + value, 0), maxShares: Math.max(0, ...sizes), error: null };
    lastMatchStats.set(key, stats);
  } catch (error) {
    lastMatchStats.set(key, { ...cached, fetchedAt: Date.now(), error: error.message });
    log("⚠️ 成交风控查询失败", error.message);
  }
  return lastMatchStats.get(key);
}

async function cancelBuyOrders(openOrders, reason) {
  return cancelOrders(openOrders.filter(order => orderSide(order) === "BUY"), reason);
}

function positionFor(positions, marketId, tokenId, outcomeId) {
  return positions.find(position => String(positionMarketId(position)) === String(marketId)
    && (tokenId && positionTokenId(position)
      ? String(positionTokenId(position)) === String(tokenId)
      : Boolean(outcomeId && position?.outcome?.id) && String(position?.outcome?.id) === String(outcomeId)));
}

function isConfiguredMarket(marketId) {
  return marketId !== undefined && marketId !== null && lastMarkets.has(String(marketId));
}

function buyStopReason(positionShares, buyingAllowed) {
  if (!buyingAllowed.ok) return buyingAllowed.reason;
  if (positionShares > POSITION_BUY_STOP_SHARES) return "该方向持仓超过100 shares买入上限";
  return null;
}

function pendingPositionSell(marketId, tokenId) {
  const key = `${marketId}:${tokenId}`;
  const pending = pendingPositionSells.get(key);
  if (pending && Date.now() - pending.createdAt > 60_000) {
    pendingPositionSells.delete(key);
    return null;
  }
  return pending || null;
}

function clearMarketState(marketId) {
  const prefix = `${marketId}:`;
  for (const key of buyStates.keys()) {
    if (key.startsWith(prefix)) buyStates.delete(key);
  }
  for (const key of pendingPositionSells.keys()) {
    if (key.startsWith(prefix)) pendingPositionSells.delete(key);
  }
  lastMatchStats.delete(String(marketId));
}

function calculateSellPrice(market, quote, cost) {
  const step = Number(tick(market)) / 1e18;
  const target = quote.bid && quote.bid.price >= cost
    ? quote.bid.price + step * SELL_REFRESH_TICKS
    : cost;
  if (quote.bid && target <= quote.bid.price) return null;
  return Math.min(0.99, target);
}

async function managePosition(position, market, book, openOrders) {
  if (!isConfiguredMarket(positionMarketId(position)) || !isConfiguredMarket(market?.id)) return;
  const sharesWei = positionQuantity(position);
  if (sharesWei <= 0n) return;
  const tokenId = positionTokenId(position);
  const outcome = market.outcomes?.find(item => String(item.onChainId) === String(tokenId)) || position.outcome;
  if (!outcome) return;
  const quote = quoteFromBook(book, market, outcome);
  const cost = positionCost(position);
  if (!quote.ask || !cost) {
    log("⏭️ 持仓暂不挂卖", `outcome=${outcome.name}`, "缺少卖一或成本价");
    return;
  }
  const target = calculateSellPrice(market, quote, cost);
  if (!target) {
    log("⏭️ 持仓暂不挂卖", `outcome=${outcome.name}`, "目标价会立即成交");
    return;
  }
  const sellOrders = openOrders.filter(order => matchingOrder(order, market.id, tokenId, outcome.id) && orderSide(order) === "SELL");
  const targetWei = priceWei(target, market, "ceil");
  const targetPrice = priceNumber(targetWei);
  const rewardQuantityWei = BigInt(Math.floor(MIN_REWARD_SELL_SHARES * 1e18));
  const targetSellOrders = sellOrders.filter(order => {
    const price = orderPrice(order);
    return price !== null && Math.abs(price - targetPrice) <= Number(tick(market)) / 1e18;
  });
  const optimalRewardOrder = targetSellOrders.find(order => {
    const quantity = orderQuantity(order);
    return quantity >= rewardQuantityWei;
  });
  if (sharesWei >= rewardQuantityWei && optimalRewardOrder) {
    const nonOptimalOrders = sellOrders.filter(order => !targetSellOrders.includes(order));
    if (nonOptimalOrders.some(order => !orderId(order))) {
      log("⚠️ 非最优卖单整理跳过", `outcome=${outcome.name}`, "存在无法识别订单ID，避免重复卖出");
      return;
    }
    if (nonOptimalOrders.length) {
      const cancelled = await cancelOrders(nonOptimalOrders, "保留最优满额卖单，撤销非最优卖单");
      if (cancelled < nonOptimalOrders.length) return;
      log("🧹 保留最优满额卖单", `outcome=${outcome.name}`, `keptOrders=${targetSellOrders.length}`, `cancelled=${cancelled}`);
      return;
    }
    const coverage = targetSellOrders.reduce((sum, order) => sum + orderQuantity(order), 0n);
    if (targetSellOrders.some(order => orderQuantity(order) <= 0n)) return;
    const remaining = sharesWei - coverage;
    if (remaining <= 0n) return;
    if (remaining < 1n * 10n ** 18n) return;
    const pending = pendingPositionSell(market.id, tokenId);
    if (pending && pending.quantityWei >= remaining) return;
    const result = await createLimitOrder(market, Side.SELL, tokenId, target, Number(remaining) / 1e18, marketEndAt(market));
    pendingPositionSells.set(`${market.id}:${tokenId}`, { price: targetPrice, quantityWei: remaining, createdAt: Date.now() });
    log("📤 补挂最优卖单", `outcome=${outcome.name}`, `shares=${(Number(remaining) / 1e18).toFixed(4)}`, `keptOrders=${targetSellOrders.length}`, `price=${target}`, `live=${LIVE_TRADING}`, `id=${orderId(result) || "paper"}`);
    return;
  }
  if (sharesWei >= rewardQuantityWei && sellOrders.length) {
    if (sellOrders.some(order => !orderId(order))) {
      log("⚠️ 小卖单合并跳过", `outcome=${outcome.name}`, "存在无法识别订单ID，避免重复卖出");
      return;
    }
    const cancelled = await cancelOrders(sellOrders, "持仓达到积分门槛，撤销非最优卖单并合并重挂");
    if (cancelled < sellOrders.length) return;
    pendingPositionSells.delete(`${market.id}:${tokenId}`);
    log("🧹 合并卖单", `outcome=${outcome.name}`, `orders=${sellOrders.length}`, `positionShares=${(Number(sharesWei) / 1e18).toFixed(4)}`);
    return;
  }
  const existing = sellOrders[0];
  const oldPrice = orderPrice(existing);
  const oldQuantity = orderQuantity(existing);
  if (sellOrders.length === 1 && existing && oldPrice
    && Math.abs(oldPrice - priceNumber(targetWei)) <= Number(tick(market)) / 1e18
    && (!oldQuantity || oldQuantity + SELL_QUANTITY_TOLERANCE_WEI >= sharesWei)) return;
  const pending = pendingPositionSell(market.id, tokenId);
  if (pending && Math.abs(pending.price - priceNumber(targetWei)) <= Number(tick(market)) / 1e18
    && pending.quantityWei + SELL_QUANTITY_TOLERANCE_WEI >= sharesWei && sellOrders.length <= 1) return;
  if (sellOrders.length) {
    const cancelled = await cancelOrders(sellOrders, "持仓卖价或数量变化");
    if (LIVE_TRADING && cancelled < sellOrders.length) return;
  }
  const shares = Number(sharesWei) / 1e18;
  if (shares < 1) return;
  const result = await createLimitOrder(market, Side.SELL, tokenId, target, shares, marketEndAt(market));
  pendingPositionSells.set(`${market.id}:${tokenId}`, { price: priceNumber(targetWei), quantityWei: sharesWei, createdAt: Date.now() });
  log("📤 挂持仓卖单", `outcome=${outcome.name}`, `shares=${shares.toFixed(4)}`, `cost=${cost.toFixed(4)}`, `bid=${quote.bid?.price ?? "-"}`, `ask=${quote.ask.price}`, `price=${target}`, `live=${LIVE_TRADING}`, `id=${orderId(result) || "paper"}`);
}

async function manageBuy(market, outcome, book, positions, openOrders, buyingAllowed, balanceBudget) {
  if (!isConfiguredMarket(market?.id)) return;
  const tokenId = outcome.onChainId;
  const position = positionFor(positions, market.id, tokenId, outcome.id);
  const positionShares = position ? Number(positionQuantity(position)) / 1e18 : 0;
  const matchingBuys = openOrders.filter(order => matchingOrder(order, market.id, tokenId, outcome.id) && orderSide(order) === "BUY");
  const stopReason = buyStopReason(positionShares, buyingAllowed);
  if (stopReason) {
    if (matchingBuys.length) await cancelOrders(matchingBuys, stopReason);
    return;
  }
  const quote = quoteFromBook(book, market, outcome);
  if (!quote.bid || !quote.ask || quote.spread > MAX_SPREAD || quote.bid.price < MIN_BUY_PRICE || quote.bid.price >= 1) {
     if (matchingBuys.length) await cancelOrders(matchingBuys, !quote.bid || quote.bid.price < MIN_BUY_PRICE
       ? `买一价格低于${MIN_BUY_PRICE}或盘口缺失`
       : "盘口缺失或价差超过6个百分点");
    return;
  }
  if (quote.bid.size < BUY_MIN_BID_SHARES || quote.depthLevels < BUY_MIN_DEPTH_LEVELS) {
    resetBuyState(market, outcome);
    if (matchingBuys.length) await cancelOrders(matchingBuys, "买一数量或盘口深度不足");
    return;
  }
  const confirmedQuote = confirmedBuyQuote(market, outcome, quote);
  if (!confirmedQuote) {
    if (matchingBuys.length) await cancelOrders(matchingBuys, "买一尚未完成稳定确认或深度可疑");
    return;
  }
  const state = buyStates.get(buyStateKey(market, outcome));
  const tickSize = Number(tick(market)) / 1e18;
  const target = priceNumber(priceWei(
    Math.min(quote.bid.price, state.confirmedPrice + tickSize * BUY_MAX_REPRICE_TICKS),
    market,
    "floor",
  ));
  const existing = matchingBuys[0];
  if (matchingBuys.length === 1 && existing && orderPrice(existing) && samePriceTick(orderPrice(existing), target, market)
    && (!orderQuantity(existing) || orderQuantity(existing) >= BigInt(Math.floor(ORDER_SHARES * 1e18)))) return;

  const targetWei = priceWei(target, market, "floor");
  const availableWei = balanceBudget.limitWei;
  const affordableSharesWei = targetWei > 0n
    ? (availableWei * 10n ** 18n) / targetWei
    : 0n;
  const affordableShares = Number(affordableSharesWei) / 1e18;
  const shares = Math.floor(Math.min(ORDER_SHARES, affordableShares) * 1e6) / 1e6;
  if (shares < MIN_ORDER_SHARES) {
    log("⏭️ 余额不足，跳过买单", `outcome=${outcome.name}`, `balanceShares=${affordableShares.toFixed(4)}`, `minShares=${MIN_ORDER_SHARES}`, `price=${target}`);
    return;
  }
  const newOrderCostWei = buyCostWei(target, shares);
  if (newOrderCostWei > availableWei) return;
  if (matchingBuys.length) {
    const cancelled = await cancelOrders(matchingBuys, "买一变化，刷新买单");
    if (LIVE_TRADING && cancelled < matchingBuys.length) return;
  }
  const result = await createLimitOrder(market, Side.BUY, tokenId, target, shares, marketEndAt(market));
  const createdOrderId = orderId(result);
  log("📥 挂上证买单", `outcome=${outcome.name}`, `shares=${shares.toFixed(4)}`, `bid=${quote.bid.price}`, `ask=${quote.ask.price}`, `mid=${quote.mid?.toFixed(4)}`, `spread=${quote.spread.toFixed(4)}`, `live=${LIVE_TRADING}`, `id=${createdOrderId || "paper"}`);
}

async function monitorOpenBuyOrders() {
  if (monitorRunning || cycleRunning || !lastMarkets.size) return;
  monitorRunning = true;
  try {
    const [openOrders, books] = await Promise.all([
      getOpenOrders(),
      Promise.all([...lastMarkets.values()].map(async market => {
        try {
          return [market, await getBook(market.id)];
        } catch (error) {
          log("⚠️ 市场盘口获取失败", `market=${market.id}`, error.message);
          return [market, null];
        }
      })),
    ]);
    for (const [market, book] of books) {
      const marketBuys = openOrders.filter(order => String(orderMarketId(order)) === String(market.id) && orderSide(order) === "BUY");
      if (!book || market.marketDataUnavailable) {
        if (marketBuys.length) await cancelOrders(marketBuys, market.marketDataUnavailable
          ? `市场数据不可用：${market.marketDataUnavailable}`
          : "盘口获取失败，撤销买单");
        continue;
      }
      for (const order of marketBuys) {
        const tokenId = orderTokenId(order);
        const outcome = tokenId
          ? market.outcomes?.find(item => String(item.onChainId) === String(tokenId))
          : market.outcomes?.find(item => String(item.id) === String(orderOutcomeId(order)));
        if (!outcome) continue;
        const quote = quoteFromBook(book, market, outcome);
        const ownPrice = orderPrice(order);
        const ownQuantity = Number(orderQuantity(order)) / 1e18;
        const state = buyStates.get(buyStateKey(market, outcome));
        const reasons = [];
        const bidTicks = quote.bid ? priceTicks(quote.bid.price, market) : null;
        const ownTicks = ownPrice ? priceTicks(ownPrice, market) : null;
        const confirmedTicks = state?.confirmedPrice === null || state?.confirmedPrice === undefined
          ? null
          : priceTicks(state.confirmedPrice, market);

        if (!inConfiguredWindow()) reasons.push("不在配置挂买时段");
        if (!quote.bid || !ownPrice || bidTicks !== ownTicks) reasons.push("买一已变化");
        if (ownQuantity < MIN_ORDER_SHARES) reasons.push(`剩余数量低于${MIN_ORDER_SHARES}shares`);
        if (ownPrice < MIN_BUY_PRICE) reasons.push(`挂单价格低于${MIN_BUY_PRICE}`);
        if (!quote.bid || quote.bid.size < BUY_MIN_BID_SHARES) reasons.push("买一数量不足");
        if (!quote.bid || Math.abs(quote.bid.size - ownQuantity) <= ORDER_MONITOR_GAP_SHARES) reasons.push("买一疑似只剩本单");
        if (confirmedTicks === null || bidTicks === null || bidTicks > confirmedTicks + BigInt(BUY_MAX_REPRICE_TICKS)) reasons.push("买一超过确认价格追价上限");
        if (!quote.bid || quote.depthLevels < BUY_MIN_DEPTH_LEVELS) reasons.push("买一后深度不足");
        if (state && state.lastPrice !== null && bidTicks > priceTicks(state.lastPrice, market) && quote.depth <= state.lastDepth) reasons.push("买一涨价但深度未增加");

        log("🔍 买单监控", `market=${market.id}`, `outcome=${outcome.name}`, `tokenId=${tokenId}`, `order=${orderId(order)}`, `ownPrice=${ownPrice ?? "null"}`, `bid=${quote.bid?.price ?? "null"}`, `bidSize=${quote.bid?.size ?? "null"}`, `ownSize=${ownQuantity}`, `depthLevels=${quote.depthLevels}`, `confirmed=${state?.confirmedPrice ?? "null"}`, `reasons=${reasons.join("|") || "ok"}`);
        if (reasons.length) await cancelOrders([order], `每秒挂单监控：${reasons.join("、")}`);
      }
    }
  } catch (error) {
    log("⚠️ 挂单监控失败", error.message);
  } finally {
    monitorRunning = false;
  }
}

async function monitorPositions() {
  if (positionMonitorRunning || cycleRunning || !lastMarkets.size) return;
  positionMonitorRunning = true;
  try {
    const [positions, openOrders, books] = await Promise.all([
      getPositions(),
      getOpenOrders(),
      Promise.all([...lastMarkets.values()].map(async market => {
        try {
          return [market, await getBook(market.id)];
        } catch (error) {
          log("⚠️ 市场盘口获取失败", `market=${market.id}`, error.message);
          return [market, null];
        }
      })),
    ]);
    for (const [market, book] of books) {
      const marketPositions = positions.filter(position => String(positionMarketId(position)) === String(market.id));
      if (!book) {
        const marketBuys = openOrders.filter(order => String(orderMarketId(order)) === String(market.id) && orderSide(order) === "BUY");
        if (marketBuys.length) await cancelOrders(marketBuys, "盘口获取失败，撤销买单");
        continue;
      }
      for (const position of marketPositions) {
        const tokenId = positionTokenId(position);
        const outcome = market.outcomes?.find(item => String(item.onChainId) === String(tokenId)) || position.outcome;
        if (!outcome) continue;
        const positionShares = Number(positionQuantity(position)) / 1e18;
        const stopReason = buyStopReason(positionShares, { ok: true, reason: "" });
        if (stopReason) {
          const buys = openOrders.filter(order => matchingOrder(order, market.id, tokenId, outcome.id) && orderSide(order) === "BUY");
          if (buys.length) await cancelOrders(buys, `持仓监控：${stopReason}`);
        }
        await managePosition(position, market, book, openOrders);
      }
    }
  } catch (error) {
    log("⚠️ 持仓卖单监控失败", error.message);
  } finally {
    positionMonitorRunning = false;
  }
}

async function cycle() {
  if (cycleRunning || monitorRunning || positionMonitorRunning) return;
  cycleRunning = true;
  try {
    const markets = await getMarkets();
    const nextMarkets = new Map();
    for (const result of markets) {
      let market = result.market;
      let unavailableReason = result.unavailableReason;
      if (market && (!market.id || !Array.isArray(market.outcomes) || market.outcomes.length < 2)) {
        log("⚠️ 市场数据不完整", `market=${market?.id || "unknown"}`, `category=${result.categorySlug}`);
        market = null;
        unavailableReason = "市场或两个 outcome 不完整";
      }
      if (market) {
        try {
          validateUpDownMarket(market);
        } catch (error) {
          log("⚠️ 非 Up/Down 市场", `market=${market.id}`, error.message);
          market = null;
          unavailableReason = error.message;
        }
      }
      if (!market) {
        const previousMarkets = [...lastMarkets.values()].filter(item => item.categorySlug === result.categorySlug);
        for (const previousMarket of previousMarkets) {
          nextMarkets.set(String(previousMarket.id), { ...previousMarket, marketDataUnavailable: unavailableReason });
        }
        continue;
      }
      nextMarkets.set(String(market.id), market);
      for (const previousMarket of lastMarkets.values()) {
        if (previousMarket.categorySlug === result.categorySlug && String(previousMarket.id) !== String(market.id)) {
          nextMarkets.set(String(previousMarket.id), { ...previousMarket, marketDataUnavailable: "市场已切换，等待旧订单清理" });
        }
      }
    }
    lastMarkets.clear();
    for (const [marketId, market] of nextMarkets) lastMarkets.set(marketId, market);
    if (!lastMarkets.size) throw new Error("没有可做市的 Up/Down 市场");

    const [positions, openOrders, balanceWei, marketData] = await Promise.all([
      getPositions(),
      getOpenOrders(),
      LIVE_TRADING ? getBalance() : Promise.resolve(10n ** 30n),
      Promise.all([...lastMarkets.values()].map(async market => {
        try {
          const [book, stats] = await Promise.all([getBook(market.id), recentMatchStats(market)]);
          return { market, book, stats };
        } catch (error) {
          log("⚠️ 市场数据获取失败", `market=${market.id}`, error.message);
          return { market, book: null, stats: null };
        }
      })),
    ]);
    for (const { market, book, stats } of marketData) {
      if (!book || !stats) {
        const marketBuys = openOrders.filter(order => String(orderMarketId(order)) === String(market.id) && orderSide(order) === "BUY");
        if (marketBuys.length) await cancelOrders(marketBuys, "市场数据获取失败，撤销买单");
        continue;
      }
      const buyingAllowed = market.marketDataUnavailable
        ? { ok: false, reason: market.marketDataUnavailable }
        : canPlaceBuys(market, stats);
      log("📊 风控", `market=${market.id}`, `category=${market.categorySlug}`, `window=${inConfiguredWindow()}`, `buy=${buyingAllowed.ok}`, `reason=${buyingAllowed.reason || "ok"}`, `trades5m=${stats.trades}`, `shares5m=${stats.shares.toFixed(1)}`, `maxTrade=${stats.maxShares.toFixed(1)}`);
      for (const position of positions.filter(item => String(positionMarketId(item)) === String(market.id))) {
        await managePosition(position, market, book, openOrders);
      }
      if (!buyingAllowed.ok) {
        await cancelOrders(openOrders.filter(order => String(orderMarketId(order)) === String(market.id) && orderSide(order) === "BUY"), buyingAllowed.reason);
        continue;
      }
      for (const outcome of market.outcomes.slice(0, 2)) {
        // Each market/outcome has an independent cap equal to the account balance.
        const balanceBudget = { limitWei: balanceWei };
        await manageBuy(market, outcome, book, positions, openOrders, buyingAllowed, balanceBudget);
        await sleep(100);
      }
    }
    for (const [marketId, market] of lastMarkets) {
      if (market.marketDataUnavailable
        && !openOrders.some(order => String(orderMarketId(order)) === String(marketId))
        && !positions.some(position => String(positionMarketId(position)) === String(marketId))) {
        lastMarkets.delete(marketId);
        clearMarketState(marketId);
      }
    }
  } finally {
    cycleRunning = false;
  }
}

async function main() {
  log("🤖 上证指数涨跌直连做市脚本启动", `live=${LIVE_TRADING}`, `categories=${CATEGORY_SLUG.join(",")}`);
  if (!LIVE_TRADING) log("📝 当前为纸面模式，不会提交真实订单；设置 SSE_LIVE_TRADING=true 才会下单");
  setInterval(() => {
    monitorOpenBuyOrders().catch(error => log("⚠️ 挂单监控异常", error.message));
  }, ORDER_MONITOR_INTERVAL_MS);
  setInterval(() => {
    monitorPositions().catch(error => log("⚠️ 持仓卖单监控异常", error.message));
  }, POSITION_MONITOR_INTERVAL_MS);
  while (true) {
    try {
      await cycle();
    } catch (error) {
      log("❌ 上证做市循环失败", error.message);
    }
    await sleep(LOOP_INTERVAL_MS);
  }
}

main().catch(error => {
  log("💥 上证做市脚本启动失败", error.message);
  process.exitCode = 1;
});
