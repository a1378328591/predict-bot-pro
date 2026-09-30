import "dotenv/config";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
import { estimateTakerBuyCost } from "./predictTakerFee.js";
import { estimateBtc5mProbability } from "./btc5mProbabilityModel.js";

const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SNAPSHOTS_FILE = resolve(DATA_DIR, "snapshots.jsonl");
const SETTLEMENTS_FILE = resolve(DATA_DIR, "settlements.jsonl");
const SIGNALS_FILE = resolve(DATA_DIR, "z_score_signals.jsonl");
const STATE_FILE = resolve(DATA_DIR, "z_score_signal_state.json");

const FAST_VOL_WINDOW_SECONDS = positiveInt(process.env.Z_FAST_VOLATILITY_WINDOW_SECONDS, 30);
const SLOW_VOL_WINDOW_SECONDS = positiveInt(process.env.Z_SLOW_VOLATILITY_WINDOW_SECONDS, 180);
const MIN_HISTORY_SECONDS = positiveInt(process.env.Z_MIN_HISTORY_SECONDS, 25);
const MIN_HISTORY_OBSERVATIONS = positiveInt(process.env.Z_MIN_HISTORY_OBSERVATIONS, 10);
const VOL_FLOOR_BPS = positiveNumber(process.env.Z_VOLATILITY_FLOOR_BPS, 0.5);
const VOLATILITY_UNCERTAINTY = positiveNumber(process.env.Z_VOLATILITY_UNCERTAINTY, 1.15);
const MICROPRICE_WEIGHT = nonnegativeNumber(process.env.Z_MICROPRICE_WEIGHT, 0.5);
const ENTRY_Z = positiveNumber(process.env.Z_ENTRY_THRESHOLD, 0.5);
const EDGE_MARGIN = nonnegativeNumber(process.env.Z_EDGE_MARGIN, 0.005);
const MIN_ENTRY_PROBABILITY = nonnegativeNumber(process.env.Z_MIN_ENTRY_PROBABILITY, 0.70);
const MIN_CALIBRATION_SAMPLES = positiveInt(process.env.Z_MIN_CALIBRATION_SAMPLES, 30);
const CONFIDENCE_Z = positiveNumber(process.env.Z_CONFIDENCE_Z, 1.64);
const MAX_SPREAD = positiveNumber(process.env.Z_MAX_SPREAD, 0.02);
const TRADE_NOTIONAL_USD = positiveNumber(process.env.Z_TRADE_NOTIONAL_USD, 10);
const MAX_SNAPSHOT_AGE_MS = positiveInt(process.env.Z_MAX_SNAPSHOT_AGE_MS, 10_000);
const MAX_REFERENCE_AGE_MS = positiveInt(process.env.Z_MAX_REFERENCE_AGE_MS, 5_000);
const TAIL_INTERVAL_MS = positiveInt(process.env.Z_TAIL_INTERVAL_MS, 1_000);

const Z_BINS = [0, 2, 3, 4, 6, 10, Infinity];
const TIME_BINS = [0, 5, 15, 30, 60, 120, 300, Infinity];
const ASK_BINS = [0, 0.7, 0.8, 0.9, 0.95, 0.98, 1.000001];

const settlements = new Map();
const calibration = new Map();
const histories = new Map();
const calibrationSeen = new Set();
const state = loadState();
state.paper_buys ??= {};
state.paper_skips ??= {};
let tailOffset = 0;
let tailRemainder = "";

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { paper_buys: {}, paper_skips: {} };
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { paper_buys: {}, paper_skips: {} };
  } catch {
    return { paper_buys: {}, paper_skips: {} };
  }
}

function saveState() {
  state.paper_buys = Object.fromEntries(Object.entries(state.paper_buys || {}).slice(-2_000));
  state.paper_skips = Object.fromEntries(Object.entries(state.paper_skips || {}).slice(-2_000));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function streamJsonl(file, onRecord) {
  if (!existsSync(file)) return;
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      onRecord(JSON.parse(line));
    } catch {
      // Ignore an incomplete line if the collector is appending while bootstrapping.
    }
  }
}

