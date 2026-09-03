import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const apiKey = process.env.PREDICT_API_KEY;
if (!apiKey) {
  throw new Error("诊断需要显式传入进程环境变量 PREDICT_API_KEY；本脚本不会读取 .env");
}
const headers = { "x-api-key": apiKey };
const proxyUrl = process.env.FICLASH_PROXY_URL || "http://127.0.0.1:7890";
const proxyAgent = new HttpsProxyAgent(proxyUrl);
const cfg = { amount: 100, minPrice: 0.10, tolerance: 0.001, minPolyUsd: 20 };
const jsonArray = value => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return []; }
};
const date = value => {
  const parsed = new Date(value);
  return value && !Number.isNaN(parsed.getTime()) ? parsed : null;
};
const firstDate = values => values.map(date).find(Boolean) ?? null;
const level = (items, ask) => {
  const levels = (items || []).map(item => ({
    price: Number(item.price ?? item[0]),
    size: Number(item.size ?? item.quantity ?? item.shares ?? item[1]),
  })).filter(item => Number.isFinite(item.price) && Number.isFinite(item.size));
  levels.sort((a, b) => ask ? a.price - b.price : b.price - a.price);
  return levels[0] ?? null;
};
const levels = (items, ask) => {
  const result = (items || []).map(item => ({
    price: Number(item.price ?? item[0]),
    size: Number(item.size ?? item.quantity ?? item.shares ?? item[1]),
  })).filter(item => Number.isFinite(item.price) && Number.isFinite(item.size));
  result.sort((a, b) => ask ? a.price - b.price : b.price - a.price);
  return result;
};
async function fetchJson(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { ...options, agent: proxyAgent });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
async function mapLimit(items, limit, fn) {
  const result = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

const query = new URLSearchParams({
  first: "100", status: "OPEN", hasActiveRewards: "true",
  marketVariant: "ESPORTS_DOTA2", tagIds: "850", sort: "REWARD_RATE_DESC",
});
const marketJson = await fetchJson("https://api.predict.fun/v1/markets?" + query, { headers });
const markets = marketJson.data || [];
const marketResults = await mapLimit(markets, 6, async market => {
  const result = { id: market.id, event: market.categorySlug, question: market.question, outcomes: [] };
  let predictBook;
  try { predictBook = (await fetchJson(`https://api.predict.fun/v1/markets/${market.id}/orderbook`, { headers })).data; }
  catch (error) { return { ...result, marketReason: "predictBookError: " + error.message }; }
  const directBid = level(predictBook?.bids, false);
  const directAsk = level(predictBook?.asks, true);
  let polyMarket = null;
  try {
    const conditionId = market.polymarketConditionIds?.[0];
    for (const endpoint of [
      "https://gamma-api.polymarket.com/markets?condition_ids=",
      "https://gamma-api.polymarket.com/markets?condition_id=",
    ]) {
      try {
        const data = await fetchJson(endpoint + encodeURIComponent(conditionId));
        polyMarket = (Array.isArray(data) ? data : data.data)?.[0] ?? null;
        if (polyMarket) break;
      } catch {}
    }
    if (!polyMarket) return { ...result, marketReason: "polyMarketUnavailable" };
  } catch (error) { return { ...result, marketReason: "polyMarketError: " + error.message }; }
  const polyOutcomes = jsonArray(polyMarket?.outcomes);
  const polyTokens = jsonArray(polyMarket?.clobTokenIds ?? polyMarket?.clob_token_ids);
  const startsAt = firstDate([
    polyMarket?.gameStartTime, polyMarket?.eventStartTime, polyMarket?.startTime,
    polyMarket?.events?.[0]?.startTime, polyMarket?.events?.[0]?.eventDate,
    market?.gameStartTime, market?.eventStartTime, market?.startTime,
    market?.events?.[0]?.startTime, market?.events?.[0]?.eventDate,
  ]);
  for (const outcome of market.outcomes || []) {
    const item = { outcome: outcome.name };
    let index = polyOutcomes.findIndex(name => String(name).trim().toLowerCase() === String(outcome.name).trim().toLowerCase());
    if (index < 0) index = Number(outcome.indexSet) - 1;
    const tokenId = polyTokens[index];
    if (!tokenId) { item.reason = "pmTokenMapping"; result.outcomes.push(item); continue; }
    const book = await fetchJson("https://clob.polymarket.com/book?token_id=" + encodeURIComponent(tokenId));
    const polyBids = levels(book?.bids, false);
    const polyBid = polyBids[0];
    if (!polyBid) item.reason = "pmNoBid";
    else {
      item.pmBid = polyBid.price;
      item.pmBidSize = polyBid.size;
      item.pmBidUsd = polyBid.price * polyBid.size;
      item.pmBid2 = polyBids[1]?.price ?? null;
      item.pmBid2Size = polyBids[1]?.size ?? null;
      item.pmBid2Usd = polyBids[1] ? polyBids[1].price * polyBids[1].size : null;
    }
    if (polyBid && polyBid.price * polyBid.size < cfg.minPolyUsd) item.reason = "pmBidDepth";
    else if (polyBid) {
      let bid = directBid;
      let ask = directAsk;
      const position = (market.outcomes || []).findIndex(value => String(value.onChainId) === String(outcome.onChainId));
      if (position === 1 && market.outcomes?.length === 2) {
        bid = directAsk ? { price: 1 - directAsk.price, size: directAsk.size } : null;
        ask = directBid ? { price: 1 - directBid.price, size: directBid.size } : null;
      }
      if (!bid) item.reason = "predictNoBid";
      else if (!ask) item.reason = "predictNoAsk";
      else if (bid.price < cfg.minPrice || bid.price > 0.99) item.reason = "priceRange";
      else if (polyBid.price + cfg.tolerance < bid.price) item.reason = "predictBidAbovePM";
      else if (ask.price <= bid.price + 1e-9) item.reason = "askNotAboveBuy";
      else if (ask.size < cfg.amount / bid.price) item.reason = "predictAskSize";
      else item.reason = "eligible";
      item.predictBid = bid?.price;
      item.predictAsk = ask?.price;
      item.predictAskSize = ask?.size;
    }
    result.outcomes.push(item);
  }
  result.predictBid = directBid;
  result.predictAsk = directAsk;
  result.startsAt = startsAt?.toISOString() ?? null;
  return result;
});
const counts = {};
const lowPmBids = [];
for (const market of marketResults) {
  for (const outcome of market.outcomes || []) {
    counts[outcome.reason] = (counts[outcome.reason] || 0) + 1;
    if (outcome.reason === "pmBidDepth" && outcome.pmBidUsd < 10) lowPmBids.push({
      marketId: market.id,
      event: market.event,
      question: market.question,
      outcome: outcome.outcome,
      pmBid: outcome.pmBid ?? null,
      pmBidSize: outcome.pmBidSize ?? null,
      pmBidUsd: outcome.pmBidUsd ?? null,
      pmBid2: outcome.pmBid2 ?? null,
      pmBid2Size: outcome.pmBid2Size ?? null,
      pmBid2Usd: outcome.pmBid2Usd ?? null,
    });
  }
}
console.log(JSON.stringify({ config: cfg, marketCount: markets.length, outcomeReasonCounts: counts, lowPmBids, markets: marketResults }, null, 2));
