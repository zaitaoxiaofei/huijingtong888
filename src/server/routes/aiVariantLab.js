export function createAiVariantLabRoutes({ services, readJson }) {
  return {
    "POST /api/ai-variant-lab/analyze-image": async (req) => services.aiVariantLabAnalyzeImage(await readJson(req), req._session),
    "POST /api/ai-variant-lab/analysis/lookup": async (req) => services.aiVariantLabAnalysisLookup(await readJson(req), req._session),
    "POST /api/ai-variant-lab/plan-variant": async (req) => services.aiVariantLabPlanVariant(await readJson(req), req._session),
    "POST /api/ai-variant-lab/batch-plan": async (req) => services.aiVariantLabBatchPlan(await readJson(req), req._session),
    "POST /api/ai-variant-lab/batch-run-images": async (req) => services.aiVariantLabBatchRunImages(await readJson(req), req._session),
    "POST /api/ai-variant-lab/batch-resume-images": async (req) => services.aiVariantLabBatchResumeImages(await readJson(req), req._session),
    "POST /api/ai-variant-lab/batch-items/manual-image": async (req) => services.aiVariantLabManualImageResult(await readJson(req), req._session),
    "GET /api/ai-variant-lab/batch-jobs": (req) => services.aiVariantLabBatchJobs(req.query || {}, req._session),
    "POST /api/ai-variant-lab/generate-copy-contract": async (req) => services.aiVariantLabGenerateCopyContract(await readJson(req), req._session),
    "POST /api/ai-variant-lab/test-image-edit": async (req) => services.aiVariantLabTestImageEdit(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/analyze": async (req) => services.aiImageOptimizerAnalyze(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/analysis/lookup": async (req) => services.aiImageOptimizerAnalysisLookup(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/analysis/confirm": async (req) => services.aiImageOptimizerConfirmAnalysis(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/plan": async (req) => services.aiImageOptimizerPlan(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/plan/confirm": async (req) => services.aiImageOptimizerConfirmPlan(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/result": async (req) => services.aiImageOptimizerSaveResult(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/review-image": async (req) => services.aiImageOptimizerReviewImage(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/compose-text": async (req) => services.aiImageOptimizerComposeText(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/test-image": async (req) => services.aiImageOptimizerTestImage(await readJson(req), req._session),
    "POST /api/ai-variant-lab/optimize/prepare-template": async (req) => services.aiProductMaterialOptimizerPrepareTemplate(await readJson(req), req._session),
    "POST /api/ai-material-optimization/batches": async (req) => services.createAiMaterialOptimizationBatch(await readJson(req), req._session),
    "GET /api/ai-material-optimization/batches": (req) => services.aiMaterialOptimizationBatches(req.query || {}, req._session),
    "POST /api/ai-variant-draft-save/batches": async (req) => services.createAiVariantDraftSaveBatch(await readJson(req), req._session),
    "POST /api/ai-variant-lab/save-template": async (req) => services.aiVariantLabSaveTemplate(await readJson(req), req._session),
    "POST /api/ai-variant-lab/cases": async (req) => services.aiVariantLabSaveCase(await readJson(req), req._session),
    "GET /api/ai-variant-lab/cases": (req) => services.aiVariantLabCases(req.query || {}, req._session),
    "GET /api/ai-variant-lab/templates": (req) => services.aiVariantLabTemplates(req.query || {}, req._session),
    "GET /api/ai-variant-lab/vehicle-catalog": (req) => services.aiVehicleCatalog(req.query || {}, req._session),
    "POST /api/ai-variant-lab/vehicle-catalog": async (req) => services.addAiVehicleCatalogEntry(await readJson(req), req._session)
  };
}

export async function handleAiVariantLabRestRoute({ req, res, parts, services, json }) {
  if (parts[0] === "api" && parts[1] === "ai-material-optimization") {
    if (req.method === "GET" && parts[2] === "batches" && parts[3]) {
      return json(res, await services.aiMaterialOptimizationBatchDetail(decodeURIComponent(parts[3]), req._session));
    }
    if (req.method === "POST" && parts[2] === "items" && parts[3] && parts[4] === "retry") {
      return json(res, await services.retryAiMaterialOptimizationItem(decodeURIComponent(parts[3]), req._session));
    }
  }
  if (parts[0] === "api" && parts[1] === "ai-variant-draft-save") {
    if (req.method === "GET" && parts[2] === "batches" && parts[3]) {
      return json(res, await services.aiVariantDraftSaveBatchDetail(decodeURIComponent(parts[3]), req._session));
    }
    if (req.method === "POST" && parts[2] === "items" && parts[3] && parts[4] === "retry") {
      return json(res, await services.retryAiVariantDraftSaveItem(decodeURIComponent(parts[3]), req._session));
    }
  }
  if (parts[0] !== "api" || parts[1] !== "ai-variant-lab") return false;
  if (req.method === "GET" && parts[2] === "batch-jobs" && parts[3]) {
    return json(res, await services.aiVariantLabBatchJobDetail(decodeURIComponent(parts[3]), req._session, req.query || {}));
  }
  if (req.method === "GET" && parts[2] === "optimize" && parts[3] === "jobs" && parts[4]) {
    return json(res, await services.aiImageOptimizerJobDetail(decodeURIComponent(parts[4]), req._session));
  }
  if (req.method === "GET" && parts[2] === "cases" && parts[3]) {
    return json(res, await services.aiVariantLabCaseDetail(decodeURIComponent(parts[3]), req._session));
  }
  if (req.method === "DELETE" && parts[2] === "cases" && parts[3]) {
    return json(res, await services.aiVariantLabDeleteCase(decodeURIComponent(parts[3]), req._session));
  }
  return false;
}
