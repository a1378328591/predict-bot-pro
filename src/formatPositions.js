/**
 * 将 positions 数据格式化为简明文本
 * @param {Array} positions 持仓数组
 * @returns {string} 格式化后的文本
 */
export function formatPositions(positions) {
    //console.log(JSON.stringify(positions, null, 2));

    if (!positions || positions.length === 0) return "ℹ️ 当前没有持仓";

    const now = new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
  
    return positions.map(pos => {
      const market = pos.market || {};
      const outcome = pos.outcome || {};
  
      // 持仓数量 shares
      const amount = Number(pos.amount) / 1e18; 
  
      // 市场状态
      const marketStatus = market.status || "UNKNOWN";
  
      return [
        `❓ 市场: ${market.question || "暂无"}`,
        `📈 持仓方向: ${outcome.name || "未知"} `,
        `💰 持仓数量: ${amount.toFixed(2)} Shares`,
        `💰 持仓金额: $${pos.valueUsd}`,
        `⏰ 推送时间: ${now}`,
      ].join("\n");
    }).join("\n\n"); // 每条持仓之间空一行
  }

  function getBeijingTime() {
    return new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  }
  
  // =================
  // 测试用
  // =================
  if (process.argv[1].endsWith("formatPositions.js")) {
    import("./getPositions.js").then(({ getPositions }) => {
      getPositions({ first: 100 }).then(positions => {
        const text = formatPositions(positions);
        console.log("📄 格式化持仓信息:\n", text);
      }).catch(console.error);
    });
  }
  