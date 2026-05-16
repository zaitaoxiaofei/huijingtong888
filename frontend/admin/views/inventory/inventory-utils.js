export function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

export function money(value) {
  return Number(value || 0).toFixed(2);
}

export function integer(value) {
  return Number(value || 0).toFixed(0);
}

export function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

export function dateText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function stockStatusType(stock, alertStock) {
  if (Number(stock) <= 0) return "danger";
  if (Number(stock) <= Number(alertStock || 0)) return "warning";
  return "success";
}

export function stockStatusText(stock, alertStock) {
  if (Number(stock) <= 0) return "无库存";
  if (Number(stock) <= Number(alertStock || 0)) return "预警";
  return "正常";
}

export function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function isWithinDateRange(value, dateFrom = "", dateTo = "") {
  if (!value) return !dateFrom && !dateTo;
  const dateKey = String(value).slice(0, 10);
  if (dateFrom && dateKey < dateFrom) return false;
  if (dateTo && dateKey > dateTo) return false;
  return true;
}

export function cleanQuery(query = {}) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

export function applyFilterQuery(route, filters, defaults = {}) {
  Object.keys(defaults).forEach((key) => {
    if (key === "page" || key === "pageSize") {
      filters[key] = asPositiveInt(route.query[key], defaults[key]);
      return;
    }
    filters[key] = String(route.query[key] ?? defaults[key] ?? "");
  });
}

export function buildFilterQuery(route, filters, defaults = {}) {
  const next = { ...route.query };
  Object.keys(defaults).forEach((key) => {
    const value = filters[key];
    const fallback = defaults[key];
    if (key === "page" || key === "pageSize") {
      next[key] = Number(value) !== Number(fallback) ? String(value) : undefined;
      return;
    }
    next[key] = String(value || "") !== String(fallback || "") ? String(value || "") : undefined;
  });
  return cleanQuery(next);
}

export function paginate(rows, page, pageSize) {
  const currentPage = asPositiveInt(page, 1);
  const size = asPositiveInt(pageSize, 20);
  const start = (currentPage - 1) * size;
  return rows.slice(start, start + size);
}
