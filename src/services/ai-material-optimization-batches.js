import { randomUUID } from "node:crypto";
import { getMysqlPoolMetrics, mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
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

import { aiTenantId, assertCurrentAiTenantPermission, currentAiTenantSession, needsAiTenantSession, withAiTenantRequestGuard, withAiTenantSession } from "./ai-tenant-context.js";
import { assertBusinessTaskPermission, restoreBusinessTaskSession } from "./business-task-tenant.js";
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA, verifyAiMaterialOptimizationSchema } from "./ai-material-optimization-schema.js";

let schemaReady = false;
let workerStarted = false;
let workerTimer = null;
let activeWorkers = 0;
const WORKER_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.AI_MATERIAL_OPTIMIZATION_CONCURRENCY || 4)));
const DETAIL_IMAGE_CONCURRENCY = 3;

export async function ensureAiMaterialOptimizationBatchSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await mysqlExecute(AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA);
    await mysqlExecute(AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA);
    // Existing tables require the explicit administrator migration. Never
    // silently assign historical rows to the current request's enterprise.
    await verifyAiMaterialOptimizationSchema(mysqlQuery);
  })().catch(error => { schemaReady = false; throw error; });
  await schemaReady;
}

async function materialDraftDetail(id, session) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw statusError("草稿编号无效，请重新选择本企业草稿",400);
  try { return await listingDraftDetail(id,session); }
  catch (error) {
    if (/^Listing draft not found$/i.test(String(error?.message || ""))) throw statusError("草稿不存在或不属于当前企业",404);
    throw error;
  }
}

export async function createAiMaterialOptimizationBatch(body = {}, session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => createAiMaterialOptimizationBatch(body, session));
  await ensureAiMaterialOptimizationBatchSchema();
  const draftIds = [...new Set(toArray(body.draftIds || body.draft_ids).map(Number).filter((id) => id > 0))].slice(0, 20);
  if (!draftIds.length) throw statusError("请至少选择一个草稿", 400);
  const scope = body.optimizationScope === "full" || body.optimization_scope === "full" ? "full" : "main_only";
  const submittedItems = new Map(toArray(body.items).map((item) => [Number(item?.draftId || item?.draft_id || 0), item]));
  const factsByDraftId = new Map(draftIds.map((draftId) => [draftId, normalizeOperatorFacts(submittedItems.get(draftId)?.operatorFacts || submittedItems.get(draftId)?.operator_facts)]));
  if (draftIds.some(id => !operatorFactsReady(factsByDraftId.get(id)))) throw statusError("每个草稿都须确认中文精确产品名称和至少 2 条真实卖点", 400);
  // Validate every reference before creating any batch/item. Request-supplied
  // tenant and actor fields have no effect on persisted ownership.
  for (const draftId of draftIds) await materialDraftDetail(draftId, currentAiTenantSession());
  await assertCurrentAiTenantPermission();
  const key = aiTenantId();
  const batchNo = `MAT-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
  await withMysqlTransaction(async connection => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR SHARE",[currentAiTenantSession().tenant.id]);
    for (const draftId of [...draftIds].sort((left,right) => left-right)) {
      const [drafts] = await connection.execute("SELECT id FROM listing_drafts WHERE id = ? AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted' FOR UPDATE", [draftId, key]);
      if (!drafts.length) throw statusError("来源草稿不存在或不属于当前企业", 404);
    }
    const actor = await assertCurrentAiTenantPermission({connection,lock:true});
    await connection.execute(`INSERT INTO ai_material_optimization_batches
      (tenant_id, batch_no, optimization_scope, status, total_count, created_by_person_id) VALUES (?, ?, ?, 'queued', ?, ?)`,
    [key, batchNo, scope, draftIds.length, actor.personId]);
    for (const draftId of draftIds) {
      await connection.execute(`INSERT INTO ai_material_optimization_items
        (tenant_id, item_no, batch_no, source_draft_id, optimization_scope, operator_facts_json, created_by_person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [key, `${batchNo}-${draftId}`, batchNo, draftId, scope, JSON.stringify(factsByDraftId.get(draftId)), actor.personId]);
    }
  });
  startAiMaterialOptimizationWorker();
  scheduleWorker(10);
  return aiMaterialOptimizationBatchDetail(batchNo, currentAiTenantSession());
}

