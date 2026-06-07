function cleanRouteQuery(query = {}) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function replaceRouteQueryIfChanged(route, router, nextQuery, isSyncingRoute = () => false) {
  if (isSyncingRoute()) return false;
  const normalizedNext = cleanRouteQuery(nextQuery);
  const normalizedCurrent = cleanRouteQuery(route.query || {});
  if (JSON.stringify(normalizedCurrent) === JSON.stringify(normalizedNext)) return false;
  router.replace({ query: normalizedNext });
  return true;
}

function buildDefaultRouteQuery(route, filters, defaults = {}, omittedKeys = []) {
  const omitted = new Set(omittedKeys);
  const next = { ...route.query };
  Object.keys(defaults).forEach((key) => {
    if (omitted.has(key)) {
      next[key] = undefined;
      return;
    }
    const value = filters[key];
    const fallback = defaults[key];
    if (key === "page" || key === "pageSize") {
      next[key] = Number(value) !== Number(fallback) ? String(value) : undefined;
      return;
    }
    next[key] = String(value || "") !== String(fallback || "") ? String(value || "") : undefined;
  });
  return cleanRouteQuery(next);
}

export function createDefaultRouteQuerySync({
  route,
  router,
  filters,
  defaults = {},
  manualKeys = [],
  isSyncingRoute = () => false
}) {
  return function syncRouteQuery(mode = "auto") {
    const omittedKeys = mode === "manual" ? [] : manualKeys;
    const next = buildDefaultRouteQuery(route, filters, defaults, omittedKeys);
    return replaceRouteQueryIfChanged(route, router, next, isSyncingRoute);
  };
}

export function createRouteQuerySync({
  route,
  router,
  buildQuery,
  isSyncingRoute = () => false
}) {
  return function syncRouteQuery(mode = "auto") {
    const next = buildQuery(mode);
    return replaceRouteQueryIfChanged(route, router, next, isSyncingRoute);
  };
}
