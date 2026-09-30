const easternClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function isUsRegularSession(timeMs) {
  return usMarketRegime(timeMs) === "regular_open";
}

function easternParts(timeMs) {
  return Object.fromEntries(easternClock.formatToParts(new Date(timeMs))
    .filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

export function usMarketDate(timeMs) {
  const parts = easternParts(timeMs);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function usMarketRegime(timeMs) {
  const parts = easternParts(timeMs);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "weekend";
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60 ? "regular_open" : "weekday_closed";
}
