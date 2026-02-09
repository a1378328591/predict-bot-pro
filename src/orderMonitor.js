import "dotenv/config";
import { getOrders } from "./getOrders.js";
import { groupOrdersByStatus, printGroupedOrders } from "./orderUtils.js";
import { pushDingTalk } from "./dingPush.js";

// 挂单推送间隔（秒，默认 10 分钟）
const ORDER_PUSH_INTERVAL =
  Number(process.env.ORDER_PUSH_INTERVAL_SECONDS || 600) * 1000;

/**
 * 拉取并推送挂单信息
 */
async function pushOrders() {
  try {
    const orders = await getOrders({ first: 100 });

    if (!orders || orders.length === 0) {
      await pushDingTalk("📭 当前无挂单");
      return;
    }

    // 分组
    const grouped = groupOrdersByStatus(orders);

    // 生成文本（要求 printGroupedOrders 支持 returnText）
    const text = printGroupedOrders(grouped, { returnText: true });

    await pushDingTalk(`📄 当前挂单状态（定时推送）\n\n${text}`);
  } catch (err) {
    console.error("❌ 查询挂单或推送失败:", err);
  }
}

// =================
// 定时执行
// =================

// 启动立即推送一次
pushOrders();

// 按固定周期推送
setInterval(pushOrders, ORDER_PUSH_INTERVAL);
