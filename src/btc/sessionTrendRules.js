export function sessionTrendDirection({
  gapBps,
  return30Bps,
  return60Bps,
  minGapBps = 1,
  minMoveBps = 1.5,
}) {
  const gap = Number(gapBps);
  const r30 = Number(return30Bps);
  const r60 = Number(return60Bps);
  if (![gap, r30, r60].every(Number.isFinite) || gap === 0) return null;
  if (Math.abs(gap) < Number(minGapBps)) return null;
  const directionSign = Math.sign(gap);
  if (Math.sign(r30) !== directionSign || Math.sign(r60) !== directionSign) return null;
  if (Math.abs(r30) < Number(minMoveBps) || Math.abs(r60) < Number(minMoveBps)) return null;
  return directionSign > 0 ? "up" : "down";
}
