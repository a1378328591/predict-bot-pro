const FIXED_18 = 10n ** 18n;

export function positionsByAddressPath(address, query) {
  const suffix = String(query || "");
  return `/v1/positions/${encodeURIComponent(address)}${suffix ? `?${suffix}` : ""}`;
}

export function fixed18ToWei(value) {
  if (typeof value === "bigint") return value;
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return BigInt(text);
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const fraction = (match[2] || "").slice(0, 18).padEnd(18, "0");
  return BigInt(match[1]) * FIXED_18 + BigInt(fraction || "0");
}

export function weiToDecimalString(value, precision = 8) {
  const wei = fixed18ToWei(value);
  const whole = wei / FIXED_18;
  const fraction = String(wei % FIXED_18).padStart(18, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function positionSnapshot(positions) {
  const snapshot = {};
  for (const position of positions || []) {
    const marketId = position?.market?.id ?? position?.marketId;
    const outcomeId = position?.outcome?.onChainId ?? position?.outcomeId;
    if (marketId === undefined || marketId === null || outcomeId === undefined || outcomeId === null) continue;
    const amountWei = fixed18ToWei(position?.amount ?? position?.balance ?? position?.quantity);
    if (amountWei <= 0n) continue;
    const key = `${marketId}|${outcomeId}`;
    snapshot[key] = {
      key,
      amount_wei: amountWei.toString(),
      average_buy_price_usd: Number(position?.averageBuyPriceUsd),
      value_usd: Number(position?.valueUsd),
      pnl_usd: Number(position?.pnlUsd),
      market: position?.market || { id: marketId },
      outcome: position?.outcome || { onChainId: outcomeId },
    };
  }
  return snapshot;
}

export function positionIncreases(previous = {}, current = {}) {
  const increases = [];
  for (const key of Object.keys(current)) {
    const before = previous[key] || null;
    const after = current[key];
    const beforeWei = fixed18ToWei(before?.amount_wei);
    const afterWei = fixed18ToWei(after?.amount_wei);
    if (afterWei <= beforeWei) continue;
    increases.push({
      key,
      deltaWei: afterWei - beforeWei,
      beforeWei,
      afterWei,
      before,
      after,
      position: after,
    });
  }
  return increases;
}

function positionKey(action) {
  return `${action.market_id}|${action.outcome_id}`;
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : value;
}

export function summarizeCopyActions(actions, outcomeStatuses = new Map()) {
  const positions = new Map();
  let totalBuyCost = 0;
  let realizedCostBasis = 0;
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;

  const sorted = actions.filter(action => action.side === "BUY").sort((a, b) => {
    const time = new Date(a.leader_executed_at || a.observed_at || 0) - new Date(b.leader_executed_at || b.observed_at || 0);
    return time || String(a.action_id).localeCompare(String(b.action_id));
  });

  for (const action of sorted) {
    const shares = Number(action.copy_shares);
    const price = Number(action.leader_price);
    if (!(shares > 0) || !(price >= 0 && price <= 1)) continue;
    const key = positionKey(action);
    const position = positions.get(key) || { shares: 0, cost: 0, marketId: action.market_id, outcomeId: action.outcome_id };
    position.shares += shares;
    position.cost += shares * price;
    totalBuyCost += shares * price;
    positions.set(key, position);
  }

  let settledPositions = 0;
  let openPositions = 0;
  let openCost = 0;
  for (const [key, position] of positions) {
    if (position.shares <= 1e-9) continue;
    const status = String(outcomeStatuses.get(key) || "").toUpperCase();
    if (status !== "WON" && status !== "LOST") {
      openPositions += 1;
      openCost += position.cost;
      continue;
    }
    const settlementPnl = (status === "WON" ? position.shares : 0) - position.cost;
    pnl += settlementPnl;
    realizedCostBasis += position.cost;
    settledPositions += 1;
    if (settlementPnl > 1e-9) wins += 1;
    else if (settlementPnl < -1e-9) losses += 1;
    else ties += 1;
  }

  return {
    actions: sorted.length,
    buys: sorted.length,
    settled_positions: settledPositions,
    open_positions: openPositions,
    wins,
    losses,
    ties,
    win_rate: wins + losses + ties > 0 ? rounded(wins / (wins + losses + ties)) : null,
    total_buy_cost_usd: rounded(totalBuyCost),
    realized_cost_basis_usd: rounded(realizedCostBasis),
    open_cost_usd: rounded(openCost),
    total_pnl_usd: rounded(pnl),
    roi: realizedCostBasis > 0 ? rounded(pnl / realizedCostBasis) : null,
  };
}