export async function aiMaterialOptimizationBatches(query = {}, session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => aiMaterialOptimizationBatches(query, session));
  await ensureAiMaterialOptimizationBatchSchema();
  const rows = await mysqlQuery("SELECT * FROM ai_material_optimization_batches WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100", [aiTenantId()]);
  await assertCurrentAiTenantPermission();
  return rows.map(mapBatch);
}

export async function aiMaterialOptimizationBatchDetail(batchNo = "", session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => aiMaterialOptimizationBatchDetail(batchNo, session));
  await ensureAiMaterialOptimizationBatchSchema();
  const key = aiTenantId();
  const batches = await mysqlQuery("SELECT * FROM ai_material_optimization_batches WHERE tenant_id = ? AND batch_no = ? LIMIT 1", [key, String(batchNo || "")]);
  if (!batches.length) throw statusError("素材优化批次不存在", 404);
  const items = await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE tenant_id = ? AND batch_no = ? ORDER BY id", [key, batchNo]);
  // Draft references may have changed since submission. Do not expose another
  // enterprise's title/result identifiers through a corrupted historical item.
  for (const item of items) {
    await materialDraftDetail(item.source_draft_id, currentAiTenantSession());
    if (item.result_draft_id) await materialDraftDetail(item.result_draft_id, currentAiTenantSession());
  }
  await assertCurrentAiTenantPermission();
  return { ...mapBatch(batches[0]), items: items.map(mapItem) };
}

export async function retryAiMaterialOptimizationItem(itemNo = "", session = null) {
  if (needsAiTenantSession(session)) return withAiTenantSession(session, () => retryAiMaterialOptimizationItem(itemNo, session));
  await ensureAiMaterialOptimizationBatchSchema();
  const rows = await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE tenant_id = ? AND item_no = ? LIMIT 1", [aiTenantId(), String(itemNo)]);
  const item = rows[0];
  if (!item) throw statusError("素材优化任务不存在", 404);
  if (item.status !== "failed" || unsafeCheckpoint(parseJson(item.checkpoint_json, {}))) throw statusError("该任务仍在运行、已完成或提交结果尚未核实，不能重新付费提交，请先核对原任务", 409);
  // Retry belongs to the persisted actor, not to a different employee's rights.
  const actor = await restoreBusinessTaskSession(item.tenant_id, item.created_by_person_id);
  assertBusinessTaskPermission(actor, "operations");
  await materialDraftDetail(item.source_draft_id, currentAiTenantSession());
  await assertCurrentAiTenantPermission();
  await mysqlExecute(`UPDATE ai_material_optimization_items SET status = 'queued', stage = 'queued', progress_percent = 0,
    error_message = NULL, finished_at = NULL WHERE tenant_id = ? AND id = ? AND status = 'failed'`, [aiTenantId(), item.id]);
  startAiMaterialOptimizationWorker();
  scheduleWorker(10);
  return { ok: true };
}

