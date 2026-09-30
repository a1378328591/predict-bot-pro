import "dotenv/config";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";
import { ChainId, OrderBuilder, Side } from "@predictdotfun/sdk";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { normalizedOutcomeBook, sdkOrderbook } from "../btc/sessionLiveOrderRules.js";
import {
  positionIncreases,
  positionSnapshot,
  positionsByAddressPath,
  weiToDecimalString,
} from "./copyTradeRules.js";

const API_BASE_URL = "https://api.predict.fun";
const LEADER = {
  name: "wangcai888",
  address: "0xAB46aDb797806CA52084283b51e2E31Da507a69c",
  profile: "https://predict.fun/zh-cn/portfolio/wangcai888",
};
const POLL_INTERVAL_MS = 1_000;
const MAX_SHARES_PER_POSITION_INCREASE = 60;
const MARKET_SLIPPAGE_BPS = 500n;
const POSITION_PAGE_SIZE = 100;
const MAX_POSITION_PAGES = 20;
const POSITION_REQUEST_TIMEOUT_MS = 5_000;
const STARTUP_REQUEST_TIMEOUT_MS = 5_000;
const USE_PROXY = true;
const PROXY_URL = "http://127.0.0.1:7890";
const HEARTBEAT_MS = 30_000;
const MAX_STATE_EVENTS = 50_000;
const MAX_STATE_POSITIONS = 20_000;
const MAX_COPY_WEI = BigInt(MAX_SHARES_PER_POSITION_INCREASE) * 10n ** 18n;

const DATA_DIR = resolve("data/copy-trading");
const LOG_FILE = resolve(DATA_DIR, "wangcai_actions.jsonl");
const STATE_FILE = resolve(DATA_DIR, "wangcai_state.json");
const LOCK_FILE = resolve(DATA_DIR, "wangcai.lock");
const proxyAgent = USE_PROXY ? new HttpsProxyAgent(PROXY_URL, { keepAlive: true }) : undefined;
const { PREDICT_API_KEY, PRIVY_PRIVATE_KEY, PREDICT_ACCOUNT } = process.env;

let state;
let lockOwned = false;
let stopping = false;
let orderBuilder = null;
let cachedToken = null;
let cachedTokenExpiresAt = 0;
let lastPositionPollMs = null;

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function requireCredentials() {
  if (!PREDICT_API_KEY || !PRIVY_PRIVATE_KEY || !PREDICT_ACCOUNT) {
    throw new Error("Real copy trading requires PREDICT_API_KEY, PRIVY_PRIVATE_KEY, and PREDICT_ACCOUNT");
  }
}

function acquireLock() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
    let active = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        active = true;
      } catch (error) {
        active = error?.code === "EPERM";
      }
    }
    if (active) throw new Error(`Another wangcai copy trader is already running (pid=${pid})`);
    unlinkSync(LOCK_FILE);
  }
  const descriptor = openSync(LOCK_FILE, "wx");
  writeFileSync(descriptor, String(process.pid), "utf8");
  closeSync(descriptor);
  lockOwned = true;
}

function releaseLock() {
  if (!lockOwned) return;
  try {
    if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // The operating system also releases the process; a stale lock is checked on next start.
  }
  lockOwned = false;
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { schema_version: 2, initialized: false, processed_events: {}, leader_positions: {}, next_action_sequence: 1 };
  }
  const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid state file: ${STATE_FILE}`);
  parsed.processed_events ??= {};
  parsed.leader_positions ??= {};
  parsed.next_action_sequence = Number(parsed.next_action_sequence) || 1;
  return parsed;
}

function trimObject(object, limit) {
  return Object.fromEntries(Object.entries(object).slice(-limit));
}

function saveState() {
  state.processed_events = trimObject(state.processed_events, MAX_STATE_EVENTS);
  state.leader_positions = trimObject(state.leader_positions, MAX_STATE_POSITIONS);
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, STATE_FILE);
}

function logRecord(type, details = {}) {
  const record = { schema_version: 1, type, observed_at: new Date().toISOString(), ...details };
  appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
  const message = details.message ? ` ${details.message}` : "";
  console.log(`${record.observed_at} ${type}${message}`);
  return record;
}

async function requestJson(path, options = {}) {
  const response = await fetch(new URL(path, API_BASE_URL), { ...options, agent: proxyAgent });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text.slice(0, 300)}`);
  if (!body || body.success === false) throw new Error(`API rejected ${path}: ${text.slice(0, 300)}`);
  return body;
}

