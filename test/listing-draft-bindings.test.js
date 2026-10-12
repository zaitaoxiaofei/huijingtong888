import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/services/listing-draft-bindings.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("export async function", "async function");

function service(ownedIds = [11, 12], taskPlan = null) {
  const writes = [];
  const connection = {
    async execute(sql, params) {
      if (sql.includes("FROM listing_drafts") && sql.includes("FOR UPDATE")) return [ownedIds.map((id) => ({ id, vehicle_brand: "TENET", vehicle_model: "T7" }))];
      if (sql.includes("FROM listing_draft_bindings")) return [[]];
      if (sql.includes("FROM team_tasks") && sql.includes("FOR UPDATE")) return [[{ id: 9, related_object: taskPlan ? JSON.stringify(taskPlan) : null }]];
      if (sql.includes("FROM listing_drafts")) return [[{ id: 11, status: "editing", sku_count: 1 }]];
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  };
  const factory = new Function("mysqlExecute", "mysqlQuery", "withMysqlTransaction", "listingTenantLookup", "normalizeVehicleModelKey", "readDevelopmentPlan", "developmentPlanProgress",
    `${source}\nreturn { bindListingDrafts, listingDraftBindingOptions };`);
  const api = factory(async () => ({}), async (sql) => {
    if (sql.includes("ai_vehicle_catalog")) return [{ id: 7, brand_name: "TENET", model_name: "T7" }];
    if (sql.includes("team_tasks")) return [{ id: 9, title: "新品任务", status: "doing", owner_person_id: 12, created_by_person_id: 14, owner_name: "小李" }];
    return [];
  }, async (callback) => callback(connection), (value) => ({ key: String(value) }), (brand, model) => `${brand}-${model}`,
  (value) => { try { const plan = typeof value === "string" ? JSON.parse(value) : value; return plan?.kind === "development_matrix" ? plan : null; } catch { return null; } },
  (plan) => ({ target: 1, done: plan.models[0].draft_ids.length, status: "doing" }));
  return { ...api, writes };
}

test("batch vehicle binding updates metadata and catalog links for every owned draft", async () => {
  const { bindListingDrafts, writes } = service();
  const result = await bindListingDrafts({ mode: "vehicle", draft_ids: [11, 12], vehicle_id: 7 });
  assert.equal(result.count, 2);
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.filter(({ sql }) => sql.includes("UPDATE listing_drafts")).map(({ params }) => params.slice(0, 3)),
    [["TENET", "T7", "TENET-T7"], ["TENET", "T7", "TENET-T7"]]);
});

test("binding rejects a batch containing an inaccessible draft before writing", async () => {
  const { bindListingDrafts, writes } = service([11]);
  await assert.rejects(bindListingDrafts({ mode: "task", draft_ids: [11, 12], task_id: 9 }), /不属于当前企业/);
  assert.equal(writes.length, 0);
});

test("task binding stores the selected task without changing vehicle metadata", async () => {
  const { bindListingDrafts, writes } = service([11]);
  const result = await bindListingDrafts({ mode: "task", draft_ids: [11], task_id: 9 });
  assert.deepEqual(result.task, { id: 9, title: "新品任务" });
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO listing_draft_bindings/);
  assert.deepEqual(writes[0].params, ["admin", 11, 9]);
});

test("task choices expose ownership and status for the default personal task list", async () => {
  const { listingDraftBindingOptions } = service();
  const { tasks } = await listingDraftBindingOptions();
  assert.equal(tasks[0].owner_person_id, 12);
  assert.equal(tasks[0].status, "doing");
  assert.equal(tasks[0].core_name, "");
});

test("task binding assigns a matching draft to the task model", async () => {
  const plan = { kind: "development_matrix", brand: "TENET", category: "钥匙壳", models: [
    { brand: "TENET", category: "钥匙壳", model_id: 7, model: "T7", target: 1, draft_ids: [] }
  ] };
  const { bindListingDrafts, writes } = service([11], plan);
  await bindListingDrafts({ mode: "task", draft_ids: [11], task_id: 9 });
  const update = writes.find(({ sql }) => sql.includes("UPDATE team_tasks"));
  assert.deepEqual(JSON.parse(update.params[0]).models[0].draft_ids, [11]);
  assert.deepEqual(writes.at(-1).params, ["admin", 11, 9]);
});

test("task binding places a draft without a matching model under the parent task", async () => {
  const plan = { kind: "development_matrix", brand: "TENET", category: "钥匙壳", models: [
    { brand: "TENET", category: "钥匙壳", model_id: 8, model: "T8", target: 1, draft_ids: [] }
  ] };
  const { bindListingDrafts, writes } = service([11], plan);
  await bindListingDrafts({ mode: "task", draft_ids: [11], task_id: 9 });
  const update = writes.find(({ sql }) => sql.includes("UPDATE team_tasks"));
  assert.deepEqual(JSON.parse(update.params[0]).unallocated_draft_ids, [11]);
  assert.deepEqual(JSON.parse(update.params[0]).models[0].draft_ids, []);
});
