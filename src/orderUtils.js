/**
 * 将 Predict 订单按状态分组
 * @param {Array} orders API 返回的订单数组
 * @returns {Object} 按状态分组的对象
 */
function groupOrdersByStatus(orders) {
    const grouped = {
      completed: [],        // 已完成
      open: [],             // 挂单中
      canceledOrExpired: [],// 已取消 / 过期 / 失效
    };
  
    orders.forEach(item => {
        console.log('item',item)
      const status = item.status?.toUpperCase?.() || "";
      const strategy = item.strategy?.toUpperCase?.() || "";
      const amount = item.amount || "0";
      const amountFilled = item.amountFilled || "0";
  
      if (status === "FILLED") {
        // 只要状态是 FILLED 就算完成
        grouped.completed.push(item);
      }
      else if (status === "OPEN") {
        grouped.open.push(item);
      }
      else if (["CANCELLED", "EXPIRED", "INVALIDATED"].includes(status)) {
        grouped.canceledOrExpired.push(item);
      }
      else {
        console.warn(`未识别订单状态: ${status}`, item.id);
      }
    });
  
    return grouped;
  }
  
  /**
   * 打印分组后的订单信息
   * @param {Object} groupedOrders groupOrdersByStatus 的返回值
   */
  function printGroupedOrders(groupedOrders) {
    console.log("✅ 已完成订单数量:", groupedOrders.completed.length);
    groupedOrders.completed.forEach(o => 
      console.log(`  - ID: ${o.id}, 策略: ${o.strategy}, 数量: ${o.amount}, 已成交: ${o.amountFilled}, 状态: ${o.status}`)
    );
  
    console.log("\n🟡 挂单中数量:", groupedOrders.open.length);
    groupedOrders.open.forEach(o => 
      console.log(`  - ID: ${o.id}, 策略: ${o.strategy}, 数量: ${o.amount}, 已成交: ${o.amountFilled}, 状态: ${o.status}`)
    );
  
    console.log("\n❌ 已取消/过期/失效数量:", groupedOrders.canceledOrExpired.length);
    groupedOrders.canceledOrExpired.forEach(o => 
      console.log(`  - ID: ${o.id}, 策略: ${o.strategy}, 数量: ${o.amount}, 已成交: ${o.amountFilled}, 状态: ${o.status}`)
    );
  }
  
  module.exports = { groupOrdersByStatus, printGroupedOrders };
  