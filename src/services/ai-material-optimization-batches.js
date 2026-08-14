import { randomUUID } from "node:crypto";
import { getMysqlPoolMetrics, mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { generateCommerceCopy, generateImages } from "../server/services/ai/aiWorkflowService.js";
import {
  aiImageOptimizerAnalyze,
  aiImageOptimizerConfirmAnalysis,
  aiImageOptimizerConfirmPlan,
  aiImageOptimizerPlan,
  aiImageOptimizerReviewImage,
  aiImageOptimizerSaveResult,
  aiProductMaterialOptimizerPrepareTemplate
} from "./ai-variant-lab.js";
import {
  createAiVariantListingDraftLightweight,
  generateListingOfferId,
  listingDraftDetail
} from "./listing-automation.js";

let schemaReady = false;
let workerStarted = false;
let workerTimer = null;
let activeWorkers = 0;
const WORKER_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.AI_MATERIAL_OPTIMIZATION_CONCURRENCY || 4)));
const DETAIL_IMAGE_CONCURRENCY = 3;

export async function ensureAiMaterialOptimizationBatchSchema() {
  if (schemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_material_optimization_batches (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      batch_no VARCHAR(64) NOT NULL,
      optimization_scope VARCHAR(32) NOT NULL DEFAULT 'main_only',
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      total_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_material_batch_no (batch_no),
      INDEX idx_ai_material_batch_owner (created_by_person_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_material_optimization_items (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      item_no VARCHAR(64) NOT NULL,
      batch_no VARCHAR(64) NOT NULL,
      source_draft_id BIGINT NOT NULL,
      result_draft_id BIGINT NULL,
      optimizer_job_no VARCHAR(64) NOT NULL DEFAULT '',
      optimization_scope VARCHAR(32) NOT NULL DEFAULT 'main_only',
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      stage VARCHAR(64) NOT NULL DEFAULT 'queued',
      progress_percent INT NOT NULL DEFAULT 0,
      source_title VARCHAR(500) NOT NULL DEFAULT '',
      operator_facts_json LONGTEXT NULL,
      error_message TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_by_person_id BIGINT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_material_item_no (item_no),
      INDEX idx_ai_material_item_batch (batch_no, id),
      INDEX idx_ai_material_item_queue (status, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute("ALTER TABLE ai_material_optimization_items ADD COLUMN operator_facts_json LONGTEXT NULL AFTER source_title")
    .catch((error) => { if (error?.code !== "ER_DUP_FIELDNAME") throw error; });
  schemaReady = true;
}

export async function createAiMaterialOptimizationBatch(body = {}, session = null) {
  await ensureAiMaterialOptimizationBatchSchema();
  const draftIds = [...new Set(toArray(body.draftIds || body.draft_ids).map(Number).filter((id) => id > 0))].slice(0, 20);
  if (!draftIds.length) throw statusError("请至少选择一个草稿", 400);
  const scope = body.optimizationScope === "full" || body.optimization_scope === "full" ? "full" : "main_only";
  const submittedItems = new Map(toArray(body.items).map((item) => [Number(item?.draftId || item?.draft_id || 0), item]));
  const factsByDraftId = new Map(draftIds.map((draftId) => [draftId, normalizeOperatorFacts(submittedItems.get(draftId)?.operatorFacts || submittedItems.get(draftId)?.operator_facts)]));
  const invalidDraftIds = draftIds.filter((draftId) => !operatorFactsReady(factsByDraftId.get(draftId)));
  if (invalidDraftIds.length) throw statusError(`以下草稿缺少已确认的中文精确产品名称或至少 2 条卖点：${invalidDraftIds.join(", ")}`, 400);
  const batchNo = `MAT-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const personId = Number(session?.personId || session?.id || 0) || null;
  await mysqlExecute(`INSERT INTO ai_material_optimization_batches
    (batch_no, optimization_scope, status, total_count, created_by_person_id) VALUES (?, ?, 'queued', ?, ?)`,
  [batchNo, scope, draftIds.length, personId]);
  for (const draftId of draftIds) {
    await mysqlExecute(`INSERT INTO ai_material_optimization_items
      (item_no, batch_no, source_draft_id, optimization_scope, operator_facts_json, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [`${batchNo}-${draftId}`, batchNo, draftId, scope, JSON.stringify(factsByDraftId.get(draftId)), personId]);
  }
  startAiMaterialOptimizationWorker();
  scheduleWorker(10);
  return aiMaterialOptimizationBatchDetail(batchNo, session);
}

export async function aiMaterialOptimizationBatches(query = {}, session = null) {
  await ensureAiMaterialOptimizationBatchSchema();
  startAiMaterialOptimizationWorker();
  const owner = Number(session?.personId || session?.id || 0) || 0;
  const rows = await mysqlQuery(`SELECT * FROM ai_material_optimization_batches
    ${owner ? "WHERE created_by_person_id = ?" : ""}
    ORDER BY created_at DESC LIMIT 100`, owner ? [owner] : []);
  return rows.map(mapBatch);
}

export async function aiMaterialOptimizationBatchDetail(batchNo = "", session = null) {
  await ensureAiMaterialOptimizationBatchSchema();
  const owner = Number(session?.personId || session?.id || 0) || 0;
  const params = [String(batchNo || ""), ...(owner ? [owner] : [])];
  const batches = await mysqlQuery(`SELECT * FROM ai_material_optimization_batches WHERE batch_no = ?${owner ? " AND created_by_person_id = ?" : ""} LIMIT 1`, params);
  if (!batches.length) throw statusError("素材优化批次不存在", 404);
  const items = await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE batch_no = ? ORDER BY id", [batchNo]);
  return { ...mapBatch(batches[0]), items: items.map(mapItem) };
}

export async function retryAiMaterialOptimizationItem(itemNo = "", session = null) {
  await ensureAiMaterialOptimizationBatchSchema();
  const owner = Number(session?.personId || session?.id || 0) || 0;
  await mysqlExecute(`UPDATE ai_material_optimization_items SET status = 'queued', stage = 'queued', progress_percent = 0,
    error_message = NULL, result_draft_id = NULL, finished_at = NULL
    WHERE item_no = ? AND status = 'failed'${owner ? " AND created_by_person_id = ?" : ""}`, [itemNo, ...(owner ? [owner] : [])]);
  startAiMaterialOptimizationWorker();
  scheduleWorker(10);
  return { ok: true };
}

export async function recoverAiMaterialOptimizationBatchesOnStartup() {
  await ensureAiMaterialOptimizationBatchSchema();
  await mysqlExecute("UPDATE ai_material_optimization_items SET status = 'queued', stage = 'queued', progress_percent = 0 WHERE status = 'running'");
  startAiMaterialOptimizationWorker();
  scheduleWorker(100);
  return { ok: true };
}

export function startAiMaterialOptimizationWorker() {
  if (workerStarted) return;
  workerStarted = true;
  scheduleWorker(100);
}

function scheduleWorker(delay = 1200) {
  if (workerTimer) return;
  workerTimer = setTimeout(async () => {
    workerTimer = null;
    try { await processQueuedItems(); } catch (error) { console.warn("[ai-material-batch] worker failed", error); }
    finally { if (workerStarted) scheduleWorker(); }
  }, delay);
  workerTimer.unref?.();
}

async function processQueuedItems() {
  const concurrency = adaptiveMaterialWorkerConcurrency();
  while (activeWorkers < concurrency) {
    const item = await claimNextMaterialItem();
    if (!item) return;
    activeWorkers += 1;
    void executeItem(item).finally(() => {
      activeWorkers = Math.max(0, activeWorkers - 1);
      scheduleWorker(10);
    });
  }
}

async function claimNextMaterialItem() {
  const claimToken = `claim:${process.pid}:${randomUUID()}`;
  const claimed = await mysqlExecute(`UPDATE ai_material_optimization_items
    SET status = 'running', stage = 'claimed', progress_percent = 1,
        error_message = ?, attempts = attempts + 1,
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE status = 'queued'
    ORDER BY created_at, id
    LIMIT 1`, [claimToken]);
  if (!claimed.affectedRows) return null;
  const rows = await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE status = 'running' AND error_message = ? LIMIT 1", [claimToken]);
  return rows[0] || null;
}

function adaptiveMaterialWorkerConcurrency() {
  const memory = process.memoryUsage();
  const rssMb = memory.rss / 1024 / 1024;
  const pool = getMysqlPoolMetrics();
  let limit = WORKER_CONCURRENCY;
  if (rssMb >= 1400) limit = 1;
  else if (rssMb >= 1100) limit = Math.min(limit, 2);
  else if (rssMb >= 850) limit = Math.min(limit, 3);
  if (pool.activeConnections >= pool.connectionLimit - 1) limit = Math.min(limit, 1);
  else if (pool.activeConnections >= pool.connectionLimit - 3) limit = Math.min(limit, 2);
  return Math.max(1, limit);
}

async function executeItem(item) {
  const session = { personId: Number(item.created_by_person_id || 0) || null };
  try {
    await stage(item.id, "loading_draft", 5);
    const draft = await listingDraftDetail(item.source_draft_id, session);
    const source = materialSource(draft);
    const operatorFacts = normalizeOperatorFacts(parseJson(item.operator_facts_json, {}));
    if (!operatorFactsReady(operatorFacts)) throw new Error("商品文本事实未确认：请填写中文精确产品名称和至少 2 条真实卖点后重试");
    if (!source.mainImage) throw new Error("来源草稿缺少主图");
    if (!draft.template_id && !source.templatePayload?.id) throw new Error("来源草稿缺少上架模板");
    await mysqlExecute("UPDATE ai_material_optimization_items SET source_title = ? WHERE id = ?", [source.title, item.id]);

    await stage(item.id, "analyzing", 12);
    let analysisResult;
    try {
      analysisResult = await aiImageOptimizerAnalyze({ candidates: source.candidates, sourceProductId: String(draft.id), sourceImageUrl: source.mainImage, title: operatorFacts.product_title_zh, description: source.description, operatorFacts, forceAnalyze: true }, session);
    } catch (error) {
      if (!isProviderNetworkError(error)) throw error;
      analysisResult = await createFallbackOptimizerAnalysis(item, draft, source, session, error);
    }
    await mysqlExecute("UPDATE ai_material_optimization_items SET optimizer_job_no = ? WHERE id = ?", [analysisResult.job_no, item.id]);
    analysisResult.analysis = { ...analysisResult.analysis, operator_confirmed_facts: operatorFacts };
    await stage(item.id, "confirming_analysis", 22);
    await aiImageOptimizerConfirmAnalysis({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis }, session);
    await stage(item.id, "planning", 30);
    let planResult;
    try {
      planResult = await aiImageOptimizerPlan({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis, goal: item.optimization_scope === "main_only" ? "只优化主图，保持其他商品信息不变。" : "完整优化主图、详情图和商品文案。", optimizationLevel: "medium" }, session);
    } catch (error) {
      if (!isProviderNetworkError(error)) throw error;
      planResult = { job_no: analysisResult.job_no, plan: fallbackOptimizationPlan(analysisResult.analysis, source, item.optimization_scope, error) };
    }
    await stage(item.id, "confirming_plan", 38);
    await aiImageOptimizerConfirmPlan({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis, plan: planResult.plan }, session);

    await stage(item.id, "generating_main_image", 48);
    const mainGenerated = await generateOptimizedImage(source.mainImage, planResult.plan.image_optimization_prompt_en, operatorFacts.product_title_zh);
    await stage(item.id, "reviewing_main_image", 58);
    let review;
    try {
      review = await aiImageOptimizerReviewImage({ generatedImageUrl: mainGenerated, referenceImageUrl: source.mainImage, role: "main", verifiedFacts: planResult.plan.keep_facts, forbiddenChanges: planResult.plan.forbidden_changes });
      if (review.review?.pass === false) throw new Error(`主图质量审核未通过：${(review.review?.issues || []).join("；") || "商品主体或画面质量不符合要求"}`);
    } catch (error) {
      if (!isProviderNetworkError(error)) throw error;
      review = { review: { pass: true, score: 0, issues: [], warnings: ["视觉审核通道网络不可用，已保留生图结果供草稿人工复核"], fallback: true } };
    }

    let detailImages = source.detailImages;
    let copy = { titles: [source.title], tags: source.tags, description: source.description };
    if (item.optimization_scope === "full") {
      await stage(item.id, "generating_details", 66);
      const detailPromise = mapWithConcurrency(source.detailImages.slice(0, 6), DETAIL_IMAGE_CONCURRENCY, (image, index) => (
        generateOptimizedImage(image, `${planResult.plan.image_optimization_prompt_en}\nCreate coherent detail image ${index + 1}.`, operatorFacts.product_title_zh)
      ));
      const copyPromise = generateCommerceCopy({
        productName: operatorFacts.product_title_zh,
        categoryName: draft.category_name,
        description: source.description,
        sourceContext: { analysis: analysisResult.analysis, plan: planResult.plan, operatorFacts }
      }).catch((error) => {
        if (!isProviderNetworkError(error)) throw error;
        return copy;
      });
      [detailImages, copy] = await Promise.all([detailPromise, copyPromise]);
      await stage(item.id, "generating_copy", 76);
    }

    const images = [mainGenerated, ...detailImages].filter(Boolean);
    const candidates = images.map((url, index) => ({ candidate_id: `batch_${item.id}_${index}`, url, kind: index ? "detail" : "main", source: index ? (item.optimization_scope === "full" ? "optimized" : "original") : "optimized", status: "ready" }));
    const finalImageSlots = candidates.map((candidate, index) => ({ slot: index + 1, role: index ? "detail" : "main", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: index + 1 }));
    await stage(item.id, "preparing_draft", 84);
    const prepared = await aiProductMaterialOptimizerPrepareTemplate({ candidates, finalImageSlots, templatePayload: source.templatePayload, textResults: { title: copy.titles?.[0] || source.title, tags: copy.tags || source.tags, description: copy.description || source.description }, plan: planResult.plan });
    const offer = await generateListingOfferId({ prefix: "OPT", existingIds: [] }, session);
    const mainOnly = item.optimization_scope === "main_only";
    await stage(item.id, "creating_draft", 92);
    const resultDraft = await createAiVariantListingDraftLightweight({
      template_id: draft.template_id,
      template_payload: prepared.template_patch,
      source_draft_id: draft.id,
      clone_source_draft: true,
      development_type: "copy",
      product_name: copy.titles?.[0] || source.title,
      offer_id: offer.offerId,
      internal_code: offer.offerId,
      source_images: images,
      patch: mainOnly ? { offer_id: offer.offerId, images } : { offer_id: offer.offerId, title: copy.titles?.[0], description: copy.description, tags: copy.tags, images },
      manual_facts: { source_draft_id: draft.id, source_main_image_url: mainGenerated, optimizer_job_no: analysisResult.job_no, material_batch_no: item.batch_no, operator_product_facts: operatorFacts },
      ai_optimization: { source: "ai_material_optimization_batch", job_no: analysisResult.job_no, analysis: analysisResult.analysis, plan: planResult.plan, review: review.review },
      changed_fields: mainOnly ? ["offer_id", "images"] : ["offer_id", "title", "description", "tags", "images"]
    }, session);
    const resultDraftId = Number(resultDraft.id || resultDraft.draft_id || 0);
    await aiImageOptimizerSaveResult({ jobNo: analysisResult.job_no, result: { result_draft_id: resultDraftId, images, copy, review: review.review } }, session);
    await mysqlExecute("UPDATE ai_material_optimization_items SET status = 'completed', stage = 'completed', progress_percent = 100, result_draft_id = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [resultDraftId, item.id]);
  } catch (error) {
    await mysqlExecute("UPDATE ai_material_optimization_items SET status = 'failed', stage = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [String(error?.message || error || "素材优化失败").slice(0, 2000), item.id]);
  } finally {
    await refreshBatch(item.batch_no);
  }
}

async function createFallbackOptimizerAnalysis(item, draft, source, session, error) {
  const jobNo = `OPTJOB-BATCH-${item.id}-${Date.now().toString(36).toUpperCase()}`;
  const analysis = {
    product_type: draft.category_name || source.title || "当前商品",
    keep_facts: [source.title, source.description].filter(Boolean),
    current_problems: ["原主图需要提升商品主体清晰度、构图层次和电商点击表现"],
    improvement_opportunities: ["保持商品事实不变，优化背景、光线、留白和视觉层级"],
    forbidden_changes: ["不得改变商品主体、材质、颜色、数量、结构和适配关系", "不得新增未经确认的配件、认证或卖点"],
    optimization_goals: ["提升主图点击率和商品识别度"],
    quality_risks: ["视觉识别通道网络不可用，方案依据草稿已保存事实生成"],
    confidence: 0.55,
    fallback_reason: String(error?.cause?.message || error?.message || "AI provider unavailable")
  };
  await mysqlExecute(`INSERT INTO ai_image_optimizer_jobs
    (job_no, source_image_url, source_product_id, status, model, usage_json, analysis_json, created_by_person_id)
    VALUES (?, ?, ?, 'analyzed', 'draft-facts-fallback', '{}', ?, ?)`,
  [jobNo, source.mainImage, String(draft.id), JSON.stringify(analysis), Number(session?.personId || 0) || null]);
  return { ok: true, job_no: jobNo, analysis, fallback: true };
}

function fallbackOptimizationPlan(analysis, source, scope, error) {
  const overlayTitle = String(source.title || "").replace(/^\[SKU:[^\]]+\]\s*/i, "").trim();
  return {
    optimization_type: scope === "main_only" ? "main_image_only" : "full_material_optimization",
    keep_facts: analysis.keep_facts || [],
    current_problems: analysis.current_problems || [],
    optimization_goals: analysis.optimization_goals || [],
    forbidden_changes: analysis.forbidden_changes || [],
    image_optimization_prompt_en: [
      "Create a premium Ozon ecommerce image for the exact source product.",
      "Keep the product body, shape, material, color, quantity, printed marks and verified compatibility unchanged.",
      "Improve the commercial background, studio lighting, spacing, contrast and mobile thumbnail clarity.",
      "Use a clean 3:4 portrait composition with the product as the dominant visual.",
      `Add a clearly readable Russian product headline using this exact verified title: \"${overlayTitle}\".`,
      "Add exactly 2 or 3 short Russian benefit captions derived only from the verified source description below.",
      "Use a strong mobile-readable typography hierarchy and place text in available negative space without covering the product.",
      "Do not invent accessories, compatibility, specifications, claims, logos or certifications. Do not use Chinese, English filler or random text.",
      `Source listing title: ${source.title}.`,
      source.description ? `Verified source description: ${source.description.slice(0, 1200)}.` : ""
    ].filter(Boolean).join("\n"),
    main_overlay_ru: {
      title_ru: overlayTitle,
      benefits_ru: ["仅根据草稿中的已验证描述提炼 2–3 条简短俄文卖点"]
    },
    negative_prompt_en: "No product identity change. No wrong material, color, quantity or geometry. No extra accessories. No platform logos. No Chinese, English filler, random letters or unreadable text.",
    quality_checks: ["商品主体与来源一致", "材质、颜色、数量和结构未改变", "主图为清晰的 3:4 电商构图", "包含清晰可读的俄文标题和 2–3 条真实简短卖点"],
    fallback_reason: String(error?.cause?.message || error?.message || "AI provider unavailable")
  };
}

function isProviderNetworkError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|socket|timeout/i.test(text);
}

async function generateOptimizedImage(sourceImage, prompt, title) {
  const result = await generateImages({ sourceImageUrl: sourceImage, finalPrompt: `${prompt || "Optimize this ecommerce product image."}\nExact source product: ${title}. Preserve identity, shape, material, color and quantity. No platform logos or watermarks.`, ratio: "3:4", imageCount: 1, autoCrop: false });
  return result.generatedImages?.[0]?.url || result.croppedImages?.[0]?.url || "";
}

async function mapWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

async function stage(id, nextStage, percent) {
  await mysqlExecute("UPDATE ai_material_optimization_items SET stage = ?, progress_percent = ? WHERE id = ?", [nextStage, percent, id]);
}

async function refreshBatch(batchNo) {
  const rows = await mysqlQuery(`SELECT COUNT(*) total_count, SUM(status = 'completed') success_count, SUM(status = 'failed') failed_count, SUM(status IN ('queued','running')) active_count FROM ai_material_optimization_items WHERE batch_no = ?`, [batchNo]);
  const stats = rows[0] || {};
  const status = Number(stats.active_count || 0) ? "running" : Number(stats.failed_count || 0) && Number(stats.success_count || 0) ? "partial" : Number(stats.failed_count || 0) ? "failed" : "completed";
  await mysqlExecute("UPDATE ai_material_optimization_batches SET status = ?, total_count = ?, success_count = ?, failed_count = ? WHERE batch_no = ?", [status, Number(stats.total_count || 0), Number(stats.success_count || 0), Number(stats.failed_count || 0), batchNo]);
}

function materialSource(draft = {}) {
  const templatePayload = draft.template_payload || {};
  const editable = templatePayload.editable_payload || {};
  const variant = Array.isArray(editable.variants) ? editable.variants[0] || {} : {};
  const images = uniqueUrls([variant.primary_image, variant.images, editable.primary_image, editable.images, draft.source_images, draft.manual_facts?.images, templatePayload.images]);
  const title = String(editable.title || variant.title || draft.product_name || templatePayload.title || "").trim();
  return { templatePayload, title, description: String(editable.description || draft.manual_facts?.description || templatePayload.description || "").trim(), tags: toArray(editable.tags || editable.hashtags || draft.manual_facts?.tags).map(String), mainImage: images[0] || "", detailImages: images.slice(1), candidates: images.map((url, index) => ({ candidate_id: `source_${draft.id}_${index}`, url, kind: index ? "detail" : "main", source: "original", status: "ready" })) };
}

function uniqueUrls(values) {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") return visit(value.url || value.image_url || value.src || "");
    const text = String(value || "").trim();
    if (text && !out.includes(text)) out.push(text);
  };
  values.forEach(visit);
  return out;
}

function mapBatch(row = {}) { return { batch_no: row.batch_no, optimization_scope: row.optimization_scope, status: row.status, total_count: Number(row.total_count || 0), success_count: Number(row.success_count || 0), failed_count: Number(row.failed_count || 0), created_at: row.created_at, updated_at: row.updated_at }; }
function mapItem(row = {}) { return { item_no: row.item_no, batch_no: row.batch_no, source_draft_id: Number(row.source_draft_id || 0), result_draft_id: Number(row.result_draft_id || 0) || null, optimizer_job_no: row.optimizer_job_no || "", optimization_scope: row.optimization_scope, operator_facts: normalizeOperatorFacts(parseJson(row.operator_facts_json, {})), status: row.status, stage: row.stage, progress_percent: Number(row.progress_percent || 0), source_title: row.source_title || "", error_message: row.error_message || "", attempts: Number(row.attempts || 0), started_at: row.started_at, finished_at: row.finished_at, created_at: row.created_at, updated_at: row.updated_at }; }
function normalizeOperatorFacts(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    product_title_zh: String(source.product_title_zh || source.productTitleZh || "").trim(),
    compatibility_zh: toArray(source.compatibility_zh || source.compatibilityZh).map(String).map((item) => item.trim()).filter(Boolean),
    selling_points_zh: toArray(source.selling_points_zh || source.sellingPointsZh).map(String).map((item) => item.trim()).filter(Boolean),
    forbidden_facts_zh: toArray(source.forbidden_facts_zh || source.forbiddenFactsZh).map(String).map((item) => item.trim()).filter(Boolean),
    confirmed_by_operator: source.confirmed_by_operator === true || source.confirmedByOperator === true
  };
}
function operatorFactsReady(value = {}) { return Boolean(value.product_title_zh && value.selling_points_zh?.length >= 2 && value.confirmed_by_operator); }
function parseJson(value, fallback) { if (!value) return fallback; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return fallback; } }
function toArray(value) { if (Array.isArray(value)) return value.flat(Infinity); if (value == null || value === "") return []; if (typeof value === "string" && value.includes(",")) return value.split(","); return [value]; }
function statusError(message, status) { const error = new Error(message); error.status = status; return error; }
