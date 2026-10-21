import { readFileSync } from "node:fs";
import vm from "node:vm";
import { hashPassword, validatePasswordStrength } from "../../src/auth-password.js";
import { getRoles, primaryRole, validateRoles } from "../../src/shared/permissions.js";
import { assertTenantQuotaAvailable } from "../../src/services/tenant-quotas.js";

function serviceSource(filename) {
  return readFileSync(new URL(`../../src/services/${filename}`, import.meta.url), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
}

// Run the actual service bodies with only their database transport replaced by
// a pool bound to a generated fixture database. Never imports application config.
export function loadIdentityMemberServices(pool, hooks = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params: Array.from(params) });
    return (await pool.execute(sql, params))[0];
  };
  const transaction = async action => {
    const connection = await pool.getConnection();
    try {
      await connection.query("SET time_zone = '+00:00'");
      await connection.beginTransaction();
      const transport = { execute: async (sql, params = []) => {
        calls.push({ sql, params: Array.from(params) });
        await hooks.beforeExecute?.(sql, params, connection);
        const result = await connection.execute(sql, params);
        await hooks.afterExecute?.(sql, params, result, connection);
        return result;
      } };
      const result = await action(transport);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
  const platform = vm.createContext({ Date, Number, String, Object, Array, Map, Set, mysqlExecute: query, mysqlQuery: query });
  vm.runInContext(serviceSource("platform-grants.js"), platform);
  const enterprise = vm.createContext({
    Date, Number, String, Object, Array, Map, Set, getRoles, validateRoles, hashPassword, validatePasswordStrength,
    assertTenantQuotaAvailable, withMysqlTransaction: transaction,
    ensureTenantSchemaMysql: async () => {}, ensurePlatformGrantSchemaMysql: platform.ensurePlatformGrantSchemaMysql
  });
  vm.runInContext(serviceSource("tenant-people.js"), enterprise);
  const tenantSource = serviceSource("tenants.js");
  const tenants = vm.createContext({ Date, Number, String, Object, Array, Map, Set,
    text: (value, max = 255) => String(value || "").trim().slice(0, max),
    mysqlQuery: query, ensureTenantSchemaMysql: async () => {}
  });
  vm.runInContext(tenantSource.slice(tenantSource.indexOf("function subscriptionState("), tenantSource.indexOf("async function listTenantsMysql(")), tenants);
  const auth = vm.createContext({ Date, Number, String, Object, Array, Map, Set, getRoles, primaryRole,
    isMysqlPrimaryEnabled: () => true, mysqlExecute: query, mysqlQuery: query,
    ensurePeopleRolesSchemaMysql: async () => {}, ensureTenantSchemaMysql: async () => {},
    resolveActiveTenantMysql: tenants.resolveActiveTenantMysql, tenantHasAccess: tenants.tenantHasAccess,
    getPlatformGrantMysql: platform.getPlatformGrantMysql
  });
  vm.runInContext(serviceSource("mysql-auth-session.js"), auth);
  return { platform, enterprise, auth, transaction, query, calls };
}
