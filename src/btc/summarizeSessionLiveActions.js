import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
import { summarizeLiveActions } from "./sessionLiveActionStats.js";

const DATA_DIR = resolve("data/btc");
const SIGNALS_FILE = resolve(DATA_DIR, "session_trend_live_signals.jsonl");
const EXECUTIONS_FILE = resolve(DATA_DIR, "session_trend_execution_log.jsonl");
const SETTLEMENTS_FILE = resolve(DATA_DIR, "settlements.jsonl");

async function readJsonl(file) {
  if (!existsSync(file)) return [];
  const records = [];
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

async function main() {
  const [signals, executions, settlements] = await Promise.all([
    readJsonl(SIGNALS_FILE),
    readJsonl(EXECUTIONS_FILE),
    readJsonl(SETTLEMENTS_FILE),
  ]);
  console.log(JSON.stringify(summarizeLiveActions(signals, executions, settlements), null, 2));
}

main().catch(error => {
  console.error("Live action statistics failed:", error.message);
  process.exitCode = 1;
});
