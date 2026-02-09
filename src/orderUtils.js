/**
 * 将 Predict 订单按状态分组
 * @param {Array} orders API 返回的订单数组
 * @returns {Object} 按状态分组的对象
 */
export function groupOrdersByStatus(orders = []) {
  const grouped = {
    completed: [],         // 已完成
    open: [],              // 挂单中
    canceledOrExpired: [], // 已取消 / 过期 / 失效
  };

  orders.forEach(item => {
    const status = item.status?.toUpperCase?.() || "";

    if (status === "FILLED") {
      grouped.completed.push(item);
    } else if (status === "OPEN") {
      grouped.open.push(item);
    } else if (["CANCELLED", "CANCELED", "EXPIRED", "INVALIDATED"].includes(status)) {
      grouped.canceledOrExpired.push(item);
    } else {
      console.warn(`⚠️ 未识别订单状态: ${status}`, item.id);
    }
  });

  return grouped;
}


/**
 * 打印 / 返回分组后的订单信息（适合钉钉推送）
 */
export function printGroupedOrders(groupedOrders, options = {}) {
  const { returnText = false } = options;
  const lines = [];

  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });

  // =====================
  // OPEN 挂单
  // =====================
  lines.push(`🟡 挂单中数量: ${groupedOrders.open.length}`);

  groupedOrders.open.forEach(o => {
    const amount = Number(o.amount) / 1e18;
    const filled = Number(o.amountFilled) / 1e18;

    const expireTime = o.order?.expiration
      ? new Date(o.order.expiration * 1000).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
      : "未知";

    const side =
      o.order?.side === 0 ? "买入 (YES)" :
      o.order?.side === 1 ? "卖出 (NO)" :
      "未知方向";

    lines.push(
      [
        `  - 订单ID: ${o.id}`,
        `    📌 方向: ${side}`,
        `    📦 挂单数量: ${amount.toFixed(2)}`,
        `    ✅ 已成交: ${filled.toFixed(2)}`,
        `    ⏳ 到期时间: ${expireTime}`,
      ].join("\n")
    );
  });

  lines.push(`\n⏰ 推送时间: ${now}`);

  const text = lines.join("\n");

  if (returnText) return text;
  console.log(text);
}
