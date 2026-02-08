import "dotenv/config";

export const CONFIG = {
  CHAIN_ID: 56, // BNB mainnet
  PRIVY_PRIVATE_KEY: process.env.PRIVY_PRIVATE_KEY!,
  PREDICT_ACCOUNT: process.env.PREDICT_ACCOUNT!,

  // 下单用多少 USDT
  ORDER_USDT_AMOUNT: 100,
};
