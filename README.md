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