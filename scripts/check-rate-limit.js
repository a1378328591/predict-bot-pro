#!/usr/bin/env node

import "dotenv/config";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const apiKey = process.env.PREDICT_API_KEY;
const proxyUrl = process.env.FICLASH_PROXY_URL || "http://127.0.0.1:7890";
const proxyAgent = new HttpsProxyAgent(proxyUrl);

if (!apiKey) {
  console.error("PREDICT_API_KEY is not set. Add it to .env or the process environment.");
  process.exit(2);
}

const endpoint = "https://api.predict.fun/v1/markets?first=1";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  // This endpoint only reads public market metadata; it cannot place, cancel, or modify orders.
  const response = await fetch(endpoint, {
    headers: { "x-api-key": apiKey },
    agent: proxyAgent,
    signal: controller.signal,
  });

  const headerNames = ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"];
  console.log(`Checked at: ${new Date().toISOString()}`);
  console.log(`Endpoint: GET ${endpoint}`);
  console.log(`HTTP status: ${response.status} ${response.statusText}`);
  for (const name of headerNames) {
    console.log(`${name}: ${response.headers.get(name) ?? "not returned"}`);
  }

  if (response.status === 429) {
    console.log("Result: rate limited. Wait for RateLimit-Reset (or Retry-After) before retrying.");
    process.exitCode = 1;
  } else if (!response.ok) {
    console.log("Result: request was not successful; rate-limit values above are the only response data shown.");
    process.exitCode = 1;
  } else if (response.headers.get("ratelimit-limit") === null) {
    console.log("Result: successful request, but this endpoint did not return RateLimit-* headers.");
  } else {
    console.log("Result: successful request with rate-limit headers.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Rate-limit probe failed: ${message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
