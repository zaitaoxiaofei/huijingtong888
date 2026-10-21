import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootstrapDefaultTenantAccessMysql } from "../src/services/tenant-default-access.js";
import { normalizeRepairPersonIds, repairDefaultTenantMemberships } from "../scripts/lib/default-tenant-membership-repair.mjs";

test("historical membership repair requires explicit valid IDs and a reason before querying", async () => {
  assert.deepEqual(normalizeRepairPersonIds("3,4,3"), [3, 4]);
  for (const value of [undefined, "", "3,", "-1", "1.5", "0", "customer", "9007199254740992", Array(201).fill(3)]) {
    assert.throws(() => normalizeRepairPersonIds(value));
  }
  let queries = 0;
  await assert.rejects(repairDefaultTenantMemberships({ execute: async () => { queries++; } }, [3], ""), /review reason/);
  assert.equal(queries, 0);
});

test("startup only bootstraps platform administrators, respecting explicit role overrides", async () => {
  const writes = [];
  const connection = {
    async execute(sql, params) {
      if (sql.startsWith("SELECT id FROM tenants")) return [[{ id: 1 }]];
      if (sql.startsWith("SELECT id, role")) return [[
        { id: 10, role: "admin", roles_json: null },
        { id: 20, role: "operations", roles_json: '["operations"]' },
        { id: 30, role: "admin", roles_json: '["packing"]' },
        { id: 40, role: "technical", roles_json: '["technical","admin"]' },
        { id: 50, role: "admin", roles_json: '[]' }
      ]];
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  };
  await bootstrapDefaultTenantAccessMysql(connection);
  assert.deepEqual(writes.filter(write => write.sql.startsWith("INSERT")).map(write => write.params), [[1, 10], [1, 40]]);
  const sessionWrite = writes.find(write => write.sql.startsWith("UPDATE sessions"));
  assert.match(sessionWrite.sql, /JOIN tenant_members tm.*tm\.active = 1/);
  assert.match(sessionWrite.sql, /WHERE s\.active_tenant_id IS NULL/);
  assert.deepEqual(sessionWrite.params, [1]);
});

test("startup refuses to infer a default enterprise when it is missing", async () => {
  await assert.rejects(bootstrapDefaultTenantAccessMysql({ execute: async () => [[]] }), /默认企业不存在/);
});

test("tenant schema initializes role storage before the transactional admin-only bootstrap", () => {
  const source = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("await ensurePeopleRolesSchemaMysql()") < source.indexOf("await withMysqlTransaction(bootstrapDefaultTenantAccessMysql)"));
  assert.doesNotMatch(source, /CROSS JOIN people/);
});
