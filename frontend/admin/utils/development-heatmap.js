import { shanghaiDateKey, shanghaiDateText } from "./shanghai-date.js";

const key = (parts) => JSON.stringify(parts);
const day = (value) => value ? shanghaiDateText(value, { assumeUtcWhenNaive: true }) : "";
const within = (value, range) => !range?.length || (value && value >= range[0] && value <= range[1]);
const priorityScore = (value) => ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 })[value] || 7;

export function developmentCoordinateKey(scope, brand, category, modelId = "") {
  return key([scope || "unknown", brand || "", category || "", String(modelId || "")]);
}

export function developmentPlanPeriodKey(period, range = []) {
  if (!range?.length || period === "all") return "";
  const [start, end] = range;
  if (!start || !end) return "";
  const [year, month] = start.split("-").map(Number);
  if (period === "week") return `week:${start}`;
  if (period === "month") return `month:${start.slice(0, 7)}`;
  if (period === "quarter") return `quarter:${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (period === "year") return `year:${year}`;
  return `custom:${start}:${end}`;
}

export function effectiveDevelopmentDueDay(task, now = Date.now()) {
  const due = task?.due_at ? String(task.due_at).slice(0, 10) : "";
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return day(task?.development_created_at || task?.created_at);
  if (["done", "closed", "cancelled"].includes(task.status)) return due;
  const date = new Date(`${due}T21:00:00+08:00`);
  if (Number.isNaN(date.getTime()) || date.getTime() >= now) return due;
  const weeks = Math.floor((now - date.getTime()) / (7 * 86400000)) + 1;
  date.setTime(date.getTime() + weeks * 7 * 86400000);
  return shanghaiDateKey(date);
}

// The same draft may be linked from several tasks. Count it once, and do not
// assign conflicting brand/model/category links to an arbitrary coordinate.
export function buildDevelopmentHeatmap(tasks, { metric = "actual", time = "draft", range = [], dimension = "model", scope = "all", query = "", now = Date.now() } = {}) {
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
  const countedDrafts = new Set(); const taskIds = new Set(); const conflicts = new Set(); const priorityTasks = new Map();
  const keyword = query.trim().toLowerCase();
  const taskDay = (task) => time === "due" ? effectiveDevelopmentDueDay(task, now) : day(task.development_created_at || task.created_at);
  function add(entry, amount, drafts = []) {
    const label = entry.scope === "unknown" ? "未分类" : dimension === "brand" || entry.scope === "non_automotive" ? entry.brand : `${entry.brand} · ${entry.model.model}`;
    if (scope !== "all" && scope !== entry.scope) return;
    if (keyword && !`${label} ${entry.category}`.toLowerCase().includes(keyword)) return;
    const rowId = key([entry.scope, entry.brand, dimension === "model" ? entry.model.model_id : ""]);
    if (!rows.has(rowId)) rows.set(rowId, { id: rowId, label, scope: entry.scope, brand: entry.brand, model_id: dimension === "model" ? String(entry.model.model_id || entry.model.model || "") : "", total: 0, priorityScore: 0, tasks: new Set() });
    if (!columns.has(entry.category)) columns.set(entry.category, { label: entry.category, total: 0, priorityScore: 0, tasks: new Set() });
    const cellKey = key([rowId, entry.category]);
    if (!cells.has(cellKey)) cells.set(cellKey, { value: 0, priorityScore: 0, tasks: new Map(), drafts: [] });
    const cell = cells.get(cellKey); const row = rows.get(rowId); const col = columns.get(entry.category);
    const freshTask = !cell.tasks.has(entry.task.id);
    const value = metric === "tasks" ? Number(freshTask) : amount;
    cell.value += value; row.total += value; col.total += value;
    const score = priorityScore(entry.task.priority);
    cell.priorityScore = Math.max(cell.priorityScore, score); row.priorityScore = Math.max(row.priorityScore, score); col.priorityScore = Math.max(col.priorityScore, score);
    cell.tasks.set(entry.task.id, entry.task); cell.drafts.push(...drafts);
    row.tasks.add(entry.task.id); col.tasks.add(entry.task.id); taskIds.add(entry.task.id);
  }
  for (const entry of entries) {
    const inTaskRange = within(taskDay(entry.task), range);
    if (inTaskRange) priorityTasks.set(entry.task.id, Math.max(priorityTasks.get(entry.task.id) || 0, priorityScore(entry.task.priority)));
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
  const sort = (a, b) => b.priorityScore - a.priorityScore || b.total - a.total || b.tasks.size - a.tasks.size || a.label.localeCompare(b.label, "zh-CN", { numeric: true });
  const sortedRows = [...rows.values()].sort(sort); const sortedColumns = [...columns.values()].sort(sort);
  const quadrantCounts = new Map([[10, 0], [8, 0], [7, 0], [6, 0]]);
  for (const score of priorityTasks.values()) quadrantCounts.set(score >= 10 ? 10 : score >= 8 ? 8 : score >= 7 ? 7 : 6, quadrantCounts.get(score >= 10 ? 10 : score >= 8 ? 8 : score >= 7 ? 7 : 6) + 1);
  return { rows: sortedRows, columns: sortedColumns, cell: (row, category) => cells.get(key([row.id, category])) || { value: 0, tasks: new Map(), drafts: [] },
    total: metric === "tasks" ? taskIds.size : sortedRows.reduce((sum, row) => sum + row.total, 0), taskCount: taskIds.size,
    max: Math.max(0, ...[...cells.values()].map(cell => cell.value)), quadrants: [...quadrantCounts].map(([score, count]) => ({ score, count })), unclassified: unclassified.length, conflicts: conflicts.size };
}
