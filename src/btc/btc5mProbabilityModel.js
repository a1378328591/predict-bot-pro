const SQRT_TWO = Math.sqrt(2);

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

export function normalCdf(value) {
  return 0.5 * (1 + erf(value / SQRT_TWO));
}

export function topOfBookMicroprice({ bid, ask, bidSize, askSize }) {
  const normalizedBid = Number(bid);
  const normalizedAsk = Number(ask);
  const normalizedBidSize = Number(bidSize);
  const normalizedAskSize = Number(askSize);
  if (!(normalizedBid > 0) || !(normalizedAsk >= normalizedBid)) return null;
  if (!(normalizedBidSize > 0) || !(normalizedAskSize > 0)) return (normalizedBid + normalizedAsk) / 2;
  return (normalizedAsk * normalizedBidSize + normalizedBid * normalizedAskSize) / (normalizedBidSize + normalizedAskSize);
}

export function variancePerSecond(points, windowSeconds, nowMs) {
  const cutoff = nowMs - windowSeconds * 1_000;
  let squaredReturns = 0;
  let elapsedSeconds = 0;
  let observations = 0;

  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (current.time < cutoff || previous.time > nowMs) continue;
    const elapsed = (current.time - previous.time) / 1_000;
    if (!(elapsed > 0 && elapsed <= 10) || !(previous.price > 0) || !(current.price > 0)) continue;
    squaredReturns += Math.log(current.price / previous.price) ** 2;
    elapsedSeconds += elapsed;
    observations += 1;
  }

  return elapsedSeconds > 0 ? {
    variance: squaredReturns / elapsedSeconds,
    elapsedSeconds,
    observations,
  } : null;
}

export function estimateBtc5mProbability({
  startPrice,
  bid,
  ask,
  bidSize,
  askSize,
  remainingSeconds,
  points,
  nowMs,
  fastWindowSeconds = 30,
  slowWindowSeconds = 180,
  minimumHistorySeconds = 25,
  minimumObservations = 10,
  volatilityFloorBps = 0.5,
  volatilityUncertainty = 1.15,
  micropriceWeight = 0.5,
}) {
  const mid = (Number(bid) + Number(ask)) / 2;
  const microprice = topOfBookMicroprice({ bid, ask, bidSize, askSize });
  if (!(Number(startPrice) > 0) || !(mid > 0) || !(remainingSeconds > 0) || !(microprice > 0)) return null;

  const fast = variancePerSecond(points, fastWindowSeconds, nowMs);
  const slow = variancePerSecond(points, slowWindowSeconds, nowMs);
  const usable = [fast, slow].filter(item => item && item.elapsedSeconds >= minimumHistorySeconds && item.observations >= minimumObservations);
  if (!usable.length) return null;

  // The slower estimate guards against a temporarily quiet final minute; the fast
  // estimate reacts to a volatility burst. Taking the maximum is deliberately conservative.
  const variance = Math.max(...usable.map(item => item.variance));
  const sigma = Math.max(Math.sqrt(variance), volatilityFloorBps / 10_000);
  const weight = Math.max(0, Math.min(1, Number(micropriceWeight)));
  const modelPrice = mid + weight * (microprice - mid);
  const signedZ = Math.log(modelPrice / Number(startPrice)) / (sigma * Math.sqrt(Number(remainingSeconds)));
  const uncertainty = Math.max(1, Number(volatilityUncertainty));
  const upProbability = Math.max(0.001, Math.min(0.999, normalCdf(signedZ)));
  const upAtHigherVolatility = normalCdf(signedZ / uncertainty);
  const upAtLowerVolatility = normalCdf(signedZ * uncertainty);
  const conservativeUpProbability = Math.max(0.001, Math.min(0.999, Math.min(upAtHigherVolatility, upAtLowerVolatility)));
  const conservativeDownProbability = Math.max(0.001, Math.min(0.999, 1 - Math.max(upAtHigherVolatility, upAtLowerVolatility)));
  const direction = signedZ >= 0 ? "up" : "down";

  return {
    direction,
    probability: direction === "up" ? upProbability : 1 - upProbability,
    conservativeProbability: direction === "up" ? conservativeUpProbability : conservativeDownProbability,
    upProbability,
    conservativeUpProbability,
    conservativeDownProbability,
    signedZ,
    zScore: Math.abs(signedZ),
    mid,
    microprice,
    modelPrice,
    sigmaBpsPerSqrtSecond: sigma * 10_000,
    fastVariancePerSecond: fast?.variance ?? null,
    slowVariancePerSecond: slow?.variance ?? null,
    historySeconds: Math.max(...usable.map(item => item.elapsedSeconds)),
    observations: Math.max(...usable.map(item => item.observations)),
  };
}
