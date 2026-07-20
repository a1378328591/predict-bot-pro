import "dotenv/config";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "z_score_signals.jsonl");
const SETTLEMENTS_FILE = resolve(DATA_DIR, "settlements.jsonl");
const RESULTS_FILE = resolve(DATA_DIR, "z_score_paper_results.jsonl");
const STATE_FILE = resolve(DATA_DIR, "z_score_paper_results_state.json");

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { settled_signal_ids: {} };
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { settled_signal_ids: {} };
  } catch {
    return { settled_signal_ids: {} };
  }
}

function settlementWinner(settlement) {
  const market = settlement?.markets?.[0];
  return String(market?.outcomes?.find(outcome => outcome?.status === "WON")?.name ?? market?.resolution?.name ?? "").toLowerCase();
}

function signalId(signal) {
  return `${signal?.features?.category_slug || ""}|${signal?.observed_at_ms || signal?.observed_at || ""}`;
}

function main() {
  const state = loadState();
  state.settled_signal_ids ??= {};

  const settlements = new Map();
  for (const settlement of readJsonl(SETTLEMENTS_FILE)) {
    const winner = settlementWinner(settlement);
    if (winner) settlements.set(settlement.category_slug, settlement);
  }

  const paperBuys = readJsonl(SIGNALS_FILE).filter(signal => signal?.type === "PAPER_BUY");
  const newResults = [];

  for (const signal of paperBuys) {
    const id = signalId(signal);
    const slug = signal?.features?.category_slug;
    const settlement = settlements.get(slug);
    if (!id || !slug || state.settled_signal_ids[id] || !settlement) continue;

    const direction = String(signal?.features?.direction || "").toLowerCase();
    const winner = settlementWinner(settlement);
    const shares = Number(signal?.features?.shares);
    const totalCost = Number(signal?.features?.total_cost_usd);
    if (!direction || !(shares > 0) || !(totalCost > 0)) continue;

    const won = direction === winner;
    const payout = won ? shares : 0;
    const pnl = payout - totalCost;
    const result = {
      schema_version: 1,
      type: "PAPER_RESULT",
      reconciled_at: new Date().toISOString(),
      signal_id: id,
      category_slug: slug,
      signal_observed_at: signal.observed_at,
      direction,
      winner,
      won,
      entry: {
        ask: signal?.features?.ask,
        vwap: signal?.features?.vwap,
        shares,
        notional_usd: signal?.features?.notional_usd,
        taker_fee_usd: signal?.features?.taker_fee_usd,
        total_cost_usd: totalCost,
      },
      settlement: {
        start_price: settlement?.variant_data?.startPrice ?? null,
        end_price: settlement?.variant_data?.endPrice ?? null,
        resolved_at: settlement?.observed_at ?? null,
      },
      payout_usd: payout,
      pnl_usd: pnl,
      roi: pnl / totalCost,
    };
    appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n", "utf8");
    state.settled_signal_ids[id] = result.reconciled_at;
    newResults.push(result);
  }

  state.settled_signal_ids = Object.fromEntries(Object.entries(state.settled_signal_ids).slice(-10_000));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  const allResults = readJsonl(RESULTS_FILE).filter(result => result?.type === "PAPER_RESULT");
  const totalCost = allResults.reduce((sum, result) => sum + Number(result.entry?.total_cost_usd || 0), 0);
  const totalPnl = allResults.reduce((sum, result) => sum + Number(result.pnl_usd || 0), 0);
  const wins = allResults.filter(result => result.won).length;
  console.log(JSON.stringify({
    paper_buy_signals: paperBuys.length,
    settled_signals: allResults.length,
    newly_reconciled: newResults.length,
    wins,
    win_rate: allResults.length ? wins / allResults.length : null,
    total_cost_usd: totalCost,
    total_pnl_usd: totalPnl,
    total_roi: totalCost ? totalPnl / totalCost : null,
  }, null, 2));
}

main();
