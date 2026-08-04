import "dotenv/config";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pushDingTalk } from "../dingPush.js";

const WEATHER_API_KEY = "e1f10a1e78da46f5b10a1e78da96f525";
const WEATHER_URL = new URL("https://api.weather.com/v3/wx/observations/current");
WEATHER_URL.search = new URLSearchParams({
  apiKey: WEATHER_API_KEY,
  language: "en-US",
  units: "m",
  format: "json",
  icaoCode: "ZSPD",
}).toString();

const POLL_INTERVAL_MS = 3_000;
const PROXY_URL = process.env.FICLASH_PROXY_URL || "http://127.0.0.1:7890";
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

let observedDate;
let highestObservedTemperature = Number.NEGATIVE_INFINITY;
let notificationSent = false;

async function fetchObservation(agent) {
  const response = await fetch(WEATHER_URL, { agent });
  if (!response.ok) {
    throw new Error(`Wunderground observation request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getObservation() {
  try {
    return await fetchObservation();
  } catch (error) {
    console.warn(`Direct Wunderground request failed; retrying via proxy ${PROXY_URL}:`, error.message);
    return fetchObservation(proxyAgent);
  }
}

async function monitorTemperature() {
  const observation = await getObservation();
  const currentTemperature = observation.temperature;
  const reportedHighTemperature = observation.temperatureMaxSince7Am;
  const date = observation.validTimeLocal?.slice(0, 10);

  if (
    !Number.isFinite(currentTemperature) ||
    !Number.isFinite(reportedHighTemperature) ||
    !date
  ) {
    throw new Error("Wunderground response is missing ZSPD temperature data");
  }

  if (observedDate !== date) {
    observedDate = date;
    highestObservedTemperature = reportedHighTemperature;
    notificationSent = false;
    console.log(`[${date}] Monitoring ZSPD. Recorded high: ${highestObservedTemperature} C`);
    return;
  }

  console.log(
    `[${date}] ZSPD current: ${currentTemperature} C, recorded high: ${highestObservedTemperature} C`,
  );

  if (currentTemperature > highestObservedTemperature) {
    highestObservedTemperature = currentTemperature;

    if (!notificationSent) {
      notificationSent = true;
      await pushDingTalk(
        `ZSPD new daily high\nDate: ${date}\nCurrent: ${currentTemperature} C\nRecorded high: ${highestObservedTemperature} C`,
      );
    }
  }
}

async function poll() {
  try {
    await monitorTemperature();
  } catch (error) {
    console.error("Temperature monitor failed:", error);
  } finally {
    setTimeout(poll, POLL_INTERVAL_MS);
  }
}

poll();
