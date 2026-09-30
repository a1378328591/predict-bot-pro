import "dotenv/config";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
import { estimateTakerBuyCost } from "./predictTakerFee.js";
import { SESSION_TREND_FIXED_SHARES as FIXED_SHARES } from "./sessionTrendConfig.js";
import { usMarketDate, usMarketRegime } from "./marketSession.js";
import { beijingIso } from "./timeFormat.js";

const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const SNAPSHOTS_FILE = resolve(DATA_DIR, "snapshots.jsonl");
const SETTLEMENTS_FILE = resolve(DATA_DIR, "settlements.jsonl");
const TRAIN_FRACTION = 0.60;
const MIN_TRAIN_TRADES = 25;

async function streamJsonl(file, callback) {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      callback(JSON.parse(line));
    } catch {}
  }
}

function settlementWinner(settlement) {
  const start = Number(settlement?.variant_data?.startPrice);
  const end = Number(settlement?.variant_data?.endPrice);
  if (Number.isFinite(start) && Number.isFinite(end) && start === end) return "tie";
  const market = settlement?.markets?.[0];
  return String(market?.outcomes?.find(outcome => outcome?.status === "WON")?.name
    ?? market?.resolution?.name
    ?? "").toLowerCase();
}

function fixedShareQuote(snapshot, direction) {
  const outcome = (snapshot.outcomes || []).find(item => String(item?.outcome_name || "").toLowerCase() === direction);
  const asks = outcome?.book?.levels?.asks || [];
  let remaining = FIXED_SHARES;
  let notional = 0;
  for (const level of asks) {
    const shares = Math.min(remaining, Number(level.size));
    const price = Number(level.price);
    if (!(shares > 0) || !(price > 0 && price < 1)) continue;
    notional += shares * price;
    remaining -= shares;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9 || !(notional > 0)) return null;
  const vwap = notional / FIXED_SHARES;
  const costs = estimateTakerBuyCost(vwap, FIXED_SHARES, notional);
  return {
    vwap,
    spread: Number(outcome?.book?.spread),
    cost: costs.total_cost_usd,
  };
}

function compactSnapshot(snapshot, winner) {
  const timeMs = Number(snapshot.observed_at_ms);
  const start = Number(snapshot.start_price);
  const bid = Number(snapshot.reference_price?.bid);
  const ask = Number(snapshot.reference_price?.ask);
  const mid = (bid + ask) / 2;
  const remaining = Number(snapshot.timing?.seconds_to_end);
  const elapsed = Number(snapshot.timing?.seconds_from_price_interval_start);
  const r30 = Number(snapshot.price_features?.return_30s);
  const r60 = Number(snapshot.price_features?.return_60s);
  const observations = Number(snapshot.price_features?.history_observations);
  if (!(timeMs > 0) || !(start > 0) || !(mid > 0) || !(remaining >= 20 && remaining <= 240)) return null;
  if (!(elapsed >= 45) || !(observations >= 15) || !Number.isFinite(r30) || !Number.isFinite(r60)) return null;
  const gapBps = Math.log(mid / start) * 10_000;
  const return30Bps = Math.log1p(r30) * 10_000;
  const return60Bps = Math.log1p(r60) * 10_000;
  if (![gapBps, return30Bps, return60Bps].every(Number.isFinite) || gapBps === 0) return null;
  return {
    slug: snapshot.category_slug,
    timeMs,
    day: usMarketDate(timeMs),
    regime: usMarketRegime(timeMs),
    winner,
    remaining,
    gapBps,
    return30Bps,
    return60Bps,
    quotes: {
      up: fixedShareQuote(snapshot, "up"),
      down: fixedShareQuote(snapshot, "down"),
    },
  };
}

