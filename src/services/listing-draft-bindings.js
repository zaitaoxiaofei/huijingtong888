import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { normalizeVehicleModelKey } from "./product-development-meta.js";
import { readDevelopmentPlan, developmentPlanProgress } from "./development-task-plan.js";
import { assertBusinessTaskPermission, authorizeBusinessTaskSession, businessTaskTenantKey } from "./business-task-tenant.js";
import { ensureVehicleCatalogSchema, vehicleCatalogTenantPredicate } from "./ai-vehicle-catalog.js";

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
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS listing_draft_vehicle_links (
    tenant_id VARCHAR(80) NOT NULL,
    draft_id BIGINT UNSIGNED NOT NULL,
    vehicle_catalog_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, draft_id, vehicle_catalog_id),
    KEY idx_listing_draft_vehicle_links_vehicle (tenant_id, vehicle_catalog_id, draft_id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  schemaReady = true;
}

async function tenantContext(session) {
  const authorized = await authorizeBusinessTaskSession(session);
  assertBusinessTaskPermission(authorized, "operations");
  return { key: businessTaskTenantKey(authorized), id: Number(authorized.tenant.id) };
}

async function tenantId(session) {
  return (await tenantContext(session)).key;
}

function draftIds(body) {
  const raw = body?.draft_ids || body?.draftIds || [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) throw new Error("请选择 1 至 100 条草稿后再绑定。");
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("草稿 ID 无效，请刷新草稿箱后重试。");
  return ids;
}

