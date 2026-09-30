import { spawn } from "node:child_process";

const workers = [
  ["collector", "src/btc/collectBtcSamples.js"],
  ["signal", "src/btc/zScoreSignalEngine.js"],
  ["executor", "src/btc/zScoreOrderExecutor.js"],
  ["dashboard", "src/btc/btc5mDashboardServer.js"],
];

const children = new Map();
let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Stopping BTC 5m trader...");
  const exits = [...children.values()].map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => child.once("exit", resolve));
  });
  for (const [name, child] of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "ESRCH") {
        console.error(`[${name}] failed to stop:`, error.message);
      }
    }
  }
  const deadline = setTimeout(() => process.exit(exitCode), 5_000);
  deadline.unref();
  Promise.all(exits).finally(() => process.exit(exitCode));
}

for (const [name, script] of workers) {
  const child = spawn(process.execPath, [script], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.set(name, child);
  child.on("error", error => {
    if (shuttingDown && (error?.code === "EPERM" || error?.code === "ESRCH")) return;
    console.error(`[${name}] process error:`, error.message);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited unexpectedly (code=${code}, signal=${signal || "none"}). Stopping BTC 5m trader.`);
    shutdown(code || 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`BTC 5m trader started with ${workers.length} workers. Live trading is controlled by Z_LIVE_TRADING.`);
