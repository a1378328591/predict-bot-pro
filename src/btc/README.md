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

## 时间约定

- 所有计算、排序、过期检查和暂停截止时间都使用Unix毫秒时间戳，不使用格式化后的本地时间字符串。
- JSONL主时间字段统一保存UTC ISO 8601（以`Z`结尾），并尽量同时保存对应的`*_ms`字段。
- `*_beijing`和控制台时间仅用于人工阅读，固定使用`Asia/Shanghai`并显式带`+08:00`。
- 美股常规盘、工作日盘外、周末及回测日归属统一使用`America/New_York`，由运行时自动处理夏令时。
- `timing.ends_at`等Predict市场时间保持UTC；倒计时使用时间戳相减，与机器当前显示时区无关。

采集器按当前 5 分钟 Unix 时间边界直接推导市场 slug：`btc-updown-5m-${floor(now / 300) * 300}`。它不会扫描全部开放分类，也不会采集未来市场。已结束的市场会保留在本地重启状态中，直到 Predict 返回结算结果。

公共 Binance BTCUSDT 最优买卖价会被记录为盘中参考特征。市场规则指定 Chainlink BTC/USDT Data Stream 为主结算源，并说明该流使用 Binance Top-of-Book 中间价；Binance 数据因此是低延迟近似值，不是本工具自行认定的最终结算值。起始价使用 Predict 返回的 Chainlink `variantData.startPrice`，最终结果以 Predict 的 `endPrice` 和结算状态为准。

`category.startsAt` 是市场开放交易时间，可能比实际价格比较区间早一天，不能当作 BTC 起始价时刻。采样器使用 slug 末尾的 Unix 时间作为 5 分钟价格区间起点，并校验它与 `endsAt` 相差 300 秒。

买入/卖出 VWAP 的 `estimated_taker_fee_usd` 使用 Predict 折后 taker 档位计算：每份手续费为 `1.8% x min(价格, 1 - 价格)`。这对应图片最后一列，例如价格 `0.99` 时有效费率为 `0.018%`，价格 `0.50` 时为 `1.8%`。Maker 挂单不在此费用模型中；如果限价买单会立刻成交，则应按 taker 成本评估。

## 双波动率概率信号

先运行采集器，再在另一个终端运行：

```bash
npm run signal:btc:z
```

脚本使用 30 秒快速波动率和 180 秒慢速波动率中较高者，结合距离 Chainlink 起始价的偏差、剩余时间以及 Binance Top-of-Book microprice，计算 Up/Down 终值概率。它会同时比较两个方向的 Predict 可成交 VWAP、taker 手续费和安全边际，选择净优势更高的一侧。已有足够结算样本时，再以最多 50% 权重加入历史校准。

信号写入 `data/btc/z_score_signals.jsonl`。信号进程不读取私钥、账户或 JWT，也不会调用订单接口。

市场结算后，运行以下命令生成纸面交易的最终结果：

```bash
npm run reconcile:btc:z
```

它只处理 `PAPER_BUY`，按信号入场时记录的份额、折后 taker 手续费和最终结算结果计算 payout、PnL、ROI，并写入 `data/btc/z_score_paper_results.jsonl`。`PAPER_SKIP` 没有持仓，收益固定为 0，不会出现在结果文件中。

```text
z = ln(model_price / chainlink_start_price)
    / (sigma_per_sqrt_second x sqrt(remaining_seconds))
```

模型对波动率增加默认 15% 的不确定性，并取各方向较保守的概率下界。脚本会以完整 `$10` 买入 VWAP 加折后 taker 费用计算成本；只有保守概率至少 70%，且高于盈亏平衡概率与 0.5% 安全边际之和时，才发出纸面信号。开盘后先积累至少 25 秒、10 个观测点的波动率样本，随后整轮持续评估；`|z| >= 0.5`、盘口价差不超过 2% 时才允许首次入场，每个市场最多一次买入。

可选环境变量：

```bash
Z_FAST_VOLATILITY_WINDOW_SECONDS=30
Z_SLOW_VOLATILITY_WINDOW_SECONDS=180
Z_MIN_HISTORY_SECONDS=25
Z_MIN_HISTORY_OBSERVATIONS=10
Z_VOLATILITY_FLOOR_BPS=0.5
Z_VOLATILITY_UNCERTAINTY=1.15
Z_MICROPRICE_WEIGHT=0.5
Z_ENTRY_THRESHOLD=0.5
Z_EDGE_MARGIN=0.005
Z_MIN_ENTRY_PROBABILITY=0.70
Z_MIN_CALIBRATION_SAMPLES=30
Z_CONFIDENCE_Z=1.64
Z_MAX_SPREAD=0.02
Z_TRADE_NOTIONAL_USD=10
Z_MAX_SNAPSHOT_AGE_MS=10000
Z_MAX_REFERENCE_AGE_MS=5000
Z_TAIL_INTERVAL_MS=1000
```

