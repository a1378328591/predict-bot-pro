import { runBot } from "./bot";
import 'dotenv/config';  // 自动加载根目录 .env



runBot().catch((e) => {
  console.error(e);
  process.exit(1);
});
