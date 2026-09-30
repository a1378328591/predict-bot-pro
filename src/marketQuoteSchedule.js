const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

function parseDateTimeKey(value, fieldName) {
  const text = String(value || "");
  const match = DATE_TIME_PATTERN.exec(text);
  if (!match) throw new Error(`${fieldName} 必须使用 YYYY-MM-DD HH:mm 格式: ${text}`);
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || hour > 23 || minute > 59) {
    throw new Error(`${fieldName} 不是有效日期时间: ${text}`);
  }
  return Number(`${yearText}${monthText}${dayText}${hourText}${minuteText}`);
}

export function shanghaiDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

export function compileQuoteSchedules(groups) {
  if (!Array.isArray(groups) || !groups.length) throw new Error("MARKET_GROUPS 不能为空");
  const byCategory = new Map();
  for (const group of groups) {
    if (!group?.name || !Array.isArray(group.categorySlugs) || !group.categorySlugs.length) {
      throw new Error("每个市场组都必须配置 name 和 categorySlugs");
    }
    if (!Array.isArray(group.quoteWindows) || !group.quoteWindows.length) {
      throw new Error(`${group.name} 必须至少配置一个 quoteWindows 区间`);
    }
    const windows = group.quoteWindows.map((window, index) => {
      const startText = window?.start;
      const endText = window?.end;
      const start = parseDateTimeKey(startText, `${group.name}.quoteWindows[${index}].start`);
      const end = parseDateTimeKey(endText, `${group.name}.quoteWindows[${index}].end`);
      if (start >= end) throw new Error(`${group.name} 挂单区间开始时间必须早于结束时间: ${startText} -> ${endText}`);
      return { start, end, startText, endText };
    }).sort((left, right) => left.start - right.start);
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index].start < windows[index - 1].end) {
        throw new Error(`${group.name} 挂单区间不能重叠`);
      }
    }
    for (const categorySlug of group.categorySlugs) {
      if (byCategory.has(categorySlug)) throw new Error(`category slug 重复配置: ${categorySlug}`);
      byCategory.set(categorySlug, { name: group.name, windows });
    }
  }
  return byCategory;
}

export function quoteWindowStatus(scheduleByCategory, categorySlug, date = new Date()) {
  const schedule = scheduleByCategory.get(categorySlug);
  if (!schedule) return { open: false, marketName: "未配置市场", nowText: shanghaiDateTime(date), activeWindow: null };
  const nowText = shanghaiDateTime(date);
  const now = parseDateTimeKey(nowText, "当前北京时间");
  const activeWindow = schedule.windows.find(window => now >= window.start && now < window.end) || null;
  return { open: Boolean(activeWindow), marketName: schedule.name, nowText, activeWindow };
}

export function formatQuoteSchedules(groups) {
  return groups.map(group => `${group.name}=${group.quoteWindows.map(window => `${window.start}~${window.end}`).join(",")}`).join(";");
}
