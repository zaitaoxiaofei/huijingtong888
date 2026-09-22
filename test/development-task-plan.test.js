import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable } from "../src/services/development-task-plan.js";

const body = { title: "TENET 钥匙壳开发", type: "product_development", owner_person_id: 7, due_at: "2026-09-30" };
const plan = () => ({ kind: "development_matrix", brand: "TENET", category: "钥匙壳", models: [
  { model_id: 1, model: "T4", target: 10, draft_ids: [101] },
  { model_id: 2, model: "T7", target: 20, draft_ids: [102] }
], notes: "包含黑色" });

test("development targets round trip without losing per-model goals or accepting client counts", () => {
  const input = plan(); input.models[0].done = 999;
  const normalized = normalizeDevelopmentPlan(JSON.stringify(input), body);
  assert.deepEqual(normalized, plan());
  assert.equal(readDevelopmentPlan("legacy text"), null);
  assert.equal(normalizeDevelopmentPlan("legacy text", body), null);
  assert.match(developmentPlanDeliverable(normalized), /T4 10 个 SKU；T7 20 个 SKU/);
});

test("missing fields, invalid dates, fractional targets, repeated models and repeated drafts are blocked", () => {
  for (const patch of [{ owner_person_id: null }, { due_at: "" }, { due_at: "2026-02-30" }, { type: "custom" }]) {
    assert.throws(() => normalizeDevelopmentPlan(plan(), { ...body, ...patch }));
  }
  for (const target of [0, -1, 1.5, NaN, 100001]) {
    const input = plan(); input.models[0].target = target;
    assert.throws(() => normalizeDevelopmentPlan(input, body), /SKU/);
  }
  const repeated = plan(); repeated.models[1].model_id = 1;
  assert.throws(() => normalizeDevelopmentPlan(repeated, body), /车型/);
  const repeatedDraft = plan(); repeatedDraft.models[1].draft_ids = [101];
  assert.throws(() => normalizeDevelopmentPlan(repeatedDraft, body), /一份草稿只能/);
  assert.throws(() => normalizeDevelopmentPlan({ ...plan(), models: [] }, body), /车型/);
});

test("overproduction in T4 cannot fill the T7 shortfall; removed drafts stop contributing", () => {
  const input = plan();
  const drafts = [{ id: 101, sku_count: 40, product_name: "T4钥匙壳" }, { id: 102, sku_count: 5, product_name: "T7钥匙壳" }];
  let progress = developmentPlanProgress(input, drafts);
  assert.equal(progress.target, 30);
  assert.equal(progress.done, 15);
  assert.equal(progress.status, "doing");
  assert.equal(progress.models[0].done, 40);
  drafts[1].sku_count = 20;
  assert.equal(developmentPlanProgress(input, drafts).status, "done");
  drafts[1].status = "deleted";
  progress = developmentPlanProgress(input, drafts);
  assert.equal(progress.done, 10);
  assert.equal(progress.status, "doing");
  assert.match(progress.models[1].drafts[0].title, /已删除/);
  assert.equal(developmentPlanProgress(input, []).status, "todo");
});

function serviceHarness() {
  const writes = [];
  const state = { stored: [], ideaLinks: [], drafts: [{ id: 101, product_name: "T4", sku_count: 12, created_by_person_id: 7 }, { id: 102, product_name: "T7", sku_count: 5, created_by_person_id: 7 }] };
  const context = vm.createContext({
    Buffer, Date, Set, Map, console,
    isMysqlPrimaryEnabled: () => true,
    readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable,
    aiVehicleCatalog: async () => ({ brands: [{ name: "TENET", models: [{ id: 1, name: "T4" }, { id: 2, name: "T7" }] }] }),
    inventoryProductNamingOptions: async () => ({ rows: [{ value: "钥匙壳" }] }),
    mysqlQuery: async (sql, params = []) => {
      if (sql.includes("FROM product_development_ideas idea LEFT JOIN product_development_idea_drafts")) return state.ideaLinks;
      if (sql.includes("FROM people")) return [{ id: 7 }];
      if (sql.includes("FROM listing_drafts")) return state.drafts.filter((row) => params.includes(row.id));
      if (sql.includes("SELECT id, automation_key FROM team_tasks")) return state.stored;
      if (sql.includes("SELECT related_object FROM team_tasks")) return state.stored;
      if (sql.includes("SELECT t.*")) return state.stored;
      throw new Error(`Unexpected query: ${sql}`);
    },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return { insertId: 55 }; }
  });
  const source = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export async function", "async function");
  vm.runInContext(`${source}\nteamTasksSchemaReady = true; operationalTasksRefreshedAt = Date.now(); syncDevelopmentIdeaTasks = async () => {};`, context);
  return { context, state, writes };
}

