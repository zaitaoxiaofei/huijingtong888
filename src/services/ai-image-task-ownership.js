import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { authorizeBusinessTaskSession, businessTaskTenantKey } from "./business-task-tenant.js";
import { currentAiTenantSession } from "./ai-tenant-context.js";
import { AI_IMAGE_TASK_OWNERS_SCHEMA } from "./ai-tenant-schema.js";
let schema;
async function ensureSchema() {
  if (!schema) schema = mysqlExecute(AI_IMAGE_TASK_OWNERS_SCHEMA).catch(error => { schema = null; throw error; });
  await schema;
}
export async function registerAiImageTaskOwner(taskId, session = currentAiTenantSession()) {
  const current = await authorizeBusinessTaskSession(session);
  await ensureSchema();
  await mysqlExecute("INSERT INTO ai_image_task_owners (task_id, tenant_id, created_by_person_id) VALUES (?, ?, ?)",
    [taskId, businessTaskTenantKey(current), current.personId]);
}
export async function assertAiImageTaskOwner(taskId, session = currentAiTenantSession()) {
  const current = await authorizeBusinessTaskSession(session);
  await ensureSchema();
  const rows = await mysqlQuery("SELECT tenant_id FROM ai_image_task_owners WHERE task_id = ? LIMIT 1", [taskId]);
  const key = businessTaskTenantKey(current);
  // Files generated before enterprise support belong to the historical default
  // workspace. Every new generation registers its owner before writing bytes.
  if ((!rows.length && key === "admin") || rows[0]?.tenant_id === key) return current;
  throw Object.assign(new Error("AI 素材不存在或不属于当前企业"), { status: 404, statusCode: 404 });
}
