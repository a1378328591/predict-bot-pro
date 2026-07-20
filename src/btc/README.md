# Predict BTC 样本采集器

这是一个用于采集 Predict BTC 涨跌市场数据的只读工具。它不会导入下单 SDK、私钥、JWT 获取模块、订单接口或持仓接口，因此无法创建、撤销或签署订单。

## 运行

在 `.env` 中配置 `PREDICT_API_KEY`，然后运行：

```bash
npm run collect:btc
```

可选环境变量：

```bash
BTC_SAMPLE_OUTPUT_DIR=data/btc
BTC_SAMPLE_INTERVAL_MS=2000
BTC_CATEGORY_REFRESH_MS=10000
BTC_DISCOVERY_INTERVAL_MS=2000
BTC_DEPTH_NOTIONALS_USD=10,50,100
PREDICT_API_BASE_URL=https://api.predict.fun
```

## 输出数据

默认所有数据都以 JSON Lines 格式写入 `data/btc`。

- `snapshots.jsonl`：每次采样、每个市场一条记录。包含 Predict 原始订单簿、每个结果归一化后的买卖盘、指定名义金额下的可执行买入/卖出 VWAP、明确标记为线性估算的手续费、时间信息、Predict 预言机元数据、起止价和 BTC 参考价格特征。
- `market_metadata.jsonl`：被追踪市场发生元数据变化时的完整分类数据，包括开始/结束时间、预言机、市场详情、结果状态和费率。
- `settlements.jsonl`：最终分类及结果结算记录。可用它与 `snapshots.jsonl` 关联，计算真实胜率和成本后 PnL。
- `errors.jsonl`：请求或解析错误。
- `active_categories.json`：尚未结算市场的轻量重启状态文件。

采集器按当前 5 分钟 Unix 时间边界直接推导市场 slug：`btc-updown-5m-${floor(now / 300) * 300}`。它不会扫描全部开放分类，也不会采集未来市场。已结束的市场会保留在本地重启状态中，直到 Predict 返回结算结果。

公共 Binance BTCUSDT 最优买卖价会被记录为参考特征。当前 BTC 市场描述说明 Chainlink 使用 Binance Top-of-Book 中间价，但采集器本身不会裁定结果。判断最终结果时，应以 `price_feed_provider`、`price_feed_symbol`、`start_price`、`end_price` 和 `settlements.jsonl` 为准。

买入/卖出 VWAP 的 `estimated_taker_fee_usd` 使用 Predict 折后 taker 档位计算：每份手续费为 `1.8% x min(价格, 1 - 价格)`。这对应图片最后一列，例如价格 `0.99` 时有效费率为 `0.018%`，价格 `0.50` 时为 `1.8%`。Maker 挂单不在此费用模型中；如果限价买单会立刻成交，则应按 taker 成本评估。

## Z 分数纸面信号

先运行采集器，再在另一个终端运行：

```bash
npm run signal:btc:z
```

脚本会读取已结算市场，以滚动波动率、剩余时间和实际盘口建立历史胜率校准；随后只监听新写入的快照。它向 `data/btc/z_score_signals.jsonl` 写入 `PAPER_BUY` 和每市场一次的 `PAPER_SKIP` 诊断记录，不读取私钥、账户、JWT，也不会调用下单或撤单接口。

市场结算后，运行以下命令生成纸面交易的最终结果：

```bash
npm run reconcile:btc:z
```

它只处理 `PAPER_BUY`，按信号入场时记录的份额、折后 taker 手续费和最终结算结果计算 payout、PnL、ROI，并写入 `data/btc/z_score_paper_results.jsonl`。`PAPER_SKIP` 没有持仓，收益固定为 0，不会出现在结果文件中。

```text
z = |ln(reference_price / start_price)| x 10000
    / (sigma_bps_per_sqrt_second x sqrt(remaining_seconds))
```

动态更新的是价格、波动率、z、盘口和实际成本。固定并经样本外验证后才更新的是波动率窗口、z 阈值、最小样本量、费用模型和安全边际。脚本会以完整 `$10` 买入 VWAP 加上述折后 taker 费用计算成本，并使用胜率的保守下界；只有它高于盈亏平衡胜率加安全边际时，才发出纸面信号。

可选环境变量：

```bash
Z_VOLATILITY_WINDOW_SECONDS=60
Z_MIN_HISTORY_SECONDS=25
Z_MIN_HISTORY_OBSERVATIONS=10
Z_VOLATILITY_FLOOR_BPS=0.5
Z_ENTRY_THRESHOLD=1.5
Z_EDGE_MARGIN=0.01
Z_MIN_CALIBRATION_SAMPLES=30
Z_CONFIDENCE_Z=1.64
Z_MAX_SPREAD=0.03
Z_TRADE_NOTIONAL_USD=10
Z_MAX_SNAPSHOT_AGE_MS=10000
Z_TAIL_INTERVAL_MS=1000
```
