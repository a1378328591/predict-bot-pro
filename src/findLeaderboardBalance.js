const GRAPHQL_URL = "https://graphql.predict.fun/graphql";
const TARGET_USD = 10700;
const TOLERANCE_USD = 1000;
const LEADERBOARD_LIMIT = 800;
const PAGE_SIZE = 25;
const CONCURRENCY = 5;

async function graphql(body) {
    const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
            "Origin": "https://predict.fun",
            "Referer": "https://predict.fun/",
            "Accept": "application/graphql-response+json, application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors) {
        throw new Error(JSON.stringify(json.errors));
    }

    return json.data;
}

async function fetchLeaderboardPage(after) {
    const data = await graphql({
        operationName: "GetLeaderboardData",
        query: `
query GetLeaderboardData($pagination: ForwardPaginationInput) {
  leaderboard(pagination: $pagination) {
    edges {
      node {
        rank
        totalPoints
        account {
          name
          address
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
        variables: {
            pagination: {
                first: PAGE_SIZE,
                ...(after ? { after } : {})
            }
        }
    });

    if (!data?.leaderboard) {
        throw new Error("排行榜响应缺少 leaderboard 数据");
    }

    return data.leaderboard;
}

async function getPortfolioSummary(leaderboardAccount) {
    const address = leaderboardAccount.account.address;
    const data = await graphql({
        operationName: "GetPortfolioSummary",
        query: `
query GetPortfolioSummary($address: Address!) {
  account(address: $address) {
    leaderboard {
      totalPoints
    }
    statistics {
      positionsValueUsd
    }
  }
}`,
        variables: { address }
    });

    const account = data?.account;
    const positionsValueUsd = Number(account?.statistics?.positionsValueUsd);
    if (!account || !Number.isFinite(positionsValueUsd)) {
        throw new Error("未返回有效的 positionsValueUsd");
    }

    return {
        ...leaderboardAccount,
        totalPoints: Number(account.leaderboard?.totalPoints ?? leaderboardAccount.totalPoints),
        positionsValueUsd
    };
}

async function mapWithConcurrency(items, callback) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            try {
                results[index] = await callback(items[index]);
            } catch (error) {
                console.warn(`组合查询失败 ${items[index].account.address}: ${error.message}`);
                results[index] = null;
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return results;
}

async function main() {
    const minimumUsd = TARGET_USD - TOLERANCE_USD;
    const maximumUsd = TARGET_USD + TOLERANCE_USD;
    let after;
    let scanned = 0;
    const matches = [];

    console.log(`扫描积分榜前 ${LEADERBOARD_LIMIT} 名`);
    console.log(`目标组合价值: ${TARGET_USD} U，范围: ${minimumUsd} - ${maximumUsd} U`);

    while (scanned < LEADERBOARD_LIMIT) {
        const page = await fetchLeaderboardPage(after);
        const accounts = page.edges
            .map(edge => edge.node)
            .filter(node => node.account?.address)
            .slice(0, LEADERBOARD_LIMIT - scanned);

        if (!accounts.length) break;

        const portfolios = await mapWithConcurrency(accounts, getPortfolioSummary);
        for (const portfolio of portfolios) {
            if (!portfolio) continue;

            if (portfolio.positionsValueUsd >= minimumUsd && portfolio.positionsValueUsd <= maximumUsd) {
                matches.push(portfolio);
            }
        }

        scanned += accounts.length;
        console.log(`已扫描 ${scanned} / ${LEADERBOARD_LIMIT} 名，命中 ${matches.length} 个`);

        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
        after = page.pageInfo.endCursor;
    }

    matches.sort((a, b) => Math.abs(a.positionsValueUsd - TARGET_USD) - Math.abs(b.positionsValueUsd - TARGET_USD));

    console.log(`\n扫描完成：${scanned} 名，范围内 ${matches.length} 名`);
    if (!matches.length) return;

    console.table(matches.map(account => ({
        rank: account.rank,
        name: account.account.name || "(未设置)",
        address: account.account.address,
        portfolioUsd: account.positionsValueUsd.toFixed(2),
        differenceUsd: (account.positionsValueUsd - TARGET_USD).toFixed(2),
        totalPoints: account.totalPoints.toFixed(2)
    })));
}

main().catch(error => {
    console.error("扫描失败:", error.message);
    process.exitCode = 1;
});
