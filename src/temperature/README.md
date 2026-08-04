# 浦东机场最高气温监控

## 启动

在项目根目录执行：

```bash
npm run monitor:temperature
```

停止脚本时按 `Ctrl+C`。

## 数据来源

脚本通过 Wunderground 页面使用的 Weather.com 观测接口监控上海浦东国际机场站（ICAO：`ZSPD`）：

- 实时气温：`temperature`
- 截至当日 07:00 的站点最高温：`temperatureMaxSince7Am`
- 站点本地观测日期：`validTimeLocal`

请求单位为摄氏度（`units=m`）。Wunderground 对该市场以整摄氏度结算，接口也返回整摄氏度数值。

## 运行逻辑

`monitorShanghaiHighTemperature.js` 启动后立即执行一次查询，之后每秒查询一次。请求采用串行调度：上一轮请求结束后才会等待一秒并开始下一轮，因此网络变慢时不会产生重叠请求。

每次请求先直连 Wunderground；直连失败或返回非成功状态时，自动通过 FiClash 默认 HTTP 代理 `http://127.0.0.1:7890` 重试。若 FiClash 使用其他端口，可设置 `FICLASH_PROXY_URL` 覆盖默认值。

脚本在内存中维护两个状态：

- `highestObservedTemperature`：启动时取 Wunderground 已报告的当天最高温，后续只会升高。
- `notificationSent`：当天是否已发送过提醒。

当实时气温首次超过脚本已记录的当天最高温时，脚本会更新本地最高温并立即调用 `src/dingPush.js` 发送钉钉消息。当天仅推送一次；日期切换到下一天时，两个状态会自动重置。

## 钉钉配置

钉钉配置沿用项目现有的 `src/dingPush.js`：该模块负责加载环境变量并读取 `DING_ACCESS_TOKEN` 与可选的 `DING_SECRET`。温度监控脚本本身不会读取 `.env` 或输出其中的任何配置。

若 `DING_ACCESS_TOKEN` 未配置，达到温度条件时推送会失败并在控制台输出错误。

## 注意事项

单日推送状态只保存在进程内存中。脚本在同一天重启后会重新开始监控，并可能再次发送一次提醒。
