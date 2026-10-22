import { AsyncLocalStorage } from "node:async_hooks";
import { assertBusinessTaskPermission, authorizeBusinessTaskSession, businessTaskTenantKey } from "./business-task-tenant.js";

const context = new AsyncLocalStorage();
export function currentTeamTenantSession() { return context.getStore() || null; }
export function teamTenantSession() {
  const session = currentTeamTenantSession();
  if (!session) throw Object.assign(new Error("任务系统缺少已授权企业上下文"), { statusCode: 403 });
  return session;
}
export async function withTeamTenantSession(session, operation) {
  const authorized = await authorizeBusinessTaskSession(session);
  assertBusinessTaskPermission(authorized, "team");
  return context.run(authorized, operation);
}
export function teamTenantKey() { return businessTaskTenantKey(teamTenantSession()); }
// These SQL constants come only from a freshly authorized DB membership. Record
// identifiers and user filters must continue using prepared query bindings.
export function teamTenantSql() { return `'${teamTenantKey()}'`; }
export function teamCoreSql(alias = "") {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid team source alias");
  const session = teamTenantSession(), column = `${alias ? `${alias}.` : ""}tenant_id`;
  return `(${column} = ${Number(session.tenant.id)}${session.tenant.slug === "default" ? ` OR ${column} IS NULL` : ""})`;
}
export function teamPersonSql(alias = "") {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid team member alias");
  const prefix = alias ? `${alias}.` : "";
  return `EXISTS (SELECT 1 FROM tenant_members team_member WHERE team_member.person_id = ${prefix}id
    AND team_member.tenant_id = ${Number(teamTenantSession().tenant.id)} AND team_member.active = 1) AND ${prefix}active != 0`;
}
