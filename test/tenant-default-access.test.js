import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bootstrapDefaultTenantAccessMysql } from "../src/services/tenant-default-access.js";
import { inspectDefaultTenantMemberships, normalizeRepairPersonIds, repairDefaultTenantMemberships } from "../scripts/lib/default-tenant-membership-repair.mjs";

test("historical membership repair requires explicit valid IDs and a reason before querying", async () => {
  assert.deepEqual(normalizeRepairPersonIds("3,4,3"), [3, 4]);
  for (const value of [undefined, "", "3,", "-1", "1.5", "0", "customer", "9007199254740992", Array(201).fill(3)]) {
    assert.throws(() => normalizeRepairPersonIds(value));
  }
  let queries = 0;
  await assert.rejects(repairDefaultTenantMemberships({ execute: async () => { queries++; } }, [3], ""), /review reason/);
  assert.equal(queries, 0);
});

test("startup creates no memberships for business or platform administrators and only binds existing authorized sessions", async () => {
  const writes = [];
  const connection = {
    async execute(sql, params) {
      if (sql.startsWith("SELECT id FROM tenants")) return [[{ id: 1 }]];
      writes.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  };
  await bootstrapDefaultTenantAccessMysql(connection);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes.filter(write => write.sql.startsWith("INSERT")), []);
  const sessionWrite = writes.find(write => write.sql.startsWith("UPDATE sessions"));
  assert.match(sessionWrite.sql, /JOIN tenant_members tm.*tm\.active = 1/);
  assert.match(sessionWrite.sql, /WHERE s\.active_tenant_id IS NULL/);
  assert.deepEqual(sessionWrite.params, [1]);
});

test("startup refuses to infer a default enterprise when it is missing", async () => {
  await assert.rejects(bootstrapDefaultTenantAccessMysql({ execute: async () => [[]] }), /默认企业不存在/);
});

test("tenant schema initializes role storage before transactional legacy session binding", () => {
  const source = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("await ensurePeopleRolesSchemaMysql()") < source.indexOf("await withMysqlTransaction(bootstrapDefaultTenantAccessMysql)"));
  assert.doesNotMatch(source, /CROSS JOIN people/);
});

test("membership repair refuses to apply before explicit platform-grant columns are migrated", async () => {
  const statements = [];
  await assert.rejects(repairDefaultTenantMemberships({ execute: async sql => { statements.push(sql); return [[]]; } }, [3], "Reviewed overlap"), /platform_grants schema/);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /INFORMATION_SCHEMA\.COLUMNS/);
});

test("dry-run protects only explicit active platform grants and performs no schema writes", async () => {
  const statements = [];
  const report = await inspectDefaultTenantMemberships(async sql => {
    statements.push(sql);
    if (sql.includes("INFORMATION_SCHEMA")) return ["person_id", "role", "active"].map(column_name => ({ column_name }));
    if (sql.startsWith("SELECT id FROM tenants")) return [{ id: 1 }];
    assert.match(sql, /pg\.role = 'super_admin' AND pg\.active = 1/);
    return [
      { person_id: 1, default_role: "owner", platform_role: "super_admin", other_tenant_id: 2 },
      { person_id: 3, default_role: "owner", platform_role: null, other_tenant_id: 2, role: "admin" }
    ];
  });
  assert.equal(report.platform_grants_schema_ready, true);
  assert.deepEqual(report.review_candidates.map(row => row.person_id), [3]);
  assert.ok(statements.every(sql => sql.trimStart().startsWith("SELECT")));
});
