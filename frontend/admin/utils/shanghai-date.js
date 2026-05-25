const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const SHANGHAI_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

function resolveDate(value, options = {}) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const text = String(value).trim();
  if (!text) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = options.assumeUtcWhenNaive && !hasTimezone
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shanghaiDateKey(value = new Date()) {
  const date = resolveDate(value);
  if (!date) return "";
  return SHANGHAI_DATE_FORMATTER.format(date);
}

export function shanghaiDateText(value, options = {}) {
  const date = resolveDate(value, options);
  if (!date) return "-";
  return SHANGHAI_DATE_FORMATTER.format(date);
}

export function shanghaiDateTimeText(value, options = {}) {
  const date = resolveDate(value, options);
  if (!date) return "-";
  return SHANGHAI_DATE_TIME_FORMATTER.format(date);
}

export function shanghaiDateDaysAgo(days = 0, anchor = new Date()) {
  const date = resolveDate(anchor);
  if (!date) return "";
  const cursor = new Date(date);
  cursor.setDate(cursor.getDate() - Number(days || 0));
  return shanghaiDateKey(cursor);
}

export function shanghaiMonthStart(value = new Date()) {
  const [year, month] = shanghaiDateKey(value).split("-");
  return year && month ? `${year}-${month}-01` : "";
}
