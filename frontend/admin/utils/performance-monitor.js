const DEFAULT_SLOW_ROUTE_MS = 1000;
const DEFAULT_SLOW_API_MS = 500;
const ROUTE_IDLE_MS = 300;
const SUMMARY_WAIT_MS = 12000;
const MAX_REPORTS = 50;
const MAX_API_RECORDS = 120;

let routeSequence = 0;
let apiSequence = 0;
let currentRoute = null;
let summaryTimer = null;

const reports = [];
const apiRecords = [];

function inferCurrentRoute() {
  return String(window.location.hash || window.location.pathname || "");
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function getSlowRouteMs() {
  return Number(readStorage("erpPerfSlowRouteMs") || DEFAULT_SLOW_ROUTE_MS);
}

function getSlowApiMs() {
  return Number(readStorage("erpPerfSlowApiMs") || DEFAULT_SLOW_API_MS);
}

function readStorage(key) {
  try {
    return window.localStorage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Monitoring must never break app startup in restricted browser contexts.
  }
}

function isLocalRuntime() {
  const host = String(window.location.hostname || "");
  return host === "localhost" || host === "127.0.0.1" || host === "";
}

function isEnabled() {
  const search = String(window.location.search || "");
  if (/[?&]_erp_perf=(1|on|true)\b/i.test(search)) {
    writeStorage("erpPerfMonitor", "on");
    return true;
  }
  const setting = String(readStorage("erpPerfMonitor") || "").toLowerCase();
  if (setting === "off" || setting === "0") return false;
  if (setting === "on" || setting === "1") return true;
  return isLocalRuntime();
}

function bootStartedAt() {
  return Number(window.__ERP_BOOT_STARTED_AT || 0);
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url || ""), window.location.origin);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || "");
  }
}

