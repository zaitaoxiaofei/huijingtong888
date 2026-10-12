import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { listingTenantLookup } from "./listing-tenant-scope.js";
import { normalizeVehicleModelKey } from "./product-development-meta.js";

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
    mysqlQuery("SELECT id, title, status FROM team_tasks WHERE active = 1 ORDER BY updated_at DESC, id DESC")
  ]);
  return { vehicles, tasks };
}

export async function listingDraftBindings(query = {}, session = null) {
  await ensureSchema();
  const ids = [...new Set(String(query.ids || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (!ids.length) return [];
  return mysqlQuery(`SELECT binding.draft_id,
      CASE WHEN vehicle.brand_name = draft.vehicle_brand AND vehicle.model_name = draft.vehicle_model THEN binding.vehicle_catalog_id ELSE NULL END AS vehicle_catalog_id,
      binding.task_id, task.title AS task_title
    FROM listing_draft_bindings binding
    JOIN listing_drafts draft ON draft.id = binding.draft_id AND draft.status <> 'deleted' AND COALESCE(draft.tenant_id, 'admin') = binding.tenant_id
    LEFT JOIN ai_vehicle_catalog vehicle ON vehicle.id = binding.vehicle_catalog_id AND vehicle.enabled = 1
    LEFT JOIN team_tasks task ON task.id = binding.task_id AND task.active = 1
    WHERE binding.tenant_id = ? AND binding.draft_id IN (${ids.map(() => "?").join(",")})`, [tenantId(session), ...ids]);
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
    const [owned] = await connection.execute(`SELECT id FROM listing_drafts WHERE id IN (${ids.map(() => "?").join(",")})
      AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted' FOR UPDATE`, [...ids, tenant]);
    if (owned.length !== ids.length) throw new Error("部分草稿不存在或不属于当前企业，请刷新草稿箱后重试。");
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
