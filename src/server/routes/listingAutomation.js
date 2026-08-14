export function createListingAutomationRoutes({ services, readJson }) {
  return {
    "GET /api/listing/templates": (req) => services.listingCategoryTemplates(req._session),
    "GET /api/listing/collector-box": (req) => services.collectorBoxProducts(req.query || {}, req._session),
    "DELETE /api/listing/collector-box": async (req) => services.deleteCollectorBoxProducts(await readJson(req), req._session),
    "POST /api/listing/templates": async (req) => services.createListingCategoryTemplate(await readJson(req), req._session),
    "POST /api/listing/templates/from-collected": async (req) => services.createListingTemplateFromCollectedProduct(await readJson(req), req._session),
    "POST /api/listing/templates/from-online-product": async (req) => {
      const body = await readJson(req);
      return services.createListingTemplateFromOnlineProduct(Number(body?.online_product_id || body?.onlineProductId || body?.id || 0), body, req._session);
    },
    "POST /api/listing/templates/category-diagnostics": async (req) => services.listingCategoryPublishDiagnostics(await readJson(req), req._session),
    "POST /api/listing/templates/validate-publish": async (req) => services.validateListingTemplatePublish(await readJson(req), req._session),
    "POST /api/listing/templates/publish-to-ozon": async (req) => services.publishListingTemplateToOzon(await readJson(req), req._session),
    "POST /api/listing/variant-media/generate": async (req) => services.generateListingVariantMediaFromImage(await readJson(req), req._session),
    "GET /api/listing/template-health-check": (req) => services.listingTemplateHealthCheck(req.query || {}, req._session),
    "GET /api/listing/draft-projects": (req, url) => services.listingDraftProjects(Object.fromEntries(url.searchParams.entries()), req._session),
    "GET /api/listing/publish-records": (req) => services.listingPublishRecords(req.query || {}, req._session),
    "GET /api/listing/publish-tasks": (req) => services.listingPublishTasks(req.query || {}, req._session),
    "POST /api/listing/publish-records/batch-delete": async (req) => services.deleteListingPublishRecords(await readJson(req), req._session),
    "GET /api/listing/media/assets": (req) => services.listingMediaAssets(req.query || {}, req._session),
    "GET /api/listing/media/ozon-upload-jobs": (req) => services.listOzonSellerMediaUploadJobs(req.query || {}),
    "POST /api/listing/media/ozon-upload-jobs": async (req) => services.createOzonSellerMediaUploadJobs(await readJson(req), req._session),
    "GET /api/material-packages/search": (req) => services.searchMaterialPackages(req.query || {}, req._session),
    "POST /api/ai/deepseek/generate": async (req) => services.generateDeepSeekListingContent(await readJson(req), req._session),
    "POST /api/listing/generate-offer-id": async (req) => services.generateListingOfferId(await readJson(req), req._session),
    "GET /api/listing/ozon-categories": (req) => services.listingOzonCategories(req.query || {}, req._session),
    "POST /api/listing/ozon-categories/sync": async (req) => services.syncListingOzonCategories(await readJson(req), req._session),
    "POST /api/listing/ozon-categories/resolve-from-sku": async (req) => services.resolveOzonCategoryFromSku(await readJson(req), req._session),
    "GET /api/listing/ozon-category-sync-jobs": (req) => services.listingOzonCategorySyncJobs(req.query || {}, req._session),
    "POST /api/listing/ozon-category-cache/refresh": async (req) => services.refreshOzonCategoryCache(await readJson(req), req._session),
    "GET /api/listing/ozon-category-attributes": (req) => services.listingOzonCategoryAttributes(req.query || {}, req._session),
    "POST /api/listing/ozon-category-attributes/sync": async (req) => services.syncListingOzonCategoryAttributes(await readJson(req), req._session),
    "GET /api/listing/ozon-attribute-values": (req) => services.listingOzonAttributeValues(req.query || {}, req._session),
    "POST /api/listing/ozon-attribute-values/sync": async (req) => services.syncListingOzonAttributeValues(await readJson(req), req._session),
    "GET /api/listing/copy-jobs": (req) => services.listingCopyJobs(req._session),
    "POST /api/listing/copy-from-sku": async (req) => services.copyListingTemplateFromOzonSku(await readJson(req), req._session),
    "POST /api/listing/media/upload": (req) => services.uploadListingMedia(req),
    "POST /api/listing/media/repair": async (req) => services.repairListingEditorMedia(await readJson(req), req._session),
    "POST /api/listing/media/watermark": async (req) => services.watermarkListingMedia(await readJson(req), req._session),
    "GET /api/listing/drafts": (req, url) => services.listingDrafts(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/listing/drafts/batch-update": async (req) => services.updateListingDraftsBatch(await readJson(req), req._session),
    "POST /api/listing/drafts/batch-publish": async (req) => services.publishListingDraftsToOzon(await readJson(req), req._session),
    "POST /api/listing/drafts/repair-media-contamination": async (req) => services.repairListingDraftMediaContamination(await readJson(req), req._session),
    "GET /api/listing/ai-variant-assets": (req, url) => services.listingAiVariantAssets(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/listing/ai-variant-assets": async (req) => services.saveListingAiVariantAsset(await readJson(req), req._session),
    "POST /api/listing/ai-variant-assets/batch-delete": async (req) => services.deleteListingAiVariantAssets(await readJson(req), req._session),
    "GET /api/listing/variant-workbench-drafts": (req, url) => services.listingVariantWorkbenchDrafts(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/listing/variant-workbench-drafts": async (req) => services.saveListingVariantWorkbenchDraft(await readJson(req), req._session),
    "POST /api/listing/drafts/ai-variant-lightweight": async (req) => services.createAiVariantListingDraftLightweight(await readJson(req), req._session),
    "POST /api/listing/drafts": async (req) => services.createListingDraft(await readJson(req), req._session)
  };
}

export async function handleListingAutomationRestRoute({ req, res, parts, services, readJson, json }) {
  if (parts[0] !== "api" || parts[1] !== "listing") return false;

  if (req.method === "GET" && parts[2] === "templates" && parts[3] && parts[4] === "diagnostics") {
    return json(res, await services.listingTemplateMappingDiagnostics(Number(parts[3]), req.query || {}, req._session));
  }

  if (req.method === "POST" && parts[2] === "templates" && parts[3] && parts[4] === "repair-mapping") {
    return json(res, await services.repairListingTemplateMapping(Number(parts[3]), await readJson(req), req._session));
  }

  if (parts[2] === "templates" && parts[3]) {
    if (req.method === "GET") {
      return json(res, await services.listingCategoryTemplateDetail(Number(parts[3]), req._session, req.query || {}));
    }
    if (req.method === "PUT") {
      return json(res, await services.updateListingCategoryTemplate(Number(parts[3]), await readJson(req), req._session));
    }
  }

  if (parts[2] === "collector-box" && parts[3]) {
    const sku = decodeURIComponent(parts[3]);
    if (req.method === "GET" && parts[4] === "diagnostics") {
      return json(res, await services.collectorBoxMappingDiagnostics(sku, req.query || {}, req._session));
    }
    if (req.method === "GET") {
      return json(res, await services.collectorBoxProductDetail(sku, req._session));
    }
    if (req.method === "POST" && parts[4] === "create-selection") {
      return json(res, await services.createSelectionFromCollectorBox(sku, await readJson(req), req._session));
    }
    if (req.method === "PUT" && parts[4] === "edit") {
      return json(res, await services.saveCollectorBoxEdit(sku, await readJson(req), req._session));
    }
    if (req.method === "PUT" && parts[4] === "development-meta") {
      return json(res, await services.updateCollectorBoxDevelopmentMeta(sku, await readJson(req), req._session));
    }
    if (req.method === "POST" && parts[4] === "create-listing-template") {
      return json(res, await services.createListingTemplateFromCollectorBox(sku, await readJson(req), req._session));
    }
    if (req.method === "DELETE") {
      return json(res, await services.deleteCollectorBoxProducts({ sku }, req._session));
    }
  }

  if (req.method === "POST" && parts[2] === "drafts" && parts[3] && parts[4] === "shop-copies") {
    return json(res, await services.generateListingShopCopies(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "GET" && parts[2] === "drafts" && parts[3] && parts[4] === "shop-copies") {
    return json(res, await services.listingShopCopies(Number(parts[3]), req._session));
  }

  if (req.method === "GET" && parts[2] === "drafts" && parts[3]) {
    return json(res, await services.listingDraftDetail(Number(parts[3]), req._session));
  }

  if (req.method === "PUT" && parts[2] === "drafts" && parts[3] && parts[4] === "development-meta") {
    return json(res, await services.updateListingDraftDevelopmentMeta(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "PUT" && parts[2] === "drafts" && parts[3]) {
    return json(res, await services.updateListingDraft(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "DELETE" && parts[2] === "drafts" && parts[3]) {
    return json(res, await services.deleteListingDraft(Number(parts[3]), req._session));
  }

  if (req.method === "DELETE" && parts[2] === "variant-workbench-drafts" && parts[3]) {
    return json(res, await services.deleteListingVariantWorkbenchDraft(decodeURIComponent(parts[3]), req._session, req.query?.route_name || req.query?.routeName || "asset-variant-center-wizard"));
  }

  if (req.method === "POST" && parts[2] === "copy-jobs" && parts[3] && parts[4] === "refresh") {
    return json(res, await services.refreshListingCopyJob(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "publish-records" && parts[3] && parts[4] === "refresh") {
    return json(res, await services.refreshListingPublishRecord(Number(parts[3]), req._session));
  }

  if (req.method === "GET" && parts[2] === "publish-tasks" && parts[3]) {
    return json(res, await services.listingPublishTaskDetail(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "publish-tasks" && parts[3] && parts[4] === "retry") {
    return json(res, await services.retryListingPublishTask(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "GET" && parts[2] === "publish-records" && parts[3]) {
    return json(res, await services.listingPublishRecordDetail(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "publish-records" && parts[3] && parts[4] === "retry") {
    return json(res, await services.retryListingPublishRecord(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "POST" && parts[2] === "publish-records" && parts[3] && parts[4] === "draft") {
    return json(res, await services.saveListingPublishRecordDraft(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "DELETE" && parts[2] === "publish-records" && parts[3]) {
    return json(res, await services.deleteListingPublishRecord(Number(parts[3]), req._session));
  }

  return false;
}

export async function handleMaterialPackageRestRoute({ req, res, parts, services, json }) {
  if (parts[0] !== "api" || parts[1] !== "material-packages") return false;

  if (req.method === "GET" && parts[2]) {
    return json(res, await services.materialPackageDetail(Number(parts[2]), req._session));
  }

  return false;
}
