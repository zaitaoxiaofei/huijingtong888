import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { migrateSubscriptionVouchers } from "../scripts/migrate-subscription-vouchers.mjs";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "unused_membership_test_import";
process.env.DB_USER ||= "root";
const { createSelfServiceMembershipService } = await import("../src/services/self-service-membership.js");
const { verifyPassword } = await import("../src/auth-password.js");

test("registration and sale vouchers against disposable socket-only MySQL", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL; no application database is used.", timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture("membership");
  let now = Math.floor(Date.now() / 1000) * 1000;
  const DAY = 86400000;
  try {
    await fixture.query(`CREATE TABLE tenant_plans (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(32) UNIQUE NOT NULL, name VARCHAR(80) NOT NULL, duration_days INT NOT NULL,
      subscription_status VARCHAR(16) NOT NULL, account_limit INT NULL, shop_limit INT NULL, active TINYINT NOT NULL DEFAULT 1)`);
    await fixture.query("INSERT INTO tenant_plans (code,name,duration_days,subscription_status,account_limit,shop_limit) VALUES ('monthly','会员月卡',30,'active',3,10), ('weekly','体验周卡',7,'trial',1,2)");
    await fixture.query("INSERT INTO tenants (slug,name,plan_code,subscription_status) VALUES ('default','历史默认企业','yearly','active')");
    const platformInsert = await fixture.query("INSERT INTO people (name,username,role,active) VALUES ('测试发码管理员','voucher-platform','operator',1)");
    const platformId = Number(platformInsert.insertId);
    await fixture.query("INSERT INTO platform_grants (person_id,role,active,reason) VALUES (?,'super_admin',1,'Isolated membership test')", [platformId]);
    const platform = { personId: platformId, platform_role: "super_admin" };
    const transaction = async action => {
      const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", database: fixture.database, timezone: "Z" });
      try {
        await connection.query("SET time_zone = '+00:00'");
        await connection.beginTransaction();
        const result = await action(connection);
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback(); throw error; }
      finally { await connection.end(); }
    };
    const service = createSelfServiceMembershipService({ ensureTenantSchemaMysql: async () => {}, mysqlExecute: fixture.query,
      withMysqlTransaction: transaction, now: () => now });
    const register = async suffix => {
      const row = await service.register({ name: `测试卖家${suffix}`, username: `seller-${suffix}`, password: "Random-strong-P82!", enterprise_name: `独立企业${suffix}` });
      return { row, session: { personId: row.id, roles: ["operator"], tenant: { id: row.tenant_id, role: "owner", slug: `untrusted-slug-${suffix}` } } };
    };
    let first, second, issued;

    await t.test("missing schema fails closed; explicit migration is read-only by default, additive, idempotent and refuses incompatible uniqueness", async () => {
      await fixture.query("DROP TABLE tenant_subscription_vouchers");
      const inspection = await migrateSubscriptionVouchers(fixture.connection);
      assert.equal(inspection.exists, false);
      assert.equal(inspection.changes_database, false);
      assert.equal((await fixture.query("SHOW TABLES LIKE 'tenant_subscription_vouchers'")).length, 0);
      await assert.rejects(register("not-created"), error => error.statusCode === 503);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM people"))[0].count, 1);
      const applied = await migrateSubscriptionVouchers(fixture.connection, { apply: true });
      assert.equal(applied.ready, true); assert.equal(applied.changes_database, true);
      assert.equal((await migrateSubscriptionVouchers(fixture.connection, { apply: true })).changes_database, false);
      await fixture.query("ALTER TABLE tenant_subscription_vouchers DROP INDEX uk_subscription_voucher_hash, ADD KEY uk_subscription_voucher_hash(code_hash)");
      assert.equal((await migrateSubscriptionVouchers(fixture.connection)).ready, false);
      await assert.rejects(migrateSubscriptionVouchers(fixture.connection, { apply: true }), /incompatible/);
      await fixture.query("ALTER TABLE tenant_subscription_vouchers DROP INDEX uk_subscription_voucher_hash, ADD UNIQUE KEY uk_subscription_voucher_hash(code_hash)");
    });

    await t.test("new users get unique isolated enterprises, real password hashes and no default/platform membership", async () => {
      first = await register("alpha"); second = await register("beta");
      assert.notEqual(first.row.tenant_id, second.row.tenant_id);
      const [person] = await fixture.query("SELECT password_hash, role, account_kind FROM people WHERE id = ?", [first.row.id]);
      assert.equal(verifyPassword("Random-strong-P82!", person.password_hash), true);
      assert.match(person.password_hash, /^scrypt:/);
      assert.equal(person.account_kind, "person");
      const [membership] = await fixture.query("SELECT role, business_roles_json FROM tenant_members WHERE person_id = ?", [first.row.id]);
      assert.equal(membership.role, "owner");
      assert.deepEqual(typeof membership.business_roles_json === "string" ? JSON.parse(membership.business_roles_json) : membership.business_roles_json, ["operator"]);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id WHERE t.slug='default'"))[0].count, 0);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM platform_grants"))[0].count, 1);
      assert.equal((await service.membership(first.session)).status, "unactivated");
      const [before] = await fixture.query("SELECT COUNT(*) AS count FROM tenants");
      await assert.rejects(register("alpha"), error => error.statusCode === 409 && !error.message.includes("Duplicate entry"));
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenants"))[0].count, before.count);
    });

    await t.test("issuance stores only a hash and snapshot; changing plan does not change issued entitlement", async () => {
      issued = await service.issueVoucher({ plan_code: "monthly" }, platform);
      const [row] = await fixture.query("SELECT * FROM tenant_subscription_vouchers WHERE id=?", [issued.id]);
      assert.equal(row.code_hash.length, 64);
      assert.equal(row.code_hint, issued.activation_code.slice(-6));
      assert.equal(JSON.stringify(row).includes(issued.activation_code), false);
      await fixture.query("UPDATE tenant_plans SET duration_days=90, account_limit=8, shop_limit=99 WHERE code='monthly'");
      const list = await service.listVouchers(platform);
      assert.equal(list.rows[0].duration_days, 30);
      assert.equal(list.rows[0].member_limit, 2);
      assert.equal(list.rows[0].shop_limit, 10);
      assert.equal(JSON.stringify(list).includes(row.code_hash), false);
    });

    await t.test("simultaneous redemption from two enterprises has exactly one winner and transfers no people/data", async () => {
      const before = await fixture.query("SELECT tenant_id,person_id,role FROM tenant_members ORDER BY tenant_id,person_id");
      const results = await Promise.allSettled([first.session, second.session].map(session => service.activate({ activation_code: issued.activation_code }, session)));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.filter(result => result.status === "rejected").length, 1);
      const [voucher] = await fixture.query("SELECT status,used_by_tenant_id,used_by_person_id,used_at FROM tenant_subscription_vouchers WHERE id=?", [issued.id]);
      assert.equal(voucher.status, "used");
      const winner = Number(voucher.used_by_tenant_id) === first.row.tenant_id ? first : second;
      const loser = winner === first ? second : first;
      assert.equal(Number(voucher.used_by_person_id), winner.row.id);
      assert.ok(voucher.used_at);
      assert.equal((await service.membership(winner.session)).remaining_days, 30);
      assert.equal((await service.membership(loser.session)).access_allowed, false);
      assert.deepEqual(await fixture.query("SELECT tenant_id,person_id,role FROM tenant_members ORDER BY tenant_id,person_id"), before);
      const [tenant] = await fixture.query("SELECT member_limit,shop_limit FROM tenants WHERE id=?", [winner.row.tenant_id]);
      assert.equal(tenant.member_limit, 2); assert.equal(tenant.shop_limit, 10);
      first = winner; second = loser;
    });

    await t.test("two concurrent renewals for one enterprise both preserve duration", async () => {
      const employee = await fixture.query("INSERT INTO people (name,username,role) VALUES ('保留的员工','retained-staff','operator')");
      await fixture.query("INSERT INTO tenant_members (tenant_id,person_id,role,business_roles_json) VALUES (?,?,'member',JSON_ARRAY('operator'))", [first.row.tenant_id, Number(employee.insertId)]);
      for (let index = 0; index < 3; index++) await fixture.query("INSERT INTO shops (tenant_id,name) VALUES (?,?)", [first.row.tenant_id, `保留的店铺${index}`]);
      const codes = await Promise.all([service.issueVoucher({ plan_code: "weekly" }, platform), service.issueVoucher({ plan_code: "weekly" }, platform)]);
      const results = await Promise.all(codes.map(code => service.activate({ activation_code: code.activation_code }, first.session)));
      assert.equal(results.length, 2);
      assert.equal((await service.membership(first.session)).remaining_days, 44);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenant_subscription_vouchers WHERE status='used'"))[0].count, 3);
      const [quota] = await fixture.query("SELECT member_limit,shop_limit FROM tenants WHERE id=?", [first.row.tenant_id]);
      assert.equal(quota.member_limit, 0); assert.equal(quota.shop_limit, 2);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id=?", [first.row.tenant_id]))[0].count, 2);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM shops WHERE tenant_id=?", [first.row.tenant_id]))[0].count, 3);
    });

    await t.test("revoked/expired/old bound codes cannot activate and active grants are rechecked", async () => {
      const revoked = await service.issueVoucher({ plan_code: "weekly" }, platform);
      assert.equal((await service.revokeVoucher(revoked.id, platform)).revoked, 1);
      await assert.rejects(service.activate({ activation_code: revoked.activation_code }, second.session), error => error.statusCode === 400);
      const expired = await service.issueVoucher({ plan_code: "weekly", redeemable_until: new Date(now + DAY).toISOString() }, platform);
      now += DAY;
      await assert.rejects(service.activate({ activation_code: expired.activation_code }, second.session), error => error.statusCode === 400);
      await assert.rejects(service.activate({ activation_code: "OZ-" + "1".repeat(48) }, second.session), error => error.statusCode === 400);
      await fixture.query("UPDATE platform_grants SET active=0 WHERE person_id=?", [platformId]);
      await assert.rejects(service.listVouchers(platform), error => error.statusCode === 403);
      await assert.rejects(service.issueVoucher({ plan_code: "weekly" }, platform), error => error.statusCode === 403);
      assert.equal((await service.membership(second.session)).access_allowed, false);
      await fixture.query("UPDATE platform_grants SET active=1 WHERE person_id=?", [platformId]);
    });

    await t.test("fresh membership revoke and suspended tenant cannot consume a code", async () => {
      const fresh = await service.issueVoucher({ plan_code: "weekly" }, platform);
      await fixture.query("UPDATE tenant_members SET active=0 WHERE tenant_id=? AND person_id=?", [second.row.tenant_id, second.row.id]);
      await assert.rejects(service.activate({ activation_code: fresh.activation_code }, second.session), error => error.statusCode === 403);
      await fixture.query("UPDATE tenant_members SET active=1 WHERE tenant_id=? AND person_id=?", [second.row.tenant_id, second.row.id]);
      await fixture.query("UPDATE tenants SET subscription_status='suspended' WHERE id=?", [second.row.tenant_id]);
      await assert.rejects(service.activate({ activation_code: fresh.activation_code }, second.session), error => error.statusCode === 403);
      assert.equal((await fixture.query("SELECT status FROM tenant_subscription_vouchers WHERE id=?", [fresh.id]))[0].status, "active");
    });
  } finally { await fixture.cleanup(); }
});
