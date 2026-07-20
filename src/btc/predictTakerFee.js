// Predict's discounted taker schedule: fee/share = 1.8% of min(price, 1 - price).
export const DISCOUNTED_TAKER_FEE_BASE_RATE = 0.018;

export function discountedTakerFeeForShares(price, shares) {
  const normalizedPrice = Number(price);
  const normalizedShares = Number(shares);
  if (!(normalizedPrice > 0 && normalizedPrice < 1) || !(normalizedShares > 0)) return 0;
  return DISCOUNTED_TAKER_FEE_BASE_RATE * Math.min(normalizedPrice, 1 - normalizedPrice) * normalizedShares;
}

export function estimateTakerBuyCost(price, shares, notional) {
  const takerFee = discountedTakerFeeForShares(price, shares);
  const totalCost = Number(notional) + takerFee;
  return {
    taker_fee_usd: takerFee,
    total_cost_usd: totalCost,
    cost_per_share: shares > 0 ? totalCost / shares : null,
  };
}

export function estimateTakerSellProceeds(price, shares, notional) {
  const takerFee = discountedTakerFeeForShares(price, shares);
  return {
    taker_fee_usd: takerFee,
    net_proceeds_usd: Number(notional) - takerFee,
  };
}