export async function recoverAiMaterialOptimizationBatchesOnStartup() {
  await ensureAiMaterialOptimizationBatchSchema();
  const rows = await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE status IN ('queued', 'running') ORDER BY id");
  let resumed = 0, paused = 0;
  for (const item of rows) {
    try {
      const actor = await restoreBusinessTaskSession(item.tenant_id, item.created_by_person_id);
      assertBusinessTaskPermission(actor, "operations");
      await withAiTenantSession(actor, async () => {
        await materialDraftDetail(item.source_draft_id, actor);
        if (item.result_draft_id) await materialDraftDetail(item.result_draft_id, actor);
        const batches = await mysqlQuery("SELECT created_by_person_id FROM ai_material_optimization_batches WHERE tenant_id = ? AND batch_no = ?", [item.tenant_id, item.batch_no]);
        if (Number(batches[0]?.created_by_person_id) !== Number(item.created_by_person_id)) throw statusError("批次与任务的原始操作人不一致", 403);
        if (item.status === "running") {
          const checkpoint = parseJson(item.checkpoint_json, {});
          const unknown = unsafeCheckpoint(checkpoint);
          const state = unknown ? "unknown_review" : checkpoint.text_pending ? "paused_review" : "queued";
          await mysqlExecute("UPDATE ai_material_optimization_items SET status = ?, error_message = ? WHERE tenant_id = ? AND id = ? AND status = 'running'", [state,
            state === "queued" ? "已恢复保存的阶段和供应商回执，不重复提交已完成步骤" : "任务执行中发生重启，已保留原始回执和结果；核实后再恢复，不会自动重复计费", item.tenant_id, item.id]);
          if (state === "queued") resumed += 1; else paused += 1;
        } else resumed += 1;
      });
    } catch {
      await mysqlExecute("UPDATE ai_material_optimization_items SET status = 'paused_review', error_message = '企业、原操作人或来源归属待核对，未自动恢复' WHERE id = ? AND tenant_id = ? AND status IN ('queued','running')", [item.id, item.tenant_id]);
      paused += 1;
    }
    await refreshBatch(item.batch_no, item.tenant_id);
  }
  startAiMaterialOptimizationWorker();
  scheduleWorker(100);
  return { ok: true, resumed, paused };
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
    try { await processQueuedItems(); } catch (error) { console.warn("[ai-material-batch] worker failed", error?.code || "worker_error"); }
    finally { if (workerStarted) scheduleWorker(); }
  }, delay);
  workerTimer.unref?.();
}

async function processQueuedItems() {
  await ensureAiMaterialOptimizationBatchSchema();
  while (activeWorkers < adaptiveMaterialWorkerConcurrency()) {
    const item = await claimNextMaterialItem();
    if (!item) return;
    activeWorkers += 1;
    void executeItem(item).finally(() => { activeWorkers = Math.max(0, activeWorkers - 1); scheduleWorker(10); });
  }
}

async function claimNextMaterialItem() {
  const claimToken = `claim:${process.pid}:${randomUUID()}`;
  const claimed = await mysqlExecute(`UPDATE ai_material_optimization_items SET status = 'running', stage = 'claimed', progress_percent = 1,
    error_message = ?, attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE status = 'queued' AND tenant_id <> 'legacy_review' AND created_by_person_id > 0 ORDER BY created_at, id LIMIT 1`, [claimToken]);
  if (!claimed.affectedRows) return null;
  return (await mysqlQuery("SELECT * FROM ai_material_optimization_items WHERE status = 'running' AND error_message = ? LIMIT 1", [claimToken]))[0] || null;
}

async function assertMaterialResources(item, { connection = null, lock = false } = {}) {
  const query = connection ? async (sql, params) => (await connection.execute(sql, params))[0] : mysqlQuery;
  const rows = await query(`SELECT i.id FROM ai_material_optimization_items i
    JOIN ai_material_optimization_batches b ON b.tenant_id = i.tenant_id AND b.batch_no = i.batch_no AND b.created_by_person_id = i.created_by_person_id
    JOIN listing_drafts d ON d.id = i.source_draft_id AND COALESCE(d.tenant_id, 'admin') = i.tenant_id AND d.status <> 'deleted'
    LEFT JOIN listing_drafts r ON r.id = i.result_draft_id AND COALESCE(r.tenant_id, 'admin') = i.tenant_id
    WHERE i.id = ? AND i.tenant_id = ? AND i.created_by_person_id = ? AND i.attempts = ? AND i.status = 'running'
      AND (i.result_draft_id IS NULL OR r.id IS NOT NULL)${connection && lock ? " FOR SHARE" : ""}`, [item.id,item.tenant_id,item.created_by_person_id,Number(item.attempts || 0)]);
  if (!rows.length) throw statusError("素材优化任务、来源草稿或结果归属已变化",409);
}

async function assertMaterialActor(item, { connection = null } = {}) {
  if (connection) await assertMaterialResources(item,{connection,lock:true});
  const actor = await assertCurrentAiTenantPermission(connection ? {connection,lock:true} : {});
  if (!actor || aiTenantId() !== String(item.tenant_id) || Number(actor.personId) !== Number(item.created_by_person_id)) throw statusError("素材优化原操作人或企业不一致",403);
  assertBusinessTaskPermission(actor,"operations");
  if (!connection) await assertMaterialResources(item);
  return actor;
}