test("create endpoint stores complete structured goals in one write and derives trusted progress", async () => {
  const { context, writes } = serviceHarness();
  const result = await context.createTeamTaskMysql({ ...body, related: plan(), done: 999, target: 999, status: "done" }, 7);
  assert.equal(result.id, 55);
  assert.equal(writes.length, 1);
  const params = writes[0].params;
  assert.equal(params[5], "doing");
  assert.equal(params[7], 30);
  assert.equal(params[8], 15);
  assert.deepEqual(JSON.parse(params[12]), plan());
});

test("server validates brand-model membership and draft creator before writing", async () => {
  const { context, state, writes } = serviceHarness();
  const wrongModel = plan(); wrongModel.models[0].model_id = 777;
  await assert.rejects(context.createTeamTaskMysql({ ...body, related: wrongModel }), /不属于所选品牌/);
  state.drafts[0].created_by_person_id = 8;
  await assert.rejects(context.createTeamTaskMysql({ ...body, related: plan() }), /负责人创建/);
  assert.equal(writes.length, 0);
});

test("task read recalculates progress before status filtering and editing preserves the plan", async () => {
  const { context, state, writes } = serviceHarness();
  state.stored = [{ id: 55, work_type: "product_development", title: body.title, related_object: JSON.stringify(plan()), target_count: 30, done_count: 30, status: "done" }];
  const rows = await context.teamTasksMysql({ status: "doing" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].done, 15);
  assert.equal(rows[0].development_plan.models[1].done, 5);
  await assert.rejects(context.updateTeamTaskMysql(55, { ...body, related: "" }), /缺少车型明细/);
  assert.equal(writes.length, 0);
  const edited = plan(); edited.models[1].target = 25;
  await context.updateTeamTaskMysql(55, { ...body, related: edited });
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].params[12]).models[1].target, 25);
});


test("non-car development uses an explicit scope and a single unambiguous target", async () => {
  const input = { ...plan(), scope: "non_automotive", brand: "非汽车", models: [{ model_id: 0, model: "非汽车", target: 8, draft_ids: [101] }] };
  assert.deepEqual(normalizeDevelopmentPlan(input, body), input);
  assert.throws(() => normalizeDevelopmentPlan({ ...input, scope: "anything" }, body), /开发范围/);
  assert.throws(() => normalizeDevelopmentPlan({ ...input, scope: "automotive" }, body), /车型/);
  const { context, writes } = serviceHarness();
  await context.createTeamTaskMysql({ ...body, related: input });
  assert.equal(JSON.parse(writes[0].params[12]).scope, "non_automotive");
});


test("idea heatmap data includes all linked draft counts and the original idea date", async () => {
  const { context, state } = serviceHarness();
  state.stored = [{ id: 56, work_type: "product_development", related_object: JSON.stringify({ kind: "product_development", idea_id: 9, brand: "TENET", category: "钥匙壳" }), created_at: "2026-09-16 00:00:00" }];
  state.ideaLinks = [{ idea_id: 9, draft_id: 101, idea_created_at: "2026-08-01 00:00:00" }, { idea_id: 9, draft_id: 102, idea_created_at: "2026-08-01 00:00:00" }];
  state.drafts[0].created_at = "2026-09-01 00:00:00";
  const [row] = await context.teamTasksMysql({});
  assert.equal(row.development_created_at, "2026-08-01 00:00:00");
  assert.equal(row.development_drafts.length, 2);
  assert.equal(row.development_drafts[0].count, 12);
  assert.equal(row.development_drafts[0].created_at, "2026-09-01 00:00:00");
});