## Z 策略固定金额执行器

执行器消费新产生的 `PAPER_BUY`，在下单前重新获取市场和订单簿，并重新校验当前 ask、折后 taker 成本、剩余时间和信号的胜率下界。它不会处理最后 5 秒固定价差策略。

默认只监听，不会下单：

```bash
npm run execute:btc:z
```

建议先在 `.env` 使用纸面模式：

```bash
# 是否允许真实下单。先保持 false；只有准备使用真实资金时才改为 true。
Z_LIVE_TRADING=false

# 每笔固定投入 USDT。首次真实验证建议 1，确认订单状态和费用后再提高。
Z_EXECUTION_NOTIONAL_USD=5

# 信号生成超过多少毫秒则放弃，防止延迟订单。建议 3000。
Z_EXECUTION_MAX_SIGNAL_AGE_MS=3000

# 只保留签名和网络执行缓冲，不作为模型禁入区间。
Z_EXECUTION_MIN_REMAINING_SECONDS=2

# 当前卖一超过此价格则不买。建议 0.95，避免高价合约剩余收益不足。
Z_EXECUTION_MAX_ASK=0.95

# 严格限价买单保持 OPEN 多久后撤单。建议 2000 毫秒。
Z_EXECUTION_ORDER_TIMEOUT_MS=2000

# 检查新纸面信号的频率。建议 500 毫秒。
Z_EXECUTION_TAIL_INTERVAL_MS=500

# 执行器运行心跳日志间隔。建议 30000 毫秒。
Z_EXECUTION_HEARTBEAT_MS=30000

# 模型退出滞后：持仓概率比可兑现净卖价低 2 个百分点才退出，避免边界抖动。
Z_EXIT_EDGE_MARGIN=0.20

# 持仓接口缓存时间。
Z_POSITION_REFRESH_MS=1000

# Predict 要求订单 expiry 至少比当前时间晚约两分钟。
Z_MIN_ORDER_EXPIRY_MS=125000
```

也可以用一个入口同时启动采样器、信号引擎和执行器：

```bash
npm run trade:btc:5m
```

统一入口会同时启动只读实时仪表盘，默认地址：

```text
http://127.0.0.1:3210
```

页面展示当前市场倒计时、Chainlink 起始价、Binance 参考价、Up/Down 模型概率、Predict 盘口、入场检查、策略持仓状态和执行日志。页面不包含下单或账户控制接口。端口被占用时会自动尝试 `3211` 至 `3220`，以启动日志打印的地址为准。可用 `BTC_DASHBOARD_HOST` 和 `BTC_DASHBOARD_PORT` 修改监听地址。

仪表盘还会从自身本次启动时间开始，根据本地执行日志统计估算盈亏，包含已结算、模型退出和当前持仓买一估值。这个统计完全在独立只读进程中完成，不请求 Predict 持仓或订单接口，不影响交易主流程。由于本地日志无法精确确认部分成交，页面会明确标注“执行估算”，应以 Predict 账户账单为最终结果。

确认纸面信号、账户签名、下单、撤单和费用记录都正确后，才将 `Z_LIVE_TRADING=true`。开始实盘时仍建议先保留 `Z_EXECUTION_NOTIONAL_USD=1`，不要直接使用较大金额。

真实执行还需要现有 Predict 账户配置：`PREDICT_API_KEY`、`PRIVY_PRIVATE_KEY`、`PREDICT_ACCOUNT`。订单以当前卖一提交严格限价买单；若在超时内仍保持 OPEN，执行器会撤单。信号引擎持续输出 `MODEL_UPDATE`，执行器会查询本机器人参与市场的真实持仓；当反方向形成入场优势，或当前方向的保守概率低于立即卖出的净可兑现价值时，按当前买一限价退出。退出单未成交会撤销，并在下一次模型更新重算。执行日志写入 `data/btc/z_score_execution_log.jsonl`，状态写入 `data/btc/z_score_executor_state.json`。

## BTC 5m 时段策略纸面验证

`reversalValueSignalEngine.js` 保留旧文件名以兼容已有命令，但现在运行 `session_trend_v2`。它与现有 Z-score 实盘策略完全分离，只读取采集器持续写入的 `snapshots.jsonl`，不导入 Predict SDK、JWT或钱包模块，也不调用订单与持仓接口。

