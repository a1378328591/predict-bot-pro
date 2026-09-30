import { spawn } from "node:child_process";

const workers = [
  ["collector", "src/btc/collectBtcSamples.js"],
  ["session-trend-signal", "src/btc/reversalValueSignalEngine.js"],
  ["volatility-monitor", "src/btc/reversalVolatilityMonitor.js"],
];

const children = new Map();
let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Stopping BTC reversal paper suite...");
  const exits = [...children.values()].map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolveExit => child.once("exit", resolveExit));
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
    console.error(`[${name}] exited unexpectedly (code=${code}, signal=${signal || "none"}). Stopping the suite.`);
    shutdown(code || 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("BTC session strategy paper suite started with collector, signal engine, and volatility monitor.");
console.log("This suite is paper-only and never starts the live BTC order executor.");
