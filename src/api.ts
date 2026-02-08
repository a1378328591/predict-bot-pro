// src/api.ts

const API_KEY = process.env.PREDICT_API_KEY;

if (!API_KEY) {
  throw new Error("Missing PREDICT_API_KEY in .env");
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  

async function fetchJson(url: string) {
  const res = await fetch(url, {
    headers: {
      "x-api-key": API_KEY!,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

export async function getTopVolumeMarket() {
    let after: string | undefined;
    let page = 0;
  
    const openMarkets: any[] = [];
  
    while (page < 20) {          // 先别 50000
      page++;
  
      const url = new URL("https://api.predict.fun/v1/markets");
      url.searchParams.set("first", "50");
      if (after) url.searchParams.set("after", after);
  
      const json = await fetchJson(url.toString());
      const markets = json.data as any[];
      console.log('markets', markets)
  
      for (const m of markets) {
        if (m.status === "RESOLVED") continue;
  
        console.log("NON-RESOLVED market ↓↓↓");
        console.log("status:", m.status);
        console.log(JSON.stringify(m, null, 2));
        console.log("──────────────────────────");
  
        openMarkets.push(m);
      }
  
      if (!json.cursor) break;
      after = json.cursor;
  
      await sleep(300);
    }
  
    return openMarkets[0];
  }
  
  
  

export async function getBuy2Price(marketId: string) {
  const json = await fetchJson(
    `https://api.predict.fun/v1/markets/${marketId}/orderbook`
  );

  const bids = json.data.bids;
  if (!bids || bids.length < 2) {
    throw new Error("Not enough bids");
  }

  return bids[1].pricePerShareWei;
}
