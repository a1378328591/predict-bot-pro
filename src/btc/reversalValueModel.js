import { normalCdf, topOfBookMicroprice, variancePerSecond } from "./btc5mProbabilityModel.js";

export function estimateReversalValue({
  startPrice,
  bid,
  ask,
  bidSize,
  askSize,
  remainingSeconds,
  points,
  nowMs,
  return30Seconds,
  return60Seconds,
  fastWindowSeconds = 30,
  slowWindowSeconds = 180,
  minimumHistorySeconds = 45,
  minimumObservations = 15,
  volatilityFloorBps = 0.5,
  volatilityUncertainty = 1.2,
  meanReversionHalfLifeSeconds = 120,
  momentumHorizonSeconds = 45,
  micropriceWeight = 0.5,
}) {
  const normalizedStart = Number(startPrice);
  const normalizedBid = Number(bid);
  const normalizedAsk = Number(ask);
  const remaining = Number(remainingSeconds);
  const r30 = Number(return30Seconds);
  const r60 = Number(return60Seconds);
  const mid = (normalizedBid + normalizedAsk) / 2;
  const microprice = topOfBookMicroprice({ bid, ask, bidSize, askSize });
  if (!(normalizedStart > 0) || !(mid > 0) || !(microprice > 0) || !(remaining > 0)) return null;
  if (!Number.isFinite(r30) || !Number.isFinite(r60) || r30 <= -1 || r60 <= -1) return null;

  const weight = Math.max(0, Math.min(1, Number(micropriceWeight)));
  const modelPrice = mid + weight * (microprice - mid);
  const gap = Math.log(modelPrice / normalizedStart);
  if (!Number.isFinite(gap) || gap === 0) return null;

  const logReturn30 = Math.log1p(r30);
  const logReturn60 = Math.log1p(r60);
  const candidateDirection = gap > 0 ? "down" : "up";
  const candidateSign = candidateDirection === "up" ? 1 : -1;
  if (candidateSign * logReturn30 <= 0 || candidateSign * logReturn60 <= 0) return null;

  const fast = variancePerSecond(points, fastWindowSeconds, nowMs);
  const slow = variancePerSecond(points, slowWindowSeconds, nowMs);
  const usable = [fast, slow].filter(item => item
    && item.elapsedSeconds >= minimumHistorySeconds
    && item.observations >= minimumObservations);
  if (!usable.length) return null;

  const variance = Math.max(...usable.map(item => item.variance));
  const sigma = Math.max(Math.sqrt(variance), Number(volatilityFloorBps) / 10_000);
  const halfLife = Math.max(1, Number(meanReversionHalfLifeSeconds));
  const persistence = Math.min(remaining, Math.max(1, Number(momentumHorizonSeconds)));
  const driftPerSecond = 0.65 * logReturn30 / 30 + 0.35 * logReturn60 / 60;
  const expectedEndGap = gap * Math.exp(-remaining / halfLife) + driftPerSecond * persistence;
  const signedZ = expectedEndGap / (sigma * Math.sqrt(remaining));
  const conservativeZ = signedZ / Math.max(1, Number(volatilityUncertainty));
  const upProbability = Math.max(0.001, Math.min(0.999, normalCdf(conservativeZ)));

  return {
    candidateDirection,
    candidateProbability: candidateDirection === "up" ? upProbability : 1 - upProbability,
    upProbability,
    mid,
    microprice,
    modelPrice,
    gapBps: gap * 10_000,
    return30Bps: logReturn30 * 10_000,
    return60Bps: logReturn60 * 10_000,
    expectedEndGapBps: expectedEndGap * 10_000,
    signedZ,
    sigmaBpsPerSqrtSecond: sigma * 10_000,
    fastVariancePerSecond: fast?.variance ?? null,
    slowVariancePerSecond: slow?.variance ?? null,
    historySeconds: Math.max(...usable.map(item => item.elapsedSeconds)),
    observations: Math.max(...usable.map(item => item.observations)),
  };
}
