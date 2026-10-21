import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function fixture({ granted = false, active = true, accountActive = true } = {}) {
  const calls = [];
  const source = readFileSync(new URL("../src/services/platform-grants.js", import.meta.url), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
  const context = vm.createContext({
    mysqlExecute: async sql => { calls.push({ sql }); return {}; },
    mysqlQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT pg.person_id")) return granted && active && accountActive ? [{ person_id: params[0], role: "super_admin", active: 1 }] : [];
      return [{ id: 10, person_id: 10, name: "Platform tester", platform_role: "super_admin", active: Number(active), account_active: Number(accountActive) }];
    }
  });
  vm.runInContext(source, context);
  return { services: context, calls };
}

test("legacy admin roles do not create explicit platform authorization", async () => {
  const f = fixture();
  assert.equal(await f.services.getPlatformGrantMysql(10), null);
  await assert.rejects(f.services.listPlatformAccountsMysql({ personId: 10, roles: ["admin"] }), { statusCode: 403 });
  assert.equal(f.calls.some(call => /INSERT|UPDATE people|INSERT.*tenant_members/.test(call.sql)), false);
});

test("inactive grants and inactive global identities cannot authorize platform sessions", async () => {
  for (const options of [{ granted: true, active: false }, { granted: true, accountActive: false }]) {
    const f = fixture(options);
    assert.equal(await f.services.getPlatformGrantMysql(10), null);
    await assert.rejects(f.services.listPlatformAccountsMysql({ personId: 10, platform_role: "super_admin" }), { statusCode: 403 });
  }
});

test("platform roster is drawn only from explicit grants and never selects password or binding secrets", async () => {
  const f = fixture({ granted: true });
  const rows = await f.services.listPlatformAccountsMysql({ personId: 10, platform_role: "super_admin" });
  assert.equal(rows[0].platform_role, "super_admin");
  const query = f.calls.find(call => call.sql.startsWith("SELECT p.id"));
  assert.match(query.sql, /FROM platform_grants pg JOIN people p/);
  assert.match(query.sql, /pg\.role AS platform_role/);
  assert.doesNotMatch(query.sql, /password_hash|wechat|api_key|token/);
  assert.equal(f.calls.filter(call => call.sql.startsWith("CREATE TABLE")).length, 1);
});
