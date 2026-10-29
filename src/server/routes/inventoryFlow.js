import { inventoryFlow } from "../../services/inventory-flow.js";
import { tenantIdFromRequest } from "../tenant-context.js";
import { hasPermission } from "../../shared/permissions.js";

export function createInventoryFlowRoutes({ readJson, syncStocks, prepare = async () => {}, flow = inventoryFlow }) {
  const actor = req => req._session?.personId;
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
    "POST /api/inventory-flow/sync": async req => syncStocks(await readJson(req), { tenantId: tenantIdFromRequest(req), signal: req._abortSignal })
  };
  return Object.fromEntries(Object.entries(routes).map(([path, handler]) => [path, async (req, url) => {
    await prepare();
    return handler(req, url);
  }]));
}
