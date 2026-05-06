import "dotenv/config";
import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import { getJwtTokenWithSDK } from "./src/getJwtTokenWithSDK.js";

const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT } = process.env;

async function test() {
  const signer = new Wallet(PRIVY_PRIVATE_KEY);
  const orderBuilder = await OrderBuilder.make(
    ChainId.BnbMainnet,
    signer,
    { predictAccount: PREDICT_ACCOUNT }
  );

  // 获取第一个市场
  const res = await fetch('https://api.predict.fun/v1/markets?first=1&status=OPEN', {
    headers: { 'x-api-key': PREDICT_API_KEY }
  });
  const json = await res.json();
  const market = json.data[0];
  
  console.log('Market:', market.title);
  console.log('ConditionId:', market.conditionId);
  
  const outcome = market.outcomes[0];
  console.log('Outcome:', outcome.name);
  console.log('onChainId:', outcome.onChainId);

  const pricePerShareWei = BigInt(Math.floor(0.5 * 1e18)); // 0.5
  const usdtWei = BigInt(5) * 10n ** 18n; // 5 USDT
  const quantityWei = (usdtWei * 10n ** 18n) / pricePerShareWei;

  const { makerAmount, takerAmount, pricePerShare } = orderBuilder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei,
    quantityWei,
  });

  const order = orderBuilder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
  });

  const typedData = orderBuilder.buildTypedData(order, {
    isNegRisk: market.isNegRisk || false,
    isYieldBearing: market.isYieldBearing || false,
  });

  const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
  const hash = orderBuilder.buildTypedDataHash(typedData);

  console.log('SignedOrder keys:', Object.keys(signedOrder));
  console.log('Hash:', hash);

  // 准备请求体
  const payload = {
    data: {
      order: { ...signedOrder, hash },
      pricePerShare,
      strategy: "LIMIT",
    }
  };
  
  // 序列化 BigInt
  const body = JSON.stringify(payload, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  console.log('Body prepared');

  const jwt = await getJwtTokenWithSDK();
  
  const orderRes = await fetch("https://api.predict.fun/v1/orders", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
      "Authorization": `Bearer ${jwt}`,
    },
    body,
  });

  const responseText = await orderRes.text();
  console.log('Response status:', orderRes.status);
  console.log('Response:', responseText.slice(0, 200));
}

test().catch(console.error);