async function saveCheckpoint(item, patch) {
  await assertMaterialActor(item);
  return withMysqlTransaction(async connection => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR SHARE",[currentAiTenantSession().tenant.id]);
    const [rows] = await connection.execute("SELECT checkpoint_json FROM ai_material_optimization_items WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running' FOR UPDATE", [item.tenant_id, item.id, Number(item.attempts || 0)]);
    if (!rows.length) throw statusError("素材优化任务已停止", 409);
    await assertMaterialActor(item,{connection});
    const previous = parseJson(rows[0].checkpoint_json, {});
    const next = { ...previous, ...patch, images: { ...previous.images, ...patch.images } };
    await connection.execute("UPDATE ai_material_optimization_items SET checkpoint_json = ? WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [JSON.stringify(next), item.tenant_id, item.id, Number(item.attempts || 0)]);
    return next;
  });
}

// A returned provider receipt is evidence of an already accepted external
// request. Preserve it under the immutable item/actor scope even if membership
// was revoked in flight; this does not authorize another poll or business save.
async function saveProviderReceipt(item, slot, providerJob) {
  const receipt = Object.fromEntries(["provider","channelId","channelName","jobId","statusUrl","endpoint","submittedAt"]
    .filter(key => typeof providerJob?.[key] === "string").map(key => [key, providerJob[key]]));
  if (!receipt.jobId) throw statusError("供应商未返回有效任务回执", 502);
  return withMysqlTransaction(async connection => {
    const [rows] = await connection.execute(`SELECT i.checkpoint_json FROM ai_material_optimization_items i
      JOIN ai_material_optimization_batches b ON b.tenant_id = i.tenant_id AND b.batch_no = i.batch_no AND b.created_by_person_id = i.created_by_person_id
      WHERE i.id = ? AND i.tenant_id = ? AND i.created_by_person_id = ? AND i.attempts = ? AND i.status = 'running' FOR UPDATE`, [item.id,item.tenant_id,item.created_by_person_id,Number(item.attempts || 0)]);
    if (!rows.length) throw statusError("原始素材任务已变化，回执不能写入其他任务",409);
    const previous = parseJson(rows[0].checkpoint_json,{}), image = previous.images?.[slot];
    if (!image || !["submitting","provider_pending"].includes(image.state) || image.provider_job?.jobId && image.provider_job.jobId !== receipt.jobId) {
      throw statusError("供应商回执与原始提交不一致",409);
    }
    const next = {...previous,images:{...previous.images,[slot]:{...image,state:"provider_pending",provider_job:receipt}}};
    await connection.execute("UPDATE ai_material_optimization_items SET checkpoint_json = ? WHERE tenant_id = ? AND id = ? AND created_by_person_id = ? AND attempts = ? AND status = 'running'",[JSON.stringify(next),item.tenant_id,item.id,item.created_by_person_id,Number(item.attempts || 0)]);
  });
}

