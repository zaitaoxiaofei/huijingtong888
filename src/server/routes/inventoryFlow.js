import { inventoryFlow } from "../../services/inventory-flow.js";
import { tenantIdFromRequest } from "../tenant-context.js";
import { createTenantBackgroundTasks } from "../../services/tenant-background-tasks.js";
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "../../services/business-task-tenant.js";
import { hasPermission } from "../../shared/permissions.js";

export function createInventoryFlowRoutes({ readJson, syncStocks, prepare = async () => {}, flow = inventoryFlow, tasks = createTenantBackgroundTasks(), authorize = authorizeBusinessTaskSession }) {
  const actor = req => req._session?.personId;
  const syncSession = async req => {
    const session = await authorize(req._session);
    assertBusinessTaskPermission(session, 'inventory.write');
    return session;
  };
  const syncKind = id => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw Object.assign(new Error('请选择需要同步的库存商品'), { statusCode: 400 });
    return `inventory-fbp:${Number(id)}`;
  };
  const routes = {
    "GET /api/inventory-flow": (req, url) => flow.list(Object.fromEntries(url.searchParams), tenantIdFromRequest(req)),
    "GET /api/inventory-flow/detail": (req, url) => flow.detail(url.searchParams.get('product_id'), tenantIdFromRequest(req)),
    "GET /api/inventory-flow/settings": req => flow.settings(tenantIdFromRequest(req)),
    "POST /api/inventory-flow/settings": async req => flow.saveSettings(await readJson(req), tenantIdFromRequest(req), actor(req)),
    "GET /api/inventory-flow/tasks": req => flow.tasks(tenantIdFromRequest(req)),
    "POST /api/inventory-flow/tasks": async req => flow.createTask(await readJson(req), tenantIdFromRequest(req), actor(req)),
    "POST /api/inventory-flow/task-action": async req => {
      const body = await readJson(req);
      const permission = body.action === 'edit' ? 'inventory.write' : 'packing';
      if (!hasPermission(req._session, permission)) throw Object.assign(new Error(body.action === 'edit' ? '需要库存编辑权限' : '需要仓库打包权限或企业管理员权限'), { statusCode: 403 });
      return flow.mutateTask(body, tenantIdFromRequest(req), actor(req));
    },
    "GET /api/inventory-flow/events": (req, url) => flow.history(Object.fromEntries(url.searchParams), tenantIdFromRequest(req)),
    "GET /api/inventory-flow/sync-status": async (req, url) => tasks.snapshot(await syncSession(req), syncKind(url.searchParams.get('product_id'))),
    "POST /api/inventory-flow/sync": async req => {
      const body = await readJson(req);
      const session = await syncSession(req);
      if (!body.background) return syncStocks(body, { session, tenantId: tenantIdFromRequest({ _session: session }), signal: req._abortSignal });
      return tasks.start(session, syncKind(body.product_id), ({ session, signal }) => syncStocks({ product_id: Number(body.product_id) }, {
        session, tenantId: tenantIdFromRequest({ _session: session }), signal
      }));
    }
  };
  return Object.fromEntries(Object.entries(routes).map(([path, handler]) => [path, async (req, url) => {
    await prepare();
    return handler(req, url);
  }]));
}
