const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shanghaiDateKey(value = new Date()) {
  const date = asDate(value);
  if (!date) return "";
  return SHANGHAI_DATE_FORMATTER.format(date);
}

export function shanghaiDateDaysAgo(days = 0, anchor = new Date()) {
  const date = asDate(anchor);
  if (!date) return "";
  const cursor = new Date(date);
  cursor.setDate(cursor.getDate() - Number(days || 0));
  return shanghaiDateKey(cursor);
}

export function normalizeShanghaiDateInput(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (!text.includes("T")) return text.slice(0, 10);
  const date = asDate(text);
  return date ? shanghaiDateKey(date) : "";
}
