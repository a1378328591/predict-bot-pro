import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  parseAbiItem,
} from "viem";

const CHAIN_ID = 4663;
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const SWAP_SHELL = "0x4262efBd176F02824af27010bEa218429c33c7E8";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG_DECIMALS = 6;
const NVDA_DECIMALS = 18;
const CANDLE_MS = 5 * 60_000;
const TARGET_CANDLES = 36;
const LOOKBACK_BLOCKS = 140_000n;
const LOG_PAGE_BLOCKS = 5_000n;
const STATE_FILE = resolve("data/arcus/usdg-nvda-mainnet-state.json");

const swapExecutedEvent = parseAbiItem(
  "event SwapExecuted(address indexed taker, address indexed tokenIn, address indexed tokenOut, uint256 minAmountOut, uint256 amountIn, uint256 quotedAmountIn, uint256 quotedAmountOut, uint256 amountOut, uint256 tokenInBenchmarkPrice, uint256 tokenOutBenchmarkPrice, address router, bytes32 routeTag, string benchmarkValidationReason, bool success, string reason)",
);

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function readState() {
  if (!existsSync(STATE_FILE)) {
    return {
      candles: [],
      managedPositionAtoms: "0",
      entryCostBaseAtoms: "0",
      lastDecisionCandle: null,
    };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withBackoff(operation, label) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delay = 1_000 * (2 ** attempt);
      console.log(`${label} retry ${attempt + 1}/5 in ${delay / 1_000}s`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function executionPrice(args) {
  const tokenIn = args.tokenIn.toLowerCase();
  const tokenOut = args.tokenOut.toLowerCase();
  const nvda = NVDA.toLowerCase();
  const usdg = USDG.toLowerCase();

  if (tokenIn === nvda && tokenOut === usdg) {
    const assetAmount = Number(formatUnits(args.amountIn, NVDA_DECIMALS));
    const baseAmount = Number(formatUnits(args.amountOut, USDG_DECIMALS));
    return baseAmount / assetAmount;
  }
  if (tokenIn === usdg && tokenOut === nvda) {
    const baseAmount = Number(formatUnits(args.amountIn, USDG_DECIMALS));
    const assetAmount = Number(formatUnits(args.amountOut, NVDA_DECIMALS));
    return baseAmount / assetAmount;
  }
  return null;
}

function buildCandles(trades, currentBucket) {
  const buckets = new Map();
  for (const trade of trades) {
    if (!trade.args.success || trade.time >= currentBucket) continue;
    const price = executionPrice(trade.args);
    if (!Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(trade.time / CANDLE_MS) * CANDLE_MS;
    const candle = buckets.get(bucket);
    if (!candle) {
      buckets.set(bucket, { time: bucket, open: price, high: price, low: price, close: price });
      continue;
    }
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
  }

  const populatedBuckets = [...buckets.keys()].sort((left, right) => left - right);
  if (populatedBuckets.length === 0) throw new Error("No successful NVDA/USDG Arcus swaps found");

  const firstBucket = populatedBuckets[0];
  const candles = [];
  let previousClose = null;
  for (let time = firstBucket; time < currentBucket; time += CANDLE_MS) {
    const observed = buckets.get(time);
    if (observed) {
      candles.push(observed);
      previousClose = observed.close;
    } else if (previousClose !== null) {
      candles.push({
        time,
        open: previousClose,
        high: previousClose,
        low: previousClose,
        close: previousClose,
      });
    }
  }
  if (candles.length < TARGET_CANDLES) {
    throw new Error(`Only ${candles.length}/${TARGET_CANDLES} completed candles could be reconstructed`);
  }
  return candles.slice(-TARGET_CANDLES);
}

async function main() {
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const latestBlock = await withBackoff(() => publicClient.getBlockNumber(), "latest block");
  const firstBlock = latestBlock > LOOKBACK_BLOCKS ? latestBlock - LOOKBACK_BLOCKS : 0n;
  const first = await withBackoff(() => publicClient.getBlock({ blockNumber: firstBlock }), "first block");
  await sleep(300);
  const latest = await withBackoff(() => publicClient.getBlock({ blockNumber: latestBlock }), "latest block timestamp");
  const totalBlockSpan = Number(latestBlock - firstBlock) || 1;
  const totalTimeSpan = Number(latest.timestamp - first.timestamp) * 1_000;
  const trades = [];

  for (let fromBlock = firstBlock; fromBlock <= latestBlock; fromBlock += LOG_PAGE_BLOCKS + 1n) {
    const toBlock = fromBlock + LOG_PAGE_BLOCKS > latestBlock
      ? latestBlock
      : fromBlock + LOG_PAGE_BLOCKS;
    const logs = await withBackoff(
      () => publicClient.getLogs({
        address: SWAP_SHELL,
        event: swapExecutedEvent,
        args: {
          tokenIn: [NVDA, USDG],
          tokenOut: [USDG, NVDA],
        },
        fromBlock,
        toBlock,
      }),
      `logs ${fromBlock}-${toBlock}`,
    );

    for (const log of logs) {
      const tokenIn = log.args.tokenIn.toLowerCase();
      const tokenOut = log.args.tokenOut.toLowerCase();
      const isPair = (tokenIn === NVDA.toLowerCase() && tokenOut === USDG.toLowerCase())
        || (tokenIn === USDG.toLowerCase() && tokenOut === NVDA.toLowerCase());
      if (!isPair) continue;
      const offset = Number(log.blockNumber - firstBlock);
      trades.push({
        args: log.args,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex ?? 0,
        time: Number(first.timestamp) * 1_000 + Math.round((offset / totalBlockSpan) * totalTimeSpan),
      });
    }
    await sleep(300);
  }

  trades.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
    return left.logIndex - right.logIndex;
  });

  const currentBucket = Math.floor(Date.now() / CANDLE_MS) * CANDLE_MS;
  const candles = buildCandles(trades, currentBucket);
  const state = readState();
  const backupFile = `${STATE_FILE}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(STATE_FILE)) copyFileSync(STATE_FILE, backupFile);

  atomicWriteJson(STATE_FILE, {
    ...state,
    candles,
    lastDecisionCandle: null,
  });

  console.log(`Backfilled ${candles.length} completed 5m candles from ${trades.length} Arcus NVDA/USDG swaps.`);
  console.log(`Range: ${new Date(candles[0].time).toISOString()} -> ${new Date(candles.at(-1).time).toISOString()}`);
  console.log(`State: ${STATE_FILE}`);
  if (existsSync(backupFile)) console.log(`Backup: ${backupFile}`);
}

main().catch(error => {
  console.error(`Arcus candle backfill failed: ${error.message}`);
  process.exitCode = 1;
});