function settlementWinner(settlement) {
  const startPrice = Number(settlement?.variant_data?.startPrice);
  const endPrice = Number(settlement?.variant_data?.endPrice);
  if (Number.isFinite(startPrice) && Number.isFinite(endPrice) && startPrice === endPrice) return null;
  const market = settlement?.markets?.[0];
  return String(market?.outcomes?.find(outcome => outcome?.status === "WON")?.name ?? market?.resolution?.name ?? "").toLowerCase();
}

function bucket(value, boundaries) {
  for (let index = 0; index < boundaries.length - 1; index++) {
    if (value >= boundaries[index] && value < boundaries[index + 1]) return `${boundaries[index]}-${boundaries[index + 1]}`;
  }
  return null;
}

function calibrationKeys(features) {
  const z = bucket(features.z_score, Z_BINS);
  const time = bucket(features.remaining_seconds, TIME_BINS);
  const ask = bucket(features.ask, ASK_BINS);
  if (!z || !time || !ask) return [];
  return [`z:${z}|time:${time}|ask:${ask}`, `z:${z}|time:${time}`, `z:${z}`, "global"];
}

function addCalibration(features, won) {
  const keys = calibrationKeys(features);
  if (!keys.length) return;
  // One market contributes at most once so correlated snapshots cannot inflate confidence.
  const detailedKey = features.category_slug;
  if (calibrationSeen.has(detailedKey)) return;
  calibrationSeen.add(detailedKey);
  for (const key of keys) {
    const stats = calibration.get(key) ?? { wins: 0, total: 0 };
    stats.total += 1;
    if (won) stats.wins += 1;
    calibration.set(key, stats);
  }
}

function probabilityEstimate(features) {
  const global = calibration.get("global") ?? { wins: 0, total: 0 };
  const analyticProbability = features.model_probability;
  const analyticLowerBound = features.conservative_probability;
  for (const key of calibrationKeys(features)) {
    const stats = calibration.get(key);
    if (!stats || stats.total < MIN_CALIBRATION_SAMPLES) continue;
    const empiricalProbability = (stats.wins + 2) / (stats.total + 4);
    const standardError = Math.sqrt(empiricalProbability * (1 - empiricalProbability) / (stats.total + 4));
    const empiricalLowerBound = Math.max(0, empiricalProbability - CONFIDENCE_Z * standardError);
    const empiricalWeight = Math.min(0.5, stats.total / (stats.total + 100));
    return {
      source: `analytic+${key}`,
      samples: stats.total,
      wins: stats.wins,
      probability: analyticProbability * (1 - empiricalWeight) + empiricalProbability * empiricalWeight,
      lower_bound: analyticLowerBound * (1 - empiricalWeight) + empiricalLowerBound * empiricalWeight,
      analytic_probability: analyticProbability,
      analytic_lower_bound: analyticLowerBound,
      empirical_probability: empiricalProbability,
      empirical_weight: empiricalWeight,
    };
  }
  return {
    source: "analytic_diffusion",
    samples: global.total,
    wins: global.wins,
    probability: analyticProbability,
    lower_bound: analyticLowerBound,
    analytic_probability: analyticProbability,
    analytic_lower_bound: analyticLowerBound,
    empirical_probability: null,
    empirical_weight: 0,
  };
}

