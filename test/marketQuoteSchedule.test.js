import test from "node:test";
import assert from "node:assert/strict";
import { compileQuoteSchedules, quoteWindowStatus } from "../src/marketQuoteSchedule.js";

const schedules = compileQuoteSchedules([
  {
    name: "上证",
    categorySlugs: ["sse"],
    quoteWindows: [{ start: "2026-09-30 18:05", end: "2026-10-08 07:55" }],
  },
  {
    name: "港股",
    categorySlugs: ["hk"],
    quoteWindows: [{ start: "2026-09-30 18:05", end: "2026-10-02 07:55" }],
  },
  {
    name: "韩股",
    categorySlugs: ["kr"],
    quoteWindows: [{ start: "2026-09-30 18:05", end: "2026-10-01 07:55" }],
  },
]);

const atShanghai = value => new Date(`${value}+08:00`);

test("each market uses its own holiday end date", () => {
  const duringOctober1 = atShanghai("2026-10-01T12:00:00");
  assert.equal(quoteWindowStatus(schedules, "sse", duringOctober1).open, true);
  assert.equal(quoteWindowStatus(schedules, "hk", duringOctober1).open, true);
  assert.equal(quoteWindowStatus(schedules, "kr", duringOctober1).open, false);

  const beforeHongKongOpens = atShanghai("2026-10-02T07:54:00");
  assert.equal(quoteWindowStatus(schedules, "sse", beforeHongKongOpens).open, true);
  assert.equal(quoteWindowStatus(schedules, "hk", beforeHongKongOpens).open, true);
  assert.equal(quoteWindowStatus(schedules, "hk", atShanghai("2026-10-02T07:55:00")).open, false);
});

test("window boundaries are start-inclusive and end-exclusive", () => {
  assert.equal(quoteWindowStatus(schedules, "kr", atShanghai("2026-09-30T18:04:00")).open, false);
  assert.equal(quoteWindowStatus(schedules, "kr", atShanghai("2026-09-30T18:05:00")).open, true);
  assert.equal(quoteWindowStatus(schedules, "kr", atShanghai("2026-10-01T07:54:00")).open, true);
  assert.equal(quoteWindowStatus(schedules, "kr", atShanghai("2026-10-01T07:55:00")).open, false);
});

test("rejects duplicate categories and invalid windows", () => {
  assert.throws(() => compileQuoteSchedules([
    { name: "A", categorySlugs: ["same"], quoteWindows: [{ start: "2026-10-01 01:00", end: "2026-10-01 02:00" }] },
    { name: "B", categorySlugs: ["same"], quoteWindows: [{ start: "2026-10-02 01:00", end: "2026-10-02 02:00" }] },
  ]), /重复配置/);
  assert.throws(() => compileQuoteSchedules([
    { name: "A", categorySlugs: ["a"], quoteWindows: [{ start: "2026-10-01 02:00", end: "2026-10-01 01:00" }] },
  ]), /开始时间必须早于结束时间/);
});
