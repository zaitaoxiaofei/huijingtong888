import { mysqlExecute } from "../mysql-pool.js";
import { getRoles, primaryRole, validateRoles } from "../shared/permissions.js";

let ready;
export async function ensurePeopleRolesSchemaMysql() {
  if (!ready) ready = mysqlExecute("ALTER TABLE people ADD COLUMN roles_json JSON NULL")
    .catch(error => { if (error?.code !== "ER_DUP_FIELDNAME") { ready = null; throw error; } });
  await ready;
}

export function personRoleFields(body = {}, existing = null) {
  const roles = body.roles !== undefined ? validateRoles(body.roles)
    : body.role !== undefined ? (existing && body.role === primaryRole(existing) ? getRoles(existing) : validateRoles([body.role]))
      : existing ? getRoles(existing) : ["operator"];
  return { role: primaryRole(roles), roles, roles_json: JSON.stringify(roles) };
}
