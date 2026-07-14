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

`estimated_linear_fee_usd` 只是线性手续费估算，不能替代 Predict 实际手续费计算。在评估策略前，应保留原始 `fee_rate_bps` 并验证实际手续费模型。
