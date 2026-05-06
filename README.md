# predict-bot-pro

Predict.fun 自动做市与风控机器人，负责自动挂单、挂单监控撤单、持仓检测和平仓处理。

核心原则是与 Polymarket 对齐：以 Polymarket 更好的买盘流动性和价格作为外部锚点，只在 Predict 价格不高于 Polymarket 或偏差很小时挂单，并在偏离时快速撤单，尽量减少被塞订单和被动持仓风险。

机器人只处理当前有积分奖励的 Predict 市场，不对无积分奖励市场挂单。

## 安装

```bash
npm install
```

## 环境变量

项目使用 `.env` 配置运行参数，`.env` 和 `.env.*` 已加入 `.gitignore`，不要提交私钥、API Key、账户地址等敏感信息。

先复制示例环境变量文件：

```bash
cp .env.example .env
```

然后在 `.env` 中填写真实的 API Key、私钥、账户地址和 RPC 地址。

`RPC_URL` 支持多个 BSC RPC 地址，用英文逗号分隔。查询余额时如果当前 RPC 失败，会自动切换到下一个 RPC。

## 运行

使用 PM2 后台运行：

```bash
pm2 start src/autoMarketMaker.js --name predict-bot --update-env
```

查看运行日志：

```bash
pm2 logs predict-bot
```

修改代码或 `.env` 后重启：

```bash
pm2 restart predict-bot --update-env
```

停止机器人：

```bash
pm2 stop predict-bot
```

不要使用 `>` 重定向日志。PM2 会输出进程日志，`autoMarketMaker.js` 也会用 UTF-8 自动写入：

```text
autoMarketMaker.log
```

## autoMarketMaker.js 主要逻辑

脚本启动后同时运行三个互不影响的循环：

1. 自动挂单主循环
2. 高频挂单风控监控
3. 高频持仓平仓监控

### 自动挂单

自动挂单主循环每 5 分钟执行一轮。

每轮会分页遍历 Predict.fun 所有 `OPEN` 且当前有积分奖励的市场，每页 100 条，不再只处理前 100 个市场。

市场基础过滤：

- 跳过标题包含 `btc` 或 `bitcoin` 的市场
- 只处理 `hasActiveRewards=true` 的市场
- 只处理包含 `polymarketConditionIds` 的市场
- 已写入 `blockedMarkets.json` 的市场不再挂单

挂单风控：

- Predict 买一价格低于 `0.25` 不挂
- Predict 买一价格高于 `0.99` 不挂
- 必须能映射到 Polymarket 对应 outcome 的 CLOB token
- Polymarket 必须有买一
- Polymarket 买一金额必须大于等于 `1000u`
- 如果 Predict 买一高于 Polymarket 买一超过 `0.001`，不挂
- 如果 Predict 买一小于或等于 Polymarket 买一，允许挂
- 运动/电竞类市场会读取 Polymarket 开始时间
- 接近开赛的市场不挂
- 支持订单过期时间，运动/电竞订单设置为开赛前 15 分钟失效

挂单节流：

- 每个市场之间等待 1 秒
- 同一市场每个 outcome 之间等待 500ms
- Yes 和 No 会分别独立判断风控，满足条件就分别挂单

挂单金额：

- 每单使用当前 USDT 余额的 95%

### 高频挂单监控

挂单监控每 3 秒独立运行一次，不依赖自动挂单主循环。

监控逻辑是保守风控：能确认安全才继续挂着，确认不了安全就撤单。

撤单条件包括：

- 市场已进入 `blockedMarkets.json`
- 找不到 Polymarket 映射
- 找不到对应 outcome
- Polymarket 无买一
- Polymarket 买一金额低于 `1000u`
- Predict 买一高于 Polymarket 买一超过 `0.001`
- 市场已接近开赛
- 单个订单监控发生异常

如果本轮获取 open orders 失败，会使用上一轮缓存的挂单继续尝试风控撤单，避免因为接口异常导致监控停摆。

### 高频持仓平仓

持仓监控每 3 秒独立运行一次，不依赖挂单主循环或挂单监控。

检测到持仓后：

- 立刻把对应市场写入 `blockedMarkets.json`
- 后续不再给该市场挂买单
- 如果已有卖单，不重复挂卖单
- 自动平仓使用限价卖单，不使用市价卖单
- 最多接受 3 个价差，例如 0.30 买入，最低只会 0.27 卖出
- 卖出前检查 Predict 订单簿买盘流动性
- 只有高于等于最低卖价的买盘数量足够覆盖持仓时才挂限价卖单
- 如果流动性不足，本轮放弃卖出，下一轮继续检查
- 如果无法识别持仓买入价，不盲卖，只记录并等待

## 本地文件

以下文件属于本地运行数据，不应提交：

```text
.env
.env.*
*.log
*.pid
blockedMarkets.json
node_modules/
```

`blockedMarkets.json` 用于记录已经成交或需要永久跳过的市场，避免同一市场被再次挂单。
