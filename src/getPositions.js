// getPositions.js
import "dotenv/config";
import { getJwtTokenWithSDK } from "./getJwtTokenWithSDK.js";

const BASE_URL = "https://api.predict.fun";

/**
 * 获取持仓列表
 * @param {Object} params 可选参数 { first, after }
 */
export async function getPositions(params = {}) {
  const { PREDICT_API_KEY } = process.env;

  if (!PREDICT_API_KEY) {
    throw new Error("缺少 PREDICT_API_KEY 环境变量");
  }

  // 获取 JWT Token
  const jwtToken = await getJwtTokenWithSDK();

  // 构造 URL query
  const query = new URLSearchParams();
  if (params.first) query.append("first", params.first);
  if (params.after) query.append("after", params.after);

  const url = `${BASE_URL}/v1/positions?${query.toString()}`;

  const res = await fetch(url, {
    headers: {
      "x-api-key": PREDICT_API_KEY,
      "Authorization": `Bearer ${jwtToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`获取持仓失败: ${res.status} ${text}`);
  }

  const json = await res.json();

  if (!json.success) {
    throw new Error(`获取持仓返回失败: ${JSON.stringify(json)}`);
  }

  return json.data; // 返回持仓数组
}

// =================
// 直接运行测试
// =================
if (process.argv[1].endsWith("getPositions.js")) {
  getPositions({ first: 100 })
    .then(positions => {
      console.log("✅ 持仓列表获取成功，共", positions.length, "条");
      console.log(positions); // 打印原始持仓数组
    })
    .catch(err => {
      console.error("❌ 获取持仓失败：", err);
      process.exit(1);
    });
}
