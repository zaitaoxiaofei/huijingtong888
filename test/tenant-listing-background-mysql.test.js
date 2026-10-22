import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import mysql from "mysql2/promise";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission, businessTaskTenantKey, restoreBusinessTaskSession } from "../src/services/business-task-tenant.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const session = (id, personId = 7) => ({ personId, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}` } });

test("persisted listing draft tasks enforce A/B/default and current member authority in MySQL", {
  skip: !socketPath && "Requires the isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_listing_jobs_test_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath, user: "root" });
  const query = async (sql, params = []) => (await connection.execute(sql, params))[0];
  let created = false;
  try {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await connection.changeUser({ database });
    for (const sql of [
      "CREATE TABLE tenants (id BIGINT PRIMARY KEY, slug VARCHAR(80), status VARCHAR(32) DEFAULT 'active', subscription_status VARCHAR(32) DEFAULT 'active', subscription_expires_at DATETIME NULL)",
      "CREATE TABLE people (id BIGINT PRIMARY KEY, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'operations', roles_json JSON NULL)",
      "CREATE TABLE tenant_members (tenant_id BIGINT, person_id BIGINT, active TINYINT DEFAULT 1, role VARCHAR(32) DEFAULT 'member', business_roles_json JSON NULL, PRIMARY KEY(tenant_id, person_id))",
      "CREATE TABLE draft_evidence (id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id BIGINT, person_id BIGINT)"
    ]) await connection.execute(sql);
    await query("INSERT INTO tenants (id, slug) VALUES (1, 'default'), (2, 'enterprise-2'), (3, 'enterprise-3')");
    await query("INSERT INTO people (id) VALUES (7), (8)");
    await query("INSERT INTO tenant_members (tenant_id, person_id, business_roles_json) VALUES (1, 7, JSON_ARRAY('operations')), (2, 7, JSON_ARRAY('operations')), (3, 7, JSON_ARRAY('operations'))");
    const context = vm.createContext({
      console, process, Number, String, Object, Array, Map, Set, JSON, Date, randomUUID,
      setTimeout: () => ({ unref() {} }),
      mysqlQuery: query, mysqlExecute: query,
      getMysqlPoolMetrics: () => ({ activeConnections: 0, connectionLimit: 10 }),
      executeMysqlStatementWithRetry: async (_connection, sql, params) => query(sql, params),
      withMysqlTransaction: async action => {
        await connection.beginTransaction();
        try { const result = await action(connection); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
      },
      businessTaskTenantKey, assertBusinessTaskPermission,
      withAiTenantSession: async (_session, action) => action(),
      authorizeBusinessTaskSession: value => authorizeBusinessTaskSession(value, query),
      restoreBusinessTaskSession: (tenant, person) => restoreBusinessTaskSession(tenant, person, query),
      generateListingOfferId: async () => ({ offerId: "retry-safe" }),
      createAiVariantListingDraftLightweight: async (_payload, current) => {
        const result = await query("INSERT INTO draft_evidence (tenant_id, person_id) VALUES (?, ?)", [current.tenant.id, current.personId]);
        return { id: result.insertId, shop_copy_count: 0 };
      }
    });
    const source = readFileSync(new URL("../src/services/ai-variant-draft-save-batches.js", import.meta.url), "utf8")
      .replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
    vm.runInContext(source, context);
    const batches = [];
    for (const id of [1, 2, 3]) batches.push(await context.createAiVariantDraftSaveBatch({ tenant_id: "other", items: [{ title: `tenant-${id}` }] }, session(id)));

    await t.test("same person in A/B/default cannot read or retry another enterprise's batch", async () => {
      assert.equal((await context.aiVariantDraftSaveBatchDetail(batches[1].batch_no, session(2))).total_count, 1);
      await assert.rejects(context.aiVariantDraftSaveBatchDetail(batches[2].batch_no, session(2)), /不存在/);
      await assert.rejects(context.aiVariantDraftSaveBatchDetail(batches[2].batch_no, session(1)), /不存在/);
      await assert.rejects(context.aiVariantDraftSaveBatchDetail(batches[1].batch_no, null), { statusCode: 403 });
      const [item] = await query("SELECT * FROM ai_variant_draft_save_items WHERE batch_no = ?", [batches[2].batch_no]);
      await query("UPDATE ai_variant_draft_save_items SET status = 'failed' WHERE id = ?", [item.id]);
      await context.retryAiVariantDraftSaveItem(item.item_no, session(2));
      assert.equal((await query("SELECT status FROM ai_variant_draft_save_items WHERE id = ?", [item.id]))[0].status, "failed");
    });

    await t.test("worker restores persisted enterprise instead of the default enterprise", async () => {
      const [item] = await query("SELECT * FROM ai_variant_draft_save_items WHERE batch_no = ?", [batches[1].batch_no]);
      await context.executeClaimedItem(item);
      assert.deepEqual(await query("SELECT tenant_id, person_id FROM draft_evidence"), [{ tenant_id: 2, person_id: 7 }]);
    });

    await t.test("revocation, role changes, expiry, and missing membership block execution", async () => {
      const [item] = await query("SELECT * FROM ai_variant_draft_save_items WHERE batch_no = ?", [batches[2].batch_no]);
      for (const [change, restore] of [
        ["UPDATE tenant_members SET active = 0 WHERE tenant_id = 3", "UPDATE tenant_members SET active = 1 WHERE tenant_id = 3"],
        ["UPDATE tenant_members SET business_roles_json = JSON_ARRAY('packing') WHERE tenant_id = 3", "UPDATE tenant_members SET business_roles_json = JSON_ARRAY('operations') WHERE tenant_id = 3"],
        ["UPDATE tenants SET subscription_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id = 3", "UPDATE tenants SET subscription_expires_at = NULL WHERE id = 3"]
      ]) {
        await query(change); await context.executeClaimedItem(item); await query(restore);
      }
      await assert.rejects(restoreBusinessTaskSession("3", 8, query), { statusCode: 403 });
      await assert.rejects(restoreBusinessTaskSession(undefined, 7, query), { statusCode: 403 });
      assert.equal((await query("SELECT COUNT(*) AS total FROM draft_evidence"))[0].total, 1);
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});
