import "dotenv/config";
import { Wallet } from "ethers";
import { OrderBuilder, ChainId } from "@predictdotfun/sdk";

/**
 * =========================
 * JWT 内存缓存
 * =========================
 */
let cachedToken = null;
let cachedExpireAt = 0; // 秒级时间戳

// 从 .env 读取缓存时长（秒），默认 2 小时
const CACHE_TTL_SECONDS = Number(process.env.JWT_CACHE_TTL_SECONDS) || 2 * 60 * 60;

/**
 * 获取 Predict JWT Token（使用 SDK，带缓存）
 */
async function getJwtTokenWithSDK() {
  const now = Math.floor(Date.now() / 1000);

  // ✅ 缓存命中（提前 60 秒失效，留安全窗口）
  if (cachedToken && cachedExpireAt - now > 60) {
    return cachedToken;
  }

  const {
    PRIVY_PRIVATE_KEY,
    PREDICT_API_KEY,
    PREDICT_ACCOUNT,
  } = process.env;

  if (!PRIVY_PRIVATE_KEY || !PREDICT_API_KEY || !PREDICT_ACCOUNT) {
    throw new Error(
      "缺少必要的环境变量 PRIVY_PRIVATE_KEY / PREDICT_API_KEY / PREDICT_ACCOUNT"
    );
  }

  // 1️⃣ 创建 Privy Wallet
  const privyWallet = new Wallet(PRIVY_PRIVATE_KEY);

  // 2️⃣ 创建 OrderBuilder（Smart Wallet）
  const builder = await OrderBuilder.make(
    ChainId.BnbMainnet,
    privyWallet,
    { predictAccount: PREDICT_ACCOUNT }
  );

  // 3️⃣ 获取动态 message
  const msgRes = await fetch("https://api.predict.fun/v1/auth/message", {
    method: "GET",
    headers: {
      "x-api-key": PREDICT_API_KEY,
    },
  });

  if (!msgRes.ok) {
    throw new Error(`获取 auth message 失败: ${msgRes.status}`);
  }

  const msgJson = await msgRes.json();
  if (!msgJson.success) {
    throw new Error(`auth message 返回失败: ${JSON.stringify(msgJson)}`);
  }

  const message = msgJson.data.message;

  // 4️⃣ 签名
  const signature = await builder.signPredictAccountMessage(message);

  // 5️⃣ 获取 JWT
  const jwtRes = await fetch("https://api.predict.fun/v1/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PREDICT_API_KEY,
    },
    body: JSON.stringify({
      signer: PREDICT_ACCOUNT,
      message,
      signature,
    }),
  });

  if (!jwtRes.ok) {
    const text = await jwtRes.text();
    throw new Error(`获取 JWT 失败: ${jwtRes.status} ${text}`);
  }

  const jwtJson = await jwtRes.json();
  if (!jwtJson.success) {
    throw new Error(`JWT 返回失败: ${JSON.stringify(jwtJson)}`);
  }

  const token = jwtJson.data.token;
  const payload = decodeJwt(token);

  // ✅ 缓存过期时间 = token 实际 exp 和 本地 TTL 取最小
  cachedToken = token;
  cachedExpireAt = Math.min(
    payload.exp,
    now + CACHE_TTL_SECONDS
  );

  console.log("🔐 刷新 JWT 成功");
  console.log("👤 Wallet:", payload.sub);
  console.log(
    "🕒 本地缓存有效期至:",
    new Date(cachedExpireAt * 1000).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    })
  );

  return token;
}

/**
 * 解码 JWT payload
 */
function decodeJwt(token) {
  const payload = token.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

/**
 * =================
 * 直接运行测试
 * =================
 */
if (process.argv[1].endsWith("getJwtTokenWithSDK.js")) {
  getJwtTokenWithSDK()
    .then(() => {
      console.log("✅ JWT Token 获取成功");
    })
    .catch((err) => {
      console.error("❌ 获取 JWT Token 失败：", err);
      process.exit(1);
    });
}

export { getJwtTokenWithSDK };
