import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serviceSource = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/server/routes/team.js", import.meta.url), "utf8");
const runtimeSource = fs.readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const viewSource = fs.readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");
const taskCreationDialogSource = fs.readFileSync(new URL("../frontend/admin/components/team/TaskCreationDialog.vue", import.meta.url), "utf8");
const taskViewSource = fs.readFileSync(new URL("../frontend/admin/views/team/TeamPlanView.vue", import.meta.url), "utf8");
const schemaSource = fs.readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const procurementListSource = fs.readFileSync(new URL("../src/services/mysql-procurement-list.js", import.meta.url), "utf8");

test("product development uses structured project, candidate, and task link tables", () => {
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS product_development_projects/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS product_development_candidates/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS product_development_task_links/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS product_development_ideas/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS product_development_idea_drafts/);
  assert.match(serviceSource, /automation_key VARCHAR\(128\)/);
  assert.match(serviceSource, /ensureOperationalTeamTasks/);
  assert.match(serviceSource, /COUNT\(DISTINCT idea_product\.product_id\)/);
  assert.match(serviceSource, /procurement_daily:/);
  assert.match(serviceSource, /shipping_daily:/);
  assert.match(serviceSource, /statistics_date/);
  assert.match(serviceSource, /INTERVAL 1 DAY/);
  assert.match(serviceSource, /SELECT id, automation_key FROM team_tasks/);
  assert.match(serviceSource, /teamTaskOperationalDetailsMysql/);
  assert.match(serviceSource, /stock_ready_unprinted/);
  assert.match(serviceSource, /printed_not_transported/);
  assert.match(serviceSource, /MAX\(source_item\.ozon_image_url\) AS image_url/);
  assert.match(serviceSource, /MAX\(item\.ozon_image_url\) AS image_url/);
  assert.match(serviceSource, /request\.source_order_id IS NOT NULL/);
  assert.match(serviceSource, /'done','purchased','partial_inbound','inbound_done'/);
  assert.match(serviceSource, /LEFT JOIN product_development_task_links link ON link\.task_id = t\.id/);
  assert.match(serviceSource, /await saveTaskLink\(Number\(result\.insertId\), payload\)/);
  assert.match(serviceSource, /await saveTaskLink\(taskId, payload\)/);
});

test("production database initialization creates product development tables", () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS product_development_projects/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS product_development_candidates/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS product_development_task_links/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS product_development_ideas/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS product_development_idea_drafts/);
});

test("product development APIs expose project and candidate CRUD", () => {
  assert.match(routeSource, /GET \/api\/team\/development-projects/);
  assert.match(routeSource, /POST \/api\/team\/development-candidates/);
  assert.match(routeSource, /GET \/api\/team\/development-ideas/);
  assert.match(routeSource, /GET \/api\/team\/development-categories/);
  assert.match(routeSource, /linkDevelopmentIdea/);
  assert.match(routeSource, /linkDevelopmentIdeaDraft/);
  assert.match(routeSource, /updateDevelopmentProject/);
  assert.match(routeSource, /deleteDevelopmentCandidate/);
  assert.match(runtimeSource, /developmentProjects: developmentProjectsMysql/);
  assert.match(runtimeSource, /createDevelopmentCandidate: createDevelopmentCandidateMysql/);
});

