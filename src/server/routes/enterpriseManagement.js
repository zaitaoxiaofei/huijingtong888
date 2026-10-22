import { getRoles, isPlatformAdmin } from "../../shared/permissions.js";
import { tenantIdFromRequest } from "../tenant-context.js";

export function createEnterpriseManagementRoutes({ services, readJson }) {
  return {
    "GET /api/platform/accounts": req => services.platformAccounts(req._session),
    "GET /api/enterprise/people": req => services.enterprisePeople(req._session),
    "POST /api/enterprise/people": async req => services.createEnterprisePerson(await readJson(req), req._session),
    "GET /api/people": async (req, url) => {
      const platformScope = (url?.searchParams.get("scope") ?? req.query?.scope) === "platform";
      if (platformScope && !isPlatformAdmin(req._session)) throw Object.assign(new Error("仅平台管理员可以查看平台账号列表"), { statusCode: 403 });
      if (platformScope || (isPlatformAdmin(req._session) && !req._session?.tenant?.id)) return services.people();
      tenantIdFromRequest(req);
      const rows = await services.tenantMembers(req._session.tenant.id, { peopleOnly: true });
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
