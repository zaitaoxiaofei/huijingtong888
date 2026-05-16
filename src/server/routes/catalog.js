export function createCatalogRoutes({ services, readJson }) {
  return {
    "GET /api/products": () => services.products(),
    "GET /api/products/selection": () => services.selectionProducts(),
    "GET /api/products/hidden": () => services.hiddenProducts(),
    "GET /api/online-products": () => services.onlineProducts(),
    "GET /api/mappings": () => services.mappings(),
    "POST /api/products": async (req) => {
      const created = services.createProduct(await readJson(req));
      return { ...created, product: services.selectionProduct(created.id) };
    },
    "POST /api/products/import-preview": async (req) => services.previewProductCsvImport(await readJson(req)),
    "POST /api/products/import-commit": async (req) => services.commitProductCsvImport(await readJson(req)),
    "POST /api/online-products": async (req) => services.createOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/online-products/bind": async (req) => services.bindOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/online-products/action": async (req) => services.performOnlineProductAction(await readJson(req), req._session?.personId),
    "POST /api/online-products/create-product": async (req) => services.createProductFromOnlineProduct(await readJson(req))
  };
}

export async function handleCatalogRestRoute({ req, res, parts, services, readJson, json, notFound, sendProductImage }) {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "order-profit-details") {
    return json(res, services.productOrderProfitDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
    return json(res, services.productCancelDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && /^\d+$/.test(parts[2] || "") && !parts[3]) {
    const detail = services.selectionProduct(Number(parts[2]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
    return sendProductImage(res, Number(parts[2]));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    services.updateProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
    return json(res, services.recalculateOrderProfitsForProduct(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, services.updateSkuMapping(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, services.deleteSkuMapping(Number(parts[2])));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    services.deleteProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "restore") {
    services.restoreProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "online-products" && parts[2]) {
    services.updateOnlineProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  return false;
}
