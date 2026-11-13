import { authorizeDashboardSession } from '../../services/dashboard-access.js';
import { dashboardForSession } from '../../shared/dashboard-visibility.js';

export function createDashboardHandler({ dashboard, authorize = authorizeDashboardSession }) {
  return async req => {
    const current = await authorize(req._session);
    req._sensitiveResponse = true;
    return dashboardForSession(await dashboard(req.query || {}, current.tenant.id), current);
  };
}
