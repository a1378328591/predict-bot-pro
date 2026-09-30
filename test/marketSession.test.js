import test from "node:test";
import assert from "node:assert/strict";
import { isUsRegularSession, usMarketDate, usMarketRegime } from "../src/btc/marketSession.js";

test("identifies the regular session during US daylight saving time", () => {
  assert.equal(isUsRegularSession(Date.parse("2026-09-21T13:29:00Z")), false);
  assert.equal(isUsRegularSession(Date.parse("2026-09-21T13:30:00Z")), true);
  assert.equal(isUsRegularSession(Date.parse("2026-09-21T19:59:00Z")), true);
  assert.equal(isUsRegularSession(Date.parse("2026-09-21T20:00:00Z")), false);
});

test("handles standard time and weekends", () => {
  assert.equal(isUsRegularSession(Date.parse("2026-12-01T14:30:00Z")), true);
  assert.equal(isUsRegularSession(Date.parse("2026-09-19T15:00:00Z")), false);
  assert.equal(usMarketRegime(Date.parse("2026-09-19T15:00:00Z")), "weekend");
  assert.equal(usMarketRegime(Date.parse("2026-09-21T12:00:00Z")), "weekday_closed");
  assert.equal(usMarketRegime(Date.parse("2026-09-21T14:00:00Z")), "regular_open");
  assert.equal(usMarketDate(Date.parse("2026-09-21T02:00:00Z")), "2026-09-20");
});
