import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateBuyNotional,
  decideAction,
  ema,
  kdj,
  reconcilePositionSnapshot,
  rsi,
  timedExitDue,
} from "../src/arcus/tradeBot.js";

test("EMA uses an SMA seed and then the exponential formula", () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("RSI handles one-way and flat price series", () => {
  assert.equal(rsi(Array.from({ length: 16 }, (_, index) => index + 1), 14).at(-1), 100);
  assert.equal(rsi(Array(16).fill(10), 14).at(-1), 50);
});

test("KDJ stays neutral for a flat market", () => {
  const result = kdj(Array.from({ length: 9 }, () => ({ high: 10, low: 10, close: 10 })), 9).at(-1);
  assert.deepEqual(result, { k: 50, d: 50, j: 50 });
});

test("strategy buys or adds on a single qualifying signal", () => {
  const previous = { rsi: 40, macd: { macd: -1, signal: 0 }, kdj: { k: 15, d: 20 } };
  const current = { rsi: 30, macd: { macd: -1, signal: 0 }, kdj: { k: 15, d: 20 } };
  assert.equal(decideAction(previous, current, false).action, "BUY");
  assert.equal(decideAction(previous, current, true, { estimatedReturnPct: -1 }).action, "BUY");
});

test("strategy respects the position cap even when a buy signal exists", () => {
  const previous = { rsi: 40, macd: { macd: -1, signal: 0 }, kdj: { k: 15, d: 20 } };
  const current = { rsi: 30, macd: { macd: -1, signal: 0 }, kdj: { k: 15, d: 20 } };
  assert.equal(decideAction(previous, current, true, {
    estimatedReturnPct: -1,
    canBuy: false,
  }).action, "HOLD");
});

test("strategy sells on one reversal signal only after covering costs", () => {
  const previous = { rsi: 55, macd: { macd: 2, signal: 1 }, kdj: { k: 60, d: 50 } };
  const current = { rsi: 55, macd: { macd: 0, signal: 1 }, kdj: { k: 60, d: 50 } };
  assert.equal(decideAction(previous, current, true, { estimatedReturnPct: -0.5 }).action, "HOLD");
  const decision = decideAction(previous, current, true, { estimatedReturnPct: 0 });
  assert.equal(decision.action, "SELL");
  assert.deepEqual(decision.reasons, ["MACD 死叉", "预计净收益 0.00%"]);
});

test("strategy enforces quote-aware take-profit and stop-loss", () => {
  const flat = { rsi: 50, macd: { macd: 1, signal: 1 }, kdj: { k: 50, d: 50 } };
  assert.equal(decideAction(flat, flat, true, { estimatedReturnPct: 1 }).action, "SELL");
  assert.equal(decideAction(flat, flat, true, { estimatedReturnPct: -3 }).action, "SELL");
});

test("dynamic position sizing maps signal strength and caps remaining capacity", () => {
  const settings = { minBuyNotionalBase: 11, maxBuyNotionalBase: 40 };
  assert.equal(calculateBuyNotional(1, 40, settings), 11);
  assert.equal(calculateBuyNotional(2, 40, settings), 25.5);
  assert.equal(calculateBuyNotional(3, 40, settings), 40);
  assert.equal(calculateBuyNotional(3, 17.25, settings), 17.25);
  assert.equal(calculateBuyNotional(1, 10.99, settings), 0);
});

test("wallet reconciliation clears a stale position after a manual sell", () => {
  const result = reconcilePositionSnapshot({
    managedPositionAtoms: "100",
    entryCostBaseAtoms: "200",
    positionOpenedAt: 1_000,
  }, 0n, 0n, 2_000);
  assert.deepEqual(result, {
    managedPositionAtoms: "0",
    entryCostBaseAtoms: "0",
    positionOpenedAt: null,
    changed: true,
  });
});

test("wallet reconciliation scales cost after a manual partial sell", () => {
  const result = reconcilePositionSnapshot({
    managedPositionAtoms: "100",
    entryCostBaseAtoms: "1000",
    positionOpenedAt: 1_000,
  }, 40n, 0n, 2_000);
  assert.equal(result.managedPositionAtoms, "40");
  assert.equal(result.entryCostBaseAtoms, "400");
  assert.equal(result.positionOpenedAt, 1_000);
});

test("wallet reconciliation adopts a manual position and starts its timer", () => {
  const result = reconcilePositionSnapshot({
    managedPositionAtoms: "0",
    entryCostBaseAtoms: "0",
    positionOpenedAt: null,
  }, 50n, 900n, 2_000);
  assert.equal(result.managedPositionAtoms, "50");
  assert.equal(result.entryCostBaseAtoms, "900");
  assert.equal(result.positionOpenedAt, 2_000);
});

test("timed exit becomes due after the configured holding period", () => {
  assert.equal(timedExitDue(1n, 1_000, 25 * 60_000 + 999, 25 * 60_000), false);
  assert.equal(timedExitDue(1n, 1_000, 25 * 60_000 + 1_000, 25 * 60_000), true);
  assert.equal(timedExitDue(0n, 1_000, 25 * 60_000 + 1_000, 25 * 60_000), false);
});
