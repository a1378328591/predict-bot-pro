import test from "node:test";
import assert from "node:assert/strict";
import { estimateReversalValue } from "../src/btc/reversalValueModel.js";

function points() {
  return Array.from({ length: 91 }, (_, index) => ({
    time: index * 2_000,
    price: 100 + Math.sin(index / 4) * 0.03,
  }));
}

test("requires momentum to reverse the displacement from start", () => {
  const result = estimateReversalValue({
    startPrice: 100,
    bid: 100.19,
    ask: 100.21,
    bidSize: 2,
    askSize: 2,
    remainingSeconds: 120,
    points: points(),
    nowMs: 180_000,
    return30Seconds: 0.001,
    return60Seconds: 0.001,
  });
  assert.equal(result, null);
});

test("selects Down when price is above start and momentum reverses lower", () => {
  const history = points();
  history[history.length - 1].price = 100.2;
  const result = estimateReversalValue({
    startPrice: 100,
    bid: 100.19,
    ask: 100.21,
    bidSize: 2,
    askSize: 2,
    remainingSeconds: 120,
    points: history,
    nowMs: 180_000,
    return30Seconds: -0.0015,
    return60Seconds: -0.001,
  });
  assert.equal(result.candidateDirection, "down");
  assert.ok(result.candidateProbability > 0 && result.candidateProbability < 1);
  assert.ok(result.return30Bps < 0);
});
