import { appendFileSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { volatilityRecoveryProgress, volatilityTriggers } from "./reversalVolatilityRules.js";
import { beijingIso, utcIso } from "./timeFormat.js";

const DATA_DIR = resolve("data/btc");
const SNAPSHOTS_FILE = resolve(DATA_DIR, "snapshots.jsonl");
const PAUSE_FILE = resolve(DATA_DIR, "reversal_value_pause.json");
const LOG_FILE = resolve(DATA_DIR, "reversal_value_volatility.jsonl");
const POLL_MS = 1_000;
const RETURN_300_BPS = 50;
const RECOVERY_PERIOD_SECONDS = 300;
const RECOVERY_CALM_PERIODS = 3;
const RECOVERY_PERIOD_MS = RECOVERY_PERIOD_SECONDS * 1_000;
const MAX_HISTORY_MS = 6 * 60_000;

let offset = existsSync(SNAPSHOTS_FILE) ? statSync(SNAPSHOTS_FILE).size : 0;
let remainder = "";
const points = [];

function appendLog(record) {
  const observedAtMs = Date.now();
  appendFileSync(LOG_FILE, JSON.stringify({
    observed_at: utcIso(observedAtMs),
    observed_at_ms: observedAtMs,
    observed_at_beijing: beijingIso(observedAtMs),
    ...record,
  }) + "\n", "utf8");
}

function readPause() {
  try { return JSON.parse(readFileSync(PAUSE_FILE, "utf8")); } catch { return null; }
}

function writePause(record) {
  writeFileSync(PAUSE_FILE, JSON.stringify(record, null, 2), "utf8");
}

function valueAtOrBefore(cutoff) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].time <= cutoff) return points[index].price;
  }
  return null;
}

function returnBps(seconds, now, price) {
  const before = valueAtOrBefore(now - seconds * 1_000);
  return before ? Math.log(price / before) * 10_000 : null;
}

function evaluate() {
  const latest = points.at(-1);
  if (!latest) return;
  const r300 = returnBps(300, latest.time, latest.price);
  const triggers = volatilityTriggers({
    return300Bps: r300,
  }, {
    return300Bps: RETURN_300_BPS,
  });
  const current = readPause();
  if (!current?.paused && triggers.length) {
    const pausedAtMs = Date.now();
    const pause = {
      paused: true,
      paused_at: utcIso(pausedAtMs),
      paused_at_ms: pausedAtMs,
      paused_at_beijing: beijingIso(pausedAtMs),
      reason: triggers,
      reference_price: latest.price,
      recovery_period_seconds: RECOVERY_PERIOD_SECONDS,
      recovery_required_calm_periods: RECOVERY_CALM_PERIODS,
      recovery_calm_periods: 0,
      recovery_next_check_at_ms: latest.time + RECOVERY_PERIOD_MS,
    };
    writePause(pause);
    appendLog({ type: "VOLATILITY_PAUSE", ...pause, return300_bps: r300 });
    console.log(`${pause.paused_at_beijing} [Asia/Shanghai] VOLATILITY_PAUSE ${triggers.join(" ")}`);
    return;
  }
  if (!current?.paused) return;

  const nextCheckAtMs = Number(current.recovery_next_check_at_ms);
  if (!(nextCheckAtMs > 0)) {
    writePause({
      ...current,
      recovery_period_seconds: RECOVERY_PERIOD_SECONDS,
      recovery_required_calm_periods: RECOVERY_CALM_PERIODS,
      recovery_calm_periods: 0,
      recovery_next_check_at_ms: latest.time + RECOVERY_PERIOD_MS,
    });
    return;
  }
  if (latest.time < nextCheckAtMs) return;

  const recovery = volatilityRecoveryProgress({
    currentCalmPeriods: Number(current.recovery_calm_periods),
    return300Bps: r300,
  }, {
    return300Bps: RETURN_300_BPS,
    requiredCalmPeriods: RECOVERY_CALM_PERIODS,
  });
  const checkedAtMs = Date.now();
  const updatedPause = {
    ...current,
    recovery_period_seconds: RECOVERY_PERIOD_SECONDS,
    recovery_required_calm_periods: RECOVERY_CALM_PERIODS,
    recovery_calm_periods: recovery.calmPeriods,
    recovery_last_check_at: utcIso(checkedAtMs),
    recovery_last_check_at_ms: checkedAtMs,
    recovery_last_return300_bps: r300,
    recovery_next_check_at_ms: latest.time + RECOVERY_PERIOD_MS,
  };
  appendLog({
    type: "VOLATILITY_RECOVERY_CHECK",
    calm: recovery.calm,
    calm_periods: recovery.calmPeriods,
    required_calm_periods: RECOVERY_CALM_PERIODS,
    return300_bps: r300,
  });

  if (recovery.shouldResume) {
    const resumedAtMs = Date.now();
    const resumed = {
      paused: false,
      resumed_at: utcIso(resumedAtMs),
      resumed_at_ms: resumedAtMs,
      resumed_at_beijing: beijingIso(resumedAtMs),
      previous_pause: updatedPause,
    };
    writePause(resumed);
    appendLog({ type: "VOLATILITY_RESUME", ...resumed });
    console.log(`${resumed.resumed_at_beijing} [Asia/Shanghai] VOLATILITY_RESUME calm_periods=${recovery.calmPeriods}`);
  } else {
    writePause(updatedPause);
    console.log(`${beijingIso(checkedAtMs)} [Asia/Shanghai] VOLATILITY_RECOVERY_CHECK calm=${recovery.calm} progress=${recovery.calmPeriods}/${RECOVERY_CALM_PERIODS}`);
  }
}

function consume(line) {
  try {
    const snapshot = JSON.parse(line);
    const bid = Number(snapshot.reference_price?.bid);
    const ask = Number(snapshot.reference_price?.ask);
    const time = Number(snapshot.reference_price?.fetched_at_ms ?? snapshot.observed_at_ms);
    const price = (bid + ask) / 2;
    if (!(time > 0 && price > 0)) return;
    if (points.at(-1)?.time === time) return;
    points.push({ time, price });
    const cutoff = time - MAX_HISTORY_MS;
    while (points.length && points[0].time < cutoff) points.shift();
    evaluate();
  } catch {}
}

async function readTail() {
  if (!existsSync(SNAPSHOTS_FILE)) return;
  const size = statSync(SNAPSHOTS_FILE).size;
  if (size < offset) { offset = size; remainder = ""; }
  if (size <= offset) return;
  let chunk = "";
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(SNAPSHOTS_FILE, { start: offset, end: size - 1, encoding: "utf8" });
    stream.on("data", data => { chunk += data; });
    stream.on("end", resolveRead);
    stream.on("error", rejectRead);
  });
  offset = size;
  const lines = (remainder + chunk).split(/\r?\n/);
  remainder = lines.pop() || "";
  for (const line of lines) if (line) consume(line);
}

async function main() {
  console.log(`Reversal volatility monitor started. Trigger=|return300|>=${RETURN_300_BPS}bps. Recovery=${RECOVERY_CALM_PERIODS}x${RECOVERY_PERIOD_SECONDS}s calm periods. Output=${PAUSE_FILE}`);
  while (true) {
    try { await readTail(); } catch (error) { console.error("Volatility monitor error:", error.message); }
    await new Promise(resolveSleep => setTimeout(resolveSleep, POLL_MS));
  }
}

main().catch(error => { console.error("Volatility monitor failed:", error.message); process.exitCode = 1; });
