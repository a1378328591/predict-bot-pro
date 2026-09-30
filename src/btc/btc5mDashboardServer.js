import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, openSync, closeSync, readFileSync, readSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const HOST = process.env.BTC_DASHBOARD_HOST || "127.0.0.1";
const PREFERRED_PORT = positiveInt(process.env.BTC_DASHBOARD_PORT, 3210);
const SESSION_STARTED_AT = Number.isFinite(Number(process.env.BTC_DASHBOARD_SESSION_START_MS))
  ? Number(process.env.BTC_DASHBOARD_SESSION_START_MS)
  : Date.now();
const DATA_DIR = resolve(process.env.BTC_SAMPLE_OUTPUT_DIR || "data/btc");
const PUBLIC_DIR = resolve("src/btc/dashboard");
const FILES = {
  snapshots: resolve(DATA_DIR, "snapshots.jsonl"),
  signals: resolve(DATA_DIR, "z_score_signals.jsonl"),
  executions: resolve(DATA_DIR, "z_score_execution_log.jsonl"),
  settlements: resolve(DATA_DIR, "settlements.jsonl"),
  executorState: resolve(DATA_DIR, "z_score_executor_state.json"),
};

const clients = new Set();
let lastPayload = "";
let settlementCache = { size: -1, winners: new Map() };

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readTailLines(file, count, maxBytes) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (!size) return [];
  const bytes = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(bytes);
  const descriptor = openSync(file, "r");
  try {
    readSync(descriptor, buffer, 0, bytes, size - bytes);
  } finally {
    closeSync(descriptor);
  }
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (size > bytes) lines.shift();
  return lines.slice(-count).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function compactBook(outcome) {
  const book = outcome?.book;
  if (!book) return null;
  return {
    name: outcome.outcome_name,
    bestBid: book.best_bid ?? null,
    bestAsk: book.best_ask ?? null,
    spread: book.spread ?? null,
    mid: book.mid ?? null,
    bidDepthUsd: book.bid_depth_usd ?? null,
    askDepthUsd: book.ask_depth_usd ?? null,
    bids: (book.levels?.bids || []).slice(0, 5),
    asks: (book.levels?.asks || []).slice(0, 5),
  };
}

function compactSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    observedAt: snapshot.observed_at,
    observedAtMs: snapshot.observed_at_ms,
    categorySlug: snapshot.category_slug,
    marketId: snapshot.market_id,
    title: snapshot.market_title,
    status: snapshot.market_trading_status,
    startPrice: snapshot.start_price,
    reference: snapshot.reference_price,
    returnFromStart: snapshot.reference_return_from_start,
    timing: snapshot.timing,
    outcomes: (snapshot.outcomes || []).map(compactBook).filter(Boolean),
  };
}

function compactSignal(signal) {
  if (!signal) return null;
  const features = signal.features || {};
  return {
    type: signal.type,
    observedAt: signal.observed_at,
    reason: signal.reason ?? null,
    direction: features.direction ?? null,
    remainingSeconds: features.remaining_seconds ?? null,
    startPrice: features.start_price ?? null,
    referencePrice: features.reference_price ?? null,
    microprice: features.microprice ?? null,
    modelPrice: features.model_price ?? null,
    deviationBps: features.deviation_bps ?? null,
    zScore: features.z_score ?? null,
    upProbability: features.up_probability ?? null,
    conservativeUpProbability: features.conservative_up_probability ?? null,
    conservativeDownProbability: features.conservative_down_probability ?? null,
    modelProbability: features.model_probability ?? null,
    conservativeProbability: features.conservative_probability ?? null,
    sigma: features.sigma_bps_per_sqrt_second ?? null,
    fastVariance: features.fast_variance_per_second ?? null,
    slowVariance: features.slow_variance_per_second ?? null,
    ask: features.ask ?? null,
    bid: features.bid ?? null,
    spread: features.spread ?? null,
    costPerShare: features.cost_per_share ?? null,
    edge: features.model_edge_before_margin ?? null,
    probability: signal.probability ?? null,
    requiredProbability: signal.required_probability ?? null,
    breakEvenProbability: signal.break_even_probability ?? null,
  };
}

function compactExecution(entry) {
  return {
    type: entry.type,
    observedAt: entry.observed_at,
    categorySlug: entry.category_slug ?? null,
    direction: entry.direction ?? null,
    message: entry.message ?? null,
    orderId: entry.order_id ?? null,
    notional: entry.fixed_notional_usd ?? null,
    shares: entry.shares ?? null,
    bid: entry.bid ?? null,
    limitPrice: entry.limit_price ?? null,
    holdingProbability: entry.holding_probability ?? null,
    netSellPerShare: entry.net_sell_per_share ?? null,
  };
}

