const PRODUCT_SAVE_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

function readProductSaveJson(readJson, req) {
  return readJson(req, { limitBytes: PRODUCT_SAVE_BODY_LIMIT_BYTES });
}

export function createCatalogRoutes({ services, readJson }) {
  return {
    "GET /api/products": (req, url) => services.products(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/selection": (req, url) => services.selectionProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/products/hidden": (req, url) => services.hiddenProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/online-products": (req, url) => services.onlineProducts(Object.fromEntries(url.searchParams.entries())),
    "GET /api/online-products/limits": (req, url) => services.onlineProductLimits(Object.fromEntries(url.searchParams.entries())),
    "GET /api/online-products/warehouses": (req, url) => services.onlineProductWarehouses(Object.fromEntries(url.searchParams.entries())),
    "GET /api/sku-inventory-recipes": (req, url) => services.skuInventoryRecipe(Object.fromEntries(url.searchParams.entries())),
    "GET /api/mappings": (req, url) => services.mappings(Object.fromEntries(url.searchParams.entries())),
    "GET /api/inventory-product-naming/options": (req, url) => services.inventoryProductNamingOptions(Object.fromEntries(url.searchParams.entries())),
    "POST /api/inventory-product-naming/options": async (req) => services.createInventoryProductNamingOption(await readJson(req), req._session),
    "POST /api/products": async (req) => {
      const body = await readProductSaveJson(readJson, req);
      const sessionPersonId = req._session?.personId || null;
      const created = await services.createProduct({
        ...body,
        owner_person_id: body.owner_person_id || sessionPersonId,
        created_by_person_id: body.created_by_person_id || sessionPersonId
      });
      return { ...created, product: await services.selectionProduct(created.id, { includeDetails: 0 }) };
    },
    "POST /api/products/merge-preview": async (req) => services.previewMergeProducts(await readJson(req)),
    "POST /api/products/merge": async (req) => services.mergeProducts(await readJson(req)),
    "POST /api/selection/selling-points/generate": async (req) => services.generateSelectionSellingPoints(await readJson(req)),
    "GET /api/products/merge-history": (req, url) => services.productMergeHistory(Object.fromEntries(url.searchParams.entries())),
    "POST /api/products/import-preview": async (req) => services.previewProductCsvImport(await readJson(req)),
    "POST /api/products/import-commit": async (req) => services.commitProductCsvImport(await readJson(req)),
    "POST /api/online-products": async (req) => services.createOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/online-products/bind": async (req) => services.bindOnlineProduct(await readJson(req)) || { ok: true },
    "POST /api/sku-inventory-recipes": async (req) => services.saveSkuInventoryRecipe(await readJson(req)) || { ok: true },
    "POST /api/online-products/batch-stock": async (req) => services.batchUpdateOnlineProductStocks(await readJson(req), req._session?.personId),
    "POST /api/online-products/action": async (req) => services.performOnlineProductAction(await readJson(req), req._session?.personId),
    "POST /api/online-products/create-product": async (req) => services.createProductFromOnlineProduct(await readJson(req))
  };
}

export async function handleCatalogRestRoute({ req, res, url, parts, services, readJson, json, notFound, sendProductImage }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inventory-product-naming" && parts[2] === "options" && /^\d+$/.test(parts[3] || "")) {
    return json(res, await services.updateInventoryProductNamingOption(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inventory-product-naming" && parts[2] === "options" && /^\d+$/.test(parts[3] || "")) {
    return json(res, await services.deleteInventoryProductNamingOption(Number(parts[3]), req._session));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "order-profit-details") {
    return json(res, await services.productOrderProfitDetails(Number(parts[2]), Object.fromEntries(url.searchParams.entries())));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "cancel-details") {
    return json(res, await services.productCancelDetails(Number(parts[2]), Object.fromEntries(url.searchParams.entries())));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && /^\d+$/.test(parts[2] || "") && !parts[3]) {
    const detail = await services.selectionProduct(Number(parts[2]), Object.fromEntries(url.searchParams.entries()));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "detail-images" && /^\d+$/.test(parts[4] || "")) {
    return sendProductImage(res, Number(parts[2]), () => services.productDetailImage(Number(parts[2]), Number(parts[4])), {
      thumbnail: ["1", "true", "yes"].includes(String(url.searchParams.get("thumb") || "").toLowerCase()),
      width: Number(url.searchParams.get("w") || 0),
      version: url.searchParams.get("v") || ""
    });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "image") {
    return sendProductImage(res, Number(parts[2]), services.productImage || null, {
      thumbnail: ["1", "true", "yes"].includes(String(url.searchParams.get("thumb") || "").toLowerCase()),
      width: Number(url.searchParams.get("w") || 0),
      version: url.searchParams.get("v") || ""
    });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "products" && parts[2]) {
    const productId = Number(parts[2]);
    if (parts[3] === "development-meta") {
      return json(res, await services.updateProductDevelopmentMeta(productId, await readJson(req)));
    }
    if (parts[3] === "components") {
      await services.updateProductComponents(productId, await readJson(req));
      return json(res, { ok: true, product: await services.selectionProduct(productId, { includeDetails: 0 }) });
    }
    await services.updateProduct(productId, await readProductSaveJson(readJson, req));
    return json(res, { ok: true, product: await services.selectionProduct(productId, { includeDetails: 0 }) });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "recalculate-profits") {
    return json(res, await services.recalculateOrderProfitsForProduct(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "products" && parts[2] && parts[3] === "force-recalculate-profits") {
    return json(res, await services.forceRecalculateOrderProfitsForProduct(Number(parts[2]), await readJson(req)));
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

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "online-products" && parts[2] && parts[3] === "edit-draft") {
    return json(res, await services.onlineProductEditDraft(Number(parts[2])));
  }

  return false;
}