function updatePriceHistory(snapshot) {
  const slug = snapshot.category_slug;
  const fetchedAt = Number(snapshot.reference_price?.fetched_at_ms);
  const time = Number.isFinite(fetchedAt) ? fetchedAt : Number(snapshot.observed_at_ms);
  const bid = Number(snapshot.reference_price?.bid);
  const ask = Number(snapshot.reference_price?.ask);
  const price = (bid + ask) / 2;
  if (!slug || !Number.isFinite(time) || !(price > 0)) return null;

  const history = histories.get(slug) ?? { points: [] };
  if (history.points.at(-1)?.time !== time) history.points.push({ time, price });
  const oldestTime = time - Math.max(FAST_VOL_WINDOW_SECONDS, SLOW_VOL_WINDOW_SECONDS) * 1_000 - 10_000;
  while (history.points.length && history.points[0].time < oldestTime) history.points.shift();
  histories.set(slug, history);
  return history.points;
}

function buyQuote(snapshot, direction) {
  const outcome = (snapshot.outcomes || []).find(item => String(item?.outcome_name || "").toLowerCase() === direction);
  const book = outcome?.book;
  const ask = Number(book?.best_ask?.price);
  const bid = Number(book?.best_bid?.price);
  const spread = Number(book?.spread);
  const vwap = (book?.buy_vwap || []).find(item => Number(item?.target_notional_usd) === TRADE_NOTIONAL_USD && item?.fully_filled);
  const shares = Number(vwap?.filled_shares);
  const notional = Number(vwap?.filled_notional_usd);
  const vwapPrice = Number(vwap?.vwap);
  const costs = estimateTakerBuyCost(vwapPrice, shares, notional);
  if (!(ask > 0 && ask < 1) || !(bid >= 0 && bid < 1) || !(spread >= 0 && spread <= MAX_SPREAD) || !(shares > 0) || !(notional > 0)) return null;
  return {
    ask,
    bid,
    spread,
    vwap: vwapPrice,
    shares,
    notional_usd: notional,
    taker_fee_usd: costs.taker_fee_usd,
    total_cost_usd: costs.total_cost_usd,
    cost_per_share: costs.cost_per_share,
  };
}

function features(snapshot) {
  const startPrice = Number(snapshot.start_price);
  const reference = snapshot.reference_price || {};
  const fetchedAt = Number(reference.fetched_at_ms);
  const referenceTime = Number.isFinite(fetchedAt) ? fetchedAt : Number(snapshot.observed_at_ms);
  const endTime = new Date(snapshot.timing?.ends_at || "").getTime();
  const remainingSeconds = (endTime - referenceTime) / 1_000;
  const provider = String(snapshot.price_feed_provider || "").toLowerCase();
  const symbol = String(snapshot.price_feed_symbol || "").toLowerCase().replace(/[^a-z]/g, "");
  const referenceAgeMs = Number.isFinite(fetchedAt) ? Number(snapshot.observed_at_ms) - referenceTime : 0;
  if (provider !== "chainlink" || symbol !== "btcusdt") return null;
  if (!Number.isFinite(referenceAgeMs) || referenceAgeMs < 0 || referenceAgeMs > MAX_REFERENCE_AGE_MS) return null;
  const points = updatePriceHistory(snapshot);
  if (!points || !(startPrice > 0) || !(remainingSeconds > 0)) return null;

  const model = estimateBtc5mProbability({
    startPrice,
    bid: reference.bid,
    ask: reference.ask,
    bidSize: reference.bid_size,
    askSize: reference.ask_size,
    remainingSeconds,
    points,
    nowMs: referenceTime,
    fastWindowSeconds: FAST_VOL_WINDOW_SECONDS,
    slowWindowSeconds: SLOW_VOL_WINDOW_SECONDS,
    minimumHistorySeconds: MIN_HISTORY_SECONDS,
    minimumObservations: MIN_HISTORY_OBSERVATIONS,
    volatilityFloorBps: VOL_FLOOR_BPS,
    volatilityUncertainty: VOLATILITY_UNCERTAINTY,
    micropriceWeight: MICROPRICE_WEIGHT,
  });
  if (!model) return null;

  const candidates = [
    { direction: "up", probability: model.upProbability, conservativeProbability: model.conservativeUpProbability },
    { direction: "down", probability: 1 - model.upProbability, conservativeProbability: model.conservativeDownProbability },
  ].filter(candidate => candidate.conservativeProbability >= MIN_ENTRY_PROBABILITY).map(candidate => {
    const quote = buyQuote(snapshot, candidate.direction);
    return quote ? { ...candidate, quote, edge: candidate.conservativeProbability - quote.cost_per_share } : null;
  }).filter(Boolean).sort((left, right) => right.edge - left.edge);
  const selected = candidates[0];

  const deviationBps = Math.abs(Math.log(model.modelPrice / startPrice)) * 10_000;
  return {
    category_slug: snapshot.category_slug,
    observed_at: snapshot.observed_at,
    observed_at_ms: snapshot.observed_at_ms,
    direction: selected?.direction ?? model.direction,
    remaining_seconds: remainingSeconds,
    start_price: startPrice,
    reference_price: model.mid,
    microprice: model.microprice,
    model_price: model.modelPrice,
    deviation_bps: deviationBps,
    z_score: model.zScore,
    signed_z: model.signedZ,
    model_probability: selected?.probability ?? model.probability,
    conservative_probability: selected?.conservativeProbability ?? model.conservativeProbability,
    up_probability: model.upProbability,
    conservative_up_probability: model.conservativeUpProbability,
    conservative_down_probability: model.conservativeDownProbability,
    sigma_bps_per_sqrt_second: model.sigmaBpsPerSqrtSecond,
    fast_variance_per_second: model.fastVariancePerSecond,
    slow_variance_per_second: model.slowVariancePerSecond,
    history_seconds: model.historySeconds,
    observations: model.observations,
    raw_model_direction: model.direction,
    model_edge_before_margin: selected?.edge ?? null,
    ...(selected?.quote ?? {
      ask: null,
      bid: null,
      spread: null,
      vwap: null,
      shares: null,
      notional_usd: null,
      taker_fee_usd: null,
      total_cost_usd: null,
      cost_per_share: null,
    }),
  };
}

