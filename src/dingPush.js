import "dotenv/config";
import crypto from "crypto";

/**
 * 发送钉钉消息（支持加签机器人）
 * @param {string} text 消息内容
 */
export async function pushDingTalk(text) {
  const { DING_ACCESS_TOKEN, DING_SECRET } = process.env;

  if (!DING_ACCESS_TOKEN) {
    throw new Error("缺少 DING_ACCESS_TOKEN 环境变量");
  }

  // 生成带签名的 webhook URL（如果配置了 DING_SECRET）
  let webhook = `https://oapi.dingtalk.com/robot/send?access_token=${DING_ACCESS_TOKEN}`;
  if (DING_SECRET) {
    const timestamp = Date.now();
    const sign = crypto
      .createHmac("sha256", DING_SECRET)
      .update(`${timestamp}\n${DING_SECRET}`)
      .digest("base64");

    webhook += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  const body = {
    msgtype: "text",
    text: { content: text },
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (json.errcode !== 0) {
      console.warn("❌ 钉钉推送失败:", json);
    } else {
      console.log("✅ 钉钉推送成功");
    }
  } catch (err) {
    console.error("❌ 钉钉推送异常:", err);
  }
}

// =================
// 测试用
// =================
if (process.argv[1].endsWith("pushDingTalk.js")) {
  pushDingTalk("测试消息: 钉钉加签推送成功").catch(console.error);
}