async function getOrderBuilder() {
  if (!orderBuilder) {
    orderBuilder = await OrderBuilder.make(
      ChainId.BnbMainnet,
      new Wallet(PRIVY_PRIVATE_KEY),
      { predictAccount: PREDICT_ACCOUNT },
    );
  }
  return orderBuilder;
}

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}

async function getJwtToken() {
  const now = Math.floor(Date.now() / 1_000);
  if (cachedToken && cachedTokenExpiresAt - now > 60) return cachedToken;
  const builder = await getOrderBuilder();
  const messageResponse = await requestJson("/v1/auth/message", {
    headers: { "x-api-key": PREDICT_API_KEY },
  });
  const message = messageResponse.data?.message;
  if (!message) throw new Error("Authentication message is missing");
  const signature = await builder.signPredictAccountMessage(message);
  const authResponse = await requestJson("/v1/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PREDICT_API_KEY },
    body: JSON.stringify({ signer: PREDICT_ACCOUNT, message, signature }),
  });
  cachedToken = authResponse.data?.token;
  if (!cachedToken) throw new Error("Authentication token is missing");
  cachedTokenExpiresAt = Math.min(tokenExpiry(cachedToken) || now + 7_200, now + 7_200);
  return cachedToken;
}

async function authenticatedHeaders() {
  return {
    "x-api-key": PREDICT_API_KEY,
    Authorization: `Bearer ${await getJwtToken()}`,
  };
}

