// A draft is explicitly assigned to one model; shop copies are not draft rows.
export function readDevelopmentPlan(value) {
  try {
    const plan = typeof value === "string" ? JSON.parse(value) : value;
    return plan?.kind === "development_matrix" ? plan : null;
  } catch { return null; }
}

export function normalizeDevelopmentPlan(value, body, { allowUnassigned = false } = {}) {
  const plan = readDevelopmentPlan(value);
  if (!plan) return null;
  const fail = (message) => { throw new Error(message); };
  if ((body.type || body.work_type) !== "product_development") fail("车型开发明细只能用于开发产品任务（type），请重新选择开发产品。");
  if (plan.scope && !["automotive", "non_automotive"].includes(plan.scope)) fail("开发范围（scope）无效，请选择汽车或非汽车。");
  const nonAutomotive = plan.scope === "non_automotive";
  const brand = nonAutomotive ? "非汽车" : String(plan.brand || "").trim();
  const category = String(plan.category || "").trim();
  if (!brand || !category) fail("缺少任务品牌或核心品名（brand/category），无法确定开发范围，请返回表格选择交叉格。");
  if (!allowUnassigned && (!Number.isSafeInteger(Number(body.owner_person_id)) || Number(body.owner_person_id) <= 0)) fail("缺少任务负责人（owner_person_id），请在任务配置中选择负责人。");
  const date = String(body.due_at || "");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!(allowUnassigned && !date) && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)) fail("缺少有效的计划完成日期（due_at），请在任务配置中选择日期。");
  if (!Array.isArray(plan.models) || !plan.models.length || plan.models.length > 200) fail("请选择 1–200 个车型（models），才能创建开发任务。");
  const modelIds = new Set(); const draftIds = new Set();
  const models = plan.models.map((row) => {
    if (!row || typeof row !== "object") fail("车型明细（models）无效，请重新选择车型。");
    const rowScope = row.scope || plan.scope || "automotive";
    if (!["automotive", "non_automotive"].includes(rowScope)) fail("开发范围（scope）无效，请重新选择交叉格。");
    const rowNonAuto = rowScope === "non_automotive";
    const rowBrand = rowNonAuto ? "非汽车" : String(row.brand || brand).trim();
    const rowCategory = String(row.category || category).trim();
    const model_id = Number(row.model_id); const coordinate = JSON.stringify([rowBrand, rowCategory, model_id]); const target = Number(row.target);
    if (!Number.isSafeInteger(model_id) || (rowNonAuto ? model_id !== 0 : model_id <= 0) || modelIds.has(coordinate)) fail("车型（model_id）无效或重复，请重新选择车型。");
    modelIds.add(coordinate);
    if (!Number.isSafeInteger(target) || target < 1 || target > 100000) fail(`${row.model || '所选车型'}的目标 SKU 数（target）必须为 1–100000 的整数，请在车型明细中修改。`);
    if (!Array.isArray(row.draft_ids || []) || (row.draft_ids || []).length > 200) fail("每个车型最多关联 200 份草稿，请检查草稿明细。");
    const ids = (row.draft_ids || []).map(Number);
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || draftIds.has(id)) fail("关联草稿（draft_ids）无效或重复，一份草稿只能分配给一个车型，请检查车型明细。");
      draftIds.add(id);
    }
    return { ...(row.brand || row.category || row.scope ? { brand: rowBrand, category: rowCategory, scope: rowScope } : {}), model_id, model: rowNonAuto ? "非汽车" : String(row.model || "").trim(), target, draft_ids: ids };
  });
  const result = { kind: "development_matrix", brand, category, models, notes: String(plan.notes || "").trim().slice(0, 2000) };
  if (plan.source_idea_id) result.source_idea_id = Number(plan.source_idea_id);
  if (plan.group_key) result.group_key = String(plan.group_key);
  if (plan.unallocated_draft_ids?.length) {
    result.unallocated_draft_ids = plan.unallocated_draft_ids.map(Number);
    for (const id of result.unallocated_draft_ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || draftIds.has(id)) fail("待分配成果草稿（unallocated_draft_ids）无效或重复，请在任务详情检查草稿归属。");
      draftIds.add(id);
    }
  }
  if (nonAutomotive) result.scope = "non_automotive";
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 60000) fail("开发任务明细过多，请按品牌和核心品名拆分任务。");
  return result;
}

export function developmentPlanProgress(plan, drafts) {
  const byId = new Map(drafts.filter((row) => row.status !== "deleted").map((row) => [Number(row.id), row]));
  const models = plan.models.map((row) => {
    const linked = row.draft_ids.map((id) => byId.get(id)).filter(Boolean);
    const done = linked.reduce((sum, draft) => sum + Number(draft.sku_count || 0), 0);
    return { ...row, done, drafts: row.draft_ids.map((id) => {
      const draft = byId.get(id);
      return { id, title: draft?.product_name || `草稿 #${id}（已删除或不可用）`, count: Number(draft?.sku_count || 0), created_at: draft?.created_at || "" };
    }) };
  });
  const target = models.reduce((sum, row) => sum + row.target, 0);
  const done = models.reduce((sum, row) => sum + Math.min(row.target, row.done), 0);
  const unallocated_drafts = (plan.unallocated_draft_ids || []).map(id => {
    const draft = byId.get(id);
    return { id, title: draft?.product_name || `草稿 #${id}（已删除或不可用）`, count: Number(draft?.sku_count || 0), created_at: draft?.created_at || "" };
  });
  return { models, unallocated_drafts, target, done, status: models.every((row) => row.done >= row.target) ? "done" : done > 0 ? "doing" : "todo" };
}

export function developmentPlanDeliverable(plan) {
  return `${plan.brand} · ${plan.category}：${plan.models.map((row) => `${row.brand || row.category ? `${row.brand || plan.brand} · ${row.category || plan.category} · ` : ""}${row.model} ${row.target} 个 SKU`).join('；')}。按关联草稿的变体数量计算，每个车型分别达标。${plan.notes ? `补充要求：${plan.notes}` : ''}`;
}
