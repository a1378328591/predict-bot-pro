import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { summarizeCopyActions } from "./copyTradeRules.js";

const API_BASE_URL = "https://api.predict.fun";
const LOG_FILE = resolve("data/copy-trading/wangcai_actions.jsonl");
const PROXY_URL = "http://127.0.0.1:7890";
const proxyAgent = new HttpsProxyAgent(PROXY_URL);
const { PREDICT_API_KEY } = process.env;

function readRecords() {
  if (!existsSync(LOG_FILE)) return { records: [], invalidLines: 0 };
  const records = [];
  let invalidLines = 0;
  for (const line of readFileSync(LOG_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

async function fetchMarket(marketId) {
  const response = await fetch(`${API_BASE_URL}/v1/markets/${encodeURIComponent(marketId)}`, {
    agent: proxyAgent,
    headers: { "x-api-key": PREDICT_API_KEY },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (body?.success === false || !body?.data) throw new Error(`invalid response: ${text.slice(0, 200)}`);
  return body.data;
}

async function loadOutcomeStatuses(actions) {
  const statuses = new Map();
  for (const action of actions) {
    const snapshot = String(action.outcome_status || "").toUpperCase();
    if (snapshot === "WON" || snapshot === "LOST") {
      statuses.set(`${action.market_id}|${action.outcome_id}`, snapshot);
    }
  }
  if (!PREDICT_API_KEY) return { statuses, refreshFailures: 0, refreshSkipped: true };

  const marketIds = [...new Set(actions.map(action => action.market_id).filter(value => value !== undefined && value !== null))];
  let refreshFailures = 0;
  for (const marketId of marketIds) {
    try {
      const market = await fetchMarket(marketId);
      for (const outcome of market.outcomes || []) {
        const outcomeId = outcome?.onChainId ?? outcome?.indexSet ?? outcome?.name;
        statuses.set(`${marketId}|${outcomeId}`, String(outcome?.status || "").toUpperCase());
      }
    } catch (error) {
      refreshFailures += 1;
      console.error(`Cannot refresh market ${marketId}: ${error.message}`);
    }
  }
  return { statuses, refreshFailures, refreshSkipped: false };
}

const { records, invalidLines } = readRecords();
const actionsById = new Map();
const resultsById = new Map();
for (const record of records) {
  if (record.type === "COPY_ACTION" && record.action_id) actionsById.set(record.action_id, record);
  if (["COPY_ORDER_SUBMITTED", "COPY_ORDER_FAILED", "COPY_ORDER_SKIPPED"].includes(record.type) && record.action_id) {
    resultsById.set(record.action_id, record);
  }
}

const actions = [...actionsById.values()].filter(action => action.side === "BUY").map(action => {
  const result = resultsById.get(action.action_id);
  const loggedPrice = Number(action.leader_price);
  if (Number.isFinite(loggedPrice) && loggedPrice >= 0 && loggedPrice <= 1) return action;
  const marketReference = Number(result?.follower_market_reference_price);
  return Number.isFinite(marketReference) && marketReference >= 0 && marketReference <= 1
    ? { ...action, leader_price: marketReference, leader_price_source: "follower_market_quote" }
    : action;
});
const { statuses, refreshFailures, refreshSkipped } = await loadOutcomeStatuses(actions);
const total = summarizeCopyActions(actions, statuses);
const buyActionIds = new Set(actions.map(action => action.action_id));
const submitted = [...resultsById.values()].filter(record => buyActionIds.has(record.action_id) && record.type === "COPY_ORDER_SUBMITTED").length;
const failed = [...resultsById.values()].filter(record => buyActionIds.has(record.action_id) && record.type === "COPY_ORDER_FAILED").length;
const skipped = records.filter(record => record.type === "COPY_ORDER_SKIPPED" && record.side === "BUY").length;
const detected = new Set(records
  .filter(record => record.type === "LEADER_POSITION_INCREASE_DETECTED" || (record.type === "LEADER_FILL_DETECTED" && record.leader_side === "BUY"))
  .map(record => record.action_id)).size;
const latestAction = actions.reduce((latest, action) => {
  const value = action.observed_at || action.leader_executed_at;
  return !latest || new Date(value) > new Date(latest) ? value : latest;
}, null);

console.log(JSON.stringify({
  calculation_basis: "buy_only_leader_position_increase; buy_price_inferred_from_average_cost; actual_fills_and_fees_ignored",
  leader_position_increases_detected: detected,
  order_actions: actions.length,
  submitted_actions: submitted,
  failed_actions: failed,
  skipped_actions: skipped,
  pending_or_uncertain_actions: Math.max(0, actions.length - submitted - failed),
  total,
  by_direction: { buy: actions.length },
  market_status_refresh: {
    skipped: refreshSkipped,
    failures: refreshFailures,
  },
  invalid_log_lines: invalidLines,
  latest_action_at: latestAction,
}));