async function fetchLeaderPositionPage(after, timeoutMs) {
  const query = new URLSearchParams({
    first: String(POSITION_PAGE_SIZE),
    isResolved: "false",
  });
  if (after) query.set("after", after);
  return requestJson(positionsByAddressPath(LEADER.address, query), {
    headers: { "x-api-key": PREDICT_API_KEY },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function fetchLeaderPositions(timeoutMs = POSITION_REQUEST_TIMEOUT_MS) {
  const positions = [];
  let after = null;
  let hasMore = false;
  for (let page = 0; page < MAX_POSITION_PAGES; page += 1) {
    const response = await fetchLeaderPositionPage(after, timeoutMs);
    const pagePositions = Array.isArray(response.data) ? response.data : [];
    positions.push(...pagePositions);
    hasMore = Boolean(response.cursor && pagePositions.length > 0);
    if (!hasMore) break;
    after = response.cursor;
  }
  if (hasMore) throw new Error(`leader_position_pagination_exceeded_${MAX_POSITION_PAGES}_pages`);
  return positions;
}

async function submitMarketOrder(event, quantityWei, actionId) {
  const market = event.market;
  if (!market?.id || String(market.tradingStatus).toUpperCase() !== "OPEN") {
    throw new Error("market_not_open");
  }
  const outcome = (market.outcomes || []).find(item => String(item?.onChainId) === String(event.outcomeId));
  if (!outcome?.onChainId) throw new Error("outcome_not_found_in_market");
  const orderbookResponse = await requestJson(`/v1/markets/${encodeURIComponent(market.id)}/orderbook`, {
    headers: { "x-api-key": PREDICT_API_KEY },
  });
  const book = normalizedOutcomeBook(orderbookResponse.data, market, outcome);
  const builder = await getOrderBuilder();
  const amounts = builder.getMarketOrderAmounts({
    side: Side.BUY,
    quantityWei,
    slippageBps: MARKET_SLIPPAGE_BPS,
    isMinAmountOut: true,
  }, sdkOrderbook(book));
  const order = builder.buildOrder("MARKET", {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    nonce: 0n,
    feeRateBps: market.feeRateBps || 0,
  });
  const typedData = builder.buildTypedData(order, {
    isNegRisk: market.isNegRisk || false,
    isYieldBearing: market.isYieldBearing || false,
  });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  logRecord("COPY_ORDER_PREPARED", {
    action_id: actionId,
    order_hash: hash,
    slippage_bps: Number(amounts.slippageBps),
    is_min_amount_out: amounts.isMinAmountOut,
  });
  const response = await requestJson("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authenticatedHeaders()) },
    body: JSON.stringify({
      data: {
        order: { ...signedOrder, hash },
        pricePerShare: amounts.pricePerShare,
        strategy: "MARKET",
        slippageBps: amounts.slippageBps,
        isMinAmountOut: amounts.isMinAmountOut,
      },
    }, (_, value) => typeof value === "bigint" ? value.toString() : value),
  });
  return {
    orderHash: hash,
    orderId: response.data?.id ?? response.data?.orderId ?? response.data?.hash ?? null,
    referencePrice: Number(amounts.pricePerShare) / 1e18,
    slippageBps: Number(amounts.slippageBps),
    isMinAmountOut: amounts.isMinAmountOut,
  };
}

function validPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : null;
}

function positionIncreasePrice(increase) {
  const beforeShares = Number(increase.beforeWei) / 1e18;
  const afterShares = Number(increase.afterWei) / 1e18;
  const deltaShares = Number(increase.deltaWei) / 1e18;
  const beforeAverage = validPrice(increase.before?.average_buy_price_usd);
  const afterAverage = validPrice(increase.after?.average_buy_price_usd);
  if (afterAverage === null) return { price: null, source: "unavailable" };
  if (beforeAverage !== null && deltaShares > 0) {
    const incremental = (afterShares * afterAverage - beforeShares * beforeAverage) / deltaShares;
    if (validPrice(incremental) !== null) return { price: incremental, source: "inferred_from_average_buy_price_change" };
  }
  return { price: afterAverage, source: "current_average_buy_price" };
}

function increaseEvent(increase) {
  const position = increase.position;
  const marketId = position?.market?.id;
  const outcomeId = position?.outcome?.onChainId ?? position?.outcome?.indexSet ?? position?.outcome?.name;
  const reference = positionIncreasePrice(increase);
  return {
    side: "BUY",
    shares: Number(increase.deltaWei) / 1e18,
    price: reference.price,
    priceSource: reference.source,
    market: position?.market || {},
    marketId,
    outcome: position?.outcome || {},
    outcomeId,
    beforeShares: Number(increase.beforeWei) / 1e18,
    afterShares: Number(increase.afterWei) / 1e18,
  };
}

function baseLogDetails(event) {
  return {
    leader_name: LEADER.name,
    leader_address: LEADER.address,
    leader_side: event.side,
    leader_shares: event.shares,
    leader_price: event.price,
    leader_price_source: event.priceSource,
    leader_shares_before: event.beforeShares,
    leader_shares_after: event.afterShares,
    market_id: event.marketId,
    market_question: event.market?.question || event.market?.title || null,
    category_slug: event.market?.categorySlug || null,
    outcome_id: event.outcomeId,
    outcome_name: event.outcome?.name || null,
    outcome_status: event.outcome?.status || null,
  };
}

async function processPositionIncrease(increase) {
  const event = increaseEvent(increase);
  const reservedWei = increase.deltaWei < MAX_COPY_WEI ? increase.deltaWei : MAX_COPY_WEI;
  const sequence = state.next_action_sequence++;
  const actionId = `increase:${sequence}:${increase.key}:${increase.beforeWei}:${increase.afterWei}`;
  state.processed_events[actionId] = {
    status: "reserved",
    action_id: actionId,
    reserved_at: new Date().toISOString(),
  };
  state.leader_positions[increase.key] = increase.after;
  saveState();

  const common = baseLogDetails(event);
  logRecord("LEADER_POSITION_INCREASE_DETECTED", { action_id: actionId, ...common });

  const actionDetails = {
    action_id: actionId,
    side: event.side,
    copy_shares: Number(weiToDecimalString(reservedWei, 8)),
    requested_copy_shares: Number(weiToDecimalString(reservedWei, 8)),
    ...common,
  };
  logRecord("COPY_ACTION", actionDetails);
  state.processed_events[actionId].status = "submitting";
  state.processed_events[actionId].copy_shares_wei = reservedWei.toString();
  saveState();

  try {
    const submitted = await submitMarketOrder(event, reservedWei, actionId);
    state.processed_events[actionId].status = "submitted";
    state.processed_events[actionId].follower_order_hash = submitted.orderHash;
    logRecord("COPY_ORDER_SUBMITTED", {
      action_id: actionId,
      side: event.side,
      copy_shares: actionDetails.copy_shares,
      order_hash: submitted.orderHash,
      order_id: submitted.orderId,
      follower_market_reference_price: submitted.referencePrice,
      slippage_bps: submitted.slippageBps,
      is_min_amount_out: submitted.isMinAmountOut,
    });
  } catch (error) {
    state.processed_events[actionId].status = "failed_no_retry";
    state.processed_events[actionId].error = error.message;
    logRecord("COPY_ORDER_FAILED", {
      action_id: actionId,
      side: event.side,
      copy_shares: actionDetails.copy_shares,
      message: error.message,
    });
  }
  saveState();
}

async function initializeBaseline() {
  const positions = await fetchLeaderPositions(STARTUP_REQUEST_TIMEOUT_MS);
  state.leader_positions = positionSnapshot(positions);
  state.initialized = true;
  state.positions_baselined = true;
  state.schema_version = 2;
  state.baseline_at = new Date().toISOString();
  saveState();
  logRecord("BASELINE_INITIALIZED", {
    leader_name: LEADER.name,
    leader_address: LEADER.address,
    baseline_positions: Object.keys(state.leader_positions).length,
    message: "Current positions were recorded as the baseline and were not copied",
  });
}

async function pollOnce() {
  const startedAt = Date.now();
  const positions = await fetchLeaderPositions();
  lastPositionPollMs = Date.now() - startedAt;
  const current = positionSnapshot(positions);
  const increases = positionIncreases(state.leader_positions, current).sort((a, b) => a.key.localeCompare(b.key));
  for (const increase of increases) await processPositionIncrease(increase);
  state.leader_positions = current;
  saveState();
  return increases.length;
}

async function main() {
  requireCredentials();
  acquireLock();
  state = loadState();
  try {
    console.log("WANGCAI COPY TRADER STARTED. REAL MARKET ORDERS ARE ENABLED.");
    console.log(`leader=${LEADER.name} address=${LEADER.address} mode=buy-only source=position-increase poll=${POLL_INTERVAL_MS}ms timeout=${POSITION_REQUEST_TIMEOUT_MS}ms max=${MAX_SHARES_PER_POSITION_INCREASE} shares/increase slippage=${MARKET_SLIPPAGE_BPS}bps minAmountOut=true proxy=${USE_PROXY ? PROXY_URL : "off"}`);
    if (!state.positions_baselined) await initializeBaseline();
    try {
      await getJwtToken();
      console.log("Copy-trading authentication is ready.");
    } catch (error) {
      console.warn(`Copy-trading authentication warm-up failed; it will retry on an action: ${error.message}`);
    }

    let lastHeartbeatAt = 0;
    while (!stopping) {
      const startedAt = Date.now();
      try {
        const increases = await pollOnce();
        if (increases > 0) console.log(`${new Date().toISOString()} copied_position_increases=${increases}`);
      } catch (error) {
        console.error(`${new Date().toISOString()} copy poll failed: ${error.message}`);
      }
      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        console.log(`${new Date().toISOString()} COPY_HEARTBEAT processed=${Object.keys(state.processed_events).length} position_poll_ms=${lastPositionPollMs ?? "n/a"}`);
      }
      const remaining = POLL_INTERVAL_MS - (Date.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
    }
    saveState();
  } finally {
    releaseLock();
  }
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.on("exit", releaseLock);

main().catch(error => {
  releaseLock();
  console.error(`Wangcai copy trader failed: ${error.message}`);
  process.exitCode = 1;
});