function unsafeCheckpoint(checkpoint = {}) {
  return checkpoint.draft_state === "submitting" || Boolean(checkpoint.result_draft_id)
    || Object.values(checkpoint.images || {}).some(image => image.state === "submitting" && !image.provider_job?.jobId);
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
  try {
    const session = await restoreBusinessTaskSession(item.tenant_id, item.created_by_person_id);
    assertBusinessTaskPermission(session, "operations");
    await withAiTenantSession(session, () => withAiTenantRequestGuard(options => assertMaterialResources(item,options), () => executeAuthorizedItem(item,session)));
  } catch (error) {
    const rows = await mysqlQuery("SELECT checkpoint_json FROM ai_material_optimization_items WHERE tenant_id = ? AND id = ?", [item.tenant_id, item.id]);
    const review = unsafeCheckpoint(parseJson(rows[0]?.checkpoint_json, {}));
    await mysqlExecute("UPDATE ai_material_optimization_items SET status = ?, stage = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [review ? "unknown_review" : "failed", review ? "unknown_review" : "failed", String(error?.message || "素材优化失败").slice(0, 2000), item.tenant_id, item.id, Number(item.attempts || 0)]);
  } finally { await refreshBatch(item.batch_no, item.tenant_id); }
}

async function executeAuthorizedItem(item, session) {
    await assertMaterialActor(item);
    let checkpoint = parseJson(item.checkpoint_json, {});
    await stage(item, "loading_draft", 5);
    const draft = await materialDraftDetail(item.source_draft_id, session);
    const source = materialSource(draft);
    const sourceImages = [source.mainImage, ...source.detailImages].filter(Boolean);
    if (checkpoint.source_images && JSON.stringify(checkpoint.source_images) !== JSON.stringify(sourceImages)) {
      throw statusError("来源草稿图片已变化，请重新创建优化批次，避免复用旧图片结果", 409);
    }
    checkpoint = await saveCheckpoint(item, { source_images: sourceImages });
    const operatorFacts = normalizeOperatorFacts(parseJson(item.operator_facts_json, {}));
    if (!operatorFactsReady(operatorFacts)) throw new Error("商品文本事实未确认：请填写中文精确产品名称和至少 2 条真实卖点后重试");
    if (!source.mainImage) throw new Error("来源草稿缺少主图");
    if (!draft.template_id && !source.templatePayload?.id) throw new Error("来源草稿缺少上架模板");
    await assertMaterialActor(item);
    await mysqlExecute("UPDATE ai_material_optimization_items SET source_title = ? WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [source.title, item.tenant_id, item.id, Number(item.attempts || 0)]);

    let analysisResult = checkpoint.analysis_result;
    if (!analysisResult) {
      await stage(item, "analyzing", 12);
      await saveCheckpoint(item, { text_pending: "analysis" });
      try {
        analysisResult = await aiImageOptimizerAnalyze({ candidates: source.candidates, sourceDraftId: draft.id, sourceProductId: String(draft.id), sourceImageUrl: source.mainImage, title: operatorFacts.product_title_zh, description: source.description, operatorFacts, forceAnalyze: true }, session);
      } catch (error) {
        if (!isProviderNetworkError(error)) throw error;
        analysisResult = await createFallbackOptimizerAnalysis(item, draft, source, session, error);
      }
      analysisResult.analysis = { ...analysisResult.analysis, operator_confirmed_facts: operatorFacts };
      await stage(item, "confirming_analysis", 22);
      await aiImageOptimizerConfirmAnalysis({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis }, session);
      checkpoint = await saveCheckpoint(item, { analysis_result: analysisResult, text_pending: null });
    }
    await assertMaterialActor(item);
    await mysqlExecute("UPDATE ai_material_optimization_items SET optimizer_job_no = ? WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [analysisResult.job_no, item.tenant_id, item.id, Number(item.attempts || 0)]);
    let planResult = checkpoint.plan_result;
    if (!planResult) {
      await stage(item, "planning", 30);
      await saveCheckpoint(item, { text_pending: "plan" });
      try {
        planResult = await aiImageOptimizerPlan({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis, goal: item.optimization_scope === "main_only" ? "只优化主图，保持其他商品信息不变。" : "完整优化主图、详情图和商品文案。", optimizationLevel: "medium" }, session);
      } catch (error) {
        if (!isProviderNetworkError(error)) throw error;
        planResult = { job_no: analysisResult.job_no, plan: fallbackOptimizationPlan(analysisResult.analysis, source, item.optimization_scope, error) };
      }
      await stage(item, "confirming_plan", 38);
      await aiImageOptimizerConfirmPlan({ jobNo: analysisResult.job_no, analysis: analysisResult.analysis, plan: planResult.plan }, session);
      checkpoint = await saveCheckpoint(item, { plan_result: planResult, text_pending: null });
    }

    await stage(item, "generating_main_image", 48);
    const mainGenerated = await generateOptimizedImage(source.mainImage, planResult.plan.image_optimization_prompt_en, operatorFacts.product_title_zh, item, "main");
    let review = checkpoint.review;
    if (!review) {
      await stage(item, "reviewing_main_image", 58);
      await saveCheckpoint(item, { text_pending: "review" });
      try {
        review = await aiImageOptimizerReviewImage({ generatedImageUrl: mainGenerated, referenceImageUrl: source.mainImage, role: "main", verifiedFacts: planResult.plan.keep_facts, forbiddenChanges: planResult.plan.forbidden_changes }, session);
        if (review.review?.pass === false) throw new Error(`主图质量审核未通过：${(review.review?.issues || []).join("；") || "商品主体或画面质量不符合要求"}`);
      } catch (error) {
        if (!isProviderNetworkError(error)) throw error;
        review = { review: { pass: true, score: 0, issues: [], warnings: ["视觉审核通道网络不可用，已保留生图结果供草稿人工复核"], fallback: true } };
      }
      checkpoint = await saveCheckpoint(item, { review, text_pending: null });
    }

    let detailImages = source.detailImages;
    let copy = { titles: [source.title], tags: source.tags, description: source.description };
    if (item.optimization_scope === "full") {
      await stage(item, "generating_details", 66);
      const detailPromise = mapWithConcurrency(source.detailImages.slice(0, 6), DETAIL_IMAGE_CONCURRENCY, (image, index) => (
        generateOptimizedImage(image, `${planResult.plan.image_optimization_prompt_en}\nCreate coherent detail image ${index + 1}.`, operatorFacts.product_title_zh, item, `detail_${index}`)
      ));
      const copyPromise = checkpoint.copy ? Promise.resolve(checkpoint.copy) : (async () => {
        await saveCheckpoint(item, { text_pending: "copy" });
        let generated;
        try {
          generated = await generateCommerceCopy({ productName: operatorFacts.product_title_zh, categoryName: draft.category_name,
            description: source.description, sourceContext: { analysis: analysisResult.analysis, plan: planResult.plan, operatorFacts } });
        } catch (error) { if (!isProviderNetworkError(error)) throw error; generated = copy; }
        await saveCheckpoint(item, { copy: generated, text_pending: null });
        return generated;
      })();
      // Wait for both branches before marking failure, so a sibling cannot
      // continue downloading or updating a completed/failed item in the background.
      const settled = await Promise.allSettled([detailPromise, copyPromise]);
      const failed = settled.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      [detailImages, copy] = settled.map(result => result.value);
      await stage(item, "generating_copy", 76);
    }

    const images = [mainGenerated, ...detailImages].filter(Boolean);
    const candidates = images.map((url, index) => ({ candidate_id: `batch_${item.id}_${index}`, url, kind: index ? "detail" : "main", source: index ? (item.optimization_scope === "full" ? "optimized" : "original") : "optimized", status: "ready" }));
    const finalImageSlots = candidates.map((candidate, index) => ({ slot: index + 1, role: index ? "detail" : "main", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: index + 1 }));
    await stage(item, "preparing_draft", 84);
    const prepared = await aiProductMaterialOptimizerPrepareTemplate({ candidates, finalImageSlots, templatePayload: source.templatePayload, textResults: { title: copy.titles?.[0] || source.title, tags: copy.tags || source.tags, description: copy.description || source.description }, plan: planResult.plan }, session);
    const offer = await generateListingOfferId({ prefix: "OPT", existingIds: [] }, session);
    const mainOnly = item.optimization_scope === "main_only";
    await stage(item, "creating_draft", 92);
    await saveCheckpoint(item, { draft_state: "submitting" });
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
    await saveCheckpoint(item, { draft_state: "saved", result_draft_id: resultDraftId });
    await aiImageOptimizerSaveResult({ jobNo: analysisResult.job_no, result: { result_draft_id: resultDraftId, images, copy, review: review.review } }, session);
    await assertMaterialActor(item);
    await mysqlExecute("UPDATE ai_material_optimization_items SET status = 'completed', stage = 'completed', progress_percent = 100, result_draft_id = ?, finished_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [resultDraftId, item.tenant_id, item.id, Number(item.attempts || 0)]);
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
  await assertMaterialActor(item);
  await mysqlExecute(`INSERT INTO ai_image_optimizer_jobs
    (tenant_id, job_no, source_image_url, source_product_id, status, model, usage_json, analysis_json, created_by_person_id)
    VALUES (?, ?, ?, ?, 'analyzed', 'draft-facts-fallback', '{}', ?, ?)`,
  [item.tenant_id, jobNo, source.mainImage, String(draft.id), JSON.stringify(analysis), item.created_by_person_id]);
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

async function generateOptimizedImage(sourceImage, prompt, title, item, slot) {
  const rows = await mysqlQuery("SELECT checkpoint_json FROM ai_material_optimization_items WHERE tenant_id = ? AND id = ?", [item.tenant_id, item.id]);
  const previous = parseJson(rows[0]?.checkpoint_json, {}).images?.[slot] || {};
  await assertMaterialActor(item);
  if (previous.state === "completed" && previous.url) return previous.url;
  if (previous.state === "submitting" && !previous.provider_job?.jobId) throw statusError("上次图片提交结果未知，请先核对原供应商任务，不能重复计费", 409);
  await saveCheckpoint(item, { images: { [slot]: { ...previous, state: "submitting" } } });
  const result = await generateImages({ sourceImageUrl: sourceImage,
    finalPrompt: `${prompt || "Optimize this ecommerce product image."}\nExact source product: ${title}. Preserve identity, shape, material, color and quantity. No platform logos or watermarks.`,
    ratio: "3:4", imageCount: 1, autoCrop: false, providerJob: previous.provider_job || null,
    onProviderJob: async providerJob => { await saveProviderReceipt(item, slot, providerJob); await assertMaterialActor(item); }
  });
  await assertMaterialActor(item);
  const url = result.generatedImages?.[0]?.url || result.croppedImages?.[0]?.url || "";
  if (!url) throw statusError("图片服务未返回可用图片，请核对原服务商任务", 502);
  await saveCheckpoint(item, { images: { [slot]: { state: "completed", url, task_id: result.taskId || "" } } });
  return url;
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
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, run));
  const failed = settled.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}

async function stage(item, nextStage, percent) {
  await assertMaterialActor(item);
  await materialDraftDetail(item.source_draft_id, currentAiTenantSession());
  await assertMaterialActor(item);
  await mysqlExecute("UPDATE ai_material_optimization_items SET stage = ?, progress_percent = ? WHERE tenant_id = ? AND id = ? AND attempts = ? AND status = 'running'", [nextStage, percent, item.tenant_id, item.id, Number(item.attempts || 0)]);
}

async function refreshBatch(batchNo, tenantId) {
  const rows = await mysqlQuery(`SELECT COUNT(*) total_count, SUM(status = 'completed') success_count,
    SUM(status IN ('failed','paused_review','unknown_review')) failed_count,
    SUM(status IN ('queued','running')) active_count FROM ai_material_optimization_items WHERE tenant_id = ? AND batch_no = ?`, [tenantId, batchNo]);
  const stats = rows[0] || {};
  const status = Number(stats.active_count || 0) ? "running" : Number(stats.failed_count || 0) && Number(stats.success_count || 0) ? "partial" : Number(stats.failed_count || 0) ? "failed" : "completed";
  await mysqlExecute("UPDATE ai_material_optimization_batches SET status = ?, total_count = ?, success_count = ?, failed_count = ? WHERE tenant_id = ? AND batch_no = ?", [status, Number(stats.total_count || 0), Number(stats.success_count || 0), Number(stats.failed_count || 0), tenantId, batchNo]);
}

function materialSource(draft = {}) {
  const templatePayload = draft.template_payload || {};
  const editable = templatePayload.editable_payload || {};
  const variant = Array.isArray(editable.variants) ? editable.variants[0] || {} : {};
  // listingDraftDetail computes authoritative media, including an explicitly
  // emptied manual set. Never append old collector/template images.
  const images = uniqueUrls([draft.effective_images || []]);
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
function mapItem(row = {}) { return { can_retry: row.status === "failed" && !unsafeCheckpoint(parseJson(row.checkpoint_json, {})), requires_review: ["unknown_review", "paused_review"].includes(row.status) || row.status === "failed" && unsafeCheckpoint(parseJson(row.checkpoint_json, {})), item_no: row.item_no, batch_no: row.batch_no, source_draft_id: Number(row.source_draft_id || 0), result_draft_id: Number(row.result_draft_id || 0) || null, optimizer_job_no: row.optimizer_job_no || "", optimization_scope: row.optimization_scope, operator_facts: normalizeOperatorFacts(parseJson(row.operator_facts_json, {})), status: row.status, stage: row.stage, progress_percent: Number(row.progress_percent || 0), source_title: row.source_title || "", error_message: row.error_message || "", attempts: Number(row.attempts || 0), started_at: row.started_at, finished_at: row.finished_at, created_at: row.created_at, updated_at: row.updated_at }; }
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
