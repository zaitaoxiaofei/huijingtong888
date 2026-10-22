import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth-password.js";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("complete HTTP registration, basic access, voucher redemption and re-login", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL and dedicated local port 8788.", timeout: 120000
}, async t => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(8788, "127.0.0.1", resolve));
  await new Promise(resolve => probe.close(resolve));
  const fixture = await createTenantMysqlFixture("membership_http");
  const directory = await mkdtemp(path.join(os.tmpdir(), "ozon-membership-http-"));
  const base = "http://127.0.0.1:8788", password = "Random-safe-P82!";
  let child, output = "", token, otherToken, adminToken, account, voucher;
  const request = async (route, bearer = "", method = "GET", body) => {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(15000),
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cache: response.headers.get("cache-control") };
  };
  try {
    await fixture.query("INSERT INTO tenants (id,slug,name,plan_code,subscription_status) VALUES (1,'default','历史默认企业','yearly','active')");
    await fixture.query("INSERT INTO people (id,name,username,password_hash,role,roles_json) VALUES (1,'发码管理员','voucher-admin',?,'operator',JSON_ARRAY('operator'))", [hashPassword(password)]);
    await fixture.query("INSERT INTO platform_grants (person_id,role,active,reason) VALUES (1,'super_admin',1,'Isolated HTTP test')");
    await fixture.query("INSERT INTO people (id,name,username,password_hash,role,roles_json) VALUES (2,'旧默认企业发货员','legacy-packing',?,'packing',NULL),(3,'旧默认企业管理员','legacy-admin',?,'admin',NULL)", [hashPassword(password), hashPassword(password)]);
    await fixture.query("INSERT INTO tenant_members (tenant_id,person_id,role,business_roles_json) VALUES (1,2,'owner',NULL),(1,3,'owner',NULL)");
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
      cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...fixture.env, HOST: "127.0.0.1", APP_BASE_URL: base, SCHEDULED_JOBS_ENABLED: "0", DEPLOYMENT_CANDIDATE: "1",
        BACKGROUND_OZON_STOCK_SYNC_ENABLED: "false", BACKGROUND_OZON_CATEGORY_SYNC_ENABLED: "false", SITE_ACCESS_PASSWORD: "", UPLOADS_ROOT: path.join(directory, "uploads") }
    });
    child.stdout.on("data", data => { output = (output + data).slice(-10000); });
    child.stderr.on("data", data => { output = (output + data).slice(-10000); });
    const until = Date.now() + 80000;
    let ready = false;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Isolated service startup failed: ${output}`);
      try { const response = await request("/api/ready"); if (response.status === 200 && response.data.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, output);

    await t.test("historical default-enterprise staff retain login and business roles without new platform authority", async () => {
      for (const [username, role, tenantRole] of [["legacy-packing", "packing", "member"], ["legacy-admin", "admin", "owner"]]) {
        const login = await request("/api/auth/login", "", "POST", { username, password });
        assert.equal(login.status, 200, JSON.stringify(login.data));
        assert.ok(login.data.token);
        assert.equal(login.data.user.platform_role, null);
        assert.equal(login.data.user.tenant.id, 1);
        assert.equal(login.data.user.tenant.role, tenantRole);
        assert.equal(login.data.user.tenant.access_allowed, true);
        assert.deepEqual(login.data.user.roles, [role]);
        const me = await request("/api/auth/me", login.data.token);
        assert.equal(me.status, 200);
        assert.equal(me.data.tenant.role, tenantRole);
        assert.equal((await request("/api/shops", login.data.token)).status, 200);
        assert.equal((await request("/api/tenants/subscription-vouchers", login.data.token)).status, 403);
        assert.equal((await request("/api/auth/membership", login.data.token)).data.can_activate, false);
      }
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM platform_grants"))[0].count, 1);
      const members = await fixture.query("SELECT person_id,role,business_roles_json FROM tenant_members WHERE tenant_id=1 ORDER BY person_id");
      assert.deepEqual(members.map(row => ({ ...row, person_id: Number(row.person_id) })), [
        { person_id: 2, role: "owner", business_roles_json: null }, { person_id: 3, role: "owner", business_roles_json: null }
      ]);
    });

    await t.test("register returns an authenticated but unactivated isolated owner, who can log in again", async () => {
      const signup = await request("/api/auth/register", "", "POST", { name: "注册卖家甲", username: "seller-alpha", password, enterprise_name: "卖家甲企业" });
      assert.equal(signup.status, 200, JSON.stringify(signup.data));
      assert.equal(signup.cache, "no-store");
      assert.ok(signup.data.token);
      token = signup.data.token; account = signup.data.user;
      assert.equal(account.platform_role, null);
      assert.equal(account.tenant.role, "owner");
      assert.equal(account.tenant.subscription_status, "unactivated");
      assert.notEqual(account.tenant.slug, "default");
      const login = await request("/api/auth/login", "", "POST", { username: "seller-alpha", password });
      assert.equal(login.status, 200, JSON.stringify(login.data));
      assert.ok(login.data.token);
      assert.equal(login.data.user.tenant.id, account.tenant.id);
      const second = await request("/api/auth/register", "", "POST", { name: "注册卖家乙", username: "seller-beta", password });
      assert.equal(second.status, 200, JSON.stringify(second.data));
      otherToken = second.data.token;
      assert.notEqual(second.data.user.tenant.id, account.tenant.id);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenant_members WHERE tenant_id=1 AND person_id NOT IN (2,3)"))[0].count, 0);
    });

    await t.test("unactivated accounts can read membership and basic calculator projections but not business data or mutations", async () => {
      const membership = await request("/api/auth/membership?tenant_id=1", token);
      assert.equal(membership.status, 200);
      assert.equal(membership.data.tenant_id, account.tenant.id);
      assert.equal(membership.data.status, "unactivated");
      assert.equal(membership.data.remaining_days, 0);
      assert.equal(membership.data.can_activate, true);
      assert.equal((await request("/api/tools/pricing/logistics-rules", token)).status, 200);
      for (const [method, route, body] of [["GET", "/api/orders"], ["GET", "/api/shops"], ["GET", "/api/dashboard"],
        ["POST", "/api/listing/generate-offer-id", {}], ["POST", "/api/shops", { name: "不应创建的店铺" }]]) {
        const result = await request(route, token, method, body);
        assert.equal(result.status, 402, `${method} ${route}: ${JSON.stringify(result.data)}`);
        assert.equal(result.data.code, "TENANT_SUBSCRIPTION_REQUIRED");
      }
      assert.equal((await request("/api/tenants/subscription-vouchers", token)).status, 403);
      assert.equal((await request("/api/auth/activate", "", "POST", { activation_code: "BD-" + "0".repeat(48) })).status, 401);
    });

    await t.test("platform-only admin issues a one-use plan voucher without activating or joining the buyer enterprise", async () => {
      const login = await request("/api/auth/login", "", "POST", { username: "voucher-admin", password });
      assert.equal(login.status, 200, JSON.stringify(login.data));
      assert.equal(login.data.user.tenant, null);
      adminToken = login.data.token;
      const issued = await request("/api/tenants/subscription-vouchers", adminToken, "POST", { plan_code: "monthly_team" });
      assert.equal(issued.status, 200, JSON.stringify(issued.data));
      assert.equal(issued.cache, "no-store");
      voucher = issued.data;
      assert.match(voucher.activation_code, /^BD-/);
      const list = await request("/api/tenants/subscription-vouchers", adminToken);
      assert.equal(list.status, 200);
      assert.equal(JSON.stringify(list.data).includes(voucher.activation_code), false);
      assert.equal(JSON.stringify(list.data).includes("code_hash"), false);
      assert.equal((await request("/api/auth/membership", token)).data.access_allowed, false);
    });

    await t.test("redeem unlocks only current enterprise; used code cannot unlock a second enterprise", async () => {
      const activation = await request("/api/auth/activate", token, "POST", { activation_code: voucher.activation_code });
      assert.equal(activation.status, 200, JSON.stringify(activation.data));
      assert.equal(activation.cache, "no-store");
      assert.equal(activation.data.membership.access_allowed, true);
      assert.equal(activation.data.membership.remaining_days, 30);
      const me = await request("/api/auth/me", token);
      assert.equal(me.data.tenant.access_allowed, true);
      assert.equal((await request("/api/orders", token)).status, 200);
      const second = await request("/api/auth/activate", otherToken, "POST", { activation_code: voucher.activation_code });
      assert.equal(second.status, 400, JSON.stringify(second.data));
      assert.equal((await request("/api/auth/membership", otherToken)).data.access_allowed, false);
      assert.equal((await request("/api/orders", otherToken)).status, 402);
      assert.equal((await fixture.query("SELECT COUNT(*) AS count FROM tenant_members WHERE person_id=1"))[0].count, 0);
    });

    await t.test("revoking a separate unused voucher leaves existing membership intact", async () => {
      const next = await request("/api/tenants/subscription-vouchers", adminToken, "POST", { plan_code: "monthly" });
      const revoked = await request("/api/tenants/subscription-vouchers", adminToken, "DELETE", { id: next.data.id });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.data.revoked, 1);
      const activation = await request("/api/auth/activate", token, "POST", { activation_code: next.data.activation_code });
      assert.equal(activation.status, 400);
      assert.equal((await request("/api/auth/membership", token)).data.remaining_days, 30);
    });
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
