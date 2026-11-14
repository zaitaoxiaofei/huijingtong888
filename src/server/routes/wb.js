import { wbPlatform } from '../../services/wb-platform.js';
import { authorizeBusinessTaskSession } from '../../services/business-task-tenant.js';
import { hasPermission, isEnterpriseAdmin } from '../../shared/permissions.js';

export function createWbRoutes({ readJson, platform = wbPlatform, authorize = authorizeBusinessTaskSession }) {
  const routes = {};
  const register = (method, path, action, permission = 'operations') => {
    routes[`${method} /api/wb/${path}`] = async (req, url) => {
      const session = await authorize(req._session);
      if (!(permission === 'enterprise.admin' ? isEnterpriseAdmin(session) : hasPermission(session, permission))) {
        throw Object.assign(new Error('当前企业岗位无权执行该 WB 操作。'), { statusCode: 403 });
      }
      const body = method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
      const service = await platform(session, permission, req._abortSignal);
      return service[action](Number(session.tenant.id), body);
    };
  };
  for (const [path, action] of [['publish-records','publishRecords'],['product-operations','productOperations'],['product-operation','productOperation'],['publish-jobs','publishJobs'],['publish-job','publishJob'],['catalog/brands','categoryBrands'],['catalog/options','categoryOptions'],['catalog/parents','categoryParents'],['catalog/categories','catalogCategories'],['catalog/schema','categorySchema'],['workbench-drafts','workbenchDrafts'],['listing-templates','listingTemplates'],['listing-drafts','listingDrafts'],['listing-source','listingSource'],['products','products'],['warehouses','warehouses'],['categories','categories'],['characteristics','characteristics'],['publish-errors','publishErrors'],['stocks','stocks'],['prices','prices'],['price-result','priceResult'],['promotions','promotions'],['promotion-products','promotionProducts']]) register('GET', path, action);
  register('GET', 'card-limits', 'cardLimits', 'orders.read');
  register('GET', 'shops', 'shops', 'orders.read');
  register('GET', 'pricing-commissions', 'pricingCommissions', 'orders.read');
  register('GET', 'inventory-usage', 'inventoryUsage', 'inventory.read');
  register('GET', 'supply', 'supply', 'orders.read');
  for (const [path, action] of [['shops/save','saveShop'],['check','check'],['warehouses/save','saveWarehouse']]) register('POST', path, action, 'enterprise.admin');
  register('POST','products/bind','bindProduct','inventory.write');
  register('POST','products/create-inventory','createProductInventory','inventory.write');
  register('POST','products/refresh','refreshProducts');
  register('POST','publish-records/sync','syncPublishRecord');
  register('POST','publish-records/delete','deletePublishRecord');
  for (const [path, action] of [['product-operation/review','reviewProductOperation'],['product-operation/submit','submitProductOperation'],['product-operation/resume','resumeProductOperation'],['listing-publish/review','reviewListingDraft'],['listing-publish/submit','submitListingDraft'],['listing-publish/resume','resumePublishJob'],['listing-barcodes','generateListingBarcodes'],['listing-preview','previewListingPayload'],['listing-templates/save','saveListingTemplate'],['listing-drafts/save','saveListingDraft'],['listing-drafts/validate','validateListingDraft'],['products/sync','syncProducts'],['publish','publish'],['products/media','uploadMedia'],['stocks/batch/read','readStockBatch'],['stocks/batch/set','setStockBatch'],['stocks/set','setStocks'],['prices/set','setPrice'],['promotions/enroll','enrollPromotion'],['orders/sync','syncOrders']]) register('POST', path, action);
  for (const [path, action] of [['orders/prepare','prepare'],['orders/stickers','stickers'],['supply/action','supplyAction']]) register('POST', path, action, 'packing');
  return routes;
}
