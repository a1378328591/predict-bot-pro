import { getOrders } from "./getOrders.js";
import { groupOrdersByStatus, printGroupedOrders } from "./orderUtils.js";

(async () => {
  try {
    const orders = await getOrders({ first: 100 });

    // 分组
    const grouped = groupOrdersByStatus(orders);

    // 打印
    printGroupedOrders(grouped);
  } catch (err) {
    console.error("❌ 错误:", err);
  }
})();
