import test from "node:test";
import assert from "node:assert/strict";
import {
  positionIncreases,
  positionSnapshot,
  positionsByAddressPath,
  summarizeCopyActions,
} from "../src/copyTrading/copyTradeRules.js";

const WEI = 10n ** 18n;

test("builds the versioned positions-by-address API path", () => {
  const query = new URLSearchParams({ first: "100", isResolved: "false" });
  assert.equal(
    positionsByAddressPath("0xABC", query),
    "/v1/positions/0xABC?first=100&isResolved=false",
  );
});

test("returns position increases and ignores decreases", () => {
  const market = { id: 7, question: "Test" };
  const yes = { onChainId: "yes", name: "Yes" };
  const no = { onChainId: "no", name: "No" };
  const previous = positionSnapshot([
    { market, outcome: yes, amount: String(10n * WEI), averageBuyPriceUsd: "0.4" },
    { market, outcome: no, amount: String(8n * WEI), averageBuyPriceUsd: "0.6" },
  ]);
  const current = positionSnapshot([
    { market, outcome: yes, amount: String(25n * WEI), averageBuyPriceUsd: "0.45" },
    { market, outcome: no, amount: String(3n * WEI), averageBuyPriceUsd: "0.6" },
  ]);

  const increases = positionIncreases(previous, current);
  assert.equal(increases.length, 1);
  assert.equal(increases[0].key, "7|yes");
  assert.equal(increases[0].deltaWei, 15n * WEI);
});

test("tracks a position by market and outcome when the API position id changes", () => {
  const market = { id: 7, question: "Test" };
  const outcome = { onChainId: "yes", name: "Yes" };
  const previous = positionSnapshot([
    { id: "old-position-id", market, outcome, amount: String(10n * WEI) },
  ]);
  const current = positionSnapshot([
    { id: "new-position-id", market, outcome, amount: String(16n * WEI) },
  ]);

  const increases = positionIncreases(previous, current);
  assert.equal(increases.length, 1);
  assert.equal(increases[0].key, "7|yes");
  assert.equal(increases[0].deltaWei, 6n * WEI);
});

test("calculates settled buy-only PnL from logged leader prices", () => {
  const actions = [
    { action_id: "1", side: "BUY", copy_shares: 10, leader_price: 0.4, market_id: 9, outcome_id: "yes", leader_executed_at: "2026-09-24T00:00:00Z" },
  ];
  const result = summarizeCopyActions(actions, new Map([["9|yes", "WON"]]));
  assert.equal(result.actions, 1);
  assert.equal(result.total_buy_cost_usd, 4);
  assert.equal(result.total_pnl_usd, 6);
  assert.equal(result.roi, 1.5);
  assert.equal(result.wins, 1);
  assert.equal(result.open_positions, 0);
});

test("does not treat unresolved inventory as realized profit", () => {
  const result = summarizeCopyActions([
    { action_id: "1", side: "BUY", copy_shares: 10, leader_price: 0.4, market_id: 9, outcome_id: "yes" },
  ]);
  assert.equal(result.total_pnl_usd, 0);
  assert.equal(result.roi, null);
  assert.equal(result.open_cost_usd, 4);
  assert.equal(result.open_positions, 1);
});
