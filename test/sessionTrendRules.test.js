import test from "node:test";
import assert from "node:assert/strict";
import { sessionTrendDirection } from "../src/btc/sessionTrendRules.js";

test("requires the gap and both momentum windows to agree", () => {
  assert.equal(sessionTrendDirection({ gapBps: 4, return30Bps: 2, return60Bps: 3 }), "up");
  assert.equal(sessionTrendDirection({ gapBps: -4, return30Bps: -2, return60Bps: -3 }), "down");
  assert.equal(sessionTrendDirection({ gapBps: 4, return30Bps: -2, return60Bps: 3 }), null);
});

test("enforces gap and momentum thresholds", () => {
  assert.equal(sessionTrendDirection({ gapBps: 0.9, return30Bps: 2, return60Bps: 3 }), null);
  assert.equal(sessionTrendDirection({ gapBps: 4, return30Bps: 1.49, return60Bps: 3 }), null);
  assert.equal(sessionTrendDirection({ gapBps: 4, return30Bps: 2, return60Bps: 1.49 }), null);
});
