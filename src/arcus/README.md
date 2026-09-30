# Arcus 简单指标交易脚本


运行：npm run trade:arcus:live
回填：node src/arcus/backfillCandles.js

该脚本使用 Arcus 官方 `@arcus-xyz/arcus-spot-sdk`，连接 Robinhood 主网（链 ID `4663`），交易对为 `NVDA/USDG`。

指标计算、策略判断、行情采样和交易执行均已合并在 `tradeBot.js`，运行时只需要执行这一个脚本。

策略保持简单，以较积极地生成 Arcus 成交量，同时避免普通反转信号在净亏损时卖出：

- 每 15 秒从 Arcus `/price` 取一次 NVDA 报价，聚合成 5 分钟 K 线。快速指标使用 MACD 8/17/6、RSI 9 和 KDJ 9，约 23 根已结束 K 线后开始判断。
- MACD 金叉、RSI <= 35、KDJ 低位金叉中任一项成立即可买入；持仓未满时允许继续加仓。
- 动态买入金额按同时成立的信号数映射：1 个信号买 11 USDG，2 个信号买 25.5 USDG，3 个信号买 40 USDG，并受剩余仓位额度限制。
- 最大仓位默认 40 USDG。脚本同时检查累计买入成本和当前可执行卖出价值；任一达到上限就不再买入，剩余额度不足 11 USDG 也不会下单。
- 签名前会用本次买到的 NVDA 立即反向询价；预计往返损耗超过 1.25% 时跳过交易。
- 持仓收益按 Arcus 当前可执行卖出报价相对累计买入成本计算。预计净收益达到 1% 直接止盈；任一反转信号出现且净收益不低于 0% 时清仓；-3% 为紧急止损。
- 实盘每 15 秒读取一次钱包的实际 NVDA 余额并同步仓位。页面手动全卖会清零脚本状态，部分卖出会同比缩减成本；手动新增的 NVDA 会按首次检测时的当前可卖价值建立成本基准。
- 独立定时卖出流程从首次持仓开始计时，默认持有满 25 分钟就直接卖出钱包内全部 NVDA，不等待止盈、止损或反转信号；加仓不会重置这次计时。
- Quote Slippage 设置为 0.20%。它是成交保护上限，不是固定收取的费用；Network Fee 和 protocol/platform fee 以 Arcus 每次返回的净报价为准，策略不会再额外重复扣减。实盘成交后以钱包余额变化记录真实到账数量，避免滑点造成仓位记录偏差。

以上金额、仓位上限、成本门槛、止盈止损、指标周期、阈值、采样频率和滑点都集中在 `tradeBot.js` 的 `SETTINGS` 中，可直接调整，不需要放入 `.env`。

## 配置

从 `.env.example` 复制以下敏感字段到 `.env`：

```dotenv
ARCUS_PRIVATE_KEY=0xYOUR_ROBINHOOD_MAINNET_PRIVATE_KEY
ARCUS_API_KEY=
```

观察模式不需要私钥。公共路由不要求 API Key 时，`ARCUS_API_KEY` 可以留空。普通参数都在 `tradeBot.js` 顶部的 `SETTINGS` 中，没有放进 `.env`。

## 运行

默认观察模式，只采集行情和打印信号，不签名、不下单：

```bash
npm run trade:arcus
```

只执行一次行情采样，适合检查连通性：

```bash
node src/arcus/tradeBot.js --once
```

首次启动前，可用 Robinhood Chain 上 Arcus 的真实 NVDA/USDG 成交回填 36 根已结束的 5 分钟 K 线：

```bash
node src/arcus/backfillCandles.js
```

回填脚本不读取私钥或 `.env`，不会签名或交易。它会先备份原状态文件，再写入由链上成交重建的 OHLC，并保留现有仓位字段。回填后启动实盘脚本会立即进行一次指标判断；没有满足信号时仍会正常 `HOLD`。

主网真实下单：

```bash
npm run trade:arcus:live
```

启动日志必须显示 `mode=LIVE`；若显示 `mode=OBSERVE`，说明仍是观察模式，不会签名或下单。

一次性卖出该钱包在 Robinhood 主网上的全部 NVDA，成交确认后立即退出：

```bash
node src/arcus/tradeBot.js --live --sell-all-nvda
```

`--sell-all-nvda` 不检查指标，也不进入循环；它会按钱包的实际 NVDA 余额提交一次卖单。该参数必须与 `--live` 同时使用。成交后脚本重新读取钱包余额，以链上实际到账数量更新和显示结果，不使用可能受滑点影响的报价数量代替实际成交结果。

真实下单启动时，脚本会核对主网链 ID、Arcus 官方代币列表中的地址和钱包余额。首次交易时，如果代币不支持 EIP-2612，脚本会按官方流程发送一次 Permit2 授权交易，之后再提交兑换。行情、实际买入成本和脚本管理的仓位保存在 `data/arcus/usdg-nvda-mainnet-state.json`，该目录已加入 `.gitignore`。

若日志出现 `upstream venue unavailable`，表示 Arcus 上游当前没有给出该股票代币的报价。脚本会等待下一轮，不会用这次响应生成 K 线或交易；可在标的可交易时段继续观察。

> `--live` 会使用真实主网资产，不承诺收益。请确认钱包内有 USDG 和足够的 ETH Gas；建议先不加 `--live` 观察完整信号周期。
