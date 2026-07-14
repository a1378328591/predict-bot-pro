import "dotenv/config";
import { pushDingTalk } from "./dingPush.js";

const GRAPHQL_URL = "https://graphql.predict.fun/graphql";

const { PREDICT_ACCOUNT } = process.env;

if (!PREDICT_ACCOUNT) {
    throw new Error("缺少 PREDICT_ACCOUNT 环境变量");
}

const ADDRESS = PREDICT_ACCOUNT;

/**
 * 获取用户排行榜信息
 * @param {string} address
 */
async function getLeaderboard(address) {
    const body = {
        operationName: "GetLeaderboardUserStats",
        query: `
query GetLeaderboardUserStats($address: Address!) {
  account(address: $address) {
    leaderboard {
      allocationRoundPoints
      totalPoints
      rank
    }
  }
}`,
        variables: {
            address
        }
    };

    const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
            "Origin": "https://predict.fun",
            "Referer": "https://predict.fun/",
            "Accept": "application/graphql-response+json, application/json",
            "Content-Type": "application/json",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
            "x-accept-language": "en"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const json = await res.json();

    if (json.errors) {
        throw new Error(JSON.stringify(json.errors));
    }

    if (!json.data?.account?.leaderboard) {
        throw new Error("未获取到 leaderboard 数据");
    }

    return json.data.account.leaderboard;
}

let lastPoint = null;

async function monitor() {
    console.log("====================================");
    console.log("开始监控 Predict.fun 积分");
    console.log("钱包：", ADDRESS);
    console.log("====================================");
    await pushDingTalk('测试推送');
    while (true) {
        try {
            const data = await getLeaderboard(ADDRESS);

            const point = Number(data.totalPoints);

            console.log(
                `[${new Date().toLocaleString()}] 当前积分：${point}`
            );

            // 第一次运行，仅初始化
            if (lastPoint === null) {
                lastPoint = point;
                console.log(`初始化积分：${point}`);
            }
            // 积分上涨
            else if (point > lastPoint) {
                const increase = point - lastPoint;

                console.log(
                    `🎉 积分上涨：+${increase.toFixed(6)}`
                );

                await pushDingTalk(
`🎉 Predict.fun 积分上涨！

钱包：
${ADDRESS}

旧积分：
${lastPoint}

新积分：
${point}

增加：
${increase.toFixed(6)}

本周积分：
${data.allocationRoundPoints}

当前排名：
${data.rank}`
                );

                // 更新最新积分
                lastPoint = point;
            }
        } catch (err) {
            console.error(
                `[${new Date().toLocaleString()}] 获取积分失败：`,
                err.message
            );
        }

        // 每5秒检查一次
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

monitor().catch(console.error);