import "dotenv/config";
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
import { usMarketRegime } from "./marketSession.js";
import { beijingIso, utcIso } from "./timeFormat.js";

const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "reversal_value_signals.jsonl");
const SETTLEMENTS_FILE = resolve(DATA_DIR, "settlements.jsonl");
const RESULTS_FILE = resolve(DATA_DIR, "reversal_value_results.jsonl");
const STATE_FILE = resolve(DATA_DIR, "reversal_value_results_state.json");

async function streamJsonl(file, callback) {
  if (!existsSync(file)) return;
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { callback(JSON.parse(line)); } catch {}
  }
}

function loadState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { reconciled: {} };
  } catch {
    return { reconciled: {} };
  }
}

function winner(settlement) {
  const startPrice = Number(settlement?.variant_data?.startPrice);
  const endPrice = Number(settlement?.variant_data?.endPrice);
  if (Number.isFinite(startPrice) && Number.isFinite(endPrice) && startPrice === endPrice) return "tie";
  const market = settlement?.markets?.[0];
  return String(market?.outcomes?.find(outcome => outcome?.status === "WON")?.name
    ?? market?.resolution?.name
    ?? "").toLowerCase();
}

async function main() {
  const state = loadState();
  state.reconciled ??= {};
  const settlements = new Map();
  const signals = [];
  await streamJsonl(SETTLEMENTS_FILE, settlement => {
    const result = winner(settlement);
    if (result) settlements.set(settlement.category_slug, { settlement, winner: result });
  });
  await streamJsonl(SIGNALS_FILE, signal => {
    if (["PAPER_BUY", "WEEKEND_SHADOW_BUY", "WEEKDAY_CLOSED_SHADOW_BUY", "US_OPEN_SHADOW_BUY"].includes(signal?.type)) signals.push(signal);
  });

  let added = 0;
  for (const signal of signals) {
    const signalTimeMs = Number(signal.observed_at_ms ?? Date.parse(signal.observed_at));
    const marketRegime = signal.us_market_regime
      ?? (Number.isFinite(signalTimeMs) ? usMarketRegime(signalTimeMs) : signal.weekend ? "weekend" : null);
    const id = `${signal.category_slug}|${signal.observed_at_ms ?? signal.observed_at}`;
    const resolution = settlements.get(signal.category_slug);
    if (!resolution || state.reconciled[id]) continue;
    const tied = resolution.winner === "tie";
    const won = tied ? null : signal.direction === resolution.winner;
    const shares = Number(signal.quote?.shares);
    const cost = Number(signal.quote?.total_cost_usd);
    const payout = tied ? shares * 0.5 : won ? shares : 0;
    const result = {
      schema_version: 1,
      type: "PAPER_RESULT",
      signal_type: signal.type,
      strategy: signal.strategy ?? "reversal_value_v1",
      weekend: marketRegime === "weekend",
      us_regular_session: marketRegime === "regular_open",
      us_market_regime: marketRegime,
      reconciled_at: new Date().toISOString(),
      signal_id: id,
      category_slug: signal.category_slug,
      signal_observed_at: signal.observed_at,
      signal_observed_at_ms: Number.isFinite(signalTimeMs) ? signalTimeMs : null,
      signal_observed_at_utc: Number.isFinite(signalTimeMs) ? utcIso(signalTimeMs) : null,
      signal_observed_at_beijing: Number.isFinite(signalTimeMs) ? beijingIso(signalTimeMs) : null,
      direction: signal.direction,
      winner: resolution.winner,
      won,
      tied,
      remaining_seconds: signal.remaining_seconds,
      model_probability: signal.model?.candidateProbability,
      edge: signal.edge,
      entry: signal.quote,
      payout_usd: payout,
      pnl_usd: payout - cost,
      roi: cost > 0 ? (payout - cost) / cost : null,
    };
    appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n", "utf8");
    state.reconciled[id] = result.reconciled_at;
    added += 1;
  }
  state.reconciled = Object.fromEntries(Object.entries(state.reconciled).slice(-20_000));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  const results = [];
  await streamJsonl(RESULTS_FILE, result => {
    if (result?.type === "PAPER_RESULT") results.push(result);
  });
  const summarize = rows => {
    const rowCost = rows.reduce((sum, result) => sum + Number(result.entry?.total_cost_usd || 0), 0);
    const rowPnl = rows.reduce((sum, result) => sum + Number(result.pnl_usd || 0), 0);
    const wins = rows.filter(result => result.won).length;
    return {
      settled: rows.length,
      wins,
      win_rate: rows.length ? wins / rows.length : null,
      total_cost_usd: rowCost,
      total_pnl_usd: rowPnl,
      roi: rowCost ? rowPnl / rowCost : null,
    };
  };
  const resultRegime = result => {
    if (result.us_market_regime) return result.us_market_regime;
    const timeMs = Number(result.signal_observed_at_ms ?? Date.parse(result.signal_observed_at));
    return Number.isFinite(timeMs) ? usMarketRegime(timeMs) : result.weekend ? "weekend" : "unknown";
  };
  const byMarketRegime = Object.fromEntries(["weekend", "weekday_closed", "regular_open", "unknown"]
    .map(regime => [regime, summarize(results.filter(result => resultRegime(result) === regime))])
    .filter(([, summary]) => summary.settled > 0));
  const byStrategy = Object.fromEntries([...new Set(results.map(result => result.strategy ?? "reversal_value_v1"))]
    .map(strategy => [strategy, summarize(results.filter(result => (result.strategy ?? "reversal_value_v1") === strategy))]));
  console.log(JSON.stringify({
    paper_signals: signals.length,
    newly_reconciled: added,
    total: summarize(results),
    by_market_regime: byMarketRegime,
    by_strategy: byStrategy,
  }, null, 2));
}

main().catch(error => {
  console.error("Reversal result reconciliation failed:", error.message);
  process.exitCode = 1;
});
