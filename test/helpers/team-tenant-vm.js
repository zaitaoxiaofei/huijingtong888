// Legacy unit fixtures supply a trusted membership directly; disposable-MySQL
// coverage exercises the real fresh authorization in tenant-team-tasks-mysql.
export function teamTenantVmContext() {
  let personId = 7;
  return {
    setTeamTestPerson(value) { personId = value; },
    teamTenantSession: () => ({ personId, tenant: { id: 1, slug: "default" } }),
    currentTeamTenantSession: () => ({ personId, tenant: { id: 1, slug: "default" } }),
    teamTenantKey: () => "admin",
    teamTenantSql: () => "'admin'",
    teamCoreSql: alias => `(${alias ? `${alias}.` : ""}tenant_id = 1 OR ${alias ? `${alias}.` : ""}tenant_id IS NULL)`,
    teamPersonSql: () => "1 = 1",
    withTeamTenantSession: async (_session, action) => action()
  };
}
