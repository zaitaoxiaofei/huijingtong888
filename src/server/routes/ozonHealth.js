import { authorizeBusinessTaskSession } from '../../services/business-task-tenant.js';
import { isEnterpriseAdmin } from '../../shared/permissions.js';

export function createOzonHealthRoutes({ readJson, authorize = authorizeBusinessTaskSession, health } = {}) {
  const service = async () => health || import('../../services/ozon-credential-health-mysql.js');
  const session = async req => {
    const current = await authorize(req._session);
    if (!isEnterpriseAdmin(current)) throw Object.assign(new Error('仅企业负责人或管理员可以检查店铺授权'), { statusCode: 403 });
    return current;
  };
  return {
    'GET /api/shops/ozon-health': async req => (await service()).readOzonHealth((await session(req)).tenant.id),
    'POST /api/shops/ozon-health': async req => {
      const current = await session(req);
      const body = await readJson(req);
      return (await service()).checkOzonHealth(current.tenant.id, body.shop_id, { signal: req._abortSignal });
    }
  };
}
