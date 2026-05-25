import { config } from "../../config.js";
import {
  addSelectionToInventoryMysql,
  bindOnlineProductMysql,
  createProductMysql,
  createProductFromOnlineProductMysql,
  createOnlineProductMysql,
  deleteProductMysql,
  deleteSkuMappingMysql,
  hiddenProductsMysql,
  mappingsMysql,
  mergeProductsMysql,
  onlineProductsMysql,
  productMergeHistoryMysql,
  previewMergeProductsMysql,
  productCancelDetailsMysql,
  productImageMysql,
  productOrderProfitDetailsMysql,
  productsMysql,
  restoreProductMysql,
  removeProductFromInventoryMysql,
  selectionProductMysql,
  selectionProductsMysql,
  undoMergeProductHistoryMysql,
  updateProductMysql,
  updateOnlineProductMysql,
  updateSkuMappingMysql
} from "../../services/mysql-cutover.js";

export function createCatalogRoutes({ services, readJson }) {
  return {
    "GET /api/products": (req, url) => config.dbClient === "mysql" ? productsMysql(Object.fromEntries(url.searchParams.entries())) : services.products(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/selection": (req, url) => config.dbClient === "mysql" ? selectionProductsMysql(Object.fromEntries(url.searchParams.entries())) : services.selectionProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/hidden": (req, url) => config.dbClient === "mysql" ? hiddenProductsMysql(Object.fromEntries(url.searchParams.entries())) : services.hiddenProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/online-products": (req, url) => config.dbClient === "mysql" ? onlineProductsMysql(Object.fromEntries(url.searchParams.entries())) : services.onlineProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/mappings": (req, url) => config.dbClient === "mysql" ? mappingsMysql(Object.fromEntries(url.searchParams.entries())) : services.mappings(Object.fromEntries(url.searchParams.entries())),
    "POST /api/products": async (req) => {
      if (config.dbClient === "mysql") {
        const created = await createProductMysql(await readJson(req));
        return { ...created, product: await selectionProductMysql(created.id) };
      }
      const created = services.createProduct(await readJson(req));
      return { ...created, product: services.selectionProduct(created.id) };
    },
    "POST /api/products/merge-preview": async (req) => config.dbClient === "mysql"
      ? previewMergeProductsMysql(await readJson(req))
      : services.previewMergeProducts(await readJson(req)),
    "POST /api/products/merge": async (req) => config.dbClient === "mysql"
      ? mergeProductsMysql(await readJson(req))
      : services.mergeProducts(await readJson(req)),
    "GET /api/products/merge-history": (req, url) => config.dbClient === "mysql"
      ? productMergeHistoryMysql(Object.fromEntries(url.searchParams.entries()))
      : services.productMergeHistory(Object.fromEntries(url.searchParams.entries())),
    "POST /api/products/import-preview": async (req) => services.previewProductCsvImport(await readJson(req)),
    "POST /api/products/import-commit": async (req) => services.commitProductCsvImport(await readJson(req)),
    "POST /api/online-products": async (req) => config.dbClient === "mysql"
      ? createOnlineProductMysql(await readJson(req))
      : services.createOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/online-products/bind": async (req) => config.dbClient === "mysql"
      ? bindOnlineProductMysql(await readJson(req))
      : services.bindOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/online-products/action": async (req) => services.performOnlineProductAction(await readJson(req), req._session?.personId),
    "POST /api/online-products/create-product": async (req) => config.dbClient === "mysql"
      ? createProductFromOnlineProductMysql(await readJson(req))
      : services.createProductFromOnlineProduct(await readJson(req))
  };
}

export async function handleCatalogRestRoute({ req, res, parts, services, readJson, json, notFound, sendProductImage }) {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "order-profit-details") {
    return json(res, config.dbClient === "mysql"
      ? await productOrderProfitDetailsMysql(Number(parts[2]))
      : services.productOrderProfitDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
    return json(res, config.dbClient === "mysql"
      ? await productCancelDetailsMysql(Number(parts[2]))
      : services.productCancelDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && /^\d+$/.test(parts[2] || "") && !parts[3]) {
    const detail = config.dbClient === "mysql"
      ? await selectionProductMysql(Number(parts[2]))
      : services.selectionProduct(Number(parts[2]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
    return sendProductImage(res, Number(parts[2]), config.dbClient === "mysql" ? productImageMysql : null);
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    if (config.dbClient === "mysql") await updateProductMysql(Number(parts[2]), await readJson(req));
    else services.updateProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
    return json(res, services.recalculateOrderProfitsForProduct(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "add-to-inventory") {
    return json(res, config.dbClient === "mysql"
      ? await addSelectionToInventoryMysql(Number(parts[2]))
      : services.addSelectionToInventory(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await updateSkuMappingMysql(Number(parts[2]), await readJson(req))
      : services.updateSkuMapping(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, config.dbClient === "mysql"
      ? await deleteSkuMappingMysql(Number(parts[2]))
      : services.deleteSkuMapping(Number(parts[2])));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    if (config.dbClient === "mysql") await deleteProductMysql(Number(parts[2]));
    else services.deleteProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "remove-from-inventory") {
    return json(res, config.dbClient === "mysql"
      ? await removeProductFromInventoryMysql(Number(parts[2]))
      : services.removeProductFromInventory(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "undo-merge") {
    return json(res, config.dbClient === "mysql"
      ? await undoMergeProductHistoryMysql(Number(parts[2]))
      : services.undoMergeProductHistory(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "restore") {
    if (config.dbClient === "mysql") await restoreProductMysql(Number(parts[2]));
    else services.restoreProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "online-products" && parts[2]) {
    if (config.dbClient === "mysql") {
      return json(res, await updateOnlineProductMysql(Number(parts[2]), await readJson(req)));
    }
    services.updateOnlineProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  return false;
}
