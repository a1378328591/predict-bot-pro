import { appendFileSync } from "node:fs";

const RATE_LIMIT_LOG_FILE = "autoMarketMaker.429.log";

function headerValue(response, name) {
  return response.headers.get(name) ?? "not returned";
}

// Rate-limit auditing must never interfere with the request that triggered it.
export function logPredict429(response, context = {}) {
  try {
    if (response?.status !== 429) return;

    const record = {
      timestamp: new Date().toISOString(),
      status: response.status,
      operation: context.operation ?? "unknown",
      method: context.method ?? "GET",
      url: context.url ?? "unknown",
      rateLimitLimit: headerValue(response, "ratelimit-limit"),
      rateLimitRemaining: headerValue(response, "ratelimit-remaining"),
      rateLimitReset: headerValue(response, "ratelimit-reset"),
      retryAfter: headerValue(response, "retry-after"),
      serverDate: headerValue(response, "date"),
    };

    try {
      appendFileSync(RATE_LIMIT_LOG_FILE, JSON.stringify(record) + "\n", "utf8");
    } catch {}

    try {
      console.log("⚠️ Predict 429:", JSON.stringify(record));
    } catch {}
  } catch {}
}
