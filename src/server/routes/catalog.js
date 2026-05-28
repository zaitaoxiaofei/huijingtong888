export function createCatalogRoutes({ services, readJson }) {
  return {
    "GET /api/products": (req, url) => services.products(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/selection": (req, url) => services.selectionProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/hidden": (req, url) => services.hiddenProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/online-products": (req, url) => services.onlineProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/mappings": (req, url) => services.mappings(Object.fromEntries(url.searchParams.entries())),
    "POST /api/products": async (req) => {
      const body = await readJson(req);
      const sessionPersonId = req._session?.personId || req._session?.person_id || null;
      const created = await services.createProduct({
        ...body,
        owner_person_id: body.owner_person_id || sessionPersonId,
        created_by_person_id: body.created_by_person_id || sessionPersonId
      });
      return { ...created, product: await services.selectionProduct(created.id) };
    },
    "POST /api/products/merge-preview": async (req) => services.previewMergeProducts(await readJson(req)),
    "POST /api/products/merge": async (req) => services.mergeProducts(await readJson(req)),
    "POST /api/selection/selling-points/generate": async (req) => services.generateSelectionSellingPoints(await readJson(req)),
    "GET /api/products/merge-history": (req, url) => services.productMergeHistory(Object.fromEntries(url.searchParams.entries())),
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
    return json(res, await services.productOrderProfitDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
    return json(res, await services.productCancelDetails(Number(parts[2])));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && /^\d+$/.test(parts[2] || "") && !parts[3]) {
    const detail = await services.selectionProduct(Number(parts[2]));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
    return sendProductImage(res, Number(parts[2]), services.productImage || null);
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    await services.updateProduct(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
    return json(res, services.recalculateOrderProfitsForProduct(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "add-to-inventory") {
    return json(res, await services.addSelectionToInventory(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, await services.updateSkuMapping(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "mappings" && parts[2]) {
    return json(res, await services.deleteSkuMapping(Number(parts[2])));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    await services.deleteProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "remove-from-inventory") {
    return json(res, await services.removeProductFromInventory(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "undo-merge") {
    return json(res, await services.undoMergeProductHistory(Number(parts[2])));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "restore") {
    await services.restoreProduct(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "online-products" && parts[2]) {
    return json(res, await services.updateOnlineProduct(Number(parts[2]), await readJson(req)));
  }

  return false;
}
