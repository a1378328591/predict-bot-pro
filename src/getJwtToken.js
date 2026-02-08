import { Wallet } from "ethers";
import "dotenv/config";

const BASE_URL = "https://api.predict.fun";

/**
 * 获取 Predict JWT Token（公共方法）
 */
export async function getJwtToken() {
  const {
    PRIVY_PRIVATE_KEY,
    PREDICT_API_KEY,
  } = process.env;

  if (!PRIVY_PRIVATE_KEY || !PREDICT_API_KEY) {
    throw new Error("缺少必要的环境变量");
  }

  const wallet = new Wallet(PRIVY_PRIVATE_KEY);

  // 1️⃣ 获取 auth message
  const msgRes = await fetch(`${BASE_URL}/v1/auth/message`, {
    headers: {
      "x-api-key": PREDICT_API_KEY,
    },
  });

  if (!msgRes.ok) {
    throw new Error(`获取 auth message 失败: ${msgRes.status}`);
  }

  const msgJson = await msgRes.json();

  if (!msgJson.success) {
    throw new Error(`auth message 返回错误: ${JSON.stringify(msgJson)}`);
  }

  const message = msgJson.data.message;
  console.log('message', message)

  // 2️⃣ 对 message 签名
  const signature = await wallet.signMessage(message);

  // 3️⃣ 换取 JWT token
  const authRes = await fetch(`${BASE_URL}/v1/auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
    },
    body: JSON.stringify({
      signer: wallet.address,
      message,
      signature,
    }),
  });

  if (!authRes.ok) {
    const text = await authRes.text();
    throw new Error(`Auth failed: ${authRes.status} ${text}`);
  }

  const authJson = await authRes.json();

  if (!authJson.success) {
    throw new Error(`Auth response error: ${JSON.stringify(authJson)}`);
  }

  return authJson.data.token;
}

/**
 * 直接运行测试
 */
if (process.argv[1].endsWith("getJwtToken.js")) {
  getJwtToken()
    .then(token => {
      console.log("✅ JWT Token 获取成功：\n");
      console.log(token);
    })
    .catch(err => {
      console.error("❌ 获取 JWT Token 失败：", err);
      process.exit(1);
    });
}