function trainOnSnapshot(snapshot) {
  const computed = features(snapshot);
  const winner = settlements.get(snapshot.category_slug);
  const analyticEntry = computed
    && computed.z_score >= ENTRY_Z
    && Number.isFinite(computed.cost_per_share)
    && computed.conservative_probability >= MIN_ENTRY_PROBABILITY
    && computed.conservative_probability > computed.cost_per_share + EDGE_MARGIN;
  if (analyticEntry && winner) addCalibration(computed, computed.direction === winner);
}

function evaluateLiveSnapshot(snapshot) {
  const computed = features(snapshot);
  if (!computed) return;
  if (Date.now() - computed.observed_at_ms > MAX_SNAPSHOT_AGE_MS) return;

  const modelUpdate = {
    schema_version: 1,
    type: "MODEL_UPDATE",
    observed_at: new Date().toISOString(),
    features: computed,
  };
  appendFileSync(SIGNALS_FILE, JSON.stringify(modelUpdate) + "\n", "utf8");

  if (computed.z_score < ENTRY_Z) return;
  if (!Number.isFinite(computed.cost_per_share)) return;
  if (computed.conservative_probability < MIN_ENTRY_PROBABILITY) return;
  if (state.paper_buys?.[computed.category_slug]) return;

  const estimate = probabilityEstimate(computed);
  const breakEvenProbability = computed.cost_per_share;
  const requiredProbability = breakEvenProbability + EDGE_MARGIN;
  if (estimate.lower_bound <= requiredProbability) {
    if (!state.paper_skips?.[computed.category_slug]) {
      const reason = "probability_lower_bound_below_required";
      const skip = {
        schema_version: 1,
        type: "PAPER_SKIP",
        observed_at: new Date().toISOString(),
        reason,
        features: computed,
        probability: estimate,
        break_even_probability: breakEvenProbability,
        required_probability: requiredProbability,
        note: "Diagnostic record only. A later snapshot may still qualify for PAPER_BUY.",
      };
      appendFileSync(SIGNALS_FILE, JSON.stringify(skip) + "\n", "utf8");
      state.paper_skips[computed.category_slug] = { observed_at: skip.observed_at, reason };
      saveState();
      console.log(`${skip.observed_at} PAPER_SKIP ${computed.category_slug} ${computed.direction.toUpperCase()} z=${computed.z_score.toFixed(2)} reason=${reason} p_low=${estimate.lower_bound.toFixed(3)} required=${requiredProbability.toFixed(3)}`);
    }
    return;
  }

  const signal = {
    schema_version: 1,
    type: "PAPER_BUY",
    observed_at: new Date().toISOString(),
    strategy: {
      z_entry_threshold: ENTRY_Z,
      model: "dual_volatility_diffusion_v1",
      fast_volatility_window_seconds: FAST_VOL_WINDOW_SECONDS,
      slow_volatility_window_seconds: SLOW_VOL_WINDOW_SECONDS,
      volatility_uncertainty: VOLATILITY_UNCERTAINTY,
      microprice_weight: MICROPRICE_WEIGHT,
      edge_margin: EDGE_MARGIN,
      min_entry_probability: MIN_ENTRY_PROBABILITY,
      max_spread: MAX_SPREAD,
      trade_notional_usd: TRADE_NOTIONAL_USD,
    },
    features: computed,
    probability: estimate,
    break_even_probability: breakEvenProbability,
    required_probability: requiredProbability,
    note: "Paper signal only. This process has no order, wallet, JWT, or private-key code.",
  };
  appendFileSync(SIGNALS_FILE, JSON.stringify(signal) + "\n", "utf8");
  state.paper_buys[computed.category_slug] = { observed_at: signal.observed_at, direction: computed.direction };
  saveState();
  console.log(`${signal.observed_at} PAPER_BUY ${computed.category_slug} ${computed.direction.toUpperCase()} z=${computed.z_score.toFixed(2)} p_low=${estimate.lower_bound.toFixed(3)} required=${requiredProbability.toFixed(3)}`);
}

