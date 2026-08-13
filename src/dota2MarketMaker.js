import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["src/soccerMarketMaker.js"], {
  cwd: process.cwd(),
  env: { ...process.env, MARKET_TYPE: "dota2" },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
