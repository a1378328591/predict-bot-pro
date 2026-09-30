import test from "node:test";
import assert from "node:assert/strict";
import { estimateBtc5mProbability, normalCdf, topOfBookMicroprice, variancePerSecond } from "../src/btc/btc5mProbabilityModel.js";

test("normal CDF is centered and symmetric", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1) + normalCdf(-1) - 1) < 1e-7);
});

test("microprice moves toward the ask when bid liquidity dominates", () => {
  const price = topOfBookMicroprice({ bid: 99, ask: 101, bidSize: 9, askSize: 1 });
  assert.equal(price, 100.8);
});

test("variance uses elapsed time instead of sample count", () => {
  const points = [
    { time: 0, price: 100 },
    { time: 2_000, price: 101 },
    { time: 4_000, price: 100 },
  ];
  const result = variancePerSecond(points, 10, 4_000);
  const expected = (Math.log(1.01) ** 2 + Math.log(100 / 101) ** 2) / 4;
  assert.ok(Math.abs(result.variance - expected) < 1e-12);
  assert.equal(result.elapsedSeconds, 4);
});

test("probability favors Up above the Chainlink start price", () => {
  const points = Array.from({ length: 31 }, (_, index) => ({
    time: index * 1_000,
    price: 100 + Math.sin(index) * 0.03,
  }));
  points[points.length - 1].price = 100.2;
  const result = estimateBtc5mProbability({
    startPrice: 100,
    bid: 100.19,
    ask: 100.21,
    bidSize: 4,
    askSize: 2,
    remainingSeconds: 30,
    points,
    nowMs: 30_000,
    minimumHistorySeconds: 20,
    minimumObservations: 10,
  });
  assert.equal(result.direction, "up");
  assert.ok(result.probability > 0.5);
  assert.ok(result.conservativeProbability <= result.probability);
  assert.ok(result.conservativeUpProbability + result.conservativeDownProbability < 1);
});