async function bootstrap() {
  await streamJsonl(SETTLEMENTS_FILE, settlement => {
    const winner = settlementWinner(settlement);
    if (winner) settlements.set(settlement.category_slug, winner);
  });
  console.log(`Loading ${settlements.size} settled markets for calibration...`);
  let loadedSnapshots = 0;
  await streamJsonl(SNAPSHOTS_FILE, snapshot => {
    trainOnSnapshot(snapshot);
    loadedSnapshots += 1;
    if (loadedSnapshots % 50_000 === 0) console.log(`Calibration loading: ${loadedSnapshots} snapshots processed...`);
  });
  tailOffset = existsSync(SNAPSHOTS_FILE) ? statSync(SNAPSHOTS_FILE).size : 0;
  console.log(`Calibration ready: ${calibration.get("global")?.total || 0} independent markets from ${loadedSnapshots} snapshots. Watching new snapshots.`);
}

async function readTail() {
  if (!existsSync(SNAPSHOTS_FILE)) return;
  const size = statSync(SNAPSHOTS_FILE).size;
  if (size < tailOffset) {
    tailOffset = 0;
    tailRemainder = "";
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
      if (line) evaluateLiveSnapshot(JSON.parse(line));
    } catch {
      // Continue tailing after a malformed or interrupted append.
    }
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  await bootstrap();
  console.log("Z-score signal engine started. It only emits paper signals and never places orders.");
  while (true) {
    try {
      await readTail();
    } catch (error) {
      console.error("z-score tail error:", error.message);
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, TAIL_INTERVAL_MS));
  }
}

main().catch(error => {
  console.error("Z-score signal engine failed to start:", error.message);
  process.exitCode = 1;
});
