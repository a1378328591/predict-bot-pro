import "dotenv/config";
import { getJwtTokenWithSDK } from "./getJwtTokenWithSDK.js"; // 获取 JWT 模块

const BASE_URL = "https://api.predict.fun";

/**
 * 获取订单列表
 * @param {Object} params 可选参数 { first, after, status }
 */
export async function getOrders(params = {}) {
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
  if (params.status) query.append("status", params.status);

  const url = `${BASE_URL}/v1/orders?${query.toString()}`;

  const res = await fetch(url, {
    headers: {
      "x-api-key": PREDICT_API_KEY,
      "Authorization": `Bearer ${jwtToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`获取订单失败: ${res.status} ${text}`);
  }

  const json = await res.json();

  if (!json.success) {
    throw new Error(`获取订单返回失败: ${JSON.stringify(json)}`);
  }

  return json.data; // 只返回订单数组，方便工具函数处理
}

// =================
// 直接运行测试
// , status: "FILLED" 或OPEN
// =================
if (process.argv[1].endsWith("getOrders.js")) {
  getOrders({ first: 100 })
    .then(orders => {
      console.log("✅ 订单列表获取成功，共", orders.length, "条");
      console.log(orders.map(order => ({ id: order.id, status: order.status, marketId: order.marketId })));
    })
    .catch(err => {
      console.error("❌ 获取订单失败：", err);
      process.exit(1);
    });
}
