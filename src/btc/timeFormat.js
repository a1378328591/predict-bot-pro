const beijingClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function utcIso(timeMs = Date.now()) {
  return new Date(timeMs).toISOString();
}

export function beijingIso(timeMs = Date.now()) {
  const parts = Object.fromEntries(beijingClock.formatToParts(new Date(timeMs))
    .filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}
