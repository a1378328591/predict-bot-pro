import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_UINT256,
  PermitUnsupportedError,
  ROBINHOOD_MAINNET_CHAIN_ID,
  SpotRouterClient,
  buildArcusSellTokenPermitIfNeeded,
  erc20ApproveAbi,
  signQuote,
} from "@arcus-xyz/arcus-spot-sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

function requireNumbers(values) {
  if (!Array.isArray(values) || values.some(value => !Number.isFinite(Number(value)))) {
    throw new TypeError("Indicator input must be an array of finite numbers");
  }
  return values.map(Number);
}

export function ema(values, period) {
  const numbers = requireNumbers(values);
  if (!Number.isInteger(period) || period < 1) throw new RangeError("EMA period must be a positive integer");
  const result = Array(numbers.length).fill(null);
  if (numbers.length < period) return result;

  let current = numbers.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < numbers.length; index += 1) {
    current = (numbers[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

export function macd(values, { fast = 12, slow = 26, signal = 9 } = {}) {
  const numbers = requireNumbers(values);
  const fastValues = ema(numbers, fast);
  const slowValues = ema(numbers, slow);
  const line = numbers.map((_, index) => {
    if (fastValues[index] === null || slowValues[index] === null) return null;
    return fastValues[index] - slowValues[index];
  });
  const firstLineIndex = line.findIndex(value => value !== null);
  const signalValues = Array(numbers.length).fill(null);
  if (firstLineIndex >= 0) {
    const denseSignal = ema(line.slice(firstLineIndex), signal);
    denseSignal.forEach((value, index) => { signalValues[firstLineIndex + index] = value; });
  }
  return numbers.map((_, index) => ({
    macd: line[index],
    signal: signalValues[index],
    histogram: line[index] === null || signalValues[index] === null
      ? null
      : line[index] - signalValues[index],
  }));
}

export function rsi(values, period = 14) {
  const numbers = requireNumbers(values);
  if (!Number.isInteger(period) || period < 1) throw new RangeError("RSI period must be a positive integer");
  const result = Array(numbers.length).fill(null);
  if (numbers.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = numbers[index] - numbers[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiValue(averageGain, averageLoss);
  for (let index = period + 1; index < numbers.length; index += 1) {
    const change = numbers[index] - numbers[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }
  return result;
}

function rsiValue(averageGain, averageLoss) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function kdj(candles, period = 9) {
  if (!Array.isArray(candles)) throw new TypeError("KDJ input must be an array");
  if (!Number.isInteger(period) || period < 1) throw new RangeError("KDJ period must be a positive integer");
  const result = Array(candles.length).fill(null);
  let k = 50;
  let d = 50;
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const highs = window.map(candle => Number(candle.high));
    const lows = window.map(candle => Number(candle.low));
    const close = Number(candles[index].close);
    if (![...highs, ...lows, close].every(Number.isFinite)) {
      throw new TypeError("KDJ candles must contain finite high, low, and close values");
    }
    const highest = Math.max(...highs);
    const lowest = Math.min(...lows);
    const rsv = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
    result[index] = { k, d, j: 3 * k - 2 * d };
  }
  return result;
}

function indicatorSeries(candles, periods = {}) {
  const closes = candles.map(candle => Number(candle.close));
  const macdValues = macd(closes, {
    fast: periods.macdFast,
    slow: periods.macdSlow,
    signal: periods.macdSignal,
  });
  const rsiValues = rsi(closes, periods.rsiPeriod);
  const kdjValues = kdj(candles, periods.kdjPeriod);
  return candles.map((candle, index) => ({
    time: candle.time,
    close: closes[index],
    macd: macdValues[index],
    rsi: rsiValues[index],
    kdj: kdjValues[index],
  }));
}

function crossedUp(previousLeft, previousRight, currentLeft, currentRight) {
  return [previousLeft, previousRight, currentLeft, currentRight].every(Number.isFinite)
    && previousLeft <= previousRight
    && currentLeft > currentRight;
}

function crossedDown(previousLeft, previousRight, currentLeft, currentRight) {
  return [previousLeft, previousRight, currentLeft, currentRight].every(Number.isFinite)
    && previousLeft >= previousRight
    && currentLeft < currentRight;
}

const DEFAULT_STRATEGY_RULES = Object.freeze({
  rsiBuyThreshold: 35,
  rsiSellThreshold: 65,
  kdjBuyThreshold: 35,
  kdjSellThreshold: 65,
  takeProfitPct: 1,
  stopLossPct: -3,
  breakEvenExitPct: 0,
});

export function decideAction(previous, current, hasPosition, options = {}) {
  if (!previous || !current) return { action: "HOLD", reasons: ["指标数据不足"] };
  const rules = { ...DEFAULT_STRATEGY_RULES, ...options.rules };
  const estimatedReturnPct = Number(options.estimatedReturnPct);
  const buyReasons = [];
  if (crossedUp(previous.macd?.macd, previous.macd?.signal, current.macd?.macd, current.macd?.signal)) {
    buyReasons.push("MACD 金叉");
  }
  if (Number.isFinite(current.rsi) && current.rsi <= rules.rsiBuyThreshold) {
    buyReasons.push(`RSI 超卖 (${current.rsi.toFixed(2)})`);
  }
  if (crossedUp(previous.kdj?.k, previous.kdj?.d, current.kdj?.k, current.kdj?.d)
      && Math.max(current.kdj.k, current.kdj.d) <= rules.kdjBuyThreshold) {
    buyReasons.push("KDJ 低位金叉");
  }

  if (hasPosition && Number.isFinite(estimatedReturnPct) && estimatedReturnPct >= rules.takeProfitPct) {
    return { action: "SELL", reasons: [`预计净收益达到止盈线 (${estimatedReturnPct.toFixed(2)}%)`] };
  }
  if (hasPosition && Number.isFinite(estimatedReturnPct) && estimatedReturnPct <= rules.stopLossPct) {
    return { action: "SELL", reasons: [`预计净收益触发止损 (${estimatedReturnPct.toFixed(2)}%)`] };
  }

  const sellReasons = [];
  if (crossedDown(previous.macd?.macd, previous.macd?.signal, current.macd?.macd, current.macd?.signal)) {
    sellReasons.push("MACD 死叉");
  }
  if (Number.isFinite(current.rsi) && current.rsi >= rules.rsiSellThreshold) {
    sellReasons.push(`RSI 超买 (${current.rsi.toFixed(2)})`);
  }
  if (crossedDown(previous.kdj?.k, previous.kdj?.d, current.kdj?.k, current.kdj?.d)
      && Math.min(current.kdj.k, current.kdj.d) >= rules.kdjSellThreshold) {
    sellReasons.push("KDJ 高位死叉");
  }
  if (hasPosition && Number.isFinite(estimatedReturnPct)
      && estimatedReturnPct >= rules.breakEvenExitPct
      && sellReasons.length > 0) {
    return {
      action: "SELL",
      reasons: [...sellReasons, `预计净收益 ${estimatedReturnPct.toFixed(2)}%`],
    };
  }

  if (buyReasons.length > 0 && options.canBuy !== false) {
    return { action: "BUY", reasons: buyReasons, buySignalCount: buyReasons.length };
  }

  if (buyReasons.length > 0 && options.canBuy === false) {
    return {
      action: "HOLD",
      reasons: ["仓位已达上限或剩余额度不足最低买入金额", ...buyReasons],
    };
  }

  return {
    action: "HOLD",
    reasons: [hasPosition
      ? (Number.isFinite(estimatedReturnPct)
        ? `继续持仓，预计净收益 ${estimatedReturnPct.toFixed(2)}%`
        : "继续持仓，尚无成本基准")
      : "未出现买入信号"],
  };
}

export function evaluateStrategy(candles, hasPosition, options = {}) {
  const periods = options.periods ?? {};
  const minimumCandles = Math.max(
    (periods.macdSlow ?? 26) + (periods.macdSignal ?? 9),
    (periods.rsiPeriod ?? 14) + 2,
    (periods.kdjPeriod ?? 9) + 1,
  );
  if (candles.length < minimumCandles) {
    return {
      action: "HOLD",
      reasons: [`等待 K 线数据 (${candles.length}/${minimumCandles})`],
      current: null,
    };
  }
  const series = indicatorSeries(candles, periods);
  const previous = series.at(-2);
  const current = series.at(-1);
  return { ...decideAction(previous, current, hasPosition, options), current };
}

export function calculateBuyNotional(signalCount, remainingPositionBase, {
  minBuyNotionalBase,
  maxBuyNotionalBase,
  maxSignals = 3,
}) {
  const remaining = Number(remainingPositionBase);
  if (!Number.isFinite(remaining) || remaining < minBuyNotionalBase || signalCount < 1) return 0;
  const strength = Math.min(Math.max(Math.trunc(signalCount), 1), maxSignals);
  const ratio = maxSignals === 1 ? 1 : (strength - 1) / (maxSignals - 1);
  const dynamicAmount = minBuyNotionalBase + (maxBuyNotionalBase - minBuyNotionalBase) * ratio;
  return Math.floor(Math.min(dynamicAmount, remaining) * 100) / 100;
}

// Non-secret bot settings intentionally live in code rather than .env.
const SETTINGS = {
  routerUrl: "https://router.spot.arcus.xyz/v1",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  baseSymbol: "USDG",
  assetSymbol: "NVDA",
  baseToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  assetToken: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  minBuyNotionalBase: 11,
  maxBuyNotionalBase: 40,
  maxPositionBase: 40,
  sampleAmountAsset: "1",
  slippageBps: 20,
  maxEntryRoundTripCostPct: 1.25,
  takeProfitPct: 1,
  stopLossPct: -3,
  breakEvenExitPct: 0,
  rsiBuyThreshold: 35,
  rsiSellThreshold: 65,
  kdjBuyThreshold: 35,
  kdjSellThreshold: 65,
  macdFast: 8,
  macdSlow: 17,
  macdSignal: 6,
  rsiPeriod: 9,
  kdjPeriod: 9,
  sampleIntervalMs: 15_000,
  candleIntervalMs: 5 * 60_000,
  timedExitMs: 25 * 60_000,
  maxCandles: 500,
  requestTimeoutMs: 15_000,
  receiptTimeoutMs: 120_000,
};

const STATE_FILE = resolve("data/arcus/usdg-nvda-mainnet-state.json");
const liveTrading = process.argv.includes("--live");
const runOnce = process.argv.includes("--once");
const sellAllNvda = process.argv.includes("--sell-all-nvda");
const chain = defineChain({
  id: ROBINHOOD_MAINNET_CHAIN_ID,
  name: "Robinhood Mainnet",
  nativeCurrency: { name: "Robinhood Gas Token", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [SETTINGS.rpcUrl] } },
});

let stopping = false;

function normalizePrivateKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function fetchWithApiKey(input, init = {}) {
  const headers = new Headers(init.headers);
  if (process.env.ARCUS_API_KEY) headers.set("X-Api-Key", process.env.ARCUS_API_KEY);
  const response = await fetch(input, { ...init, headers });

  // The Arcus SDK clears its timeout as soon as the supplied fetch resolves.
  // Buffer the body here so that its AbortSignal also covers a stalled body.
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      candles: Array.isArray(parsed.candles) ? parsed.candles.slice(-SETTINGS.maxCandles) : [],
      managedPositionAtoms: String(parsed.managedPositionAtoms || "0"),
      entryCostBaseAtoms: String(parsed.entryCostBaseAtoms || "0"),
      positionOpenedAt: Number(parsed.positionOpenedAt) || null,
      lastDecisionCandle: Number(parsed.lastDecisionCandle) || null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      candles: [],
      managedPositionAtoms: "0",
      entryCostBaseAtoms: "0",
      positionOpenedAt: null,
      lastDecisionCandle: null,
    };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, STATE_FILE);
}

export function addPriceSample(candles, price, observedAt = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid Arcus price: ${price}`);
  const bucket = Math.floor(observedAt / SETTINGS.candleIntervalMs) * SETTINGS.candleIntervalMs;
  const current = candles.at(-1);
  if (!current || current.time < bucket) {
    candles.push({ time: bucket, open: price, high: price, low: price, close: price });
    if (candles.length > SETTINGS.maxCandles) candles.splice(0, candles.length - SETTINGS.maxCandles);
    return Boolean(current);
  }
  if (current.time > bucket) return false;
  current.high = Math.max(current.high, price);
  current.low = Math.min(current.low, price);
  current.close = price;
  return false;
}

function arcusEntry(response) {
  const entry = response.all?.find(item => item.venue === "arcus");
  if (!entry) {
    const errors = response.errors?.map(item => `${item.venue}: ${item.error?.message || "unknown"}`).join("; ");
    throw new Error(`Arcus route unavailable${errors ? ` (${errors})` : ""}`);
  }
  return entry;
}

function percentageChange(currentAmount, basisAmount) {
  if (basisAmount <= 0n) return null;
  const scaled = ((currentAmount - basisAmount) * 1_000_000n) / basisAmount;
  return Number(scaled) / 10_000;
}

async function estimateExit(client, tokens, assetAmount, entryCostBaseAtoms) {
  const response = await client.getPrice({
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    sellToken: tokens.asset.address,
    buyToken: tokens.base.address,
    sellAmount: assetAmount.toString(),
  });
  const quote = arcusEntry(response);
  const proceeds = BigInt(quote.buyAmount);
  return {
    proceeds,
    estimatedReturnPct: percentageChange(proceeds, entryCostBaseAtoms),
  };
}

export function reconcilePositionSnapshot(snapshot, walletPosition, externalAddedValue = 0n, observedAt = Date.now()) {
  const trackedPosition = BigInt(snapshot.managedPositionAtoms || "0");
  const trackedEntryCost = BigInt(snapshot.entryCostBaseAtoms || "0");
  const openedAt = Number(snapshot.positionOpenedAt) || null;
  let position = BigInt(walletPosition);
  let entryCost = trackedEntryCost;
  let positionOpenedAt = openedAt;

  if (position === 0n) {
    entryCost = 0n;
    positionOpenedAt = null;
  } else if (position < trackedPosition) {
    entryCost = trackedPosition > 0n
      ? (trackedEntryCost * position) / trackedPosition
      : BigInt(externalAddedValue);
  } else if (position > trackedPosition) {
    entryCost = trackedEntryCost + BigInt(externalAddedValue);
    if (trackedPosition === 0n) positionOpenedAt = observedAt;
  }

  if (position > 0n && !positionOpenedAt) positionOpenedAt = observedAt;
  const next = {
    managedPositionAtoms: position.toString(),
    entryCostBaseAtoms: entryCost.toString(),
    positionOpenedAt,
  };
  return {
    ...next,
    changed: next.managedPositionAtoms !== String(snapshot.managedPositionAtoms || "0")
      || next.entryCostBaseAtoms !== String(snapshot.entryCostBaseAtoms || "0")
      || next.positionOpenedAt !== openedAt,
  };
}

export function timedExitDue(position, positionOpenedAt, observedAt, timedExitMs) {
  return BigInt(position) > 0n
    && Number.isFinite(Number(positionOpenedAt))
    && Number(positionOpenedAt) > 0
    && observedAt - Number(positionOpenedAt) >= timedExitMs;
}

async function syncWalletPosition({ client, tokens, publicClient, walletClient, state, walletPosition }) {
  const actualPosition = walletPosition ?? await publicClient.readContract({
    address: tokens.asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletClient.account.address],
  });
  const trackedPosition = BigInt(state.managedPositionAtoms);
  let externalAddedValue = 0n;
  if (actualPosition > trackedPosition) {
    const addedPosition = actualPosition - trackedPosition;
    externalAddedValue = (await estimateExit(client, tokens, addedPosition, 0n)).proceeds;
  }

  const reconciled = reconcilePositionSnapshot(
    state,
    actualPosition,
    externalAddedValue,
    Date.now(),
  );
  if (reconciled.changed) {
    console.log(`${new Date().toISOString()} position sync tracked=${formatUnits(trackedPosition, tokens.asset.decimals)} wallet=${formatUnits(actualPosition, tokens.asset.decimals)} ${tokens.asset.symbol}`);
    state.managedPositionAtoms = reconciled.managedPositionAtoms;
    state.entryCostBaseAtoms = reconciled.entryCostBaseAtoms;
    state.positionOpenedAt = reconciled.positionOpenedAt;
    saveState(state);
  }
  return actualPosition;
}

async function loadTokens(client) {
  const tokens = await client.getTokenList();
  const findVerified = (symbol, expectedAddress) => {
    const token = tokens.find(item => item.chainId === ROBINHOOD_MAINNET_CHAIN_ID
      && item.symbol.toLowerCase() === symbol.toLowerCase());
    if (!token) throw new Error(`Arcus mainnet token list does not contain ${symbol}`);
    if (token.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`${symbol} address mismatch: expected ${expectedAddress}, router returned ${token.address}`);
    }
    if (!token.verified) throw new Error(`Arcus mainnet token ${symbol} is not verified`);
    return token;
  };
  return {
    base: findVerified(SETTINGS.baseSymbol, SETTINGS.baseToken),
    asset: findVerified(SETTINGS.assetSymbol, SETTINGS.assetToken),
  };
}

async function fetchReferencePrice(client, tokens) {
  const sellAmount = parseUnits(SETTINGS.sampleAmountAsset, tokens.asset.decimals).toString();
  const response = await client.getPrice({
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    sellToken: tokens.asset.address,
    buyToken: tokens.base.address,
    sellAmount,
  });
  const price = arcusEntry(response);
  return Number(formatUnits(BigInt(price.buyAmount), tokens.base.decimals))
    / Number(SETTINGS.sampleAmountAsset);
}

async function approvePermit2(error, publicClient, walletClient) {
  const approve = async amount => {
    const hash = await walletClient.writeContract({
      address: error.token,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [error.spender, amount],
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: SETTINGS.receiptTimeoutMs });
    if (receipt.status !== "success") throw new Error(`Permit2 approval reverted: ${hash}`);
  };
  if (error.currentAllowance > 0n) await approve(0n);
  await approve(MAX_UINT256);
}

async function executeSwap({ side, amount, client, publicClient, walletClient, tokens }) {
  const account = walletClient.account;
  const isBuy = side === "BUY";
  const sellToken = isBuy ? tokens.base : tokens.asset;
  const buyToken = isBuy ? tokens.asset : tokens.base;
  const [walletBalance, buyBalanceBefore] = await Promise.all([
    publicClient.readContract({
      address: sellToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: buyToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);
  if (walletBalance < amount) {
    throw new Error(`Insufficient ${sellToken.symbol}: need ${formatUnits(amount, sellToken.decimals)}, wallet has ${formatUnits(walletBalance, sellToken.decimals)}`);
  }

  const quotes = await client.getQuote({
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    sellToken: sellToken.address,
    buyToken: buyToken.address,
    sellAmount: amount.toString(),
    taker: account.address,
    slippageBps: SETTINGS.slippageBps,
  });
  const quote = arcusEntry(quotes);

  let roundTripCostPct = null;
  if (isBuy) {
    const exitEstimate = await estimateExit(client, tokens, BigInt(quote.buyAmount), BigInt(quote.sellAmount));
    roundTripCostPct = -(exitEstimate.estimatedReturnPct ?? 0);
    if (roundTripCostPct > SETTINGS.maxEntryRoundTripCostPct) {
      throw new Error(`Entry skipped: estimated round-trip cost ${roundTripCostPct.toFixed(2)}% exceeds ${SETTINGS.maxEntryRoundTripCostPct.toFixed(2)}%`);
    }
    console.log(`${new Date().toISOString()} entry cost check=${roundTripCostPct.toFixed(2)}% max=${SETTINGS.maxEntryRoundTripCostPct.toFixed(2)}%`);
  }

  let permit;
  try {
    permit = await buildArcusSellTokenPermitIfNeeded({ quote, publicClient, walletClient });
  } catch (error) {
    if (!(error instanceof PermitUnsupportedError)) throw error;
    console.log(`${new Date().toISOString()} token does not support EIP-2612; sending one-time Permit2 approval`);
    await approvePermit2(error, publicClient, walletClient);
    permit = await buildArcusSellTokenPermitIfNeeded({ quote, publicClient, walletClient });
  }

  const signed = await signQuote(quote, walletClient, { permits: permit ? [permit] : undefined });
  const submitted = await client.submitSignedQuote(signed);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: submitted.txHash,
    timeout: SETTINGS.receiptTimeoutMs,
  });
  if (receipt.status !== "success") throw new Error(`Swap reverted: ${submitted.txHash}`);
  const buyBalanceAfter = await publicClient.readContract({
    address: buyToken.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const actualBuyAmount = buyBalanceAfter >= buyBalanceBefore
    ? buyBalanceAfter - buyBalanceBefore
    : 0n;
  return { quote, submitted, roundTripCostPct, actualBuyAmount };
}

function indicatorText(current) {
  if (!current) return "warming up";
  const value = number => Number.isFinite(number) ? number.toFixed(2) : "n/a";
  return `RSI=${value(current.rsi)} MACD=${value(current.macd?.macd)}/${value(current.macd?.signal)} KDJ=${value(current.kdj?.k)}/${value(current.kdj?.d)}/${value(current.kdj?.j)}`;
}

async function main() {
  await import("dotenv/config");
  console.log(`${new Date().toISOString()} Arcus bot initializing...`);
  if (sellAllNvda && !liveTrading) {
    throw new Error("--sell-all-nvda requires --live because it submits a real mainnet order");
  }
  let walletClient = null;
  let publicClient = null;
  if (liveTrading) {
    const privateKey = normalizePrivateKey(process.env.ARCUS_PRIVATE_KEY);
    if (!privateKey) throw new Error("--live requires ARCUS_PRIVATE_KEY in .env");
    const account = privateKeyToAccount(privateKey);
    publicClient = createPublicClient({ chain, transport: http(SETTINGS.rpcUrl) });
    walletClient = createWalletClient({ account, chain, transport: http(SETTINGS.rpcUrl) });
  }

  const client = new SpotRouterClient({
    baseUrl: SETTINGS.routerUrl,
    timeoutMs: SETTINGS.requestTimeoutMs,
    fetch: fetchWithApiKey,
  });
  const health = await client.health();
  if (!health.ok || health.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`Unexpected Arcus router health: ${JSON.stringify(health)}`);
  }
  if (Array.isArray(health.venues) && !health.venues.includes("arcus")) {
    throw new Error(`Arcus venue is unavailable: ${JSON.stringify(health.venues)}`);
  }
  const tokens = await loadTokens(client);
  const state = loadState();
  const mode = sellAllNvda ? "SELL_ALL_NVDA" : liveTrading ? "LIVE" : "OBSERVE";
  console.log(`Arcus MAINNET bot started: mode=${mode} chain=${ROBINHOOD_MAINNET_CHAIN_ID} pair=${tokens.asset.symbol}/${tokens.base.symbol} interval=${SETTINGS.candleIntervalMs / 60_000}m buy=${SETTINGS.minBuyNotionalBase}-${SETTINGS.maxBuyNotionalBase} ${tokens.base.symbol} maxPosition=${SETTINGS.maxPositionBase} ${tokens.base.symbol} slippage=${SETTINGS.slippageBps / 100}%`);
  if (liveTrading) {
    const rpcChainId = await publicClient.getChainId();
    if (rpcChainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
      throw new Error(`RPC chain mismatch: expected ${ROBINHOOD_MAINNET_CHAIN_ID}, received ${rpcChainId}`);
    }
    const [gasBalance, baseBalance, assetBalance] = await Promise.all([
      publicClient.getBalance({ address: walletClient.account.address }),
      publicClient.readContract({
        address: tokens.base.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletClient.account.address],
      }),
      publicClient.readContract({
        address: tokens.asset.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletClient.account.address],
      }),
    ]);
    console.log(`wallet=${walletClient.account.address} ETH=${formatUnits(gasBalance, 18)} ${tokens.base.symbol}=${formatUnits(baseBalance, tokens.base.decimals)} ${tokens.asset.symbol}=${formatUnits(assetBalance, tokens.asset.decimals)}`);

    if (sellAllNvda) {
      if (assetBalance === 0n) {
        throw new Error(`Wallet ${walletClient.account.address} has no ${tokens.asset.symbol} to sell`);
      }
      console.log(`${new Date().toISOString()} submitting one-time SELL of ${formatUnits(assetBalance, tokens.asset.decimals)} ${tokens.asset.symbol}`);
      const result = await executeSwap({
        side: "SELL",
        amount: assetBalance,
        client,
        publicClient,
        walletClient,
        tokens,
      });
      state.managedPositionAtoms = "0";
      state.entryCostBaseAtoms = "0";
      state.positionOpenedAt = null;
      saveState(state);
      console.log(`${new Date().toISOString()} SELL confirmed tx=${result.submitted.txHash} sold=${formatUnits(BigInt(result.quote.sellAmount), tokens.asset.decimals)} ${tokens.asset.symbol} quoted=${formatUnits(BigInt(result.quote.buyAmount), tokens.base.decimals)} ${tokens.base.symbol} received=${formatUnits(result.actualBuyAmount, tokens.base.decimals)} ${tokens.base.symbol}`);
      return;
    }

    await syncWalletPosition({
      client,
      tokens,
      publicClient,
      walletClient,
      state,
      walletPosition: assetBalance,
    });
  }

  while (!stopping) {
    const startedAt = Date.now();
    try {
      const price = await fetchReferencePrice(client, tokens);
      const finalized = addPriceSample(state.candles, price, startedAt);
      saveState(state);
      console.log(`${new Date().toISOString()} price=${price.toFixed(6)} ${tokens.base.symbol} candles=${state.candles.length}`);

      if (liveTrading) {
        await syncWalletPosition({ client, tokens, publicClient, walletClient, state });
        const position = BigInt(state.managedPositionAtoms);
        if (timedExitDue(position, state.positionOpenedAt, Date.now(), SETTINGS.timedExitMs)) {
          const heldMinutes = (Date.now() - state.positionOpenedAt) / 60_000;
          console.log(`${new Date().toISOString()} TIMED SELL due after ${heldMinutes.toFixed(1)}m; selling ${formatUnits(position, tokens.asset.decimals)} ${tokens.asset.symbol}`);
          const result = await executeSwap({
            side: "SELL",
            amount: position,
            client,
            publicClient,
            walletClient,
            tokens,
          });
          state.managedPositionAtoms = "0";
          state.entryCostBaseAtoms = "0";
          state.positionOpenedAt = null;
          saveState(state);
          console.log(`${new Date().toISOString()} TIMED SELL confirmed tx=${result.submitted.txHash} received=${formatUnits(result.actualBuyAmount, tokens.base.decimals)} ${tokens.base.symbol}`);
        }
      }

      const closedCandles = state.candles.slice(0, -1);
      const closedAt = closedCandles.at(-1)?.time;
      if (finalized && closedAt && state.lastDecisionCandle !== closedAt) {
        const position = BigInt(state.managedPositionAtoms);
        const entryCost = BigInt(state.entryCostBaseAtoms);
        const exitEstimate = position > 0n && entryCost > 0n
          ? await estimateExit(client, tokens, position, entryCost)
          : null;
        const maximumPosition = parseUnits(String(SETTINGS.maxPositionBase), tokens.base.decimals);
        const currentExitValue = exitEstimate?.proceeds ?? 0n;
        const currentExposure = entryCost > currentExitValue ? entryCost : currentExitValue;
        const remainingPosition = maximumPosition > currentExposure
          ? maximumPosition - currentExposure
          : 0n;
        const minimumBuy = parseUnits(String(SETTINGS.minBuyNotionalBase), tokens.base.decimals);
        const canBuy = remainingPosition >= minimumBuy && (position === 0n || entryCost > 0n);
        const decision = evaluateStrategy(closedCandles, position > 0n, {
          estimatedReturnPct: exitEstimate?.estimatedReturnPct,
          canBuy,
          periods: {
            macdFast: SETTINGS.macdFast,
            macdSlow: SETTINGS.macdSlow,
            macdSignal: SETTINGS.macdSignal,
            rsiPeriod: SETTINGS.rsiPeriod,
            kdjPeriod: SETTINGS.kdjPeriod,
          },
          rules: {
            takeProfitPct: SETTINGS.takeProfitPct,
            stopLossPct: SETTINGS.stopLossPct,
            breakEvenExitPct: SETTINGS.breakEvenExitPct,
            rsiBuyThreshold: SETTINGS.rsiBuyThreshold,
            rsiSellThreshold: SETTINGS.rsiSellThreshold,
            kdjBuyThreshold: SETTINGS.kdjBuyThreshold,
            kdjSellThreshold: SETTINGS.kdjSellThreshold,
          },
        });
        state.lastDecisionCandle = closedAt;
        console.log(`${new Date(closedAt).toISOString()} signal=${decision.action} ${decision.reasons.join(", ")} ${indicatorText(decision.current)}`);

        if (liveTrading && decision.action !== "HOLD") {
          const buyNotional = decision.action === "BUY"
            ? calculateBuyNotional(
              decision.buySignalCount,
              Number(formatUnits(remainingPosition, tokens.base.decimals)),
              SETTINGS,
            )
            : 0;
          const amount = decision.action === "BUY"
            ? parseUnits(buyNotional.toFixed(tokens.base.decimals), tokens.base.decimals)
            : position;
          if (amount === 0n) {
            console.log(`${new Date().toISOString()} BUY skipped: remaining position capacity is below ${SETTINGS.minBuyNotionalBase} ${tokens.base.symbol}`);
            saveState(state);
            continue;
          }
          if (decision.action === "BUY") {
            console.log(`${new Date().toISOString()} dynamic buy=${buyNotional.toFixed(2)} ${tokens.base.symbol} signals=${decision.buySignalCount}`);
          }
          const result = await executeSwap({
            side: decision.action,
            amount,
            client,
            publicClient,
            walletClient,
            tokens,
          });
          if (decision.action === "BUY") {
            if (position === 0n && result.actualBuyAmount > 0n) {
              state.positionOpenedAt = Date.now();
            }
            state.managedPositionAtoms = (position + result.actualBuyAmount).toString();
            state.entryCostBaseAtoms = (entryCost + BigInt(result.quote.sellAmount)).toString();
          } else {
            state.managedPositionAtoms = (position - BigInt(result.quote.sellAmount)).toString();
            if (BigInt(state.managedPositionAtoms) === 0n) {
              state.entryCostBaseAtoms = "0";
              state.positionOpenedAt = null;
            }
          }
          console.log(`${new Date().toISOString()} ${decision.action} confirmed tx=${result.submitted.txHash} managedPosition=${formatUnits(BigInt(state.managedPositionAtoms), tokens.asset.decimals)} ${tokens.asset.symbol}`);
        }
        saveState(state);
      }
    } catch (error) {
      console.error(`${new Date().toISOString()} cycle failed: ${error.message}`);
    }

    if (runOnce) break;
    const remaining = SETTINGS.sampleIntervalMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolveSleep => setTimeout(resolveSleep, remaining));
  }
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  main().catch(error => {
    console.error(`Arcus bot failed: ${error.message}`);
    process.exitCode = 1;
  });
}