旧的 `reversal_value_v1` 前向结果为55笔、15胜、ROI -20.41%。历史快照按时间前60%选参、后40%留出验证后，盘外反转的留出ROI为 -20.25%，盘内反转与盘内顺势也未通过。当前唯一在训练和留出段方向一致的是美股常规盘外顺势，但留出期仍很短，因此只进入新的纸面验证阶段，不能据此启用实盘。

v2默认固定10份：BTC相对Chainlink起始价至少偏离1bps，30秒和60秒收益都同向且绝对值至少1.0bps，剩余30至180秒，纸面买价保持35c至70c，价差不超过2c。为增加纸面样本，最小动量门槛从1.5bps降到1.0bps。默认只有纽约周末计入纸面主策略，工作日盘外记录为 `WEEKDAY_CLOSED_SHADOW_BUY`，美股常规盘内记录为 `US_OPEN_SHADOW_BUY`。当前数据只覆盖一个完整周末，时间留出并不等于跨周末复现，不能用于实盘。时段按 `America/New_York` 判断并自动处理夏令时，日志可读时间仍为北京时间（UTC+8）。

一键启动采集器、反转纸面信号和剧烈波动监控：

```bash
npm run paper:btc:reversal
# 等价的新名称：npm run paper:btc:sessions
```

该命令只启动三项只读/纸面流程，不启动现有Z-score实盘订单执行器。按 `Ctrl+C` 会统一关闭三个子进程。任一子进程异常退出时，启动器会停止整组，避免留下不完整流程。

监控只使用 Binance BTC 中间价的5分钟累计收益判断异常，阈值固定为50bps（0.5%）；不再使用30秒、60秒收益或短窗sigma。暂停没有固定时长：每300秒检查一次，连续3个周期的5分钟涨跌都低于0.5%才恢复，任一周期达到阈值便将连续计数清零。这些风控值直接定义在脚本中，不读取 `.env`。结果写入 `data/btc/reversal_value_pause.json`；纸面信号只记录异常，实盘信号会实际遵守暂停状态。

首次启动从当时的快照文件末尾开始，只记录未来信号；重启会从保存的文件偏移继续读取。输出文件：

- `data/btc/reversal_value_signals.jsonl`：候选评估和每市场最多一次的 `PAPER_BUY`。
- `data/btc/reversal_value_state.json`：读取偏移和已买市场。

市场结算后运行：

```bash
npm run reconcile:btc:reversal
# 等价的新名称：npm run reconcile:btc:sessions
```

结算结果写入 `data/btc/reversal_value_results.jsonl`，并按 `strategy` 分开输出信号数、胜率、PnL与ROI。策略参数直接定义在 `reversalValueSignalEngine.js` 中，不读取 `.env`。重新检查全部历史数据可运行 `npm run backtest:btc:sessions`。前向实验期间不要根据短期结果频繁修改参数，否则会破坏样本外检验。

## BTC 5m 时段策略实盘

实盘必须使用名称明确的独立入口，纸面命令不会提交订单：

```bash
npm run trade:btc:reversal
```

该入口启动采样器、5分钟波动监控、实盘信号和独立订单执行器。策略及风控参数直接定义在脚本中，不使用新增环境变量；认证仍通过现有 `PREDICT_API_KEY`、`PRIVY_PRIVATE_KEY`、`PREDICT_ACCOUNT` 获取。每笔通过原生 `MARKET` 策略固定买入10份，实时盘口VWAP必须在35c至70c、吃满10份的最后一档价格不得高于70c、价差不得超过2c。每个市场最多提交一次，不再采用限价单等待2秒后撤单；市价单不额外放宽滑点，价格保护来自提交前读取的10份盘口。

实盘会读取 `data/btc/reversal_value_pause.json`：5分钟涨跌达到0.5%时停止产生实盘信号，之后每5分钟检查一次，连续3个周期低于0.5%才恢复。实盘信号、执行日志和重启状态分别写入 `session_trend_live_signals.jsonl`、`session_trend_execution_log.jsonl`、`session_trend_executor_state.json`，不会重放历史纸面信号。

只统计实盘下单动作（不查询接口成交结果，也不读取 `.env`）：

```bash
npm run stats:btc:live
```

同一个信号即使产生提交、撤单等多条日志也只算一个 `order_actions`；接口成功或失败都计入。`pending_actions` 表示已经产生实盘信号、但执行器日志中还没有对应动作的数量。盈亏和ROI使用本地 `settlements.jsonl` 结算，并假设每个动作都按信号日志记录的份额和报价完整买入，因此衡量的是动作策略表现，不是账户真实成交盈亏。