function pushLimited(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function getApiSummary(route) {
  const rows = [...route.apiRecords].sort((a, b) => b.elapsedMs - a.elapsedMs);
  const totalMs = rows.reduce((sum, item) => sum + item.elapsedMs, 0);
  return {
    total: rows.length,
    slow: rows.filter((item) => item.elapsedMs >= getSlowApiMs()).length,
    failed: rows.filter((item) => item.status >= 400 || item.error).length,
    totalMs: roundMs(totalMs),
    slowest: rows.slice(0, 8)
  };
}

function finishRoute(reason = "idle") {
  if (!isEnabled() || !currentRoute || currentRoute.finished) return;
  const elapsedMs = roundMs(now() - currentRoute.startedAt);
  currentRoute.finished = true;
  currentRoute.finishedAt = now();
  currentRoute.reason = reason;
  currentRoute.elapsedMs = elapsedMs;
  currentRoute.apiSummary = getApiSummary(currentRoute);

  const report = {
    id: currentRoute.id,
    route: currentRoute.fullPath,
    name: currentRoute.name,
    title: currentRoute.title,
    elapsedMs,
    reason,
    bootToRouteStartMs: bootStartedAt() ? roundMs(currentRoute.startedAt - bootStartedAt()) : null,
    bootToRouteReadyMs: bootStartedAt() && currentRoute.routeReadyAt ? roundMs(currentRoute.routeReadyAt - bootStartedAt()) : null,
    routeReadyMs: currentRoute.routeReadyAt ? roundMs(currentRoute.routeReadyAt - currentRoute.startedAt) : null,
    api: currentRoute.apiSummary,
    startedAt: new Date(currentRoute.wallClockStartedAt).toISOString()
  };
  pushLimited(reports, report, MAX_REPORTS);

  const isSlow = elapsedMs >= getSlowRouteMs() || report.api.slow > 0 || report.api.failed > 0;
  const label = `[erp-perf] ${isSlow ? "slow" : "ok"} route ${report.route} ${elapsedMs}ms, api=${report.api.total}, slowApi=${report.api.slow}, failed=${report.api.failed}`;
  const log = isSlow ? console.warn : console.info;
  log(label, report);
  if (report.api.slowest.length) {
    console.table(report.api.slowest.map((item) => ({
      method: item.method,
      url: item.url,
      status: item.status || item.error || "-",
      elapsedMs: item.elapsedMs
    })));
  }
}

function scheduleSummary() {
  if (!isEnabled() || !currentRoute || currentRoute.finished) return;
  window.clearTimeout(summaryTimer);
  const pending = currentRoute.pendingApi;
  const waitMs = pending > 0 ? SUMMARY_WAIT_MS : ROUTE_IDLE_MS;
  summaryTimer = window.setTimeout(() => {
    if (!currentRoute || currentRoute.finished) return;
    if (currentRoute.pendingApi > 0) {
      finishRoute("timeout_pending_api");
      return;
    }
    finishRoute("idle");
  }, waitMs);
}

export function startRoutePerf(to) {
  if (!isEnabled()) return;
  if (currentRoute && !currentRoute.finished) finishRoute("route_changed");
  window.clearTimeout(summaryTimer);
  currentRoute = {
    id: ++routeSequence,
    name: String(to?.name || ""),
    fullPath: String(to?.fullPath || window.location.hash || ""),
    title: String(to?.meta?.title || ""),
    startedAt: now(),
    wallClockStartedAt: Date.now(),
    routeReadyAt: null,
    pendingApi: 0,
    apiRecords: [],
    finished: false
  };
  scheduleSummary();
}

export function markRouteReadyPerf(to) {
  if (!isEnabled() || !currentRoute || currentRoute.finished) return;
  const routePath = String(to?.fullPath || "");
  if (routePath && routePath !== currentRoute.fullPath) return;
  currentRoute.routeReadyAt = now();
  scheduleSummary();
}

export function beginApiPerf(url, options = {}) {
  if (!isEnabled()) return null;
  const trace = {
    id: ++apiSequence,
    routeId: currentRoute?.finished ? null : currentRoute?.id || null,
    route: inferCurrentRoute(),
    method: String(options.method || "GET").toUpperCase(),
    url: normalizeUrl(url),
    startedAt: now()
  };
  if (currentRoute && trace.routeId === currentRoute.id && !currentRoute.finished) {
    currentRoute.pendingApi += 1;
    scheduleSummary();
  }
  return trace;
}

export function endApiPerf(trace, result = {}) {
  if (!isEnabled() || !trace) return;
  const elapsedMs = roundMs(now() - trace.startedAt);
  const record = {
    id: trace.id,
    routeId: trace.routeId,
    route: trace.route,
    method: trace.method,
    url: trace.url,
    status: result.status || 0,
    error: result.error || "",
    elapsedMs,
    endedAt: new Date().toISOString()
  };
  pushLimited(apiRecords, record, MAX_API_RECORDS);
  if (currentRoute && trace.routeId === currentRoute.id && !currentRoute.finished) {
    currentRoute.pendingApi = Math.max(0, currentRoute.pendingApi - 1);
    currentRoute.apiRecords.push(record);
    scheduleSummary();
  }
  if (elapsedMs >= getSlowApiMs() || record.status >= 400 || record.error) {
    console.warn(`[erp-perf] api ${trace.method} ${trace.url} ${elapsedMs}ms status=${record.status || record.error}`);
  }
}

export function getPerfReports() {
  const byRoute = new Map();
  for (const item of apiRecords) {
    const key = item.route || "(unknown)";
    const existing = byRoute.get(key) || {
      route: key,
      total: 0,
      slow: 0,
      failed: 0,
      totalMs: 0,
      slowest: []
    };
    existing.total += 1;
    existing.totalMs = roundMs(existing.totalMs + item.elapsedMs);
    if (item.elapsedMs >= getSlowApiMs()) existing.slow += 1;
    if (item.status >= 400 || item.error) existing.failed += 1;
    existing.slowest.push(item);
    existing.slowest.sort((a, b) => b.elapsedMs - a.elapsedMs);
    existing.slowest = existing.slowest.slice(0, 5);
    byRoute.set(key, existing);
  }
  return {
    currentRoute,
    reports: [...reports],
    apiRecords: [...apiRecords],
    routes: [...byRoute.values()].sort((a, b) => b.totalMs - a.totalMs)
  };
}

if (typeof window !== "undefined") {
  window.__ERP_PERF__ = {
    getReports: getPerfReports,
    finishCurrent: finishRoute,
    enable() {
      writeStorage("erpPerfMonitor", "on");
    },
    disable() {
      writeStorage("erpPerfMonitor", "off");
    }
  };
}