function configurations(style, session) {
  const rows = [];
  for (const minPrice of [0.10, 0.25, 0.40]) {
    for (const maxPrice of [0.50, 0.60, 0.70]) {
      if (minPrice >= maxPrice) continue;
      for (const minMoveBps of [0.5, 1.5, 3]) {
        for (const minGapBps of [1, 3, 5]) {
          for (const maxRemaining of [120, 180, 240]) {
            rows.push({
              style,
              session,
              minPrice,
              maxPrice,
              minMoveBps,
              minGapBps,
              minRemaining: 30,
              maxRemaining,
              maxSpread: 0.02,
            });
          }
        }
      }
    }
  }
  return rows;
}

function entryFor(row, config) {
  if (config.session === "open" && row.regime !== "regular_open") return null;
  if (config.session === "closed" && row.regime === "regular_open") return null;
  if (!(row.remaining >= config.minRemaining && row.remaining <= config.maxRemaining)) return null;
  if (Math.abs(row.gapBps) < config.minGapBps) return null;
  const gapSign = Math.sign(row.gapBps);
  const directionSign = config.style === "trend" ? gapSign : -gapSign;
  if (Math.sign(row.return30Bps) !== directionSign || Math.sign(row.return60Bps) !== directionSign) return null;
  if (Math.abs(row.return30Bps) < config.minMoveBps || Math.abs(row.return60Bps) < config.minMoveBps) return null;
  const direction = directionSign > 0 ? "up" : "down";
  const quote = row.quotes[direction];
  if (!quote || !(quote.spread >= 0 && quote.spread <= config.maxSpread)) return null;
  if (!(quote.vwap >= config.minPrice && quote.vwap <= config.maxPrice)) return null;
  const tied = row.winner === "tie";
  const won = !tied && row.winner === direction;
  const payout = tied ? FIXED_SHARES * 0.5 : won ? FIXED_SHARES : 0;
  return {
    slug: row.slug,
    day: row.day,
    timeMs: row.timeMs,
    regime: row.regime,
    direction,
    won,
    tied,
    price: quote.vwap,
    cost: quote.cost,
    pnl: payout - quote.cost,
  };
}

export function evaluateConfiguration(markets, config, allowedSlugs = null) {
  const trades = [];
  for (const [slug, rows] of markets) {
    if (allowedSlugs && !allowedSlugs.has(slug)) continue;
    for (const row of rows) {
      const trade = entryFor(row, config);
      if (trade) {
        trades.push(trade);
        break;
      }
    }
  }
  return summarize(trades);
}

function summarize(trades) {
  const cost = trades.reduce((sum, trade) => sum + trade.cost, 0);
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter(trade => trade.won).length;
  const meanPnl = trades.length ? pnl / trades.length : null;
  const pnlVariance = trades.length > 1
    ? trades.reduce((sum, trade) => sum + (trade.pnl - meanPnl) ** 2, 0) / (trades.length - 1)
    : null;
  const standardError = pnlVariance === null ? null : Math.sqrt(pnlVariance / trades.length);
  const dayGroups = new Map();
  const regimeGroups = new Map();
  for (const trade of trades) {
    const dayTrades = dayGroups.get(trade.day) ?? [];
    dayTrades.push(trade);
    dayGroups.set(trade.day, dayTrades);
    const regimeTrades = regimeGroups.get(trade.regime) ?? [];
    regimeTrades.push(trade);
    regimeGroups.set(trade.regime, regimeTrades);
  }
  return {
    trades: trades.length,
    wins,
    win_rate: trades.length ? wins / trades.length : null,
    cost_usd: cost,
    pnl_usd: pnl,
    roi: cost ? pnl / cost : null,
    mean_pnl_per_trade_usd: meanPnl,
    mean_pnl_95pct_low_usd: standardError === null ? null : meanPnl - 1.96 * standardError,
    mean_pnl_95pct_high_usd: standardError === null ? null : meanPnl + 1.96 * standardError,
    by_day: Object.fromEntries([...dayGroups]
      .map(([day, dayTrades]) => [day, summarizeWithoutDays(dayTrades)])),
    by_regime: Object.fromEntries([...regimeGroups]
      .map(([regime, regimeTrades]) => [regime, summarizeWithoutDays(regimeTrades)])),
  };
}

