import assert from 'node:assert/strict';
import test from 'node:test';
import { mysqlRuntimeServices } from '../src/services/mysql-runtime-services.js';
import { resolveOzonCategoryFromSku } from '../src/services/listing-automation.js';
import { createListingAutomationRoutes } from '../src/server/routes/listingAutomation.js';

test('production runtime exposes the real same-shop category resolver', () => {
  assert.equal(typeof mysqlRuntimeServices.resolveOzonCategoryFromSku, 'function');
  assert.equal(mysqlRuntimeServices.resolveOzonCategoryFromSku, resolveOzonCategoryFromSku);
});

test('category HTTP route forwards body and authenticated session and preserves errors', async () => {
  const session = { tenant: { id: 42 }, person: { id: 12 } };
  const body = { shop_id: 7, sku: '123456' };
  const result = { ok: true, category: { description_category_id: 300, type_id: 400 } };
  let failure;
  const routes = createListingAutomationRoutes({
    services: { ...mysqlRuntimeServices, resolveOzonCategoryFromSku: async (input, currentSession) => {
      assert.equal(input, body);
      assert.equal(currentSession, session);
      if (failure) throw failure;
      return result;
    } },
    readJson: async () => body
  });
  const route = routes['POST /api/listing/ozon-categories/resolve-from-sku'];
  assert.equal(await route({ _session: session }), result);
  failure = Object.assign(new Error('原店铺未匹配到唯一商品，请重新选择'), { statusCode: 409 });
  await assert.rejects(route({ _session: session }), error => error === failure);
});
