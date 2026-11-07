const BEIJING_TIME_ZONE = "Asia/Shanghai";

function beijingDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDateKey(dateKey, offset) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return date.toISOString().slice(0, 10);
}

export function getAnalyticsPeriodDateRange(periodKey, now = new Date()) {
  const today = beijingDateKey(now);
  if (periodKey === "today") return [today, today];
  if (periodKey === "yesterday") {
    const yesterday = offsetDateKey(today, -1);
    return [yesterday, yesterday];
  }
  if (periodKey === "7d") return [offsetDateKey(today, -6), today];
  if (periodKey === "28d") return [offsetDateKey(today, -27), today];

  const [year, month] = today.split("-").map(Number);
  if (periodKey === "quarter") {
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return [`${year}-${String(quarterStartMonth).padStart(2, "0")}-01`, today];
  }
  if (periodKey === "year") return [`${year}-01-01`, today];
  return null;
}
