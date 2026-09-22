import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable } from "../src/services/development-task-plan.js";

const source = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");
function harness() {
  const writes = [];
  const state = { ideas: [], tasks: [] };
  const context = vm.createContext({
    Buffer, Date, console, isMysqlPrimaryEnabled: () => true,
    readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable,
    aiVehicleCatalog: async () => ({ brands: [{ name: "TENET", models: [] }] }),
    inventoryProductNamingOptions: async () => ({ rows: [{ value: "汽车脚垫" }] }),
    mysqlQuery: async (sql) => {
      if (sql.includes("SELECT idea.*")) return state.ideas;
      if (sql.includes("SELECT t.*")) return state.tasks;
      if (sql.includes("SELECT id, automation_key FROM team_tasks")) return state.tasks;
      if (sql.includes("FROM people")) return [{ id: 7 }];
      if (sql.includes("FROM product_development_idea_drafts") || sql.includes("SELECT link.idea_id")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return { insertId: 12, affectedRows: 1 }; }
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, "").replaceAll("export async function", "async function")
    + "\nteamTasksSchemaReady = true; operationalTasksRefreshedAt = Date.now();", context);
  return { context, state, writes };
}
const idea = { title: "脚垫开发", development_brand: "TENET", development_category: "汽车脚垫", target_product_count: 10 };

test("quick inspiration requires a catalog brand and category but can remain unassigned", async () => {
  const { context, writes } = harness();
  for (const invalid of [{ ...idea, development_brand: "" }, { ...idea, development_category: "" }, { ...idea, development_brand: "UNKNOWN" }, { ...idea, development_category: "UNKNOWN" }]) {
    await assert.rejects(context.createDevelopmentIdeaMysql(invalid, 7), /品牌|类目/);
  }
  assert.equal(writes.length, 0);
  await context.createDevelopmentIdeaMysql(idea, 7);
  assert.equal(writes[0].params[7], null);
  assert.deepEqual(Array.from(writes[0].params.slice(-2)), ["TENET", "汽车脚垫"]);
  assert.equal(vm.runInContext("operationalTasksRefreshedAt", context), 0);
  await context.createDevelopmentIdeaMysql({ ...idea, development_brand: "非汽车" }, 7);
});

test("idea synchronization includes unstarted ideas with one stable automation key", async () => {
  const { context, writes } = harness();
  await context.syncDevelopmentIdeaTasks();
  const sql = writes[0].sql;
  assert.match(sql, /CONCAT\('development_idea:', idea.id\)/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql, /'brand',idea.development_brand,'category',idea.development_category/);
  assert.match(sql, /WHEN idea.status='idea' OR idea.assignee_person_id IS NULL THEN 'todo'/);
  assert.doesNotMatch(sql, /AND idea.target_product_count>0|AND \(\s*idea.development_started_at/);
  assert.match(writes[1].sql, /SET task.active=0 WHERE \(idea.active=0 OR idea.development_matrix_enabled=1\)/);
});

test("task center plans appear once in inspirations and retain their original task for editing", async () => {
  const { context, state, writes } = harness();
  state.ideas = [{ id: 12, title: "灵感", created_at: "2026-09-15", development_brand: "TENET", development_category: "汽车脚垫" }];
  state.tasks = [
    { id: 44, work_type: "product_development", title: "车型计划", created_at: "2026-09-16", owner_person_id: 7,
      related_object: JSON.stringify({ kind: "development_matrix", brand: "TENET", category: "汽车脚垫", models: [{ model_id: 1, model: "T4", target: 10, draft_ids: [] }] }) },
    { id: 45, work_type: "product_development", related_object: JSON.stringify({ kind: "product_development", idea_id: 12, brand: "TENET", category: "汽车脚垫" }) }
  ];
  const rows = await context.developmentIdeasMysql();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "task:44");
  assert.equal(rows[0].task.id, 44);
  assert.equal(rows[0].development_category, "汽车脚垫");
  assert.equal(rows[1].id, 12);
  assert.equal(writes.length, 0);
});

test("editing generated task owner updates the source idea before refreshing task", async () => {
  const { context, state, writes } = harness();
  state.tasks = [{ id: 45, automation_key: "development_idea:12" }];
  await context.updateTeamTaskMysql(45, { title: "脚垫开发", owner_person_id: 7 });
  assert.match(writes[0].sql, /UPDATE product_development_ideas/);
  assert.deepEqual(Array.from(writes[0].params), [7, 7, 12]);
});

test("brand/category filters and matrix counts share the same development scope", () => {
  const scope = view.match(/function matchesDevelopmentScope\(row\) \{[\s\S]*?\n\}/)[0];
  const scopes = view.match(/function developmentScopes\(row\) \{[^\n]+/)[0];
  const matches = vm.runInNewContext(`${scopes}\n(${scope})`, { developmentBrandFilter: { value: "TENET" }, developmentCategoryFilter: { value: "汽车脚垫" } });
  assert.equal(matches(idea), true);
  assert.equal(matches({ ...idea, development_brand: "HAVAL" }), false);
  assert.equal(matches({ ...idea, development_category: "钥匙壳" }), false);
  const dialog = fs.readFileSync(new URL("../frontend/admin/components/team/TaskCreationDialog.vue", import.meta.url), "utf8");
  const expr = dialog.match(/const existingCounts = computed\(([\s\S]*?)\n\}\);/)[1] + "\n}";
  const counts = vm.runInNewContext(`(${expr})()`, { props: { tasks: [idea, { development_plan: { brand: "TENET", category: "汽车脚垫" } }] } });
  assert.equal(counts.get("TENET\n汽车脚垫"), 2);
});

test("one parent inspiration lists its child tasks without duplicate synthetic cards", async () => {
  const { context, state } = harness();
  state.ideas = [{ id: 12, title: "多范围灵感", created_at: "2026-09-15", development_matrix_enabled: 1 }];
  state.tasks = ["汽车脚垫", "钥匙壳"].map((category, index) => ({
    id: 44 + index, work_type: "product_development", title: category, created_at: "2026-09-16", owner_person_id: 7,
    related_object: JSON.stringify({ kind: "development_matrix", source_idea_id: 12, group_key: `group-${index}`, brand: "TENET", category,
      models: [{ brand: "TENET", category, model_id: 1, model: "T4", target: 10, draft_ids: [] }] })
  }));
  const rows = await context.developmentIdeasMysql();
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 12);
  assert.equal(rows[0].development_tasks.length, 2); assert.equal(rows[0].target_product_count, 20);
  assert.deepEqual(Array.from(rows[0].development_tasks, row => row.task_id), [44, 45]);
  assert.equal(rows[0].development_category, "汽车脚垫、钥匙壳");
});

test("merged task filters only match actual brand-category pairs", () => {
  const scopes = view.match(/function developmentScopes\(row\) \{[^\n]+/)[0];
  const matcher = view.match(/function matchesDevelopmentScope\(row\) \{[\s\S]*?\n\}/)[0];
  const brand = { value: "BYD" }; const category = { value: "钥匙壳" };
  const matches = vm.runInNewContext(`${scopes}\n(${matcher})`, { developmentBrandFilter: brand, developmentCategoryFilter: category });
  const row = { development_scopes: [{ brand: "BYD", category: "钥匙壳" }, { brand: "HAVAL", category: "汽车脚垫" }] };
  assert.equal(matches(row), true); category.value = "汽车脚垫";
  assert.equal(matches(row), false); brand.value = "HAVAL";
  assert.equal(matches(row), true);
});
