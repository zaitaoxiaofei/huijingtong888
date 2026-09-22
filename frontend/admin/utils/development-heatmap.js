import { shanghaiDateText } from "./shanghai-date.js";

const key = (parts) => JSON.stringify(parts);
const day = (value) => value ? shanghaiDateText(value, { assumeUtcWhenNaive: true }) : "";
const within = (value, range) => !range?.length || (value && value >= range[0] && value <= range[1]);

// The same draft may be linked from several tasks. Count it once, and do not
// assign conflicting brand/model/category links to an arbitrary coordinate.
export function buildDevelopmentHeatmap(tasks, { metric = "actual", time = "draft", range = [], dimension = "model", scope = "all", query = "" } = {}) {
  const entries = [];
  const assignments = new Map();
  const legacy = [];
  for (const task of tasks) {
    if (task.type !== "product_development") continue;
    let plan = task.development_plan;
    if (!plan) {
      const classified = task.development_brand && task.development_category;
      if (!classified) legacy.push(task);
      plan = { brand: task.development_brand || "未分类", category: task.development_category || "未分类",
        scope: task.development_brand === "非汽车" ? "non_automotive" : classified ? "automotive" : "unknown",
        models: [{ model_id: "unspecified", model: "未指定车型", target: task.idea_id || task.unit === "SKU" ? task.target : 0, drafts: task.development_drafts || [] }] };
    }
    for (const model of plan.models) {
      const modelScope = model.scope || plan.scope;
      const nonAuto = modelScope === "non_automotive";
      const entry = { task, model, category: model.category || plan.category, brand: nonAuto ? "非汽车" : model.brand || plan.brand, scope: modelScope === "unknown" ? "unknown" : nonAuto ? "non_automotive" : "automotive" };
      entry.coordinate = key([entry.scope, entry.brand, model.model_id, entry.category]);
      entries.push(entry);
      for (const draft of model.drafts || []) {
        if (!draft.count) continue;
        if (!assignments.has(draft.id)) assignments.set(draft.id, new Set());
        assignments.get(draft.id).add(entry.coordinate);
      }
    }
  }
  const rows = new Map(); const columns = new Map(); const cells = new Map();
  const countedDrafts = new Set(); const taskIds = new Set(); const conflicts = new Set();
  const keyword = query.trim().toLowerCase();
  const taskDay = (task) => time === "due" ? task.due_at : day(task.development_created_at || task.created_at);
  function add(entry, amount, drafts = []) {
    const label = entry.scope === "unknown" ? "未分类" : dimension === "brand" || entry.scope === "non_automotive" ? entry.brand : `${entry.brand} · ${entry.model.model}`;
    if (scope !== "all" && scope !== entry.scope) return;
    if (keyword && !`${label} ${entry.category}`.toLowerCase().includes(keyword)) return;
    const rowId = key([entry.scope, entry.brand, dimension === "model" ? entry.model.model_id : ""]);
    if (!rows.has(rowId)) rows.set(rowId, { id: rowId, label, total: 0, tasks: new Set() });
    if (!columns.has(entry.category)) columns.set(entry.category, { label: entry.category, total: 0, tasks: new Set() });
    const cellKey = key([rowId, entry.category]);
    if (!cells.has(cellKey)) cells.set(cellKey, { value: 0, tasks: new Map(), drafts: [] });
    const cell = cells.get(cellKey); const row = rows.get(rowId); const col = columns.get(entry.category);
    const freshTask = !cell.tasks.has(entry.task.id);
    const value = metric === "tasks" ? Number(freshTask) : amount;
    cell.value += value; row.total += value; col.total += value;
    cell.tasks.set(entry.task.id, entry.task); cell.drafts.push(...drafts);
    row.tasks.add(entry.task.id); col.tasks.add(entry.task.id); taskIds.add(entry.task.id);
  }
  for (const entry of entries) {
    const inTaskRange = within(taskDay(entry.task), range);
    if (metric !== "actual") {
      if (inTaskRange) add(entry, Number(entry.model.target || 0));
      continue;
    }
    const drafts = []; let hasMatchingDraft = false;
    for (const draft of entry.model.drafts || []) {
      if (!draft.count || !(time === "draft" ? within(day(draft.created_at), range) : inTaskRange)) continue;
      hasMatchingDraft = true;
      if (assignments.get(draft.id)?.size > 1) { conflicts.add(draft.id); continue; }
      const identity = key([entry.coordinate, draft.id]);
      if (countedDrafts.has(identity)) continue;
      countedDrafts.add(identity); drafts.push(draft);
    }
    // Retain zero cells for tasks in the period, so a new plan is still visible.
    if (hasMatchingDraft || inTaskRange) add(entry, drafts.reduce((sum, draft) => sum + Number(draft.count), 0), drafts);
  }
  const unclassified = legacy.filter(task => within(taskDay(task), range));
  if (metric === "tasks") {
    for (const row of rows.values()) row.total = row.tasks.size;
    for (const column of columns.values()) column.total = column.tasks.size;
  }
  const sort = (a, b) => b.total - a.total || b.tasks.size - a.tasks.size || a.label.localeCompare(b.label, "zh-CN", { numeric: true });
  const sortedRows = [...rows.values()].sort(sort); const sortedColumns = [...columns.values()].sort(sort);
  return { rows: sortedRows, columns: sortedColumns, cell: (row, category) => cells.get(key([row.id, category])) || { value: 0, tasks: new Map(), drafts: [] },
    total: metric === "tasks" ? taskIds.size : sortedRows.reduce((sum, row) => sum + row.total, 0), taskCount: taskIds.size,
    max: Math.max(0, ...[...cells.values()].map(cell => cell.value)), unclassified: unclassified.length, conflicts: conflicts.size };
}