function summarizeWithoutDays(trades) {
  const cost = trades.reduce((sum, trade) => sum + trade.cost, 0);
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter(trade => trade.won).length;
  const meanPnl = trades.length ? pnl / trades.length : null;
  const pnlVariance = trades.length > 1
    ? trades.reduce((sum, trade) => sum + (trade.pnl - meanPnl) ** 2, 0) / (trades.length - 1)
    : null;
  const standardError = pnlVariance === null ? null : Math.sqrt(pnlVariance / trades.length);
  return {
    trades: trades.length,
    wins,
    win_rate: trades.length ? wins / trades.length : null,
    cost_usd: cost,
    pnl_usd: pnl,
    roi: cost ? pnl / cost : null,
    mean_pnl_per_trade_usd: meanPnl,
    mean_pnl_95pct_low_usd: standardError === null ? null : meanPnl - 1.96 * standardError,
    mean_pnl_95pct_high_usd: standardError === null ? null : meanPnl + 1.96 * standardError,
  };
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : value;
}

function roundedSummary(summary) {
  return {
    ...summary,
    win_rate: round(summary.win_rate),
    cost_usd: round(summary.cost_usd),
    pnl_usd: round(summary.pnl_usd),
    roi: round(summary.roi),
    mean_pnl_per_trade_usd: round(summary.mean_pnl_per_trade_usd),
    mean_pnl_95pct_low_usd: round(summary.mean_pnl_95pct_low_usd),
    mean_pnl_95pct_high_usd: round(summary.mean_pnl_95pct_high_usd),
    by_day: Object.fromEntries(Object.entries(summary.by_day).map(([day, item]) => [day, {
      ...item,
      win_rate: round(item.win_rate),
      cost_usd: round(item.cost_usd),
      pnl_usd: round(item.pnl_usd),
      roi: round(item.roi),
      mean_pnl_per_trade_usd: round(item.mean_pnl_per_trade_usd),
      mean_pnl_95pct_low_usd: round(item.mean_pnl_95pct_low_usd),
      mean_pnl_95pct_high_usd: round(item.mean_pnl_95pct_high_usd),
    }])),
    by_regime: Object.fromEntries(Object.entries(summary.by_regime).map(([regime, item]) => [regime, {
      ...item,
      win_rate: round(item.win_rate),
      cost_usd: round(item.cost_usd),
      pnl_usd: round(item.pnl_usd),
      roi: round(item.roi),
      mean_pnl_per_trade_usd: round(item.mean_pnl_per_trade_usd),
      mean_pnl_95pct_low_usd: round(item.mean_pnl_95pct_low_usd),
      mean_pnl_95pct_high_usd: round(item.mean_pnl_95pct_high_usd),
    }])),
  };
}

