import { onBeforeUnmount, onMounted } from "vue";

const excluded = ".el-dialog, .el-drawer, .el-popper, [data-paged-layout='off']";
const marker = "data-erp-paged-layout";

// Keep the scroll boundary at the main table, including pages nested in mode
// switches, cards and tabs. Dialogs and expanded-row tables own their layouts.
export function installPagedWorkspaceLayout(panel) {
  const desktop = window.matchMedia("(min-width: 768px) and (min-height: 500px)");
  let frame = 0, marked = new Map(), disposed = false;
  const visible = element => element.getClientRects().length > 0;
  const eligible = element => visible(element) && !element.closest(excluded) && !element.parentElement?.closest(".el-table");

  function refresh() {
    frame = 0;
    if (disposed) return;
    const next = new Map();
    const mark = (element, name) => {
      next.set(element, name);
    };
    if (desktop.matches) {
      const tables = [...panel.querySelectorAll(".el-table")].filter(eligible);
      for (const pager of panel.querySelectorAll(".el-pagination")) {
        if (!eligible(pager)) continue;
        const footer = pager.closest(".erp-footer-pagination, .table-footer") || pager;
        // The nearest shared container associates each pagination with its list,
        // rather than capturing another tab's table or an inline detail table.
        let common = footer.parentElement, candidates = [];
        while (common && panel.contains(common)) {
          candidates = tables.filter(table => common.contains(table) && !table.contains(footer));
          if (candidates.length) break;
          if (common === panel) break;
          common = common.parentElement;
        }
        const table = candidates.filter(item => item.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
        if (!table) continue;
        mark(table, "table");
        mark(footer, "footer");
        for (let node = table.parentElement; node && panel.contains(node); node = node.parentElement) {
          const style = getComputedStyle(node);
          // Preserve split-pane grids instead of turning their columns into rows.
          const grid = style.display === "grid" && style.gridTemplateColumns.split(" ").length > 1;
          mark(node, grid ? "grid" : "column");
          if (node === panel) break;
        }
      }
    }
    // Custom attributes survive Vue/Element Plus dynamic class updates. Diff
    // markers so unchanged rows do not trigger table relayouts.
    for (const element of marked.keys()) {
      if (!next.has(element)) element.removeAttribute(marker);
    }
    for (const [element, name] of next) {
      if (element.getAttribute(marker) !== name) element.setAttribute(marker, name);
    }
    marked = next;
  }

  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(refresh);
  }
  const observer = new MutationObserver(records => {
    // Ignore cell text, row updates and table-internal measurements. Re-evaluate
    // only when a list mounts/unmounts or a containing tab changes visibility.
    if (records.some(record => {
      if (record.type === "attributes") return !record.target.parentElement?.closest(".el-table") &&
        (record.target.matches(".el-table, .el-pagination") || record.target.querySelector(".el-pagination"));
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        (node.matches(".el-table, .el-pagination") || node.querySelector(".el-table, .el-pagination")));
    })) schedule();
  });
  observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden"] });
  desktop.addEventListener("change", schedule);
  schedule();
  return () => {
    disposed = true;
    observer.disconnect();
    desktop.removeEventListener("change", schedule);
    cancelAnimationFrame(frame);
    for (const element of marked.keys()) element.removeAttribute(marker);
    marked.clear();
  };
}

export function usePagedWorkspaceLayout(panelRef) {
  let stop;
  onMounted(() => { if (panelRef.value) stop = installPagedWorkspaceLayout(panelRef.value); });
  onBeforeUnmount(() => stop?.());
}
