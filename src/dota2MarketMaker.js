import { spawn } from "node:child_process";

const MARKET_TYPE = "dota2";

const child = spawn(process.execPath, ["src/soccerMarketMaker.js", "--market-type=" + MARKET_TYPE], {
  cwd: process.cwd(),
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