async function main() {
  if (!existsSync(SNAPSHOTS_FILE) || !existsSync(SETTLEMENTS_FILE)) {
    throw new Error(`Missing ${SNAPSHOTS_FILE} or ${SETTLEMENTS_FILE}`);
  }
  const winners = new Map();
  await streamJsonl(SETTLEMENTS_FILE, settlement => {
    const winner = settlementWinner(settlement);
    if (settlement?.category_slug && winner) winners.set(settlement.category_slug, winner);
  });

  const markets = new Map();
  let snapshotCount = 0;
  await streamJsonl(SNAPSHOTS_FILE, snapshot => {
    snapshotCount += 1;
    const winner = winners.get(snapshot.category_slug);
    if (!winner) return;
    const row = compactSnapshot(snapshot, winner);
    if (!row) return;
    const rows = markets.get(row.slug) ?? [];
    rows.push(row);
    markets.set(row.slug, rows);
  });
  for (const rows of markets.values()) rows.sort((a, b) => a.timeMs - b.timeMs);

  const orderedSlugs = [...markets.keys()].sort((a, b) => markets.get(a)[0].timeMs - markets.get(b)[0].timeMs);
  const splitIndex = Math.max(1, Math.floor(orderedSlugs.length * TRAIN_FRACTION));
  const training = new Set(orderedSlugs.slice(0, splitIndex));
  const holdout = new Set(orderedSlugs.slice(splitIndex));
  const selections = [];

  for (const session of ["closed", "open"]) {
    for (const style of ["reversal", "trend"]) {
      const candidates = configurations(style, session).map(config => ({
        config,
        training: evaluateConfiguration(markets, config, training),
      })).filter(item => item.training.trades >= MIN_TRAIN_TRADES)
        .sort((a, b) => b.training.pnl_usd - a.training.pnl_usd || b.training.roi - a.training.roi);
      const selected = candidates[0] ?? null;
      selections.push(selected ? {
        config: selected.config,
        training: roundedSummary(selected.training),
        holdout: roundedSummary(evaluateConfiguration(markets, selected.config, holdout)),
        all: roundedSummary(evaluateConfiguration(markets, selected.config)),
      } : { config: { style, session }, error: `No configuration had ${MIN_TRAIN_TRADES} training trades.` });
    }
  }

  const strictWeekendTrend = {
    style: "trend",
    session: "closed",
    minPrice: 0.40,
    maxPrice: 0.70,
    minMoveBps: 1.5,
    minGapBps: 1,
    minRemaining: 30,
    maxRemaining: 180,
    maxSpread: 0.02,
  };
  const sensitivity = [
    { name: "strict_current", overrides: {} },
    { name: "move_1_0bps", overrides: { minMoveBps: 1.0 } },
    { name: "move_0_5bps", overrides: { minMoveBps: 0.5 } },
    { name: "price_0_30_0_75", overrides: { minPrice: 0.30, maxPrice: 0.75 } },
    { name: "remaining_20_240", overrides: { minRemaining: 20, maxRemaining: 240 } },
    {
      name: "combined_loose",
      overrides: { minMoveBps: 1.0, minPrice: 0.30, maxPrice: 0.75, minRemaining: 20, maxRemaining: 240 },
    },
  ].map(preset => {
    const config = { ...strictWeekendTrend, ...preset.overrides };
    return {
      name: preset.name,
      config,
      training: roundedSummary(evaluateConfiguration(markets, config, training)),
      holdout: roundedSummary(evaluateConfiguration(markets, config, holdout)),
      all: roundedSummary(evaluateConfiguration(markets, config)),
    };
  });

  const firstTime = markets.get(orderedSlugs[0])?.[0]?.timeMs;
  const lastTime = markets.get(orderedSlugs.at(-1))?.at(-1)?.timeMs;
  const holdoutStart = markets.get(orderedSlugs[splitIndex])?.[0]?.timeMs;
  console.log(JSON.stringify({
    methodology: {
      fixed_shares: FIXED_SHARES,
      taker_fees_included: true,
      entry: "First eligible historical ask per market; no future snapshot data used.",
      selection: `Grid parameters selected on the first ${TRAIN_FRACTION * 100}% of markets by total PnL; reported once on the final ${(1 - TRAIN_FRACTION) * 100}% holdout.`,
      caution: "A short holdout is evidence, not proof. Keep new rules in paper mode until they survive more days and market regimes.",
      session_timezone: "America/New_York",
      daily_summary_timezone: "America/New_York",
      stored_timestamp_timezone: "UTC",
    },
    data: {
      snapshots_read: snapshotCount,
      settled_markets_with_features: orderedSlugs.length,
      range_start: firstTime ? new Date(firstTime).toISOString() : null,
      range_start_beijing: firstTime ? beijingIso(firstTime) : null,
      range_end: lastTime ? new Date(lastTime).toISOString() : null,
      range_end_beijing: lastTime ? beijingIso(lastTime) : null,
      training_markets: training.size,
      holdout_markets: holdout.size,
      holdout_start: holdoutStart ? new Date(holdoutStart).toISOString() : null,
      holdout_start_beijing: holdoutStart ? beijingIso(holdoutStart) : null,
    },
    sensitivity,
    selections,
  }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
if (isMain) {
  main().catch(error => {
    console.error("BTC session strategy backtest failed:", error.message);
    process.exitCode = 1;
  });
}
