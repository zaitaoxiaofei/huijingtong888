import { authorizeBusinessTaskSession } from './business-task-tenant.js';

// Preserve explicit platform grants without treating an old admin role or a
// default-enterprise membership as platform authority.
export async function authorizeDashboardSession(session, query) {
  const current = await authorizeBusinessTaskSession(session, query);
  if (session.platform_role !== 'super_admin') return current;
  const runQuery = query || (await import('../mysql-pool.js')).mysqlQuery;
  const grants = await runQuery("SELECT person_id FROM platform_grants WHERE person_id=? AND role='super_admin' AND active=1 LIMIT 1", [current.personId]);
  return grants[0] ? { ...current, platform_role: 'super_admin' } : current;
}
