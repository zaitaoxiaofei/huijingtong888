import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const service = fs.readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");
function harness(idea, affectedRows = 1) {
  const writes = [];
  const context = vm.createContext({
    isMysqlPrimaryEnabled: () => true,
    withMysqlTransaction: async callback => callback({ execute: async (sql,params) => { writes.push({sql,params}); return [{affectedRows}]; } }),
    mysqlQuery: async () => idea ? [idea] : [],
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return { affectedRows }; }
  });
  vm.runInContext(service.replace(/^import .*;\n/gm, "").replaceAll("export async function", "async function")
    + "\nteamTasksSchemaReady = true;", context);
  return { context, writes };
}

test("another person's unassigned inspiration can be claimed before development configuration", async () => {
  const { context, writes } = harness({ status: "idea", created_by_person_id: 9, assignee_person_id: null });
  await context.claimDevelopmentIdeaMysql(12, 7);
  assert.deepEqual(Array.from(writes[0].params), [7, 12, 7]);
  assert.match(writes[0].sql, /WHEN status='idea' THEN 'idea'/);
  assert.match(writes[0].sql, /assignee_person_id IS NULL OR assignee_person_id=\?/);
});

test("assigned owner can claim, but other people and unlinked accounts cannot", async () => {
  const { context, writes } = harness({ status: "assigned", assignee_person_id: 7 });
  await assert.rejects(context.claimDevelopmentIdeaMysql(12, 9), /只有指定负责人/);
  await assert.rejects(context.claimDevelopmentIdeaMysql(12, null), /未关联人员/);
  assert.equal(writes.length, 0);
  await context.claimDevelopmentIdeaMysql(12, 7);
  assert.equal(writes.length, 2);
  assert.match(writes[1].sql, /owner_person_id IS NULL/);
});

test("a competing claim cannot silently overwrite the winner", async () => {
  const { context } = harness({ status: "idea", assignee_person_id: null }, 0);
  await assert.rejects(context.claimDevelopmentIdeaMysql(12, 7), /已被其他人员认领或状态已变化/);
});

test("missing and closed ideas cannot be claimed", async () => {
  for (const idea of [null, { status: "done" }]) {
    const { context, writes } = harness(idea);
    await assert.rejects(context.claimDevelopmentIdeaMysql(12, 7), /不支持认领/);
    assert.equal(writes.length, 0);
  }
});

test("starting development retains an earlier claim and still validates required configuration", async () => {
  const { context, writes } = harness({ assignee_person_id: 7, target_product_count: 2, development_due_at: "2026-10-01", claimed_at: "2026-09-16" });
  await context.startDevelopmentIdeaMysql(12);
  assert.match(writes[0].sql, /WHEN claimed_at IS NOT NULL THEN 'developing' ELSE 'assigned'/);
  const incomplete = harness({ assignee_person_id: 7 });
  await assert.rejects(incomplete.context.startDevelopmentIdeaMysql(12), /产品数量、截止时间/);
  assert.equal(incomplete.writes.length, 0);
});

test("inspiration cards expose claims and sort newest first regardless of urgency", () => {
  const rows = [
    { id: 9, created_at: "2026-09-10T00:00:00Z", urgency: 10 },
    { id: 2, created_at: "2026-09-16T00:00:00Z", urgency: 1 },
    { id: 3, created_at: "2026-09-16T00:00:00Z", urgency: 2 }
  ];
  const expression = view.match(/const sortedIdeas = computed\(([^;]+)\);/)[1];
  const sorted = vm.runInNewContext(`(${expression})()`, { ideas: { value: rows }, matchesDevelopmentScope: () => true });
  assert.deepEqual(Array.from(sorted, row => row.id), [3, 2, 9]);
  assert.match(service, /ORDER BY idea\.created_at DESC, idea\.id DESC/);
  assert.match(view, /v-if="canClaimIdea\(row\)"[^>]+@click="claimIdea\(row\)"/);
  const claimCheck = view.match(/function canClaimIdea\(row\) \{[\s\S]*?\n\}/)[0];
  const canClaim = vm.runInNewContext(`(${claimCheck})`, { authStore: { user: { personId: 7 } } });
  assert.equal(canClaim({ status: "idea", assignee_person_id: null }), true);
  assert.equal(canClaim({ status: "assigned", assignee_person_id: 7 }), true);
  assert.equal(canClaim({ status: "idea", assignee_person_id: 9 }), false);
  assert.equal(canClaim({ status: "idea", assignee_person_id: 7, claimed_at: "2026-09-16" }), false);
});
