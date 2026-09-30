import test from "node:test";
import assert from "node:assert/strict";
import { volatilityRecoveryProgress, volatilityTriggers } from "../src/btc/reversalVolatilityRules.js";

const thresholds = { return300Bps: 50 };

test("normal volatility does not trigger a pause", () => {
  assert.deepEqual(volatilityTriggers({
    return300Bps: 18,
  }, thresholds), []);
});

test("only a large five-minute return triggers a pause", () => {
  const triggers = volatilityTriggers({
    return300Bps: -51,
  }, thresholds);
  assert.deepEqual(triggers, ["return300=-51.00bps"]);
});

test("recovery requires three consecutive calm five-minute periods", () => {
  const recoveryThresholds = { return300Bps: 50, requiredCalmPeriods: 3 };
  const first = volatilityRecoveryProgress({ currentCalmPeriods: 0, return300Bps: 20 }, recoveryThresholds);
  const second = volatilityRecoveryProgress({ currentCalmPeriods: first.calmPeriods, return300Bps: -49 }, recoveryThresholds);
  const third = volatilityRecoveryProgress({ currentCalmPeriods: second.calmPeriods, return300Bps: 10 }, recoveryThresholds);

  assert.deepEqual(first, { calm: true, calmPeriods: 1, shouldResume: false });
  assert.deepEqual(second, { calm: true, calmPeriods: 2, shouldResume: false });
  assert.deepEqual(third, { calm: true, calmPeriods: 3, shouldResume: true });
});

test("a volatile period resets recovery progress", () => {
  assert.deepEqual(volatilityRecoveryProgress({
    currentCalmPeriods: 2,
    return300Bps: 50,
  }, {
    return300Bps: 50,
    requiredCalmPeriods: 3,
  }), {
    calm: false,
    calmPeriods: 0,
    shouldResume: false,
  });
});
