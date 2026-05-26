export function createListingAutomationRoutes({ services, readJson }) {
  return {
    "GET /api/listing/templates": (req) => services.listingCategoryTemplates(req._session),
    "POST /api/listing/templates": async (req) => services.createListingCategoryTemplate(await readJson(req), req._session),
    "POST /api/listing/templates/from-collected": async (req) => services.createListingTemplateFromCollectedProduct(await readJson(req), req._session),
    "POST /api/listing/templates/validate-publish": async (req) => services.validateListingTemplatePublish(await readJson(req), req._session),
    "POST /api/listing/templates/publish-to-ozon": async (req) => services.publishListingTemplateToOzon(await readJson(req), req._session),
    "GET /api/listing/publish-records": (req) => services.listingPublishRecords(req.query || {}, req._session),
    "GET /api/listing/media/assets": (req) => services.listingMediaAssets(req.query || {}, req._session),
    "GET /api/listing/ozon-categories": (req) => services.listingOzonCategories(req.query || {}, req._session),
    "POST /api/listing/ozon-categories/sync": async (req) => services.syncListingOzonCategories(await readJson(req), req._session),
    "GET /api/listing/ozon-category-sync-jobs": (req) => services.listingOzonCategorySyncJobs(req.query || {}, req._session),
    "POST /api/listing/ozon-category-cache/refresh": async (req) => services.refreshOzonCategoryCache(await readJson(req), req._session),
    "GET /api/listing/ozon-category-attributes": (req) => services.listingOzonCategoryAttributes(req.query || {}, req._session),
    "POST /api/listing/ozon-category-attributes/sync": async (req) => services.syncListingOzonCategoryAttributes(await readJson(req), req._session),
    "GET /api/listing/ozon-attribute-values": (req) => services.listingOzonAttributeValues(req.query || {}, req._session),
    "POST /api/listing/ozon-attribute-values/sync": async (req) => services.syncListingOzonAttributeValues(await readJson(req), req._session),
    "GET /api/listing/copy-jobs": (req) => services.listingCopyJobs(req._session),
    "POST /api/listing/copy-from-sku": async (req) => services.copyListingTemplateFromOzonSku(await readJson(req), req._session),
    "POST /api/listing/media/upload": (req) => services.uploadListingMedia(req),
    "GET /api/listing/drafts": (req, url) => services.listingDrafts(Object.fromEntries(url.searchParams.entries()), req._session),
    "POST /api/listing/drafts": async (req) => services.createListingDraft(await readJson(req), req._session)
  };
}

export async function handleListingAutomationRestRoute({ req, res, parts, services, readJson, json }) {
  if (parts[0] !== "api" || parts[1] !== "listing") return false;

  if (parts[2] === "templates" && parts[3]) {
    if (req.method === "GET") {
      return json(res, await services.listingCategoryTemplateDetail(Number(parts[3]), req._session));
    }
    if (req.method === "PUT") {
      return json(res, await services.updateListingCategoryTemplate(Number(parts[3]), await readJson(req), req._session));
    }
  }

  if (req.method === "POST" && parts[2] === "drafts" && parts[3] && parts[4] === "shop-copies") {
    return json(res, await services.generateListingShopCopies(Number(parts[3]), await readJson(req), req._session));
  }

  if (req.method === "GET" && parts[2] === "drafts" && parts[3] && parts[4] === "shop-copies") {
    return json(res, await services.listingShopCopies(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "copy-jobs" && parts[3] && parts[4] === "refresh") {
    return json(res, await services.refreshListingCopyJob(Number(parts[3]), req._session));
  }

  if (req.method === "POST" && parts[2] === "publish-records" && parts[3] && parts[4] === "refresh") {
    return json(res, await services.refreshListingPublishRecord(Number(parts[3]), req._session));
  }

  return false;
}
