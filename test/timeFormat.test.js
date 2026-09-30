import test from "node:test";
import assert from "node:assert/strict";
import { beijingIso, utcIso } from "../src/btc/timeFormat.js";

test("formats the same instant explicitly in UTC and Beijing time", () => {
  const timeMs = Date.parse("2026-09-21T13:30:45.123Z");
  assert.equal(utcIso(timeMs), "2026-09-21T13:30:45.123Z");
  assert.equal(beijingIso(timeMs), "2026-09-21T21:30:45+08:00");
  assert.equal(Date.parse(utcIso(timeMs)), Date.parse(beijingIso(timeMs)) + 123);
});
