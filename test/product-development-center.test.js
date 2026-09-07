import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const serviceSource = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/server/routes/team.js", import.meta.url), "utf8");
const runtimeSource = fs.readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const viewSource = fs.readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");
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

test("product development center covers the inventory-driven management views", () => {
  for (const label of ["任务中心", "灵感列表", "开发产品", "开发总览", "裂变效果", "SKU库存关联"]) {
    assert.match(viewSource, new RegExp(label));
  }
  assert.match(viewSource, /const activeTab = ref\("tasks"\)/);
  assert.match(viewSource, /ProductCreateEditDialog/);
  assert.match(viewSource, /加入现有库存产品/);
  assert.match(viewSource, /创建上架草稿/);
  assert.match(viewSource, /去开发/);
  assert.match(viewSource, /指定人员/);
  assert.match(viewSource, /变体产品进度/);
  assert.match(viewSource, /店铺副本不重复计数/);
  assert.match(viewSource, /订单模块待打通/);
  assert.match(viewSource, /第一阶段 · 任务认领/);
  assert.match(viewSource, /第二阶段 · 产品进度/);
  assert.match(viewSource, /第三阶段 · 草稿箱记录/);
  assert.match(viewSource, /暂无符合条件的开发任务/);
  assert.match(viewSource, /shanghaiDateTimeText/);
  assert.match(viewSource, /handleIdeaImagePaste/);
  assert.match(viewSource, /handleIdeaImageDrop/);
  assert.match(viewSource, /uploadListingMedia/);
  assert.match(viewSource, /编辑灵感/);
  assert.match(viewSource, /displayedProjects/);
  assert.match(viewSource, /产品数量从高到低/);
  assert.match(viewSource, /新增任务/);
  assert.match(viewSource, /deleteTask/);
  assert.match(viewSource, /任务时间轴/);
  assert.match(viewSource, /taskRangeOptions/);
  assert.match(viewSource, /按时完成/);
  assert.match(viewSource, /有风险/);
  assert.match(viewSource, /已超时/);
  assert.match(viewSource, /已关闭/);
  assert.match(viewSource, /timeline-node/);
  assert.match(viewSource, /taskTypeOptions/);
  assert.match(viewSource, /开发产品/);
  assert.match(viewSource, /采购任务/);
  assert.match(viewSource, /每日发货/);
  assert.match(viewSource, /自定义/);
  assert.match(viewSource, /setCustomProgress/);
  assert.match(viewSource, /任务类型/);
  assert.match(viewSource, /计划完成/);
  assert.match(viewSource, /当前进度/);
  assert.match(viewSource, /trigger="hover"/);
  assert.match(viewSource, /:hide-after="650"/);
  assert.match(viewSource, /task-dialog-metrics/);
  assert.match(viewSource, /task-owner-card/);
  assert.match(viewSource, /operational-detail-section/);
  assert.match(viewSource, /具体处理清单/);
  assert.match(viewSource, /发货异常诊断/);
  assert.match(viewSource, /order-alert-image/);
  assert.match(viewSource, /taskOrderTimeText/);
  assert.match(viewSource, /width="1040px"/);
  assert.match(viewSource, /min-height:22px;height:22px/);
  assert.match(viewSource, /min-height:132px/);
  assert.match(viewSource, /onMounted\(loadTaskCenterData\)/);
  assert.match(viewSource, /if \(value !== "tasks"\) loadDevelopmentData\(\)/);
  assert.match(viewSource, /position:absolute;right:0;bottom:0/);
  assert.match(viewSource, /北京时间范围/);
  assert.match(viewSource, /保存负责人/);
  assert.match(viewSource, /listingDraftRows/);
  assert.match(viewSource, /goDashboardTarget/);
  assert.match(viewSource, /bindingRowKey/);
  assert.match(viewSource, /SKU库存关联/);
  assert.match(viewSource, /loadCategories/);
  assert.match(viewSource, /v-if="developmentIdeas\.length" class="development-tasks panel"/);
  assert.match(viewSource, /idea-title-line/);
  assert.match(viewSource, /idea-people-row/);
  assert.match(viewSource, /personAvatar\(row\.assignee_person_id\)/);
  assert.match(viewSource, /personAvatar\(row\.owner_person_id \|\| row\.assignee_person_id\)/);
  assert.match(viewSource, /<el-avatar/);
  assert.match(viewSource, /idea-meta-row/);
  assert.match(viewSource, /ideaDueAtText/);
  assert.match(viewSource, /T21:00:00\+08:00/);
  assert.match(viewSource, /repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(viewSource, /替换图片/);
  assert.doesNotMatch(viewSource, /保存配置/);
});

test("task center reuses automated statistics briefly instead of recalculating on every read", () => {
  assert.match(serviceSource, /OPERATIONAL_TASK_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(serviceSource, /await refreshOperationalTeamTasks\(\)/);
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
  assert.match(serviceSource, /component_supply\.component_local_stock/);
  assert.match(serviceSource, /active_demand\.order_demand_quantity/);
});

test("team tasks can bind a structured project, candidate, deliverable, and reviewer", () => {
  assert.match(taskViewSource, /v-model="taskForm\.project_id"/);
  assert.match(taskViewSource, /v-model="taskForm\.candidate_id"/);
  assert.match(taskViewSource, /v-model="taskForm\.deliverable"/);
  assert.match(taskViewSource, /v-model="taskForm\.reviewer_person_id"/);
});
