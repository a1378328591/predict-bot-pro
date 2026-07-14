import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API_BASE_URL = process.env.PREDICT_API_BASE_URL || "https://api.predict.fun";
const API_KEY = process.env.PREDICT_API_KEY;
const OUTPUT_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SAMPLE_INTERVAL_MS = positiveInt(process.env.BTC_SAMPLE_INTERVAL_MS, 2_000);
const CATEGORY_REFRESH_MS = positiveInt(process.env.BTC_CATEGORY_REFRESH_MS, 10_000);
const DISCOVERY_INTERVAL_MS = positiveInt(process.env.BTC_DISCOVERY_INTERVAL_MS, 2_000);
const DEPTH_NOTIONALS_USD = (process.env.BTC_DEPTH_NOTIONALS_USD || "10,50,100")
  .split(",")
  .map(Number)
  .filter(value => Number.isFinite(value) && value > 0);

const FILES = {
  snapshots: "snapshots.jsonl",
  metadata: "market_metadata.jsonl",
  settlements: "settlements.jsonl",
  errors: "errors.jsonl",
  state: "active_categories.json",
};

const trackedCategories = new Map();
const priceHistory = new Map();

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(name, record) {
  appendFileSync(resolve(OUTPUT_DIR, FILES[name]), JSON.stringify(record) + "\n", "utf8");
}

function serializeError(stage, error, extra = {}) {
  appendJsonl("errors", {
    schema_version: 1,
    observed_at: nowIso(),
    stage,
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  });
}

function readState() {
  const file = resolve(OUTPUT_DIR, FILES.state);
  if (!existsSync(file)) return [];
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    serializeError("read_state", error);
    return [];
  }
}

function saveState() {
  const rows = [...trackedCategories.values()]
    .filter(item => !item.finalized)
    .map(item => ({ slug: item.slug, discovered_at: item.discoveredAt }));
  writeFileSync(resolve(OUTPUT_DIR, FILES.state), JSON.stringify(rows, null, 2), "utf8");
}

