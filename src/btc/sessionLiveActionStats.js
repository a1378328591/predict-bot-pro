const ACTION_TYPES = new Set([
  "LIVE_ORDER_SUBMITTED",
  "LIVE_ORDER_CANCEL_REQUESTED",
  "LIVE_ORDER_CLOSED_OR_FILLED",
  "LIVE_ORDER_SKIPPED_OR_FAILED",
]);

export function liveSignalId(record) {
  if (record?.signal_id) return String(record.signal_id);
  const slug = String(record?.category_slug || "");
  const observedAt = record?.observed_at_ms ?? record?.observed_at;
  return slug && observedAt !== undefined && observedAt !== null && observedAt !== ""
    ? `${slug}|${observedAt}`
    : null;
}

function settlementWinner(settlement) {
  const startPrice = Number(settlement?.variant_data?.startPrice);
  const endPrice = Number(settlement?.variant_data?.endPrice);
  if (Number.isFinite(startPrice) && Number.isFinite(endPrice) && startPrice === endPrice) return "tie";
  const market = settlement?.markets?.[0];
  return String(market?.outcomes?.find(outcome => outcome?.status === "WON")?.name
    ?? market?.resolution?.name
    ?? "").toLowerCase();
}

function performanceSummary(actions) {
  const settled = actions.filter(action => action.result);
  const wins = settled.filter(action => action.result.won).length;
  const losses = settled.filter(action => action.result.won === false).length;
  const ties = settled.filter(action => action.result.tied).length;
  const totalCost = settled.reduce((sum, action) => sum + action.result.cost_usd, 0);
  const totalPnl = settled.reduce((sum, action) => sum + action.result.pnl_usd, 0);
  return {
    actions: actions.length,
    settled: settled.length,
    unsettled: actions.length - settled.length,
    wins,
    losses,
    ties,
    win_rate: settled.length ? wins / settled.length : null,
    total_cost_usd: totalCost,
    total_pnl_usd: totalPnl,
    roi: totalCost ? totalPnl / totalCost : null,
  };
}

function groupedPerformance(actions, field) {
  return Object.fromEntries([...new Set(actions.map(action => action[field] || "unknown"))]
    .map(value => [value, performanceSummary(actions.filter(action => (action[field] || "unknown") === value))]));
}

export function summarizeLiveActions(signals, executionRecords, settlements = []) {
  const signalById = new Map();
  for (const signal of signals) {
    if (signal?.type !== "LIVE_BUY_SIGNAL") continue;
    const id = liveSignalId(signal);
    if (id) signalById.set(id, signal);
  }

  const settlementBySlug = new Map();
  for (const settlement of settlements) {
    const slug = String(settlement?.category_slug || "");
    const winner = settlementWinner(settlement);
    if (slug && winner) settlementBySlug.set(slug, winner);
  }

  const actionById = new Map();
  for (const record of executionRecords) {
    if (!ACTION_TYPES.has(record?.type)) continue;
    const id = liveSignalId(record);
    if (!id) continue;
    const signal = signalById.get(id);
    const previous = actionById.get(id);
    actionById.set(id, {
      signal_id: id,
      category_slug: signal?.category_slug ?? record.category_slug ?? previous?.category_slug ?? null,
      direction: signal?.direction ?? record.direction ?? previous?.direction ?? "unknown",
      us_market_regime: signal?.us_market_regime ?? record.us_market_regime ?? previous?.us_market_regime ?? "unknown",
      action_at: previous?.action_at ?? record.observed_at ?? null,
      quote: signal?.quote ?? previous?.quote ?? null,
    });
  }

  const actions = [...actionById.values()].map(action => {
    const winner = settlementBySlug.get(action.category_slug);
    const shares = Number(action.quote?.shares);
    const cost = Number(action.quote?.total_cost_usd);
    if (!winner || !(shares > 0) || !(cost > 0)) return action;
    const tied = winner === "tie";
    const won = tied ? null : action.direction === winner;
    const payout = tied ? shares * 0.5 : won ? shares : 0;
    return {
      ...action,
      result: {
        winner,
        won,
        tied,
        cost_usd: cost,
        payout_usd: payout,
        pnl_usd: payout - cost,
      },
    };
  });
  const pendingActions = [...signalById.keys()].filter(id => !actionById.has(id)).length;
  const actionTimes = actions.map(action => Date.parse(action.action_at)).filter(Number.isFinite);

  return {
    calculation_basis: "signal_quote_assuming_full_fill",
    live_signals: signalById.size,
    order_actions: actions.length,
    pending_actions: pendingActions,
    total: performanceSummary(actions),
    by_market_regime: groupedPerformance(actions, "us_market_regime"),
    by_direction: groupedPerformance(actions, "direction"),
    latest_action_at: actionTimes.length ? new Date(Math.max(...actionTimes)).toISOString() : null,
  };
}
