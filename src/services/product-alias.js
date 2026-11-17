import { mysqlQuery, withMysqlTransaction } from '../mysql-pool.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { resolveInventoryTenantScope, assertInventoryRecord } from './inventory-tenant-scope.js';
import { hasPermission } from '../shared/permissions.js';
import { normalizeProductAlias } from '../shared/product-alias.js';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function createProductAliasService({ query = mysqlQuery, transaction = withMysqlTransaction, authorize = authorizeBusinessTaskSession } = {}) {
  async function context(session, q, write = false) {
    const current = await authorize(session, q);
    const permissions = write ? ['inventory.write', 'procurement', 'packing'] : ['inventory.read', 'procurement', 'packing'];
    if (!permissions.some(permission => hasPermission(current, permission))) throw fail('当前企业岗位无权' + (write ? '修改' : '查看') + '商品别名', 403);
    return { current, scope: await resolveInventoryTenantScope(current.tenant.id, q) };
  }
  return {
    async read(params, session) {
      const ids = [...new Set(String(params.product_ids || '').split(',').map(Number))];
      if (!ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw fail('请选择1至200个有效库存商品');
      const { scope } = await context(session, query);
      const tenant = scope.predicate('p');
      return { rows: await query(`SELECT p.id AS product_id, p.product_alias FROM products p WHERE p.id IN (${ids.map(() => '?').join(',')}) AND ${tenant.sql}`, [...ids, ...tenant.params]) };
    },
    async save(body, session) {
      const alias = normalizeProductAlias(body.product_alias);
      const expected = normalizeProductAlias(body.expected_alias);
      return transaction(async connection => {
        const q = async (sql, args = []) => (await connection.query(sql, args))[0];
        const { scope } = await context(session, q, true);
        const product = await assertInventoryRecord(scope, 'product', body.product_id, q, { lock: true });
        if ((product.product_alias || '') !== expected) throw fail('商品别名已被其他人修改，请重新打开编辑后再保存', 409);
        await q('UPDATE products SET product_alias=? WHERE id=?', [alias, product.id]);
        return { product_id: Number(product.id), product_alias: alias };
      });
    }
  };
}
export const productAliasService = createProductAliasService();