export async function listingDraftBindingOptions(query = {}, session = null) {
  const { key: tenant, id: enterpriseId } = await tenantContext(session);
  const catalog = vehicleCatalogTenantPredicate(tenant);
  await ensureSchema();
  await ensureVehicleCatalogSchema();
  const [vehicles, tasks] = await Promise.all([
    mysqlQuery(`SELECT id, brand_name, model_name FROM ai_vehicle_catalog WHERE enabled = 1 AND ${catalog.sql} AND model_name <> '' ORDER BY brand_name, model_name`, catalog.params),
    mysqlQuery(`SELECT task.id, task.title, task.status, task.work_type, owner.id AS owner_person_id,
      task.created_by_person_id, task.created_at, task.start_at, task.due_at, task.priority,
      task.target_count, task.done_count, task.related_object, owner.name AS owner_name,
      owner.avatar_url AS owner_avatar_url
      FROM team_tasks task
      LEFT JOIN people owner ON owner.id = task.owner_person_id AND owner.active = 1
        AND EXISTS (SELECT 1 FROM tenant_members owner_member
          WHERE owner_member.tenant_id = ? AND owner_member.person_id = owner.id AND owner_member.active = 1)
      WHERE task.tenant_id = ? AND task.active = 1 ORDER BY task.created_at DESC, task.id DESC`, [enterpriseId, tenant])
  ]);
  await tenantId(session);
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
  const { key: tenant, id: enterpriseId } = await tenantContext(session);
  const catalog = vehicleCatalogTenantPredicate(tenant, "vehicle");
  await ensureSchema();
  await ensureVehicleCatalogSchema();
  const ids = [...new Set(String(query.ids || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (!ids.length) { await tenantId(session); return []; }
  const placeholders = ids.map(() => "?").join(",");
  const [rows, vehicleLinks, taskPlanLinks] = await Promise.all([
    mysqlQuery(`SELECT draft.id AS draft_id,
      CASE WHEN vehicle.brand_name = draft.vehicle_brand AND vehicle.model_name = draft.vehicle_model THEN binding.vehicle_catalog_id ELSE NULL END AS vehicle_catalog_id,
      draft.vehicle_brand AS primary_vehicle_brand, draft.vehicle_model AS primary_vehicle_model,
      task.id AS task_id, task.title AS task_title,
      CASE WHEN JSON_VALID(task.related_object) THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.category')), '') ELSE NULL END AS task_core_name,
      CASE WHEN JSON_VALID(task.related_object) THEN JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.kind')) ELSE NULL END AS task_plan_kind,
      owner.name AS task_owner_name,
      owner.avatar_url AS task_owner_avatar_url, inventory.inventory_category AS draft_core_name,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(NULLIF(shop.name, ''), CONCAT('店铺 ', copy.shop_id)) ORDER BY copy.shop_id SEPARATOR '、')
       FROM listing_shop_copies copy LEFT JOIN shops shop ON shop.id = copy.shop_id AND COALESCE(shop.tenant_id, 'admin') = COALESCE(copy.tenant_id, 'admin')
       WHERE copy.draft_id = draft.id AND COALESCE(copy.tenant_id, 'admin') = COALESCE(draft.tenant_id, 'admin') AND copy.status <> 'deleted') AS shop_names
    FROM listing_drafts draft
    LEFT JOIN listing_draft_bindings binding ON binding.draft_id = draft.id AND binding.tenant_id = COALESCE(draft.tenant_id, 'admin')
    LEFT JOIN ai_vehicle_catalog vehicle ON vehicle.id = binding.vehicle_catalog_id AND vehicle.enabled = 1 AND ${catalog.sql}
    LEFT JOIN team_tasks task ON task.id = binding.task_id AND task.tenant_id COLLATE utf8mb4_unicode_ci = binding.tenant_id AND task.active = 1
    LEFT JOIN people owner ON owner.id = task.owner_person_id AND owner.active = 1
      AND EXISTS (SELECT 1 FROM tenant_members owner_member
        WHERE owner_member.tenant_id = ? AND owner_member.person_id = owner.id AND owner_member.active = 1)
    LEFT JOIN products inventory ON inventory.id = draft.source_product_id AND inventory.active = 1
      AND inventory.tenant_id = CASE WHEN COALESCE(draft.tenant_id, 'admin') = 'admin'
        THEN (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1) ELSE CAST(draft.tenant_id AS UNSIGNED) END
    WHERE COALESCE(draft.tenant_id, 'admin') = ? AND draft.status <> 'deleted' AND draft.id IN (${placeholders})`, [...catalog.params, enterpriseId, tenant, ...ids]),
    mysqlQuery(`SELECT link.draft_id, link.vehicle_catalog_id AS id, vehicle.brand_name, vehicle.model_name
      FROM listing_draft_vehicle_links link
      JOIN ai_vehicle_catalog vehicle ON vehicle.id = link.vehicle_catalog_id AND vehicle.enabled = 1 AND ${catalog.sql}
      WHERE link.tenant_id = ? AND link.draft_id IN (${placeholders})
      ORDER BY link.created_at, link.vehicle_catalog_id`, [...catalog.params, tenant, ...ids]),
    mysqlQuery(`SELECT task.id AS task_id, task.title AS task_title, owner.name AS task_owner_name,
        owner.avatar_url AS task_owner_avatar_url,
        CASE WHEN JSON_VALID(task.related_object) THEN JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.category')) ELSE NULL END AS task_core_name,
        linked.draft_id, task.updated_at AS task_updated_at
      FROM team_tasks task
      JOIN JSON_TABLE(CASE WHEN JSON_VALID(task.related_object) THEN task.related_object ELSE '{}' END,
        '$.models[*].draft_ids[*]' COLUMNS (draft_id BIGINT PATH '$')) linked
      LEFT JOIN people owner ON owner.id = task.owner_person_id AND owner.active = 1
        AND EXISTS (SELECT 1 FROM tenant_members owner_member
          WHERE owner_member.tenant_id = ? AND owner_member.person_id = owner.id AND owner_member.active = 1)
      WHERE task.tenant_id = ? AND task.active = 1 AND task.work_type = 'product_development' AND linked.draft_id IN (${placeholders})
      UNION ALL
      SELECT task.id, task.title, owner.name, owner.avatar_url,
        CASE WHEN JSON_VALID(task.related_object) THEN JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.category')) ELSE NULL END, linked.draft_id, task.updated_at
      FROM team_tasks task
      JOIN JSON_TABLE(CASE WHEN JSON_VALID(task.related_object) THEN task.related_object ELSE '{}' END,
        '$.unallocated_draft_ids[*]' COLUMNS (draft_id BIGINT PATH '$')) linked
      LEFT JOIN people owner ON owner.id = task.owner_person_id AND owner.active = 1
        AND EXISTS (SELECT 1 FROM tenant_members owner_member
          WHERE owner_member.tenant_id = ? AND owner_member.person_id = owner.id AND owner_member.active = 1)
      WHERE task.tenant_id = ? AND task.active = 1 AND task.work_type = 'product_development' AND linked.draft_id IN (${placeholders})
      UNION ALL
      SELECT task.id, task.title, owner.name, owner.avatar_url,
        CASE WHEN JSON_VALID(task.related_object) THEN JSON_UNQUOTE(JSON_EXTRACT(task.related_object, '$.category')) ELSE NULL END, idea_draft.draft_id, task.updated_at
      FROM team_tasks task
      JOIN product_development_idea_drafts idea_draft
        ON idea_draft.tenant_id = task.tenant_id AND idea_draft.idea_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(
          CASE WHEN JSON_VALID(task.related_object) THEN task.related_object ELSE '{}' END, '$.idea_id')) AS UNSIGNED)
      LEFT JOIN people owner ON owner.id = task.owner_person_id AND owner.active = 1
        AND EXISTS (SELECT 1 FROM tenant_members owner_member
          WHERE owner_member.tenant_id = ? AND owner_member.person_id = owner.id AND owner_member.active = 1)
      WHERE task.tenant_id = ? AND task.active = 1 AND task.work_type = 'product_development'
        AND JSON_VALID(task.related_object) AND idea_draft.draft_id IN (${placeholders})`, [enterpriseId, tenant, ...ids, enterpriseId, tenant, ...ids, enterpriseId, tenant, ...ids])
  ]);
  await tenantId(session);
  const vehiclesByDraft = new Map();
  for (const link of vehicleLinks) {
    const draftId = Number(link.draft_id);
    if (!vehiclesByDraft.has(draftId)) vehiclesByDraft.set(draftId, []);
    vehiclesByDraft.get(draftId).push(link);
  }
  const tasksByDraft = new Map();
  for (const link of taskPlanLinks) {
    const draftId = Number(link.draft_id);
    if (!tasksByDraft.has(draftId)) tasksByDraft.set(draftId, []);
    tasksByDraft.get(draftId).push(link);
  }
  for (const links of tasksByDraft.values()) links.sort((a, b) =>
    String(b.task_updated_at || "").localeCompare(String(a.task_updated_at || "")) || Number(b.task_id) - Number(a.task_id));
  return rows.map((row) => {
    const planLinks = tasksByDraft.get(Number(row.draft_id)) || [];
    const planLink = planLinks.find((link) => Number(link.task_id) === Number(row.task_id)) || planLinks[0];
    const task = planLink || (row.task_plan_kind === "development_matrix" ? null : row);
    const vehicle_bindings = vehiclesByDraft.get(Number(row.draft_id)) || [];
    return {
      ...row,
      task_id: task?.task_id || null,
      task_title: task?.task_title || "",
      task_core_name: task?.task_core_name || "",
      task_owner_name: task?.task_owner_name || "",
      task_owner_avatar_url: task?.task_owner_avatar_url || "",
      vehicle_bindings: vehicle_bindings.length ? vehicle_bindings : (row.vehicle_catalog_id ? [{
        id: row.vehicle_catalog_id, brand_name: row.primary_vehicle_brand, model_name: row.primary_vehicle_model
      }] : [])
    };
  });
}

function matchingModelIndex(plan, draft, hints = {}) {
  const candidates = hints.brand && hints.model
    ? [{ brand_name: hints.brand, model_name: hints.model }]
    : [...(draft.vehicle_bindings || []), { brand_name: draft.vehicle_brand, model_name: draft.vehicle_model }];
  return plan.models.findIndex((item) => candidates.some((candidate) =>
    String(item.brand || plan.brand || "").trim().toLocaleLowerCase() === String(candidate.brand_name || "").trim().toLocaleLowerCase()
    && String(item.model || "").trim().toLocaleLowerCase() === String(candidate.model_name || "").trim().toLocaleLowerCase()));
}

async function syncTaskPlan(connection, taskId, ids, drafts, tenant, hints = {}) {
  const [rows] = await connection.execute("SELECT id, related_object FROM team_tasks WHERE id = ? AND tenant_id = ? AND active = 1 FOR UPDATE", [taskId, tenant]);
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
    FROM listing_drafts WHERE COALESCE(tenant_id, 'admin') = ? AND id IN (${allIds.map(() => "?").join(",")})`, [tenant, ...allIds]) : [[]];
  const progress = developmentPlanProgress(plan, linked);
  await connection.execute("UPDATE team_tasks SET related_object = ?, target_count = ?, done_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?",
    [JSON.stringify(plan), progress.target, progress.done, progress.status, taskId, tenant]);
}

export async function bindListingDrafts(body = {}, session = null) {
  const tenant = await tenantId(session);
  const catalog = vehicleCatalogTenantPredicate(tenant);
  await ensureSchema();
  await ensureVehicleCatalogSchema();
  const ids = draftIds(body);
  const mode = String(body.mode || "");
  if (mode !== "vehicle" && mode !== "task") throw new Error("请选择车型或任务绑定方式。");
  let vehicle;
  let vehicles = [];
  let task;
  if (mode === "vehicle") {
    const raw = body.vehicle_ids || body.vehicleIds || [body.vehicle_id || body.vehicleId];
    if (!Array.isArray(raw)) throw new Error("请选择车型目录中的品牌和车型。");
    const vehicleIds = [...new Set(raw.map(Number))];
    if (!vehicleIds.length || vehicleIds.length > 50 || vehicleIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("请选择 1 至 50 个有效车型。");
    }
    const found = await mysqlQuery(`SELECT id, brand_name, model_name FROM ai_vehicle_catalog
      WHERE id IN (${vehicleIds.map(() => "?").join(",")}) AND ${catalog.sql} AND enabled = 1 AND model_name <> ''`, [...vehicleIds, ...catalog.params]);
    if (found.length !== vehicleIds.length) throw new Error("部分车型不存在或已停用，请重新选择。");
    const byId = new Map(found.map((item) => [Number(item.id), item]));
    vehicles = vehicleIds.map((id) => byId.get(id));
    vehicle = vehicles[0];
  } else {
    const taskId = Number(body.task_id || body.taskId);
    if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error("请选择任务系统中的有效任务。");
    [task] = await mysqlQuery("SELECT id, title FROM team_tasks WHERE id = ? AND tenant_id = ? AND active = 1", [taskId, tenant]);
    if (!task) throw new Error("任务不存在或已删除，请重新选择。");
  }
  await withMysqlTransaction(async (connection) => {
    const [owned] = await connection.execute(`SELECT id, vehicle_brand, vehicle_model FROM listing_drafts WHERE id IN (${ids.map(() => "?").join(",")})
      AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted' FOR UPDATE`, [...ids, tenant]);
    if (owned.length !== ids.length) throw new Error("部分草稿不存在或不属于当前企业，请刷新草稿箱后重试。");
    if (mode === "task") {
      const vehicleCatalog = vehicleCatalogTenantPredicate(tenant, "vehicle");
      const [vehicleRows] = await connection.execute(`SELECT link.draft_id, vehicle.brand_name, vehicle.model_name
        FROM listing_draft_vehicle_links link JOIN ai_vehicle_catalog vehicle ON vehicle.id = link.vehicle_catalog_id AND vehicle.enabled = 1 AND ${vehicleCatalog.sql}
        WHERE link.tenant_id = ? AND link.draft_id IN (${ids.map(() => "?").join(",")})`, [...vehicleCatalog.params, tenant, ...ids]);
      for (const draft of owned) draft.vehicle_bindings = vehicleRows.filter((link) => Number(link.draft_id) === Number(draft.id));
      const [previous] = await connection.execute(`SELECT DISTINCT task_id FROM listing_draft_bindings WHERE tenant_id = ?
        AND draft_id IN (${ids.map(() => "?").join(",")}) AND task_id IS NOT NULL`, [tenant, ...ids]);
      for (const row of previous) {
        if (Number(row.task_id) === Number(task.id)) continue;
        const [oldRows] = await connection.execute("SELECT related_object FROM team_tasks WHERE id = ? AND tenant_id = ? AND active = 1 FOR UPDATE", [row.task_id, tenant]);
        const oldPlan = readDevelopmentPlan(oldRows[0]?.related_object);
        if (!oldPlan) continue;
        const selected = new Set(ids);
        oldPlan.models = oldPlan.models.map((model) => ({ ...model, draft_ids: (model.draft_ids || []).filter((id) => !selected.has(Number(id))) }));
        oldPlan.unallocated_draft_ids = (oldPlan.unallocated_draft_ids || []).filter((id) => !selected.has(Number(id)));
        const oldIds = [...new Set([...oldPlan.models.flatMap((model) => model.draft_ids || []), ...oldPlan.unallocated_draft_ids])];
        const [oldDrafts] = oldIds.length ? await connection.execute(`SELECT id, product_name, created_at, status,
          GREATEST(1, COALESCE(CASE WHEN JSON_VALID(template_payload_json) THEN JSON_LENGTH(JSON_EXTRACT(template_payload_json,'$.editable_payload.variants')) END, 1)) AS sku_count
          FROM listing_drafts WHERE COALESCE(tenant_id, 'admin') = ? AND id IN (${oldIds.map(() => "?").join(",")})`, [tenant, ...oldIds]) : [[]];
        const oldProgress = developmentPlanProgress(oldPlan, oldDrafts);
        await connection.execute("UPDATE team_tasks SET related_object = ?, target_count = ?, done_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?",
          [JSON.stringify(oldPlan), oldProgress.target, oldProgress.done, oldProgress.status, row.task_id, tenant]);
      }
      await syncTaskPlan(connection, task.id, ids, owned, tenant, body);
    }
    for (const id of ids) {
      if (mode === "vehicle") {
        await connection.execute(`UPDATE listing_drafts SET vehicle_brand = ?, vehicle_model = ?, vehicle_model_key = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND COALESCE(tenant_id, 'admin') = ?`, [vehicle.brand_name, vehicle.model_name,
          normalizeVehicleModelKey(vehicle.brand_name, vehicle.model_name), id, tenant]);
        await connection.execute(`INSERT INTO listing_draft_bindings (tenant_id, draft_id, vehicle_catalog_id) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE vehicle_catalog_id = VALUES(vehicle_catalog_id), updated_at = CURRENT_TIMESTAMP`, [tenant, id, vehicle.id]);
        await connection.execute("DELETE FROM listing_draft_vehicle_links WHERE tenant_id = ? AND draft_id = ?", [tenant, id]);
        await connection.execute(`INSERT INTO listing_draft_vehicle_links (tenant_id, draft_id, vehicle_catalog_id) VALUES ${vehicles.map(() => "(?, ?, ?)").join(",")}`,
          vehicles.flatMap((item) => [tenant, id, item.id]));
      } else {
        await connection.execute(`INSERT INTO listing_draft_bindings (tenant_id, draft_id, task_id) VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), updated_at = CURRENT_TIMESTAMP`, [tenant, id, task.id]);
        try {
          await connection.execute(`UPDATE listing_variant_lineage SET development_task_id = ?, development_task_title = ?
            WHERE tenant_id = ? AND draft_id = ?`, [Number(task.id), String(task.title || ""), tenant, id]);
        } catch (error) {
          if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
        }
      }
    }
  });
  return { count: ids.length, mode, vehicle: vehicle ? `${vehicle.brand_name} ${vehicle.model_name}` : undefined,
    vehicles: vehicles.map((item) => ({ id: Number(item.id), brand: item.brand_name, model: item.model_name })),
    task: task ? { id: Number(task.id), title: task.title } : undefined };
}
