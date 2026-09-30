import test from "node:test";
import assert from "node:assert/strict";
import { summarizeLiveActions } from "../src/btc/sessionLiveActionStats.js";

const signal = (suffix, direction, regime) => ({
  type: "LIVE_BUY_SIGNAL",
  category_slug: `btc-${suffix}`,
  observed_at_ms: suffix,
  direction,
  us_market_regime: regime,
  quote: { shares: 20, total_cost_usd: suffix === 1 ? 12 : 14 },
});

const settlement = (suffix, winner) => ({
  category_slug: `btc-${suffix}`,
  variant_data: { startPrice: 100, endPrice: winner === "up" ? 101 : 99 },
  markets: [{ outcomes: [
    { name: "Up", status: winner === "up" ? "WON" : "LOST" },
    { name: "Down", status: winner === "down" ? "WON" : "LOST" },
  ] }],
});

test("counts one action per signal regardless of its execution lifecycle", () => {
  const signals = [signal(1, "up", "weekday_closed"), signal(2, "down", "regular_open")];
  const executions = [
    { type: "LIVE_ORDER_SUBMITTED", signal_id: "btc-1|1", observed_at: "2026-09-24T00:00:00.000Z" },
    { type: "LIVE_ORDER_CANCEL_REQUESTED", signal_id: "btc-1|1", observed_at: "2026-09-24T00:00:02.000Z" },
    { type: "LIVE_ORDER_SKIPPED_OR_FAILED", signal_id: "btc-2|2", observed_at: "2026-09-24T00:05:00.000Z" },
  ];

  assert.deepEqual(summarizeLiveActions(signals, executions, [settlement(1, "up"), settlement(2, "up")]), {
    calculation_basis: "signal_quote_assuming_full_fill",
    live_signals: 2,
    order_actions: 2,
    pending_actions: 0,
    total: {
      actions: 2,
      settled: 2,
      unsettled: 0,
      wins: 1,
      losses: 1,
      ties: 0,
      win_rate: 0.5,
      total_cost_usd: 26,
      total_pnl_usd: -6,
      roi: -6 / 26,
    },
    by_market_regime: {
      weekday_closed: { actions: 1, settled: 1, unsettled: 0, wins: 1, losses: 0, ties: 0, win_rate: 1, total_cost_usd: 12, total_pnl_usd: 8, roi: 8 / 12 },
      regular_open: { actions: 1, settled: 1, unsettled: 0, wins: 0, losses: 1, ties: 0, win_rate: 0, total_cost_usd: 14, total_pnl_usd: -14, roi: -1 },
    },
    by_direction: {
      up: { actions: 1, settled: 1, unsettled: 0, wins: 1, losses: 0, ties: 0, win_rate: 1, total_cost_usd: 12, total_pnl_usd: 8, roi: 8 / 12 },
      down: { actions: 1, settled: 1, unsettled: 0, wins: 0, losses: 1, ties: 0, win_rate: 0, total_cost_usd: 14, total_pnl_usd: -14, roi: -1 },
    },
    latest_action_at: "2026-09-24T00:05:00.000Z",
  });
});

test("reports live signals that have not reached the executor as pending", () => {
  const summary = summarizeLiveActions([
    signal(1, "up", "weekend"),
    { ...signal(1, "up", "weekend") },
    { type: "PAPER_CANDIDATE", category_slug: "ignored", observed_at_ms: 3 },
  ], []);

  assert.equal(summary.live_signals, 1);
  assert.equal(summary.order_actions, 0);
  assert.equal(summary.pending_actions, 1);
  assert.deepEqual(summary.total, {
    actions: 0,
    settled: 0,
    unsettled: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    win_rate: null,
    total_cost_usd: 0,
    total_pnl_usd: 0,
    roi: null,
  });
  assert.deepEqual(summary.by_market_regime, {});
});

test("settles ties at half payout and leaves unresolved actions out of pnl", () => {
  const signals = [signal(1, "up", "weekend"), signal(2, "down", "weekend")];
  const executions = [
    { type: "LIVE_ORDER_SKIPPED_OR_FAILED", signal_id: "btc-1|1", observed_at: "2026-09-24T00:00:00.000Z" },
    { type: "LIVE_ORDER_SUBMITTED", signal_id: "btc-2|2", observed_at: "2026-09-24T00:05:00.000Z" },
  ];
  const tie = {
    category_slug: "btc-1",
    variant_data: { startPrice: 100, endPrice: 100 },
    markets: [{ outcomes: [] }],
  };

  const total = summarizeLiveActions(signals, executions, [tie]).total;
  assert.equal(total.actions, 2);
  assert.equal(total.settled, 1);
  assert.equal(total.unsettled, 1);
  assert.equal(total.ties, 1);
  assert.equal(total.total_cost_usd, 12);
  assert.equal(total.total_pnl_usd, -2);
  assert.equal(total.roi, -2 / 12);
});
