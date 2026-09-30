import "dotenv/config";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pushDingTalk } from "./dingPush.js";

// 监控配置：业务密钥仍从现有 dotenv 配置读取，这些监控参数只改本文件。
const MONITORED_ACCOUNTS = [
  
  {
    name: "Franky0nfire",
    address: "0xE01DC76bAd456363b9AD9122c1Ea8D9E1B9CF0D6",
  },
];
const POLL_INTERVAL_MS = 10_000;
const FIRST = 100;
const USE_PROXY = true;
const PROXY_URL = "http://127.0.0.1:7890";
const API_BASE_URL = "https://api.predict.fun";

const { PREDICT_API_KEY } = process.env;
if (!PREDICT_API_KEY) {
  throw new Error("缺少 PREDICT_API_KEY 环境变量");
}

const proxyAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL) : undefined;
let seenMatchKeys = null;
let checking = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCryptoMarket(market = {}) {
  const variantData = market.variantData || {};
  return market.marketVariant === "CRYPTO_UP_DOWN"
    || variantData.type === "CRYPTO_UP_DOWN"
    || String(market.categorySlug || "").toLowerCase().includes("crypto");
}

function fillKey(match, fill, role, account) {
  const signer = String(fill?.signer || account.address).toLowerCase();
  const outcomeId = fill?.outcome?.onChainId ?? fill?.outcome?.indexSet ?? fill?.outcome?.name ?? "unknown-outcome";
  return [
    match.transactionHash,
    match.executedAt,
    role,
    signer,
    outcomeId,
    fill?.quoteType,
    fill?.amount,
  ].join(":");
}

function getAddressFills(match, account) {
  const address = account.address.toLowerCase();
  const fills = [];
  if (String(match.taker?.signer || "").toLowerCase() === address) {
    fills.push({ role: "taker", fill: match.taker });
  }
  for (const maker of match.makers || []) {
    if (String(maker?.signer || "").toLowerCase() === address) {
      fills.push({ role: "maker", fill: maker });
    }
  }
  return fills;
}

function formatFixed18(value) {
  const number = Number(value) / 1e18;
  return Number.isFinite(number) ? number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(value ?? "未知");
}

function marketTypeLabel(market = {}) {
  const labels = {
    SPORTS_MONEYLINE: "胜负盘",
    SPORTS_SPREADS: "让分盘",
    SPORTS_TOTALS: "总分盘",
    SPORTS_BOTH_TEAMS_TO_SCORE: "双方均进球？",
    SPORTS_BOTH_TEAMS_TO_SCORE_FIRST_HALF: "上半场双方均进球",
    SPORTS_BOTH_TEAMS_TO_SCORE_SECOND_HALF: "下半场双方均进球",
    SPORTS_EXACT_SCORE: "精确比分",
    SPORTS_FIRST_TO_SCORE: "首先进球的球队",
    SPORTS_HALFTIME_RESULT: "半场结果",
    SPORTS_TEAM_TO_ADVANCE: "晋级球队",
    SPORTS_SECOND_HALF_RESULT: "下半场结果",
    SPORTS_EXTRA_TIME: "加时赛？",
    SPORTS_PENALTY_SHOOTOUT: "点球大战？",
    SPORTS_TOTAL_CORNERS: "总角球数",
    SPORTS_FIRST_HALF_TOTAL_CORNERS: "上半场总角球数",
    SPORTS_SECOND_HALF_TOTAL_CORNERS: "下半场总角球数",
    SPORTS_CORNERS_ODD_EVEN: "角球单双",
    SPORTS_FIRST_CORNER: "首个角球",
    SPORTS_FIRST_HALF_TOTALS: "上半场大小球",
    SPORTS_SECOND_HALF_TOTALS: "下半场大小球",
  };
  return labels[market.marketType] || market.marketType || market.marketVariant || "未知盘口";
}

function marketOutcomes(market = {}) {
  const names = (market.outcomes || [])
    .map(outcome => outcome?.name)
    .filter(Boolean);
  return names.length > 0 ? names.join(" / ") : "接口未返回市场选项";
}

function formatBeijingTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

async function getMatches(account) {
  const query = new URLSearchParams({
    first: String(FIRST),
    signerAddress: account.address,
  });
  const url = `${API_BASE_URL}/v1/orders/matches?${query}`;
  const response = await fetch(url, {
    agent: proxyAgent,
    headers: { "x-api-key": PREDICT_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`查询成交失败：${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const json = await response.json();
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error(`查询成交返回失败：${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data;
}

function formatFill(match, role, fill, account) {
  const market = match.market || {};
  const outcome = fill.outcome || {};
  const side = fill.quoteType === "Bid" ? "买入" : fill.quoteType === "Ask" ? "卖出" : "未知方向";
  const shares = Number(fill.amount) / 1e18;
  const price = Number(fill.price) / 1e18;
  return [
    `用户：${account.name}`,
    `地址：${account.address}`,
    `${side} ${role}`,
    `市场：${market.question || market.title || "未知市场"}`,
    `盘口类型：${marketTypeLabel(market)}`,
    `市场选项：${marketOutcomes(market)}`,
    `成交结果：${outcome.name || "未知"}`,
    `市场 ID：${market.id ?? "未知"}`,
    `成交数量：${Number.isFinite(shares) ? shares.toFixed(4) : fill.amount} Shares`,
    `成交价格：${Number.isFinite(price) ? `${formatFixed18(fill.price)}（${(price * 100).toFixed(2)}¢）` : "未知"}`,
    `成交时间（北京时间）：${formatBeijingTime(match.executedAt)}`,
  ].join("\n");
}

async function checkOnce() {
  if (checking) return;
  checking = true;
  try {
    const accountMatches = await Promise.all(
      MONITORED_ACCOUNTS.map(async account => ({
        account,
        matches: await getMatches(account),
      })),
    );
    const events = accountMatches.flatMap(({ account, matches }) => matches
      .filter(match => !isCryptoMarket(match.market))
      .flatMap(match => getAddressFills(match, account).map(({ role, fill }) => ({
        key: fillKey(match, fill, role, account),
        match,
        role,
        fill,
        account,
      }))));
    const currentKeys = new Set(events.map(event => event.key));

    // 第一次只建立基线，避免把接口返回的历史成交全部推送。
    if (seenMatchKeys === null) {
      seenMatchKeys = currentKeys;
      console.log(`初始化成交基线：${currentKeys.size} 条（已过滤加密市场）`);
      return;
    }

    const newEvents = events.filter(event => !seenMatchKeys.has(event.key));
    seenMatchKeys = new Set([...seenMatchKeys, ...currentKeys]);
    console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] 成交 ${events.length} 条，新增 ${newEvents.length} 条`);

    if (newEvents.length > 0) {
      const message = [
        "Predict.fun 新成交提醒",
        "",
        newEvents.map(event => formatFill(event.match, event.role, event.fill, event.account)).join("\n\n"),
      ].join("\n");
      await pushDingTalk(message, { agent: proxyAgent });
    }
  } catch (error) {
    console.error(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] 成交监控失败：`, error.message);
  } finally {
    checking = false;
  }
}

console.log(`开始监控 ${MONITORED_ACCOUNTS.length} 个地址的成交，间隔 ${POLL_INTERVAL_MS}ms，代理：${USE_PROXY ? PROXY_URL : "关闭"}`);
await checkOnce();
while (true) {
  await sleep(POLL_INTERVAL_MS);
  await checkOnce();
}