function settlementWinners() {
  if (!existsSync(FILES.settlements)) return new Map();
  const size = statSync(FILES.settlements).size;
  if (size === settlementCache.size) return settlementCache.winners;
  const winners = new Map(settlementCache.winners);
  for (const settlement of readTailLines(FILES.settlements, 200, 4 * 1024 * 1024)) {
    const market = settlement?.markets?.[0];
    const winner = market?.outcomes?.find(outcome => outcome?.status === "WON")?.name ?? market?.resolution?.name;
    if (settlement?.category_slug && winner) winners.set(settlement.category_slug, String(winner).toLowerCase());
  }
  settlementCache = { size, winners };
  return winners;
}

function estimatedSessionPnl(snapshot) {
  const rows = readTailLines(FILES.executions, 2_000, 4 * 1024 * 1024)
    .filter(entry => new Date(entry?.observed_at || 0).getTime() >= SESSION_STARTED_AT);
  const winners = settlementWinners();
  const trades = new Map();

  for (const entry of rows) {
    const slug = entry?.category_slug;
    if (!slug) continue;
    if (entry.type === "ORDER_SUBMITTED") {
      const shares = Number(entry?.quote?.shares);
      const cost = Number(entry?.quote?.total_cost_usd);
      if (!(shares > 0) || !(cost > 0)) continue;
      trades.set(slug, {
        slug,
        direction: String(entry.direction || "").toLowerCase(),
        openedAt: entry.observed_at,
        orderId: entry.order_id ?? null,
        shares,
        cost,
        entryPrice: Number(entry.limit_price),
        buyStatus: "submitted",
      });
      continue;
    }
    const trade = trades.get(slug);
    if (!trade) continue;
    if (entry.type === "ORDER_CLOSED_OR_FILLED") trade.buyStatus = "closed_or_filled";
    if (entry.type === "ORDER_CANCEL_REQUESTED") trade.buyStatus = "cancel_requested_fill_unknown";
    if (entry.type === "MODEL_EXIT_SUBMITTED" && !trade.exit) {
      const exitShares = Math.min(trade.shares, Number(entry.shares) || trade.shares);
      const netPerShare = Number(entry.net_sell_per_share);
      if (exitShares > 0 && netPerShare >= 0) {
        trade.exit = {
          observedAt: entry.observed_at,
          shares: exitShares,
          netProceeds: exitShares * netPerShare,
          price: Number(entry.sell_vwap ?? entry.limit_price ?? entry.bid),
          status: "submitted",
        };
      }
    }
    if (trade.exit && entry.type === "MODEL_EXIT_CLOSED_OR_FILLED") trade.exit.status = "closed_or_filled";
    if (trade.exit && entry.type === "MODEL_EXIT_CANCEL_REQUESTED") trade.exit.status = "cancel_requested_fill_unknown";
  }

  const details = [...trades.values()].map(trade => {
    const winner = winners.get(trade.slug) ?? null;
    let status = "open";
    let value = null;
    if (trade.exit?.status === "closed_or_filled") {
      status = "model_exit";
      value = trade.exit.netProceeds;
    } else if (winner) {
      status = "settled";
      value = winner === trade.direction ? trade.shares : 0;
    } else if (snapshot?.category_slug === trade.slug) {
      const outcome = snapshot.outcomes?.find(item => String(item?.outcome_name || "").toLowerCase() === trade.direction);
      const bid = Number(outcome?.book?.best_bid?.price);
      if (bid > 0) {
        const gross = bid * trade.shares;
        const fee = 0.018 * Math.min(bid, 1 - bid) * trade.shares;
        value = gross - fee;
      }
    }
    if (trade.buyStatus === "cancel_requested_fill_unknown" && !winner) value = null;
    const pnl = value === null ? null : value - trade.cost;
    return { ...trade, winner, status, value, pnl };
  }).sort((left, right) => String(right.openedAt).localeCompare(String(left.openedAt)));

  const valued = details.filter(trade => Number.isFinite(trade.pnl));
  const realized = details.filter(trade => trade.status === "settled" || trade.status === "model_exit");
  const unrealized = details.filter(trade => trade.status === "open" && Number.isFinite(trade.pnl));
  const sum = rowsToSum => rowsToSum.reduce((total, trade) => total + trade.pnl, 0);
  return {
    startedAt: new Date(SESSION_STARTED_AT).toISOString(),
    estimated: true,
    trades: details.length,
    valuedTrades: valued.length,
    wins: realized.filter(trade => trade.pnl > 0).length,
    losses: realized.filter(trade => trade.pnl < 0).length,
    totalPnl: sum(valued),
    realizedPnl: sum(realized),
    unrealizedPnl: sum(unrealized),
    deployed: details.reduce((total, trade) => total + trade.cost, 0),
    details: details.slice(0, 30),
  };
}

