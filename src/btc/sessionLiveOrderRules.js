export function parseOrderbookLevel(level) {
  const price = Number(level?.price ?? level?.pricePerShare ?? level?.[0]);
  const size = Number(level?.size ?? level?.quantity ?? level?.shares ?? level?.[1]);
  return Number.isFinite(price) && Number.isFinite(size) && price > 0 && price < 1 && size > 0 ? { price, size } : null;
}

export function normalizedOutcomeBook(rawBook, market, outcome) {
  const bids = (rawBook?.bids || []).map(parseOrderbookLevel).filter(Boolean).sort((a, b) => b.price - a.price);
  const asks = (rawBook?.asks || []).map(parseOrderbookLevel).filter(Boolean).sort((a, b) => a.price - b.price);
  const index = (market?.outcomes || []).findIndex(item => String(item?.onChainId) === String(outcome?.onChainId));
  if (index !== 1 || market?.outcomes?.length !== 2) return { bids, asks };
  return {
    bids: asks.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => b.price - a.price),
    asks: bids.map(level => ({ price: 1 - level.price, size: level.size })).sort((a, b) => a.price - b.price),
  };
}

export function quoteForShares(book, targetShares) {
  let remaining = Number(targetShares);
  let cost = 0;
  let limitPrice = null;
  for (const level of book?.asks || []) {
    const shares = Math.min(remaining, Number(level.size));
    if (!(shares > 0)) continue;
    cost += shares * Number(level.price);
    remaining -= shares;
    limitPrice = Number(level.price);
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9 || !(cost > 0) || !(limitPrice > 0)) return null;
  const bestAsk = Number(book.asks[0]?.price);
  const bestBid = Number(book.bids?.[0]?.price);
  return {
    shares: Number(targetShares),
    notionalUsd: cost,
    vwap: cost / Number(targetShares),
    limitPrice,
    bestAsk,
    bestBid,
    spread: Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? bestAsk - bestBid : null,
  };
}

export function sdkOrderbook(book) {
  return {
    bids: (book?.bids || []).map(level => [level.price, level.size]),
    asks: (book?.asks || []).map(level => [level.price, level.size]),
  };
}

export function liveQuoteRejectionReason(quote, limits) {
  if (!quote) return "insufficient_orderbook_depth";
  if (!Number.isFinite(quote.spread) || quote.spread < 0 || quote.spread > limits.maxSpread + 1e-9) return "spread_too_wide";
  if (quote.vwap < limits.minPrice || quote.vwap > limits.maxPrice) return "vwap_out_of_range";
  if (quote.limitPrice > limits.maxPrice) return "limit_price_above_max";
  return null;
}
