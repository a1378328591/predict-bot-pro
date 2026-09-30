import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTakerBuyCost } from "./predictTakerFee.js";
import { usMarketRegime } from "./marketSession.js";
import { SESSION_TREND_FIXED_SHARES as FIXED_SHARES } from "./sessionTrendConfig.js";
import { sessionTrendDirection } from "./sessionTrendRules.js";
import { beijingIso, utcIso } from "./timeFormat.js";

const LIVE_SIGNAL_MODE = process.argv.includes("--live");
const DATA_DIR = resolve("data/btc");
const SNAPSHOTS_FILE = resolve(DATA_DIR, "snapshots.jsonl");
const SIGNALS_FILE = resolve(DATA_DIR, LIVE_SIGNAL_MODE ? "session_trend_live_signals.jsonl" : "reversal_value_signals.jsonl");
const STATE_FILE = resolve(DATA_DIR, LIVE_SIGNAL_MODE ? "session_trend_live_signal_state.json" : "reversal_value_state.json");
const PAUSE_FILE = resolve(DATA_DIR, "reversal_value_pause.json");

const MIN_PRICE = 0.35;
const MAX_PRICE = 0.70;
const MAX_SPREAD = 0.02;
const MIN_MOVE_BPS = 1.0;
const MIN_GAP_BPS = 1;
const MIN_REMAINING_SECONDS = 30;
const MAX_REMAINING_SECONDS = 180;
const MIN_HISTORY_SECONDS = 45;
const MIN_HISTORY_OBSERVATIONS = 15;
const WEEKEND_MODE = "paper";
const WEEKDAY_CLOSED_MODE = "shadow";
const US_OPEN_MODE = "shadow";
const RESPECT_VOLATILITY_PAUSE = LIVE_SIGNAL_MODE;
const MAX_SNAPSHOT_AGE_MS = 10_000;
const TAIL_INTERVAL_MS = 500;

const state = loadState();
state.paper_buys ??= {};
let tailOffset = 0;
let tailRemainder = "";
let recordsSinceSave = 0;
let stopping = false;

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { paper_buys: {}, tail_offset: null };
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { paper_buys: {}, tail_offset: null };
  } catch {
    return { paper_buys: {}, tail_offset: null };
  }
}

function saveState() {
  state.paper_buys = Object.fromEntries(Object.entries(state.paper_buys).slice(-10_000));
  state.tail_offset = tailOffset;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  recordsSinceSave = 0;
}

function appendSignal(record) {
  appendFileSync(SIGNALS_FILE, JSON.stringify(record) + "\n", "utf8");
}

function activeVolatilityPause() {
  if (!RESPECT_VOLATILITY_PAUSE) return null;
  try {
    const pause = JSON.parse(readFileSync(PAUSE_FILE, "utf8"));
    return pause?.paused ? pause : null;
  } catch {
    return null;
  }
}

function outcomeQuote(snapshot, direction) {
  const outcome = (snapshot.outcomes || []).find(item => String(item?.outcome_name || "").toLowerCase() === direction);
  const asks = outcome?.book?.levels?.asks || [];
  let remaining = FIXED_SHARES;
  let cost = 0;
  for (const level of asks) {
    const shares = Math.min(remaining, Number(level.size));
    const price = Number(level.price);
    if (!(shares > 0) || !(price > 0 && price < 1)) continue;
    cost += shares * price;
    remaining -= shares;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9 || !(cost > 0)) return null;
  const vwap = cost / FIXED_SHARES;
  const costs = estimateTakerBuyCost(vwap, FIXED_SHARES, cost);
  return {
    outcome_id: outcome?.outcome_id ?? null,
    outcome_on_chain_id: outcome?.outcome_on_chain_id ?? null,
    best_bid: Number(outcome?.book?.best_bid?.price),
    best_ask: Number(outcome?.book?.best_ask?.price),
    spread: Number(outcome?.book?.spread),
    shares: FIXED_SHARES,
    vwap,
    notional_usd: cost,
    taker_fee_usd: costs.taker_fee_usd,
    total_cost_usd: costs.total_cost_usd,
    cost_per_share: costs.cost_per_share,
  };
}

