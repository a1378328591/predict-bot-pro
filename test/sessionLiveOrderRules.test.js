import test from "node:test";
import assert from "node:assert/strict";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import { liveQuoteRejectionReason, normalizedOutcomeBook, quoteForShares, sdkOrderbook } from "../src/btc/sessionLiveOrderRules.js";
import { SESSION_TREND_FIXED_SHARES } from "../src/btc/sessionTrendConfig.js";

test("quotes exactly twenty shares across multiple ask levels", () => {
  const quote = quoteForShares({ bids: [{ price: 0.59, size: 100 }], asks: [{ price: 0.60, size: 10 }, { price: 0.61, size: 20 }] }, 20);
  assert.equal(quote.vwap, 0.605);
  assert.equal(quote.limitPrice, 0.61);
  assert.equal(quote.notionalUsd, 12.1);
});

test("rejects a quote whose last fill exceeds the maximum price", () => {
  const quote = quoteForShares({ bids: [{ price: 0.68, size: 100 }], asks: [{ price: 0.69, size: 10 }, { price: 0.71, size: 20 }] }, 20);
  assert.equal(liveQuoteRejectionReason(quote, { minPrice: 0.35, maxPrice: 0.70, maxSpread: 0.02 }), "limit_price_above_max");
});

test("normalizes the second binary outcome by inverting the direct book", () => {
  const market = { outcomes: [{ onChainId: "up" }, { onChainId: "down" }] };
  const book = normalizedOutcomeBook({ bids: [[0.40, 5]], asks: [[0.42, 7]] }, market, market.outcomes[1]);
  assert.deepEqual(book.bids, [{ price: 0.5800000000000001, size: 7 }]);
  assert.deepEqual(book.asks, [{ price: 0.6, size: 5 }]);
});

test("builds SDK market-buy amounts for the configured ten shares", async () => {
  const book = sdkOrderbook({
    bids: [{ price: 0.59, size: 100 }],
    asks: [{ price: 0.60, size: 4 }, { price: 0.61, size: 20 }],
  });
  const builder = await OrderBuilder.make(ChainId.BnbMainnet);
  const amounts = builder.getMarketOrderAmounts({
    side: Side.BUY,
    quantityWei: BigInt(SESSION_TREND_FIXED_SHARES) * 10n ** 18n,
  }, book);

  assert.equal(SESSION_TREND_FIXED_SHARES, 10);
  assert.deepEqual(book.asks, [[0.60, 4], [0.61, 20]]);
  assert.equal(amounts.amount, 10n * 10n ** 18n);
  assert.equal(amounts.takerAmount, 10n * 10n ** 18n);
  assert.equal(amounts.pricePerShare, 606n * 10n ** 15n);
  assert.equal(amounts.lastPrice, 61n * 10n ** 16n);
  assert.equal(amounts.slippageBps, 0n);
});

test("applies five-percent market-buy slippage as minimum shares without inflating spend", async () => {
  const book = sdkOrderbook({
    bids: [{ price: 0.58, size: 100 }],
    asks: [{ price: 0.59, size: 20 }],
  });
  const builder = await OrderBuilder.make(ChainId.BnbMainnet);
  const amounts = builder.getMarketOrderAmounts({
    side: Side.BUY,
    quantityWei: 20n * 10n ** 18n,
    slippageBps: 500n,
    isMinAmountOut: true,
  }, book);

  assert.equal(amounts.amount, 20n * 10n ** 18n);
  assert.equal(amounts.makerAmount, 118n * 10n ** 17n);
  assert.equal(amounts.takerAmount, 19n * 10n ** 18n);
  assert.equal(amounts.slippageBps, 500n);
  assert.equal(amounts.isMinAmountOut, true);
});

test("builds SDK market-sell amounts for an exact share quantity", async () => {
  const book = sdkOrderbook({
    bids: [{ price: 0.60, size: 20 }],
    asks: [{ price: 0.61, size: 20 }],
  });
  const builder = await OrderBuilder.make(ChainId.BnbMainnet);
  const amounts = builder.getMarketOrderAmounts({
    side: Side.SELL,
    quantityWei: 10n * 10n ** 18n,
  }, book);

  assert.equal(amounts.amount, 10n * 10n ** 18n);
  assert.equal(amounts.makerAmount, 10n * 10n ** 18n);
  assert.equal(amounts.takerAmount, 6n * 10n ** 18n);
  assert.equal(amounts.pricePerShare, 6n * 10n ** 17n);
  assert.equal(amounts.slippageBps, 0n);
});
