const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
let state = null;
let activeBook = "Up";

const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--";
const percent = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : "--";
const price = value => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}` : "--";
const cents = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}c` : "--";
const time = value => value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "--";
const money = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : "-"}$${Math.abs(Number(value)).toFixed(2)}` : "--";
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function remainingSeconds() {
  const endsAt = state?.snapshot?.timing?.ends_at;
  return endsAt ? Math.max(0, (new Date(endsAt).getTime() - Date.now()) / 1000) : null;
}

function setCheck(id, pass, value) {
  const row = elements[id];
  row.classList.toggle("pass", Boolean(pass));
  row.classList.toggle("fail", pass === false);
  row.querySelector("strong").textContent = value;
  return pass ? 1 : 0;
}

function renderBook() {
  const outcome = state?.snapshot?.outcomes?.find(item => item.name === activeBook);
  document.querySelectorAll(".book-tabs button").forEach(button => button.classList.toggle("active", button.dataset.side === activeBook));
  elements["book-spread"].textContent = outcome ? `价差 ${cents(outcome.spread)}` : "--";
  if (!outcome) {
    elements.orderbook.innerHTML = '<div class="empty">等待订单簿</div>';
    return;
  }
  const length = Math.max(outcome.bids.length, outcome.asks.length, 5);
  elements.orderbook.innerHTML = Array.from({ length }, (_, index) => {
    const bid = outcome.bids[index];
    const ask = outcome.asks[index];
    const middle = index === 0 ? `${number(outcome.mid * 100, 1)}c` : "";
    return `<div class="book-row"><span class="bid">${bid ? number(bid.size, 2) : ""}</span><span class="price">${middle}</span><span class="ask">${ask ? number(ask.size, 2) : ""}</span></div>`;
  }).join("");
}

function renderActivity() {
  const events = state?.executions || [];
  elements.activity.innerHTML = events.length ? events.map(event => {
    const detail = [event.direction?.toUpperCase(), event.notional ? `$${event.notional}` : null, event.shares ? `${number(event.shares, 3)} shares` : null, event.message].filter(Boolean).join(" · ");
    return `<div class="event"><time>${escapeHtml(time(event.observedAt))}</time><strong>${escapeHtml(event.type)}</strong><span>${escapeHtml(detail || event.orderId || "--")}</span></div>`;
  }).join("") : '<div class="empty">尚无本次策略执行记录</div>';
}

function setPnl(id, value) {
  const element = elements[id];
  element.textContent = money(value);
  element.classList.toggle("pnl-positive", Number(value) > 0);
  element.classList.toggle("pnl-negative", Number(value) < 0);
}

function renderSessionPnl() {
  const pnl = state?.sessionPnl;
  if (!pnl) return;
  setPnl("total-pnl", pnl.totalPnl);
  setPnl("realized-pnl", pnl.realizedPnl);
  setPnl("unrealized-pnl", pnl.unrealizedPnl);
  elements.deployed.textContent = `$${number(pnl.deployed, 2)}`;
  elements["trade-record"].textContent = `${pnl.trades} · ${pnl.wins}/${pnl.losses}`;
  elements["pnl-since"].textContent = `自 ${time(pnl.startedAt)} · ${pnl.valuedTrades}/${pnl.trades} 笔已估值`;
  elements["session-trades"].innerHTML = pnl.details.length ? pnl.details.map(trade => {
    const status = ({ open: "持仓估值", settled: `已结算 ${trade.winner?.toUpperCase() || ""}`, model_exit: "模型退出" })[trade.status] || trade.status;
    const pnlClass = Number(trade.pnl) > 0 ? "pnl-positive" : Number(trade.pnl) < 0 ? "pnl-negative" : "";
    return `<div class="session-row"><span>${escapeHtml(time(trade.openedAt))}</span><span class="slug" title="${escapeHtml(trade.slug)}">${escapeHtml(trade.slug)}</span><span class="direction">${escapeHtml(trade.direction.toUpperCase())}</span><span class="status">${escapeHtml(status)}</span><span>$${number(trade.cost, 2)}</span><span>${Number.isFinite(Number(trade.value)) ? `$${number(trade.value, 2)}` : "--"}</span><strong class="${pnlClass}">${money(trade.pnl)}</strong></div>`;
  }).join("") : '<div class="empty">本次启动后尚无订单</div>';
}

function decisionText(model, decision, remaining) {
  if (!model) return ["准备模型", "--", `开盘后先积累至少 ${state.config.minHistorySeconds} 秒波动率样本，随后全程实时评估。`, "neutral"];
  if (state.trackedPosition && !state.trackedPosition.exit_complete) {
    return ["持仓监控", String(state.trackedPosition.direction || "").toUpperCase(), "模型持续重算；优势反转或持有价值低于卖出价值时退出。", "buy"];
  }
  const decisionIsCurrent = decision && Math.abs(new Date(model.observedAt).getTime() - new Date(decision.observedAt).getTime()) <= 10_000;
  if (decision?.type === "PAPER_BUY" && decisionIsCurrent) {
    return ["满足入场", decision.direction?.toUpperCase(), `保守概率 ${percent(decision.probability?.lower_bound)}，要求 ${percent(decision.requiredProbability)}。`, "buy"];
  }
  if (decision?.type === "PAPER_SKIP" && decisionIsCurrent) {
    return ["跳过交易", decision.direction?.toUpperCase(), `保守概率 ${percent(decision.probability?.lower_bound)}，低于要求 ${percent(decision.requiredProbability)}。`, "skip"];
  }
  if (model.zScore < state.config.entryZ) return ["观察中", model.direction?.toUpperCase(), `Z=${number(model.zScore, 2)}，尚未达到 ${state.config.entryZ.toFixed(2)}。`, "neutral"];
  if (!Number.isFinite(Number(model.costPerShare))) return ["盘口不可执行", model.direction?.toUpperCase(), "当前价差或深度未通过入场检查，模型仍持续更新。", "skip"];
  return ["等待优势", model.direction?.toUpperCase(), `当前净优势 ${percent(model.edge)}。`, "neutral"];
}

function render(nextState) {
  state = nextState;
  const snapshot = state.snapshot;
  const model = state.model;
  const remaining = remainingSeconds();
  const upBook = snapshot?.outcomes?.find(item => item.name === "Up");
  const marketUp = upBook?.mid;

  elements.mode.textContent = state.config.liveTrading ? "实盘" : "纸面";
  elements.mode.style.color = state.config.liveTrading ? "var(--red)" : "var(--amber)";
  elements["market-id"].textContent = snapshot?.categorySlug || "等待市场";
  elements["market-title"].textContent = snapshot?.title || "BTC Up or Down";
  elements["start-price"].textContent = price(snapshot?.startPrice);
  elements["reference-price"].textContent = price(snapshot?.reference?.mid);
  elements.microprice.textContent = price(model?.microprice);
  elements["z-score"].textContent = number(model?.zScore, 2);
  elements.deviation.textContent = Number.isFinite(Number(model?.deviationBps)) ? `${number(model.deviationBps, 2)} bps` : "--";
  elements.sigma.textContent = number(model?.sigma, 3);
  const change = snapshot?.returnFromStart;
  elements["price-change"].textContent = Number.isFinite(Number(change)) ? `${change >= 0 ? "+" : ""}${percent(change)}` : "--";
  elements["price-change"].className = change >= 0 ? "positive" : "negative";

  const upProbability = model?.upProbability;
  elements["up-prob"].textContent = percent(upProbability);
  elements["down-prob"].textContent = percent(Number.isFinite(Number(upProbability)) ? 1 - upProbability : null);
  elements["up-conservative"].textContent = percent(model?.conservativeUpProbability);
  elements["down-conservative"].textContent = percent(model?.conservativeDownProbability);
  elements["market-up"].textContent = cents(marketUp);
  elements["model-window"].textContent = "全程实时";
  elements["up-fill"].style.width = `${Math.max(0, Math.min(100, Number(upProbability || .5) * 100))}%`;
  elements["market-marker"].style.left = `${Math.max(0, Math.min(100, Number(marketUp || .5) * 100))}%`;
  elements["model-age"].textContent = model ? `更新 ${time(model.observedAt)}` : "等待模型";

  const [label, direction, detail, decisionClass] = decisionText(model, state.decision, remaining);
  elements.decision.className = `decision ${decisionClass}`;
  elements["decision-state"].textContent = label;
  elements["decision-direction"].textContent = direction;
  elements["decision-detail"].textContent = detail;

  const inWindow = remaining !== null && remaining > 0;
  const zPass = model ? model.zScore >= state.config.entryZ : null;
  const spreadPass = model && Number.isFinite(Number(model.spread)) ? model.spread <= state.config.maxSpread : null;
  const probabilityPass = model ? model.conservativeProbability >= state.config.minEntryProbability : null;
  const required = Number(model?.costPerShare) + state.config.edgeMargin;
  const edgePass = model && Number.isFinite(required) ? model.conservativeProbability > required : null;
  let passed = 0;
  passed += setCheck("check-window", inWindow, remaining === null ? "--" : `${Math.ceil(remaining)}s`);
  passed += setCheck("check-z", zPass, model ? `${number(model.zScore, 2)} / ${state.config.entryZ.toFixed(2)}` : "--");
  passed += setCheck("check-spread", spreadPass, model?.spread !== null ? `${cents(model?.spread)} / ${cents(state.config.maxSpread)}` : "--");
  passed += setCheck("check-probability", probabilityPass, model ? `${percent(model.conservativeProbability)} / ${percent(state.config.minEntryProbability)}` : "--");
  passed += setCheck("check-edge", edgePass, Number.isFinite(required) ? `${percent(model.conservativeProbability)} / ${percent(required)}` : "--");
  elements["checks-summary"].textContent = `${passed} / 5`;
  elements.notional.textContent = `$${number(state.config.notionalUsd, 0)}`;
  elements["edge-margin"].textContent = percent(state.config.edgeMargin);
  elements["exit-margin"].textContent = percent(state.config.exitMargin);
  elements["position-status"].textContent = state.trackedPosition ? `${String(state.trackedPosition.direction || "").toUpperCase()} · ${state.trackedPosition.exit_complete ? "已退出" : "监控中"}` : "无策略持仓";
  elements["last-update"].textContent = `数据更新 ${time(state.generatedAt)}（北京时间）`;
  renderBook();
  renderActivity();
  renderSessionPnl();
}

function tick() {
  elements.clock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  const remaining = remainingSeconds();
  elements.countdown.textContent = remaining === null ? "--:--" : `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(Math.floor(remaining % 60)).padStart(2, "0")}`;
}

document.querySelectorAll(".book-tabs button").forEach(button => button.addEventListener("click", () => {
  activeBook = button.dataset.side;
  renderBook();
}));

fetch("/api/state")
  .then(response => response.json())
  .then(render)
  .catch(() => {});

const events = new EventSource("/events");
events.onopen = () => {
  elements.connection.className = "status live";
  elements.connection.innerHTML = "<i></i>实时连接";
};
events.onmessage = event => render(JSON.parse(event.data));
events.onerror = () => {
  elements.connection.className = "status offline";
  elements.connection.innerHTML = "<i></i>连接中断";
};

setInterval(tick, 250);
tick();