async function fetchJson(path, params = {}) {
  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!response.ok) throw new Error(`${response.status} ${url.pathname}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  if (body?.success === false) throw new Error(`API rejected ${url.pathname}: ${JSON.stringify(body).slice(0, 300)}`);
  return body?.data ?? body;
}

async function fetchBtcReference() {
  try {
    const sources = [
      { name: "binance_btcusdt_book_ticker", url: "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT" },
      { name: "binance_public_data_mirror_btcusdt_book_ticker", url: "https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT" },
    ];
    let lastError = null;
    for (const source of sources) {
      try {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
        const ticker = await response.json();
        const bid = Number(ticker.bidPrice);
        const ask = Number(ticker.askPrice);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) throw new Error(`${source.name} returned an invalid ticker`);
        return {
          source: source.name,
          bid,
          ask,
          mid: (bid + ask) / 2,
          bid_size: finiteOrNull(ticker.bidQty),
          ask_size: finiteOrNull(ticker.askQty),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("all Binance reference endpoints failed");
  } catch (error) {
    serializeError("reference_price", error);
    return null;
  }
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseDate(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date : null;
}

function getCategoryTimes(category) {
  const startsAt = parseDate(category?.startsAt ?? category?.startTime ?? category?.startDate);
  const endsAt = parseDate(category?.endsAt ?? category?.endTime ?? category?.endDate);
  return {
    starts_at: startsAt?.toISOString() ?? null,
    ends_at: endsAt?.toISOString() ?? null,
    seconds_from_start: startsAt ? (Date.now() - startsAt.getTime()) / 1_000 : null,
    seconds_to_end: endsAt ? (endsAt.getTime() - Date.now()) / 1_000 : null,
  };
}

function isExpectedBtcFiveMinuteCategory(category) {
  if (String(category?.marketVariant || "").toUpperCase() !== "CRYPTO_UP_DOWN") return false;
  const text = [category?.slug, category?.title, category?.shortTitle, category?.description, category?.variantData?.priceFeedSymbol]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!(text.includes("bitcoin") || /(^|[^a-z])btc([^a-z]|$)/.test(text))) return false;
  const startsAt = parseDate(category?.startsAt ?? category?.startTime ?? category?.startDate);
  const endsAt = parseDate(category?.endsAt ?? category?.endTime ?? category?.endDate);
  if (!startsAt || !endsAt) return false;
  return Math.abs((endsAt.getTime() - startsAt.getTime()) / 1_000 - 300) <= 2;
}

function getCurrentBtcFiveMinuteSlug() {
  const currentStartUnix = Math.floor(Date.now() / 1_000 / 300) * 300;
  return `btc-updown-5m-${currentStartUnix}`;
}

async function fetchCategory(slug) {
  return fetchJson(`/v1/categories/${encodeURIComponent(slug)}`);
}

async function fetchOrderbook(marketId) {
  return fetchJson(`/v1/markets/${encodeURIComponent(marketId)}/orderbook`);
}

function parseLevel(level) {
  const price = finiteOrNull(level?.price ?? level?.pricePerShare ?? level?.[0]);
  const size = finiteOrNull(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  if (price === null || size === null || price < 0 || price > 1 || size <= 0) return null;
  return { price, size };
}

function levels(value, direction) {
  const rows = Array.isArray(value) ? value.map(parseLevel).filter(Boolean) : [];
  return rows.sort((a, b) => direction === "bid" ? b.price - a.price : a.price - b.price);
}

function invertLevels(rows, direction) {
  return rows
    .map(level => ({ price: 1 - level.price, size: level.size }))
    .sort((a, b) => direction === "bid" ? b.price - a.price : a.price - b.price);
}

function outcomeBook(book, market, outcome) {
  const bids = levels(book?.bids, "bid");
  const asks = levels(book?.asks, "ask");
  const outcomeIndex = Array.isArray(market?.outcomes)
    ? market.outcomes.findIndex(item => String(item?.onChainId) === String(outcome?.onChainId))
    : -1;

  if (outcomeIndex === 1 && market?.outcomes?.length === 2) {
    return { bids: invertLevels(asks, "bid"), asks: invertLevels(bids, "ask"), representation: "inverted_binary_book" };
  }
  return { bids, asks, representation: "direct_book" };
}

function summarizeBook(book, feeRateBps) {
  const bestBid = book.bids[0] ?? null;
  const bestAsk = book.asks[0] ?? null;
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null;
  const feeRate = Number.isFinite(Number(feeRateBps)) ? Number(feeRateBps) / 10_000 : null;

  return {
    representation: book.representation,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread,
    bid_depth_shares: book.bids.reduce((total, level) => total + level.size, 0),
    ask_depth_shares: book.asks.reduce((total, level) => total + level.size, 0),
    bid_depth_usd: book.bids.reduce((total, level) => total + level.price * level.size, 0),
    ask_depth_usd: book.asks.reduce((total, level) => total + level.price * level.size, 0),
    buy_vwap: DEPTH_NOTIONALS_USD.map(notional => walkBuyBook(book.asks, notional, feeRate)),
    sell_vwap: DEPTH_NOTIONALS_USD.map(notional => walkSellBook(book.bids, notional, feeRate)),
    levels: { bids: book.bids, asks: book.asks },
  };
}

function walkBuyBook(asks, targetNotional, feeRate) {
  let spent = 0;
  let shares = 0;
  for (const level of asks) {
    const availableCost = level.price * level.size;
    const cost = Math.min(targetNotional - spent, availableCost);
    if (cost <= 0) break;
    spent += cost;
    shares += cost / level.price;
  }
  const filled = spent >= targetNotional - 1e-9;
  const feeEstimate = feeRate === null ? null : spent * feeRate;
  return {
    target_notional_usd: targetNotional,
    filled_notional_usd: spent,
    filled_shares: shares,
    fully_filled: filled,
    vwap: shares > 0 ? spent / shares : null,
    estimated_linear_fee_usd: feeEstimate,
    estimated_total_cost_usd: feeEstimate === null ? null : spent + feeEstimate,
  };
}

function walkSellBook(bids, targetNotional, feeRate) {
  let proceeds = 0;
  let shares = 0;
  for (const level of bids) {
    const availableValue = level.price * level.size;
    const value = Math.min(targetNotional - proceeds, availableValue);
    if (value <= 0) break;
    proceeds += value;
    shares += value / level.price;
  }
  const filled = proceeds >= targetNotional - 1e-9;
  const feeEstimate = feeRate === null ? null : proceeds * feeRate;
  return {
    target_notional_usd: targetNotional,
    filled_notional_usd: proceeds,
    filled_shares: shares,
    fully_filled: filled,
    vwap: shares > 0 ? proceeds / shares : null,
    estimated_linear_fee_usd: feeEstimate,
    estimated_net_proceeds_usd: feeEstimate === null ? null : proceeds - feeEstimate,
  };
}

function updatePriceFeatures(categorySlug, referenceMid) {
  if (!Number.isFinite(referenceMid)) return null;
  const now = Date.now();
  const history = priceHistory.get(categorySlug) ?? [];
  history.push({ time: now, price: referenceMid });
  while (history.length && history[0].time < now - 10 * 60_000) history.shift();
  priceHistory.set(categorySlug, history);

  const returnForWindow = windowMs => {
    const before = [...history].reverse().find(row => row.time <= now - windowMs);
    return before ? referenceMid / before.price - 1 : null;
  };

  const oneSecondReturns = [];
  for (let index = 1; index < history.length; index++) {
    const elapsed = history[index].time - history[index - 1].time;
    if (elapsed >= 500 && elapsed <= 5_000) oneSecondReturns.push(history[index].price / history[index - 1].price - 1);
  }
  const realizedVolatility = oneSecondReturns.length > 1
    ? Math.sqrt(oneSecondReturns.reduce((sum, value) => sum + value * value, 0) / oneSecondReturns.length)
    : null;

  return {
    return_5s: returnForWindow(5_000),
    return_30s: returnForWindow(30_000),
    return_60s: returnForWindow(60_000),
    return_300s: returnForWindow(300_000),
    realized_volatility_per_observation: realizedVolatility,
    history_observations: history.length,
  };
}

function categoryMetadataSignature(category) {
  return JSON.stringify({
    status: category?.status,
    startsAt: category?.startsAt,
    endsAt: category?.endsAt,
    variantData: category?.variantData,
    markets: (category?.markets || []).map(market => ({
      id: market.id,
      status: market.status,
      tradingStatus: market.tradingStatus,
      resolution: market.resolution,
      outcomes: market.outcomes,
      feeRateBps: market.feeRateBps,
    })),
  });
}

function rememberCategory(category, source) {
  const slug = String(category?.slug || "");
  if (!slug) return;
  const existing = trackedCategories.get(slug) ?? { slug, discoveredAt: nowIso(), finalized: false, metadataSignature: "" };
  existing.category = category;
  existing.lastCategoryRefreshAt = Date.now();
  existing.source = source;
  const signature = categoryMetadataSignature(category);
  if (signature !== existing.metadataSignature) {
    appendJsonl("metadata", {
      schema_version: 1,
      observed_at: nowIso(),
      source,
      category_slug: slug,
      category_id: category.id ?? null,
      category,
    });
    existing.metadataSignature = signature;
  }
  trackedCategories.set(slug, existing);
}

function categoryIsResolved(category) {
  if (String(category?.status || "").toUpperCase() === "RESOLVED") return true;
  const markets = Array.isArray(category?.markets) ? category.markets : [];
  return markets.length > 0 && markets.every(market => String(market?.status || "").toUpperCase() === "RESOLVED");
}

function recordSettlement(item) {
  if (item.finalized || !item.category) return;
  appendJsonl("settlements", {
    schema_version: 1,
    observed_at: nowIso(),
    category_slug: item.slug,
    category_id: item.category.id ?? null,
    category_status: item.category.status ?? null,
    resolution_provider: item.category.resolutionProvider ?? null,
    variant_data: item.category.variantData ?? null,
    starts_at: item.category.startsAt ?? null,
    ends_at: item.category.endsAt ?? null,
    markets: (item.category.markets || []).map(market => ({
      id: market.id,
      title: market.title,
      question: market.question,
      status: market.status,
      trading_status: market.tradingStatus,
      resolution: market.resolution ?? null,
      outcomes: market.outcomes ?? [],
      fee_rate_bps: market.feeRateBps ?? null,
    })),
    raw_category: item.category,
  });
  item.finalized = true;
}

async function snapshotCategory(item, reference) {
  const category = item.category;
  if (!category || item.finalized) return;
  const time = getCategoryTimes(category);
  const referenceFeatures = updatePriceFeatures(item.slug, reference?.mid);
  const startPrice = finiteOrNull(category?.variantData?.startPrice);
  const endPrice = finiteOrNull(category?.variantData?.endPrice);
  const markets = Array.isArray(category.markets) ? category.markets : [];

  for (const market of markets) {
    try {
      const rawBook = await fetchOrderbook(market.id);
      const outcomeSummaries = (market.outcomes || []).map(outcome => {
        const sidedBook = outcomeBook(rawBook, market, outcome);
        return {
          outcome_id: outcome.id ?? null,
          outcome_name: outcome.name ?? null,
          outcome_on_chain_id: outcome.onChainId ?? null,
          outcome_status: outcome.status ?? null,
          book: summarizeBook(sidedBook, market.feeRateBps),
        };
      });

      appendJsonl("snapshots", {
        schema_version: 1,
        observed_at: nowIso(),
        observed_at_ms: Date.now(),
        category_slug: item.slug,
        category_id: category.id ?? null,
        category_status: category.status ?? null,
        market_id: market.id,
        market_title: market.title ?? null,
        market_question: market.question ?? null,
        market_status: market.status ?? null,
        market_trading_status: market.tradingStatus ?? null,
        market_variant: market.marketVariant ?? category.marketVariant ?? null,
        fee_rate_bps: market.feeRateBps ?? null,
        decimal_precision: market.decimalPrecision ?? null,
        resolution_provider: category.resolutionProvider ?? null,
        price_feed_provider: category.variantData?.priceFeedProvider ?? null,
        price_feed_symbol: category.variantData?.priceFeedSymbol ?? null,
        start_price: startPrice,
        end_price: endPrice,
        reference_price: reference,
        reference_minus_start: reference?.mid && startPrice ? reference.mid - startPrice : null,
        reference_return_from_start: reference?.mid && startPrice ? reference.mid / startPrice - 1 : null,
        price_features: referenceFeatures,
        timing: time,
        outcomes: outcomeSummaries,
        raw_orderbook: rawBook,
      });
    } catch (error) {
      serializeError("snapshot_orderbook", error, { category_slug: item.slug, market_id: market.id });
    }
  }
}

async function refreshTrackedCategories() {
  const refreshes = [...trackedCategories.values()]
    .filter(item => !item.finalized && (!item.lastCategoryRefreshAt || Date.now() - item.lastCategoryRefreshAt >= CATEGORY_REFRESH_MS))
    .map(async item => {
      try {
        rememberCategory(await fetchCategory(item.slug), "category_refresh");
        const current = trackedCategories.get(item.slug);
        if (current && categoryIsResolved(current.category)) recordSettlement(current);
      } catch (error) {
        serializeError("category_refresh", error, { category_slug: item.slug });
      }
    });
  await Promise.all(refreshes);
  saveState();
}

async function discover() {
  const slug = getCurrentBtcFiveMinuteSlug();
  const category = await fetchCategory(slug);
  if (!isExpectedBtcFiveMinuteCategory(category)) {
    throw new Error(`Unexpected category returned for ${slug}`);
  }
  rememberCategory(category, "current_slug_discovery");
  saveState();
  return slug;
}

async function main() {
  if (!API_KEY) throw new Error("Missing PREDICT_API_KEY. The collector only needs the Predict API key.");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const persisted of readState()) {
    if (persisted?.slug) trackedCategories.set(String(persisted.slug), {
      slug: String(persisted.slug),
      discoveredAt: persisted.discovered_at || nowIso(),
      finalized: false,
      metadataSignature: "",
    });
  }

  console.log(`BTC sample collector started. Output: ${OUTPUT_DIR}`);
  console.log(`Sample interval: ${SAMPLE_INTERVAL_MS}ms. This process never creates, cancels, or signs orders.`);

  let nextDiscoveryAt = 0;
  while (true) {
    const startedAt = Date.now();
    try {
      if (Date.now() >= nextDiscoveryAt) {
        const slug = await discover();
        console.log(`${nowIso()} tracking current BTC category ${slug}; pending settlements ${[...trackedCategories.values()].filter(item => !item.finalized).length}.`);
        nextDiscoveryAt = Date.now() + DISCOVERY_INTERVAL_MS;
      }

      await refreshTrackedCategories();
      const reference = await fetchBtcReference();
      await Promise.all([...trackedCategories.values()].filter(item => !item.finalized).map(item => snapshotCategory(item, reference)));
    } catch (error) {
      serializeError("collector_loop", error);
      console.error(`${nowIso()} collector error:`, error.message);
    }

    await sleep(Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - startedAt)));
  }
}

main().catch(error => {
  console.error("BTC sample collector failed to start:", error.message);
  process.exitCode = 1;
});
