import { authorizeDashboardSession } from '../../services/dashboard-access.js';
import { dashboardPollResponse } from '../../services/dashboard-poll-response.js';

export function createDashboardHandler({ dashboard, authorize = authorizeDashboardSession }) {
  return async req => {
    const current = await authorize(req._session);
    req._sensitiveResponse = true;
    const query = req.query || {};
    const statusOnly = ['1', 'true', 'yes'].includes(String(query.statusOnly || query.status_only || '').toLowerCase());
    const readQuery = statusOnly ? { ...query, snapshotOnly: '1', snapshot_only: '1', refresh: '0', forceRefresh: '0', force_refresh: '0' } : query;
    return dashboardPollResponse(await dashboard(readQuery, current.tenant.id), current, { statusOnly });
  };
}
