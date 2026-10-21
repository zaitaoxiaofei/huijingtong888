import { getRoles, isPlatformAdmin } from "../../shared/permissions.js";
import { tenantIdFromRequest } from "../tenant-context.js";

export function createEnterpriseManagementRoutes({ services, readJson }) {
  return {
    "GET /api/platform/accounts": req => services.platformAccounts(req._session),
    "GET /api/enterprise/people": req => services.enterprisePeople(req._session),
    "POST /api/enterprise/people": async req => services.createEnterprisePerson(await readJson(req), req._session),
    "GET /api/people": async req => {
      if (isPlatformAdmin(req._session)) return services.people();
      tenantIdFromRequest(req);
      const rows = await services.tenantMembers(req._session.tenant.id);
      return rows.filter(row => Number(row.account_active ?? 1) !== 0).map(row => ({
        id: row.person_id, name: row.name, username: row.username, avatar_url: row.avatar_url || "",
        roles: getRoles({ roles: row.business_roles_json ?? row.roles_json ?? row.business_role }), active: row.active
      }));
    }
  };
}

export async function handleEnterpriseManagementRestRoute({ req, res, parts, services, readJson, json }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "enterprise" && parts[2] === "people" && parts.length === 4 && /^\d+$/.test(String(parts[3] || ""))) {
    json(res, await services.updateEnterprisePerson(Number(parts[3]), await readJson(req), req._session));
    return true;
  }
  return false;
}
