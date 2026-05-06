# 针对node v16版本写的
mkdir predict-bot
cd predict-bot

npm init -y

npm install typescript ts-node dotenv node-fetch@2 ethers@6 @predictdotfun/sdk



本地运行：
```
node ./src/positionMonitor.js
```


服务器：
```
#这里没用pm2
# 确认有没有在后台运行
ps aux | grep positionMonitor.js
# 查看日志
tail -f monitor.log
# 切换目录 和 后台执行
cd predict-bot/
nohup node src/positionMonitor.js > monitor.log 2>&1 &
```







───

📋 Predict.fun 自动做市机器人 - 部署总结

代码入口

~/.openclaw/workspace/predict-bot/src/autoMarketMaker.js

启动命令

cd ~/.openclaw/workspace/predict-bot
nohup node src/autoMarketMaker.js > autoMarketMaker.log 2>&1 &

查看日志

tail -f ~/.openclaw/workspace/predict-bot/autoMarketMaker.log

停止脚本

pkill -f autoMarketMaker

───

已实现的功能

| 需求               | 状态 | 说明                        |
| ------------------ | ---- | --------------------------- |
| 挂单金额 = 余额95% | ✅    | 每单使用账户余额的95%       |
| 前100个市场        | ✅    | 按 VOLUME_24H_DESC 排序     |
| YES/NO双边挂单     | ✅    | 每个市场两个方向都挂        |
| 已有挂单则跳过     | ✅    | 避免重复挂单                |
| 过滤BTC市场        | ✅    | 跳过标题含BTC/Bitcoin的市场 |
| 独立平仓功能       | ✅    | 持仓检测并市价卖出          |
| 错误捕获           | ✅    | 单个市场失败不影响其他      |

───

当前状态

从日志看，余额仅剩 0.87 USDT，说明：

1. ✅ 之前的挂单已经成功
2. ✅ 并且已经成交（被吃了）
3. ❓ 但平仓（卖出）可能有问题，导致资金没有回笼

需要检查：

• 持仓是否被正确检测
• 市价卖出是否成功

要继续运行，需要：

1. 充值 USDT 到账户
2. 或检查为什么平仓没有成功卖出持仓

───

配置文件

环境变量在 ~/.openclaw/workspace/predict-bot/.env：

PRIVY_PRIVATE_KEY=xxx
PREDICT_ACCOUNT=0x5d7B3a48Dbb29b7E6ABcD82EC36Ea2276809eA4B
PREDICT_API_KEY=xxx