function evaluate(snapshot) {
  const observedAtMs = Number(snapshot.observed_at_ms);
  if (!(observedAtMs > 0) || Date.now() - observedAtMs > MAX_SNAPSHOT_AGE_MS) return;
  if (state.paper_buys[snapshot.category_slug] || activeVolatilityPause()) return;

  const remainingSeconds = Number(snapshot.timing?.seconds_to_end);
  const historySeconds = Number(snapshot.timing?.seconds_from_price_interval_start);
  const observations = Number(snapshot.price_features?.history_observations);
  if (!(remainingSeconds >= MIN_REMAINING_SECONDS && remainingSeconds <= MAX_REMAINING_SECONDS)) return;
  if (!(historySeconds >= MIN_HISTORY_SECONDS) || !(observations >= MIN_HISTORY_OBSERVATIONS)) return;

  const startPrice = Number(snapshot.start_price);
  const bid = Number(snapshot.reference_price?.bid);
  const ask = Number(snapshot.reference_price?.ask);
  const mid = (bid + ask) / 2;
  const rawReturn30 = Number(snapshot.price_features?.return_30s);
  const rawReturn60 = Number(snapshot.price_features?.return_60s);
  if (!(startPrice > 0) || !(mid > 0) || !Number.isFinite(rawReturn30) || !Number.isFinite(rawReturn60)) return;
  const gapBps = Math.log(mid / startPrice) * 10_000;
  const return30Bps = Math.log1p(rawReturn30) * 10_000;
  const return60Bps = Math.log1p(rawReturn60) * 10_000;
  const direction = sessionTrendDirection({ gapBps, return30Bps, return60Bps, minGapBps: MIN_GAP_BPS, minMoveBps: MIN_MOVE_BPS });
  if (!direction) return;

  const quote = outcomeQuote(snapshot, direction);
  if (!quote) return;
  const reasons = [];
  if (!(quote.spread >= 0 && quote.spread <= MAX_SPREAD)) reasons.push("spread_too_wide");
  if (!(quote.vwap >= MIN_PRICE && quote.vwap <= MAX_PRICE)) reasons.push("price_out_of_range");
  const marketRegime = usMarketRegime(observedAtMs);
  const usRegularSession = marketRegime === "regular_open";
  const regimeMode = marketRegime === "weekend"
    ? WEEKEND_MODE
    : marketRegime === "weekday_closed"
      ? WEEKDAY_CLOSED_MODE
      : US_OPEN_MODE;
  if (regimeMode === "skip") reasons.push(`${marketRegime}_disabled`);

  const common = {
    schema_version: 2,
    observed_at: utcIso(observedAtMs),
    observed_at_ms: observedAtMs,
    observed_at_beijing: beijingIso(observedAtMs),
    strategy: "session_trend_v2",
    category_slug: snapshot.category_slug,
    market_id: snapshot.market_id,
    weekend: marketRegime === "weekend",
    us_regular_session: usRegularSession,
    us_market_regime: marketRegime,
    direction,
    remaining_seconds: remainingSeconds,
    start_price: startPrice,
    reference_price: mid,
    model: {
      style: "trend",
      gapBps,
      return30Bps,
      return60Bps,
      minGapBps: MIN_GAP_BPS,
      minMoveBps: MIN_MOVE_BPS,
    },
    quote,
  };
  appendSignal({ ...common, type: "PAPER_CANDIDATE", eligible: reasons.length === 0, reasons });
  if (reasons.length) return;

  const shadow = regimeMode !== "paper";
  const shadowType = marketRegime === "weekend"
    ? "WEEKEND_SHADOW_BUY"
    : marketRegime === "weekday_closed"
      ? "WEEKDAY_CLOSED_SHADOW_BUY"
      : "US_OPEN_SHADOW_BUY";
  const signal = {
    ...common,
    type: LIVE_SIGNAL_MODE ? "LIVE_BUY_SIGNAL" : shadow ? shadowType : "PAPER_BUY",
    execution_eligible: LIVE_SIGNAL_MODE || !shadow,
    note: LIVE_SIGNAL_MODE
      ? "Live execution signal. The executor must revalidate the current market and orderbook before submission."
      : shadow
      ? `${marketRegime} shadow signal. Excluded from the paper strategy until new holdout evidence is positive.`
      : "Forward paper signal only. This strategy never signs or submits orders.",
  };
  appendSignal(signal);
  state.paper_buys[snapshot.category_slug] = {
    observed_at: signal.observed_at,
    direction: signal.direction,
    price: quote.vwap,
    strategy: signal.strategy,
  };
  saveState();
  console.log(`${signal.observed_at_beijing} [Asia/Shanghai] ${signal.type} ${signal.category_slug} ${direction.toUpperCase()} price=${quote.cost_per_share.toFixed(3)} gap=${gapBps.toFixed(2)}bps r30=${return30Bps.toFixed(2)}bps remaining=${remainingSeconds.toFixed(1)}s`);
}

