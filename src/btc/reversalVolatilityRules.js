export function volatilityTriggers({ return300Bps }, thresholds) {
  const triggers = [];
  if (Number.isFinite(return300Bps) && Math.abs(return300Bps) >= thresholds.return300Bps) {
    triggers.push(`return300=${return300Bps.toFixed(2)}bps`);
  }
  return triggers;
}

export function volatilityRecoveryProgress({ currentCalmPeriods, return300Bps }, thresholds) {
  const calm = Number.isFinite(return300Bps)
    && Math.abs(return300Bps) < thresholds.return300Bps;
  const previous = Number.isInteger(currentCalmPeriods) && currentCalmPeriods > 0
    ? currentCalmPeriods
    : 0;
  const calmPeriods = calm ? previous + 1 : 0;
  return {
    calm,
    calmPeriods,
    shouldResume: calmPeriods >= thresholds.requiredCalmPeriods,
  };
}
