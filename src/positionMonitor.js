import "dotenv/config";
import { getPositions } from "./getPositions.js";
import { formatPositions } from "./formatPositions.js";
import { pushDingTalk } from "./dingPush.js";

const MIN_INTERVAL = Number(process.env.MIN_INTERVAL_SECONDS || 60) * 1000;
const NORMAL_PUSH_INTERVAL = Number(process.env.NORMAL_PUSH_INTERVAL_SECONDS || 600) * 1000;

let lastPositionsIds = new Set(); // 存储上次的仓位 id
let lastPushTime = 0;

/**
 * 判断是否有新增仓位
 * @param {Array} positions 当前查询到的 positions
 * @returns {Array} 新增仓位数组
 */
function getNewPositions(positions) {
  const newPositions = positions.filter(p => !lastPositionsIds.has(p.id));
  return newPositions;
}

/**
 * 更新 lastPositionsIds
 * @param {Array} positions
 */
function updateLastPositionsIds(positions) {
  lastPositionsIds = new Set(positions.map(p => p.id));
}

async function checkPositions() {
  try {
    const positions = await getPositions({ first: 100 });
    const now = Date.now();

    const newPositions = getNewPositions(positions);
    const needNormalPush = now - lastPushTime > NORMAL_PUSH_INTERVAL;

    if (newPositions.length > 0) {
      // 有新增仓位，立刻推送
      const text = formatPositions(newPositions);
      await pushDingTalk(`🚀 新增仓位提醒\n\n${text}`);
      updateLastPositionsIds(positions);
      lastPushTime = now;
    } else if (needNormalPush) {
      // 无新增，但超过10分钟，定期推送
      const text = formatPositions(positions);
      await pushDingTalk(`⏱ 定期持仓状态\n\n${text}`);
      updateLastPositionsIds(positions);
      lastPushTime = now;
    } else {
      console.log("ℹ️ 持仓无新增，暂不推送");
    }
  } catch (err) {
    console.error("❌ 查询持仓或推送失败:", err);
  }
}

// 每分钟检查一次
setInterval(checkPositions, MIN_INTERVAL);

// 启动时立即执行一次
checkPositions();
