import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import { CONFIG } from "./config";
import { getTopVolumeMarket, getBuy2Price } from "./api";

export async function runBot() {
  const signer = new Wallet(CONFIG.PRIVY_PRIVATE_KEY);

  const orderBuilder = await OrderBuilder.make(
    ChainId.BnbMainnet,
    signer,
    {
      predictAccount: CONFIG.PREDICT_ACCOUNT,
    }
  );

  const market = await getTopVolumeMarket();

  

  if (!market.outcomes || market.outcomes.length === 0) {
    throw new Error("Market has no outcomes");
  }

  const outcome = market.outcomes[0];

  const pricePerShareWei = BigInt(
    await getBuy2Price(market.conditionId)
  );

  const usdtWei =
    BigInt(CONFIG.ORDER_USDT_AMOUNT) * 10n ** 18n;

  const quantityWei =
    (usdtWei * 10n ** 18n) / pricePerShareWei;

  const { makerAmount, takerAmount, pricePerShare } =
    orderBuilder.getLimitOrderAmounts({
      side: Side.BUY,
      pricePerShareWei,
      quantityWei,
    });

  const order = orderBuilder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.tokenId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps,
  });

  const typedData = orderBuilder.buildTypedData(order, {
    isNegRisk: market.isNegRisk,
    isYieldBearing: market.isYieldBearing,
  });

  const signedOrder =
    await orderBuilder.signTypedDataOrder(typedData);

  const hash =
    orderBuilder.buildTypedDataHash(typedData);

  await fetch("https://api.predict.fun/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        order: { ...signedOrder, hash },
        pricePerShare,
        strategy: "LIMIT",
      },
    }),
  });

  console.log("✅ LIMIT 买二挂单成功");
}