function buildState() {
  const snapshots = readTailLines(FILES.snapshots, 1, 2 * 1024 * 1024);
  const snapshot = snapshots.at(-1) ?? null;
  const slug = snapshot?.category_slug;
  const signals = readTailLines(FILES.signals, 300, 2 * 1024 * 1024);
  const currentSignals = slug ? signals.filter(signal => signal?.features?.category_slug === slug) : signals;
  const model = [...currentSignals].reverse().find(signal => signal.type === "MODEL_UPDATE") ?? null;
  const decision = [...currentSignals].reverse().find(signal => signal.type === "PAPER_BUY" || signal.type === "PAPER_SKIP") ?? null;
  const executions = readTailLines(FILES.executions, 30, 512 * 1024).map(compactExecution).reverse();
  const executorState = readJson(FILES.executorState, {});
  const tracked = slug ? executorState.traded_markets?.[slug] ?? null : null;

  return {
    generatedAt: new Date().toISOString(),
    config: {
      liveTrading: String(process.env.Z_LIVE_TRADING || "false").toLowerCase() === "true",
      notionalUsd: Number(process.env.Z_EXECUTION_NOTIONAL_USD || 5),
      entryZ: Number(process.env.Z_ENTRY_THRESHOLD || 0.5),
      edgeMargin: Number(process.env.Z_EDGE_MARGIN || 0.005),
      minEntryProbability: Number(process.env.Z_MIN_ENTRY_PROBABILITY || 0.70),
      maxSpread: Number(process.env.Z_MAX_SPREAD || 0.02),
      minHistorySeconds: Number(process.env.Z_MIN_HISTORY_SECONDS || 25),
      minExecutionSeconds: Number(process.env.Z_EXECUTION_MIN_REMAINING_SECONDS || 2),
      exitMargin: Number(process.env.Z_EXIT_EDGE_MARGIN || 0.20),
    },
    snapshot: compactSnapshot(snapshot),
    model: compactSignal(model),
    decision: compactSignal(decision),
    trackedPosition: tracked,
    sessionPnl: estimatedSessionPnl(snapshot),
    executions,
    files: {
      snapshotBytes: existsSync(FILES.snapshots) ? statSync(FILES.snapshots).size : 0,
      signalBytes: existsSync(FILES.signals) ? statSync(FILES.signals).size : 0,
    },
  };
}

function contentType(file) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" })[extname(file)] || "application/octet-stream";
}

function sendJson(response, data) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

const server = createServer((request, response) => {
  const path = new URL(request.url, `http://${request.headers.host || HOST}`).pathname;
  if (path === "/api/state") return sendJson(response, buildState());
  if (path === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`data: ${JSON.stringify(buildState())}\n\n`);
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  const asset = path === "/" ? "index.html" : path.slice(1);
  if (!new Set(["index.html", "dashboard.css", "dashboard.js"]).has(asset)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const file = resolve(PUBLIC_DIR, asset);
  response.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": asset === "index.html" ? "no-store" : "public, max-age=60" });
  response.end(readFileSync(file));
});

const timer = setInterval(() => {
  if (!clients.size) return;
  try {
    const payload = JSON.stringify(buildState());
    if (payload === lastPayload) return;
    lastPayload = payload;
    for (const client of clients) client.write(`data: ${payload}\n\n`);
  } catch (error) {
    console.error("Dashboard refresh failed:", error.message);
  }
}, 1_000);

let activePort = PREFERRED_PORT;
let attempts = 0;
server.on("error", error => {
  if (error?.code === "EADDRINUSE" && attempts < 10) {
    attempts += 1;
    activePort += 1;
    server.listen(activePort, HOST);
    return;
  }
  console.error("BTC dashboard failed:", error.message);
  process.exitCode = 1;
});
server.on("listening", () => console.log(`BTC dashboard: http://${HOST}:${activePort}`));
server.listen(activePort, HOST);

function shutdown() {
  clearInterval(timer);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
