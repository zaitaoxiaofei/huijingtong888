export function normalizePrintState(filters = {}) {
  const legacyPrintView = String(filters.printView || "all");
  const printFilter = String(filters.printFilter || "all") !== "all"
    ? String(filters.printFilter)
    : ["printed", "unprinted"].includes(legacyPrintView)
      ? legacyPrintView
      : "all";
  const sortMode = String(filters.sortMode || "ordered") === "inventory" || legacyPrintView === "inventory"
    ? "inventory"
    : "ordered";
  const activePrintViews = [
    ...(sortMode === "inventory" ? ["inventory"] : []),
    ...(printFilter !== "all" ? [printFilter] : [])
  ];
  return { printView: activePrintViews[0] || "all", printFilter, sortMode, activePrintViews };
}

export function togglePrintViewState(filters = {}, view = "all") {
  const current = normalizePrintState(filters);
  if (view === "inventory") {
    return normalizePrintState({
      printFilter: current.printFilter,
      sortMode: current.sortMode === "inventory" ? "ordered" : "inventory"
    });
  }
  if (["printed", "unprinted"].includes(view)) {
    return normalizePrintState({
      printFilter: current.printFilter === view ? "all" : view,
      sortMode: current.sortMode
    });
  }
  return normalizePrintState({ printFilter: "all", sortMode: "ordered" });
}
