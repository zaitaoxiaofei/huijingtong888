import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { listingTenantLookup } from "./listing-tenant-scope.js";
import { normalizeVehicleModelKey } from "./product-development-meta.js";
import { readDevelopmentPlan, developmentPlanProgress } from "./development-task-plan.js";

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS listing_draft_bindings (
    tenant_id VARCHAR(80) NOT NULL,
    draft_id BIGINT UNSIGNED NOT NULL,
    vehicle_catalog_id BIGINT UNSIGNED NULL,
    task_id BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, draft_id),
    KEY idx_listing_draft_bindings_task (task_id),
    KEY idx_listing_draft_bindings_vehicle (vehicle_catalog_id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  schemaReady = true;
}

function tenantId(session) {
  const tenant = session?.tenant;
  if (tenant && (!tenant.id || !tenant.slug)) throw new Error("当前会话缺少有效企业上下文，无法绑定草稿。");
  return listingTenantLookup(!tenant || tenant.slug === "default" ? "admin" : tenant.id).key;
}

function draftIds(body) {
  const raw = body?.draft_ids || body?.draftIds || [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new Error("请选择 1 至 100 条草稿后再绑定。");
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("草稿 ID 无效，请刷新草稿箱后重试。");
  return ids;
}

export async function listingDraftBindingOptions() {
  await ensureSchema();
  const [vehicles, tasks] = await Promise.all([
    mysqlQuery("SELECT id, brand_name, model_name FROM ai_vehicle_catalog WHERE enabled = 1 AND model_name <> '' ORDER BY brand_name, model_name"),
    mysqlQuery(`SELECT task.id, task.title, task.status, task.work_type, task.owner_person_id,
      task.created_by_person_id, task.created_at, task.start_at, task.due_at, task.priority,
      task.target_count, task.done_count, task.related_object, owner.name AS owner_name,
      owner.avatar_url AS owner_avatar_url
      FROM team_tasks task
      LEFT JOIN people owner ON owner.id = task.owner_person_id
      WHERE task.active = 1 ORDER BY task.created_at DESC, task.id DESC`)
  ]);
  return { vehicles, tasks: tasks.map((task) => {
    const plan = readDevelopmentPlan(task.related_object);
    let related;
    try { related = JSON.parse(task.related_object || "{}"); } catch { related = {}; }
    return {
      ...task,
      related_object: undefined,
      core_name: plan?.category || related?.category || "",
      brand: plan?.brand || related?.brand || "",
      models: plan?.models?.map((model) => ({ id: model.model_id, name: model.model,
        brand: model.brand || plan.brand, category: model.category || plan.category })) || []
    };
  }) };
}

export async function listingDraftBindings(query = {}, session = null) {
  await ensureSchema();
  const ids = [...new Set(String(query.ids || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (!ids.length) return [];
  return mysqlQuery(`SELECT draft.id AS draft_id,
      CASE WHEN vehicle.brand_name = draft.vehicle_brand AND vehicle.model_name = draft.vehicle_model THEN binding.vehicle_catalog_id ELSE NULL END AS vehicle_catalog_id,
      task.id AS task_id, task.title AS task_title,
      CASE WHEN JSON_VALID(task.related_object) THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.category')), '') ELSE NULL END AS task_core_name,
      owner.name AS task_owner_name,
      owner.avatar_url AS task_owner_avatar_url, inventory.inventory_category AS draft_core_name,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(NULLIF(shop.name, ''), CONCAT('店铺 ', copy.shop_id)) ORDER BY copy.shop_id SEPARATOR '、')
       FROM listing_shop_copies copy LEFT JOIN shops shop ON shop.id = copy.shop_id AND COALESCE(shop.tenant_id, 'admin') = COALESCE(copy.tenant_id, 'admin')
       WHERE copy.draft_id = draft.id AND COALESCE(copy.tenant_id, 'admin') = COALESCE(draft.tenant_id, 'admin') AND copy.status <> 'deleted') AS shop_names
    FROM listing_drafts draft
    LEFT JOIN listing_draft_bindings binding ON binding.draft_id = draft.id AND binding.tenant_id = COALESCE(draft.tenant_id, 'admin')
    LEFT JOIN ai_vehicle_catalog vehicle ON vehicle.id = binding.vehicle_catalog_id AND vehicle.enabled = 1
    LEFT JOIN team_tasks task ON task.id = binding.task_id AND task.active = 1
    LEFT JOIN people owner ON owner.id = task.owner_person_id
    LEFT JOIN products inventory ON inventory.id = draft.source_product_id AND inventory.active = 1
      AND inventory.tenant_id = CASE WHEN COALESCE(draft.tenant_id, 'admin') = 'admin'
        THEN (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1) ELSE CAST(draft.tenant_id AS UNSIGNED) END
    WHERE COALESCE(draft.tenant_id, 'admin') = ? AND draft.status <> 'deleted' AND draft.id IN (${ids.map(() => "?").join(",")})`, [tenantId(session), ...ids]);
}

function matchingModelIndex(plan, draft, hints = {}) {
  const brand = String(hints.brand || draft.vehicle_brand || "").trim().toLocaleLowerCase();
  const model = String(hints.model || draft.vehicle_model || "").trim().toLocaleLowerCase();
  if (!brand || !model) return -1;
  return plan.models.findIndex((item) => String(item.brand || plan.brand || "").trim().toLocaleLowerCase() === brand
    && String(item.model || "").trim().toLocaleLowerCase() === model);
}

async function syncTaskPlan(connection, taskId, ids, drafts, hints = {}) {
  const [rows] = await connection.execute("SELECT id, related_object FROM team_tasks WHERE id = ? AND active = 1 FOR UPDATE", [taskId]);
  const plan = readDevelopmentPlan(rows[0]?.related_object);
  if (!plan) return;
  const targetIds = new Set(ids);
  plan.models = plan.models.map((model) => ({ ...model, draft_ids: (model.draft_ids || []).filter((id) => !targetIds.has(Number(id))) }));
  plan.unallocated_draft_ids = (plan.unallocated_draft_ids || []).filter((id) => !targetIds.has(Number(id)));
  for (const draft of drafts) {
    const index = matchingModelIndex(plan, draft, hints);
    if (index >= 0) plan.models[index].draft_ids.push(Number(draft.id));
    else plan.unallocated_draft_ids.push(Number(draft.id));
  }
  if (plan.models.some((model) => model.draft_ids.length > 200) || plan.unallocated_draft_ids.length > 200) throw new Error("任务或车型已关联 200 份草稿，请先在任务系统整理草稿。");
  const allIds = [...new Set([...plan.models.flatMap((model) => model.draft_ids || []), ...plan.unallocated_draft_ids])];
  const [linked] = allIds.length ? await connection.execute(`SELECT id, product_name, created_at, status,
    GREATEST(1, COALESCE(CASE WHEN JSON_VALID(template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(template_payload_json,'$.editable_payload.variants')) END, 1)) AS sku_count
    FROM listing_drafts WHERE id IN (${allIds.map(() => "?").join(",")})`, allIds) : [[]];
  const progress = developmentPlanProgress(plan, linked);
  await connection.execute("UPDATE team_tasks SET related_object = ?, target_count = ?, done_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [JSON.stringify(plan), progress.target, progress.done, progress.status, taskId]);
}

export async function bindListingDrafts(body = {}, session = null) {
  await ensureSchema();
  const ids = draftIds(body);
  const tenant = tenantId(session);
  const mode = String(body.mode || "");
  if (mode !== "vehicle" && mode !== "task") throw new Error("请选择车型或任务绑定方式。");
  let vehicle;
  let task;
  if (mode === "vehicle") {
    const vehicleId = Number(body.vehicle_id || body.vehicleId);
    if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0) throw new Error("请选择车型目录中的品牌和车型。");
    [vehicle] = await mysqlQuery("SELECT id, brand_name, model_name FROM ai_vehicle_catalog WHERE id = ? AND enabled = 1 AND model_name <> ''", [vehicleId]);
    if (!vehicle) throw new Error("车型不存在或已停用，请重新选择。");
  } else {
    const taskId = Number(body.task_id || body.taskId);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("请选择任务系统中的有效任务。");
    [task] = await mysqlQuery("SELECT id, title FROM team_tasks WHERE id = ? AND active = 1", [taskId]);
    if (!task) throw new Error("任务不存在或已删除，请重新选择。");
  }
  await withMysqlTransaction(async (connection) => {
    const [owned] = await connection.execute(`SELECT id, vehicle_brand, vehicle_model FROM listing_drafts WHERE id IN (${ids.map(() => "?").join(",")})
      AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted' FOR UPDATE`, [...ids, tenant]);
    if (owned.length !== ids.length) throw new Error("部分草稿不存在或不属于当前企业，请刷新草稿箱后重试。");
    if (mode === "task") {
      const [previous] = await connection.execute(`SELECT DISTINCT task_id FROM listing_draft_bindings WHERE tenant_id = ?
        AND draft_id IN (${ids.map(() => "?").join(",")}) AND task_id IS NOT NULL`, [tenant, ...ids]);
      for (const row of previous) {
        if (Number(row.task_id) === Number(task.id)) continue;
        const [oldRows] = await connection.execute("SELECT related_object FROM team_tasks WHERE id = ? AND active = 1 FOR UPDATE", [row.task_id]);
        const oldPlan = readDevelopmentPlan(oldRows[0]?.related_object);
        if (!oldPlan) continue;
        const selected = new Set(ids);
        oldPlan.models = oldPlan.models.map((model) => ({ ...model, draft_ids: (model.draft_ids || []).filter((id) => !selected.has(Number(id))) }));
        oldPlan.unallocated_draft_ids = (oldPlan.unallocated_draft_ids || []).filter((id) => !selected.has(Number(id)));
        const oldIds = [...new Set([...oldPlan.models.flatMap((model) => model.draft_ids || []), ...oldPlan.unallocated_draft_ids])];
        const [oldDrafts] = oldIds.length ? await connection.execute(`SELECT id, product_name, created_at, status,
          GREATEST(1, COALESCE(CASE WHEN JSON_VALID(template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(template_payload_json,'$.editable_payload.variants')) END, 1)) AS sku_count
          FROM listing_drafts WHERE id IN (${oldIds.map(() => "?").join(",")})`, oldIds) : [[]];
        const oldProgress = developmentPlanProgress(oldPlan, oldDrafts);
        await connection.execute("UPDATE team_tasks SET related_object = ?, target_count = ?, done_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [JSON.stringify(oldPlan), oldProgress.target, oldProgress.done, oldProgress.status, row.task_id]);
      }
      await syncTaskPlan(connection, task.id, ids, owned, body);
    }
    for (const id of ids) {
      if (mode === "vehicle") {
        await connection.execute(`UPDATE listing_drafts SET vehicle_brand = ?, vehicle_model = ?, vehicle_model_key = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND COALESCE(tenant_id, 'admin') = ?`, [vehicle.brand_name, vehicle.model_name,
          normalizeVehicleModelKey(vehicle.brand_name, vehicle.model_name), id, tenant]);
        await connection.execute(`INSERT INTO listing_draft_bindings (tenant_id, draft_id, vehicle_catalog_id) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE vehicle_catalog_id = VALUES(vehicle_catalog_id), updated_at = CURRENT_TIMESTAMP`, [tenant, id, vehicle.id]);
      } else {
        await connection.execute(`INSERT INTO listing_draft_bindings (tenant_id, draft_id, task_id) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), updated_at = CURRENT_TIMESTAMP`, [tenant, id, task.id]);
      }
    }
  });
  return { count: ids.length, mode, vehicle: vehicle ? `${vehicle.brand_name} ${vehicle.model_name}` : undefined,
    task: task ? { id: Number(task.id), title: task.title } : undefined };
}