test("product development center shows completed-task review and loads ideas without repeating task reads", () => {
  for (const label of ["任务中心", "灵感列表", "开发数据复盘", "开发总览", "裂变效果", "SKU库存关联"]) {
    assert.match(viewSource, new RegExp(label));
  }
  assert.match(viewSource, /const activeTab = ref\("tasks"\)/);
  assert.match(viewSource, /const completedDevelopmentTasks = computed/);
  assert.match(viewSource, /function reviewTaskDraftIds/);
  assert.match(viewSource, /function reviewTaskMetrics/);
  assert.match(viewSource, /function reviewTaskPublishState/);
  assert.match(viewSource, /effective_images\?\.\[0\]/);
  assert.match(viewSource, /label="开发产出"/);
  assert.match(viewSource, /草稿箱/);
  assert.match(viewSource, /草稿商品/);
  assert.match(viewSource, /label="上架情况"/);
  assert.match(viewSource, /创建人：/);
  assert.match(viewSource, /reviewTaskCompletionTime/);
  assert.match(viewSource, /include_tasks=0/);
  assert.match(viewSource, /mergeIdeaRowsWithTasks/);
  assert.match(viewSource, /task-draft-popover/);
  assert.match(viewSource, /max-height:190px/);
  assert.match(viewSource, /padding:0 14px 14px!important/);
  assert.match(viewSource, /class="task-list-dialog"/);
  assert.match(viewSource, /const taskListVisible = ref\(false\)/);
  assert.match(viewSource, /const taskPageSize = ref\(20\)/);
  assert.match(viewSource, /onMounted\(\(\) =>/);
  assert.match(viewSource, /:initial-tasks="tasks" :initial-tasks-loaded="tasksLoaded"/);
});

test("task center reuses automated statistics briefly instead of recalculating on every read", () => {
  assert.match(serviceSource, /OPERATIONAL_TASK_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(serviceSource, /scheduleOperationalTeamTaskRefresh\(\);\s*const where = \["t\.active = 1"\]/);
});

test("development records link to the real inventory product master", () => {
  assert.match(serviceSource, /product_id BIGINT UNSIGNED NULL/);
  assert.match(schemaSource, /KEY idx_dev_candidates_product/);
  assert.match(serviceSource, /LEFT JOIN products product ON product\.id=candidate\.product_id/);
  assert.match(viewSource, /product_id: product\.id/);
  assert.match(viewSource, /path: "\/inventory\/products"/);
  assert.match(viewSource, /path: "\/asset-variant-center"/);
});

test("development ideas require the assigned person to claim before product creation", () => {
  assert.match(serviceSource, /只有指定负责人本人可以认领/);
  assert.match(viewSource, /请由指定负责人先认领任务/);
  assert.match(serviceSource, /product_development_idea_products/);
  assert.match(serviceSource, /product_development_idea_drafts/);
  assert.match(serviceSource, /INSERT IGNORE INTO product_development_idea_products/);
  assert.match(serviceSource, /effective_development_started_at/);
  assert.match(serviceSource, /created_by_person_id,assignee_person_id,target_product_count,development_due_at/);
  assert.match(viewSource, /development_due_at: ideaDueDateValue\(row\.development_due_at\)/);
});

test("daily procurement details use the same live shortage rule as the procurement workspace", () => {
  assert.match(procurementListSource, /export function procurementRealOrderShortageMysql/);
  assert.match(serviceSource, /procurementRealOrderShortageMysql\(item\) > 0/);
  assert.match(serviceSource, /UPDATE team_tasks SET done_count=\?,status=\?,completed_at=CASE WHEN \?='done' THEN COALESCE\(completed_at,CURRENT_TIMESTAMP\) ELSE NULL END,updated_at=CURRENT_TIMESTAMP/);
  assert.match(serviceSource, /progress: \{ done, status \}/);
  assert.match(viewSource, /if \(details\.progress\) \{ Object\.assign\(row, details\.progress\)/);
  assert.match(serviceSource, /component_supply\.component_local_stock/);
  assert.match(serviceSource, /active_demand\.order_demand_quantity/);
});

test("team tasks can bind a structured project, candidate, deliverable, and reviewer", () => {
  assert.match(taskViewSource, /v-model="taskForm\.project_id"/);
  assert.match(taskViewSource, /v-model="taskForm\.candidate_id"/);
  assert.match(taskViewSource, /v-model="taskForm\.deliverable"/);
  assert.match(taskViewSource, /v-model="taskForm\.reviewer_person_id"/);
});

test("legacy development tasks remain editable and configuration loading cannot hang forever", () => {
  assert.match(serviceSource, /allowedLegacyCategoryKeys/);
  assert.match(serviceSource, /legacyCategoryAllowed/);
  assert.match(taskCreationDialogSource, /车型或核心品名目录加载超时，请检查网络后重试。/);
  assert.match(taskCreationDialogSource, /if \(loadError\.value\) return;/);
  assert.match(taskCreationDialogSource, /重新加载/);
});

test("pending development tasks open the draft creator instead of the SKU detail dialog", () => {
  assert.match(viewSource, /if \(row\.status === "todo"\) return createTaskDraft/);
  assert.match(viewSource, /path: "\/listing-automation"/);
  assert.match(viewSource, /quickCreate: "1"/);
  assert.match(viewSource, /关联已有草稿/);
  assert.doesNotMatch(viewSource, />编辑 SKU 配置</);
});