async function readTail() {
  if (!existsSync(SNAPSHOTS_FILE)) return;
  const size = statSync(SNAPSHOTS_FILE).size;
  if (size < tailOffset) {
    tailOffset = size;
    tailRemainder = "";
    saveState();
    return;
  }
  if (size <= tailOffset) return;
  let chunk = "";
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(SNAPSHOTS_FILE, { start: tailOffset, end: size - 1, encoding: "utf8" });
    stream.on("data", data => { chunk += data; });
    stream.on("end", resolveRead);
    stream.on("error", rejectRead);
  });
  tailOffset = size;
  const lines = (tailRemainder + chunk).split(/\r?\n/);
  tailRemainder = lines.pop() || "";
  for (const line of lines) {
    try {
      if (line) evaluate(JSON.parse(line));
    } catch (error) {
      console.error("Session signal evaluation failed:", error.message);
    }
    recordsSinceSave += 1;
  }
  if (recordsSinceSave >= 100) saveState();
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const currentSize = existsSync(SNAPSHOTS_FILE) ? statSync(SNAPSHOTS_FILE).size : 0;
  const persistedOffset = state.tail_offset === null || state.tail_offset === undefined ? null : Number(state.tail_offset);
  tailOffset = Number.isInteger(persistedOffset) ? Math.min(persistedOffset, currentSize) : currentSize;
  console.log(`BTC session trend v2 ${LIVE_SIGNAL_MODE ? "LIVE SIGNAL" : "paper"} strategy started.`);
  console.log(`Forward-only from byte ${tailOffset}. Weekend=${LIVE_SIGNAL_MODE ? "LIVE" : WEEKEND_MODE.toUpperCase()}, weekday closed=${LIVE_SIGNAL_MODE ? "LIVE" : WEEKDAY_CLOSED_MODE.toUpperCase()}, US open=${LIVE_SIGNAL_MODE ? "LIVE" : US_OPEN_MODE.toUpperCase()}.`);
  console.log(`Fixed shares=${FIXED_SHARES}. Price=${MIN_PRICE}-${MAX_PRICE}.`);
  console.log(`Output: ${SIGNALS_FILE}. This signal process never reads wallet credentials or submits orders.`);
  while (!stopping) {
    await readTail();
    await new Promise(resolveSleep => setTimeout(resolveSleep, TAIL_INTERVAL_MS));
  }
  saveState();
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

main().catch(error => {
  console.error("BTC session trend paper strategy failed:", error.message);
  process.exitCode = 1;
});
