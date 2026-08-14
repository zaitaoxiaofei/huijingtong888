import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { chatWithAiProvider, visionWithAiProvider } from "./ai-provider-settings.js";
import { generateImages } from "../server/services/ai/aiWorkflowService.js";
import { aiImageRuntimePoolConfig } from "./ai-provider-settings.js";
import { materializeListingMediaAssetUrl } from "./listing-automation.js";
import { putContentAddressedObject } from "./object-storage.js";
import { adaptiveAiImageConcurrency, aiImageRuntimeMetrics } from "./ai-image-runtime-limiter.js";

const DEFAULT_TEMPLATE_KEY = "generic_vehicle_accessory_variant";
const SILL_PLATE_TEMPLATE_KEY = "sill_plate_vehicle_variant";
const JSON_OBJECT_RE = /\{[\s\S]*\}/;
const AI_VARIANT_IMAGE_TIMEOUT_MS = 300_000;
const runningBatchImageJobs = new Set();
const pendingBatchImageJobWakeups = new Set();
const pendingBatchImageResumeTimers = new Map();
const UNKNOWN_FACT_RE = /(^|[\s,;:()[\]{}"'`|/\\-])(uncertain|unknown|not\s+sure|not\s+visible|unclear|n\/a|na|null|undefined|未识别|不确定|未知|无法判断|看不清|不清楚)(?=$|[\s,;:()[\]{}"'`|/\\-])/i;
const INTERNAL_COPY_LEAK_RE = /(исходн(?:ого|ому|ой|ую)|проверенн(?:ые|ых)\s+факт|только\s+целевая\s+модель|меняется\s+только|source\s+(?:product|item|card)|original\s+(?:product|item|card)|verified\s+facts|only\s+the\s+target\s+model|原商品|原始商品|原卡片|源商品|已验证事实|只改(?:变)?车型|仅改变车型)/i;
const GLOBAL_IMAGE_BASELINE_NEGATIVE_RULES = [
  "No watermark.",
  "No fake certification badge.",
  "No platform logo.",
  "No marketplace names or platform-sensitive words such as Ozon, Wildberries, AliExpress, marketplace, or seller-service wording.",
  "No misleading official authorization.",
  "No exaggerated or unverifiable claims.",
  "No distorted product geometry.",
  "No gibberish text.",
  "No Chinese text or Chinese characters.",
  "No extra accessories not present in the reference image."
];
const IMAGE_TEMPLATE_PROFILES = {
  ozon_poster: {
    key: "ozon_poster",
    name: "Ozon poster layout",
    rules: [
      "Use the reference image as a poster layout template, not as product truth.",
      "Preserve the poster composition hierarchy, main product placement, product scale, lighting direction, and premium ecommerce advertising feel.",
      "Keep existing non-conflicting text block positions, badge positions, selling-point module positions, and right-top whitespace style when the reference image has them.",
      "Only replace the configured target vehicle/model text fields and editable background vehicle atmosphere.",
      "Do not let template style change recognized product material, quantity, shape, curvature, thickness, texture, highlight, reflection, or printed marks."
    ]
  },
  product_scene: {
    key: "product_scene",
    name: "Product scene layout",
    rules: [
      "Use the reference image as a product-scene composition template.",
      "Preserve product placement, angle, scale, realistic lighting, shadow direction, and commercial photography style.",
      "Background and vehicle cues may support the target model but must stay secondary.",
      "Do not let scene style change recognized product material, quantity, shape, curvature, thickness, texture, highlight, reflection, or printed marks."
    ]
  },
  clean_product: {
    key: "clean_product",
    name: "Clean product layout",
    rules: [
      "Use a clean ecommerce product layout with the product as the clear visual focus.",
      "Preserve product placement, angle, scale, realistic lighting, shadow direction, and commercial photography style.",
      "Keep background simple and lower priority than the product.",
      "Do not let clean-layout style change recognized product material, quantity, shape, curvature, thickness, texture, highlight, reflection, or printed marks."
    ]
  }
};

export async function aiVariantLabAnalyzeImage(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const businessMode = cleanText(body.businessMode || body.business_mode || "vehicle_model_variant");
  const sourceImageUrl = cleanText(body.sourceImageUrl || body.imageUrl || body.imagePath || "");
  const sourceProductId = cleanText(body.sourceProductId || body.source_product_id || "");
  if (body.lookupOnly || body.lookup_only) {
    const reusable = await findReusableVariantAnalysis({ sourceProductId, sourceImageUrl, businessMode });
    return reusable || { ok: true, reusable: false };
  }
  const reusable = shouldReuseAnalysis(body)
    ? await findReusableVariantAnalysis({ sourceProductId, sourceImageUrl, businessMode })
    : null;
  if (reusable) return reusable;
  const imageUrl = await resolveImageUrl(body);
  const prompt = buildAnalyzePrompt(body, businessMode);
  const result = await visionWithAiProvider({
    temperature: 0.1,
    maxTokens: 1400,
    timeoutMs: 180_000,
    messages: [
      { role: "system", content: analyzeSystemPrompt() },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ]
  });
  const analysis = parseJsonObject(result.content, {
    raw_text: result.content,
    parse_error: true
  });
  const gatedAnalysis = applyProductFactGate(analysis);
  const templateMatch = inferTemplateMatch(gatedAnalysis);
  const productFactContract = buildProductFactContract(gatedAnalysis, body);
  const enrichedAnalysis = {
    ...gatedAnalysis,
    product_fact_contract: gatedAnalysis.product_fact_contract || productFactContract,
    template_match: gatedAnalysis.template_match || templateMatch,
    recommended_template_key: gatedAnalysis.recommended_template_key || templateMatch.template_key
  };
  const analysisNo = body.analysisNo || body.analysis_no || makeNo("AVL-A");
  await mysqlExecute(`
    INSERT INTO ai_variant_lab_analyses
    (analysis_no, source_image_url, source_product_id, business_mode, model, usage_json, analysis_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_image_url = VALUES(source_image_url),
      source_product_id = VALUES(source_product_id),
      business_mode = VALUES(business_mode),
      model = VALUES(model),
      usage_json = VALUES(usage_json),
      analysis_json = VALUES(analysis_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    analysisNo,
    sourceImageUrl,
    sourceProductId,
    businessMode,
    result.model || "",
    JSON.stringify(result.usage || {}),
    JSON.stringify(enrichedAnalysis),
    personId(session)
  ]);
  return {
    ok: true,
    analysis_no: analysisNo,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    analysis: enrichedAnalysis
  };
}

export async function aiVariantLabAnalysisLookup(body = {}) {
  await ensureAiVariantLabSchema();
  const sourceImageUrl = cleanText(body.sourceImageUrl || body.imageUrl || body.imagePath || "");
  const sourceProductId = cleanText(body.sourceProductId || body.source_product_id || "");
  const businessMode = cleanText(body.businessMode || body.business_mode || "vehicle_model_variant");
  return await findReusableVariantAnalysis({ sourceProductId, sourceImageUrl, businessMode }) || { ok: true, reusable: false };
}

export async function aiVariantLabPlanVariant(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const analysis = await resolveAnalysis(body);
  const targetVariantValue = cleanText(body.targetVariantValue || body.target_variant_value || body.targetModel || body.target_model);
  if (!targetVariantValue) throw statusError("targetVariantValue is required", 400);
  const sourceVariantValue = cleanText(body.sourceVariantValue || body.source_variant_value || analysis.source_variant_value || analysis.sourceVehicleModel || analysis.source_vehicle_model || "");
  const sourceTitle = sourceListingTitle(body);
  const template = await findTemplate(body.templateKey || body.template_key || analysis.recommended_template_key || DEFAULT_TEMPLATE_KEY);
  const planRequest = {
    temperature: 0.12,
    maxTokens: 1700,
    messages: [
      { role: "system", content: planSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          business_goal: "Controlled SKU fission for Ozon product listing.",
          source_variant_value: sourceVariantValue,
          target_variant_value: targetVariantValue,
          analysis,
          reusable_template: template?.template_json || null,
          operator_note: cleanText(body.operatorNote || body.operator_note || "")
        }, null, 2)
      }
    ]
  };
  const result = await callOptimizerPlanWithRetry(planRequest);
  const plan = parseJsonObject(result.content, { raw_text: result.content, parse_error: true });
  const enrichedPlan = normalizeVariantPlan(plan, analysis, {
    sourceVariantValue,
    targetVariantValue,
    sourceTitle,
    templateKey: template?.template_key || analysis.recommended_template_key || DEFAULT_TEMPLATE_KEY,
    operatorNote: cleanText(body.operatorNote || body.operator_note || "")
  });
  const planNo = body.planNo || body.plan_no || makeNo("AVL-P");
  await mysqlExecute(`
    INSERT INTO ai_variant_lab_plans
    (plan_no, analysis_no, source_variant_value, target_variant_value, template_key, model, usage_json, plan_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      analysis_no = VALUES(analysis_no),
      source_variant_value = VALUES(source_variant_value),
      target_variant_value = VALUES(target_variant_value),
      template_key = VALUES(template_key),
      model = VALUES(model),
      usage_json = VALUES(usage_json),
      plan_json = VALUES(plan_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    planNo,
    cleanText(body.analysisNo || body.analysis_no || ""),
    enrichedPlan.source_variant_value,
    enrichedPlan.target_variant_value,
    enrichedPlan.template_key,
    result.model || "",
    JSON.stringify(result.usage || {}),
    JSON.stringify(enrichedPlan),
    personId(session)
  ]);
  return {
    ok: true,
    plan_no: planNo,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    plan: enrichedPlan
  };
}

export async function aiVariantLabGenerateCopyContract(body = {}, session = {}) {
  const plan = body.plan || await resolvePlan(body);
  const analysis = body.analysis || await resolveAnalysis(body).catch(() => ({}));
  const contract = buildCopyContract(plan || {}, analysis || {}, body);
  return {
    ok: true,
    copy_contract: contract,
    session_person_id: personId(session)
  };
}

export async function aiVariantLabBatchPlan(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const targets = normalizeTargetValues(body.targetModels || body.target_models || body.targets);
  if (!targets.length) throw statusError("targetModels is required", 400);
  const analysisResult = await resolveOrCreateAnalysis(body, session);
  const operatorNote = cleanText(body.operatorNote || body.operator_note || "");
  const analysis = applyOperatorFactOverrides(analysisResult.analysis, operatorNote);
  const sourceVariantValue = cleanText(body.sourceVariantValue || body.source_variant_value || analysis.source_variant_value || "");
  const sourceTitle = sourceListingTitle(body);
  const variantType = normalizeImageVariantType(body.variantType || body.variant_type || body.variantGoal || body.variant_goal || analysis.recommended_variant_mode || "vehicle_model_swap");
  const template = await findTemplate(body.templateKey || body.template_key || analysis.recommended_template_key || DEFAULT_TEMPLATE_KEY);
  let result;
  let parsed;
  const aiTimeoutMs = clampInteger(body.aiTimeoutMs || body.ai_timeout_ms, 15_000, 120_000, 45_000);
  try {
    if (body.useAiPlan === false || body.use_ai_plan === false) {
      throw statusError("AI batch plan skipped, using fallback template", 200);
    }
    result = await withTimeout(chatWithAiProvider({
      temperature: 0.12,
      maxTokens: Math.min(3600, 700 + targets.length * 420),
      timeoutMs: aiTimeoutMs,
      messages: [
        { role: "system", content: batchPlanSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            business_goal: "Create one-to-many SKU fission plans for Ozon automotive listings.",
            variant_type: variantType,
            source_variant_value: sourceVariantValue,
            source_listing_title_ru: sourceTitle,
            target_variant_values: targets,
            analysis,
            product_fact_contract: buildProductFactContract(analysis, body),
            reusable_template: template?.template_json || null,
            operator_note: operatorNote,
            image_prompt_hard_rules: buildOperatorImageHardRules(operatorNote, variantType),
            output_contract: {
              items: "One item per target. Keep product facts stable. Generate image prompt, negative prompt, title/tags/description/rich content copy in Russian."
            }
          }, null, 2)
        }
      ]
    }), aiTimeoutMs + 1000, "AI batch plan timeout, using fallback template");
    parsed = parseJsonObject(result.content, { items: [] });
  } catch (error) {
    result = {
      provider: "fallback",
      model: "deterministic-template",
      usage: null,
      fallback_error: cleanText(error.message)
    };
    parsed = { items: buildFallbackBatchItems(targets, analysis, { sourceVariantValue, sourceTitle, templateKey: template?.template_key || DEFAULT_TEMPLATE_KEY, operatorNote, variantType }) };
  }
  const items = normalizeBatchItems(parsed.items || parsed.targets || parsed.variants, analysis, {
    sourceVariantValue,
    sourceTitle,
    templateKey: template?.template_key || analysis.recommended_template_key || DEFAULT_TEMPLATE_KEY,
    targets,
    operatorNote,
    variantType,
  });
  const jobNo = body.jobNo || body.job_no || makeNo("AVL-B");
  const budget = normalizeBudget(body.budget || body.budget_cny || body.budgetCny);
  const jobPayload = {
    job_type: "variant_batch",
    variant_type: variantType,
    source_variant_value: sourceVariantValue,
    target_count: items.length,
    target_variant_values: targets,
    analysis_no: analysisResult.analysis_no || cleanText(body.analysisNo || body.analysis_no || ""),
    template_key: template?.template_key || analysis.recommended_template_key || DEFAULT_TEMPLATE_KEY,
    provider: result.provider,
    model: result.model
  };
  await mysqlExecute(`
    INSERT INTO ai_variant_lab_batch_jobs
    (job_no, job_type, analysis_no, source_product_id, source_variant_value, target_count, status, budget_cny, image_concurrency, request_json, result_json, usage_json, cost_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      analysis_no = VALUES(analysis_no),
      source_product_id = VALUES(source_product_id),
      source_variant_value = VALUES(source_variant_value),
      target_count = VALUES(target_count),
      status = VALUES(status),
      budget_cny = VALUES(budget_cny),
      image_concurrency = VALUES(image_concurrency),
      request_json = VALUES(request_json),
      result_json = VALUES(result_json),
      usage_json = VALUES(usage_json),
      cost_json = VALUES(cost_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    jobNo,
    "variant_batch",
    jobPayload.analysis_no,
    cleanText(body.sourceProductId || body.source_product_id || ""),
    sourceVariantValue,
    items.length,
    "planned",
    budget,
    positiveInteger(body.imageConcurrency || body.image_concurrency, 20),
    JSON.stringify({
      ...jobPayload,
      operator_note: operatorNote,
      workbench_snapshot: nonEmptyObjectValue(body.workbenchSnapshot || body.workbench_snapshot) || null
    }),
    JSON.stringify({ items }),
    JSON.stringify(result.usage || {}),
    JSON.stringify({ estimated_text_cny: estimateTextCostCny(result.usage), image_spend_cny: 0 }),
    personId(session)
  ]);
  await replaceBatchItems(jobNo, items);
  return {
    ok: true,
    job_no: jobNo,
    analysis_no: jobPayload.analysis_no,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    estimated_text_cost_cny: estimateTextCostCny(result.usage),
    budget_cny: budget,
    items
  };
}

export async function aiVariantLabBatchRunImages(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  if (!jobNo) throw statusError("jobNo is required", 400);
  const sourceImageUrl = await resolveImageUrl(body);
  const limit = clampInteger(body.limit, 1, 100, 100);
  const execute = body.execute === true;
  const force = body.force === true || body.forceRegenerate === true || body.force_regenerate === true;
  const selectedKeys = new Set(toArray(body.itemNos || body.item_nos || body.selectedItemNos || body.selected_item_nos).map(cleanText).filter(Boolean));
  const overrideByKey = normalizeItemOverrides(body.itemOverrides || body.item_overrides || body.items || []);
  const runnableStatusSql = force
    ? "status IN ('planned', 'queued_image', 'failed', 'image_done')"
    : "status IN ('planned', 'failed')";
  const rows = selectedKeys.size
    ? await mysqlQuery(`
    SELECT item_no, target_variant_value, status, item_json
    FROM ai_variant_lab_batch_items
    WHERE job_no = ? AND ${runnableStatusSql}
    ORDER BY sort_order ASC, id ASC
  `, [jobNo])
    : await mysqlQuery(`
    SELECT item_no, target_variant_value, status, item_json
    FROM ai_variant_lab_batch_items
    WHERE job_no = ? AND ${runnableStatusSql}
    ORDER BY sort_order ASC, id ASC
    LIMIT ?
  `, [jobNo, limit]);
  const runnableRows = selectedKeys.size
    ? rows.filter((row) => selectedKeys.has(row.item_no) || selectedKeys.has(row.target_variant_value))
    : rows;
  const results = [];
  const queuedRows = [];
  for (const row of runnableRows) {
    const persistedItem = applyItemOverride(parseStoredJson(row.item_json, {}), overrideByKey.get(row.item_no) || overrideByKey.get(row.target_variant_value));
    const item = await finalizeBatchImageItemForRun(persistedItem);
    if (overrideByKey.has(row.item_no) || overrideByKey.has(row.target_variant_value)) {
      await mysqlExecute("UPDATE ai_variant_lab_batch_items SET target_variant_value = ?, item_json = ?, updated_at = CURRENT_TIMESTAMP WHERE item_no = ?", [cleanText(persistedItem.target_variant_value || row.target_variant_value), JSON.stringify(persistedItem), row.item_no]);
      row.target_variant_value = cleanText(persistedItem.target_variant_value || row.target_variant_value);
    }
    queuedRows.push({ ...row, item_json: JSON.stringify(item) });
    const prompt = cleanText(item.image_edit_prompt_en || item.imagePrompt || "");
    const negative = cleanText(item.negative_prompt_en || item.negativePrompt || "");
    const preflight = imagePromptPreflight(prompt, item, {});
    if (!execute) {
      results.push({
        item_no: row.item_no,
        target_variant_value: row.target_variant_value,
        dry_run: true,
        preflight,
        image_edit_prompt_en: prompt,
        negative_prompt_en: negative
      });
      continue;
    }
    await mysqlExecute(`
      UPDATE ai_variant_lab_batch_items
      SET target_variant_value = ?,
          status = 'queued_image',
          item_json = ?,
          image_result_json = NULL,
          error_message = '',
          updated_at = CURRENT_TIMESTAMP
      WHERE item_no = ?
    `, [row.target_variant_value, JSON.stringify(item), row.item_no]);
  }
  if (!execute) {
    await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [
      "image_dry_run",
      JSON.stringify({ last_results: results }),
      jobNo
    ]);
    return { ok: true, job_no: jobNo, execute, summary: await summarizeBatchJob(jobNo), results, session_person_id: personId(session) };
  }
  const queueConfig = await resolveImageRuntimeQueueConfig({
    imageConcurrency: positiveInteger(body.imageConcurrency || body.image_concurrency, 20)
  });
  await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [
    "generating_images",
    JSON.stringify({
      mode: "background",
      started_at: new Date().toISOString(),
      queued_count: queuedRows.length,
      estimated_seconds: estimateBatchImageSeconds(queuedRows.length),
      source_image_url: sourceImageUrl.startsWith("data:image/") ? "" : sourceImageUrl,
      ratio: body.ratio || "3:4",
      auto_crop: body.autoCrop === true,
      effective_image_concurrency: queueConfig.effectiveConcurrency,
      image_pool_max_concurrency: queueConfig.poolMaxConcurrency,
      image_channel_capacity: queueConfig.channelCapacity
    }),
    jobNo
  ]);
  const started = startBatchImageBackgroundJob(jobNo, {
    rows: queuedRows,
    sourceImageUrl,
    ratio: body.ratio || "3:4",
    autoCrop: body.autoCrop === true,
    imageConcurrency: queueConfig.effectiveConcurrency,
    sessionPersonId: personId(session)
  });
  const summary = await summarizeBatchJob(jobNo);
  const queue = await batchImageQueueStats(jobNo, queueConfig);
  return {
    ok: true,
    job_no: jobNo,
    execute,
    queued: true,
    background: true,
    worker_started: started,
    estimated_seconds: estimateBatchImageSeconds(queuedRows.length),
    summary,
    queue,
    results,
    session_person_id: personId(session)
  };
}

export async function aiVariantLabBatchResumeImages(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  if (!jobNo) throw statusError("jobNo is required", 400);
  const jobs = await mysqlQuery(`
    SELECT job_no, result_json, image_concurrency, created_by_person_id
    FROM ai_variant_lab_batch_jobs
    WHERE job_no = ?
    LIMIT 1
  `, [jobNo]);
  if (!jobs.length) throw statusError(`batch job not found: ${jobNo}`, 404);
  const job = jobs[0];
  const previousResult = parseStoredJson(job.result_json, {});
  const resumed = await mysqlExecute(`
    UPDATE ai_variant_lab_batch_items
    SET status = 'queued_image',
        error_message = '已继续等待，将使用原服务商任务号拉回图片，不重复提交生图',
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ? AND status = 'provider_pending'
  `, [jobNo]);
  const summary = await summarizeBatchJob(jobNo);
  if (!summary.pending) return { ok: true, job_no: jobNo, resumed_count: 0, summary };
  await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [jobNo]);
  const started = startBatchImageBackgroundJob(jobNo, {
    sourceImageUrl: cleanText(previousResult.source_image_url || ""),
    ratio: previousResult.ratio || "3:4",
    autoCrop: previousResult.auto_crop === true,
    imageConcurrency: positiveInteger(job.image_concurrency || previousResult.effective_image_concurrency || 4, 4),
    sessionPersonId: personId(session) || Number(job.created_by_person_id || 0) || null
  });
  return {
    ok: true,
    job_no: jobNo,
    resumed_count: Number(resumed.affectedRows || 0),
    worker_started: started,
    summary: await summarizeBatchJob(jobNo)
  };
}

function startBatchImageBackgroundJob(jobNo, options = {}) {
  if (runningBatchImageJobs.has(jobNo)) {
    pendingBatchImageJobWakeups.add(jobNo);
    return false;
  }
  runningBatchImageJobs.add(jobNo);
  Promise.resolve()
    .then(() => runBatchImageBackgroundJob(jobNo, options))
    .catch(async (error) => {
      console.error("[ai-variant-lab] background image batch failed", { jobNo, error: error?.message || error });
      const summary = await summarizeBatchJob(jobNo).catch(() => ({}));
      await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [
        "failed",
        JSON.stringify({
          source_image_url: cleanText(options.sourceImageUrl || ""),
          ratio: options.ratio || "3:4",
          auto_crop: options.autoCrop === true,
          summary,
          background_error: formatImageGenerationError(error),
          failed_at: new Date().toISOString()
        }),
        jobNo
      ]).catch(() => {});
    })
    .finally(() => {
      const shouldWake = pendingBatchImageJobWakeups.has(jobNo);
      pendingBatchImageJobWakeups.delete(jobNo);
      runningBatchImageJobs.delete(jobNo);
      if (shouldWake) startBatchImageBackgroundJob(jobNo, options);
    });
  return true;
}

async function runBatchImageBackgroundJob(jobNo, options = {}) {
  const resultSummary = [];
  const queueConfig = await resolveImageRuntimeQueueConfig(options);
  const { runtimeChannels, hasChannelPool, channelCapacity, poolMaxConcurrency, effectiveConcurrency } = queueConfig;
  let concurrency = 1;
  let workerChannels = [];
  while (true) {
    pendingBatchImageJobWakeups.delete(jobNo);
    const initialStats = await batchImageQueueStats(jobNo, queueConfig);
    if (!initialStats.queued_count) break;
    concurrency = Math.min(adaptiveAiImageConcurrency(effectiveConcurrency), Math.max(1, initialStats.queued_count || 1));
    workerChannels = hasChannelPool ? buildWeightedChannelWorkers(runtimeChannels, concurrency) : [];
    async function worker(workerIndex = 0) {
      while (true) {
        const row = await fetchNextQueuedBatchImageRow(jobNo);
        if (!row) return;
        const result = await runBatchImageRow(jobNo, row, options, runtimeChannels, workerIndex, workerChannels[workerIndex] || null);
        resultSummary.push({ item_no: result.item_no, target_variant_value: result.target_variant_value, elapsedMs: result.elapsedMs, error: result.error || "" });
        if (resultSummary.length > 100) resultSummary.splice(0, resultSummary.length - 100);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, workerIndex) => worker(workerIndex)));
    const nextSummary = await summarizeBatchJob(jobNo);
    if (!pendingBatchImageJobWakeups.has(jobNo) && !nextSummary.queued) break;
  }
  const summary = await summarizeBatchJob(jobNo);
  const finalStatus = summary.failed > 0
    ? (summary.done > 0 ? "partially_failed" : "failed")
    : (summary.pending > 0 ? "partially_generated" : "image_done");
  await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = ?, result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [
    finalStatus,
    JSON.stringify({
      source_image_url: cleanText(options.sourceImageUrl || ""),
      ratio: options.ratio || "3:4",
      auto_crop: options.autoCrop === true,
      summary,
      last_results: resultSummary,
      image_concurrency: concurrency,
      effective_image_concurrency: effectiveConcurrency,
      image_pool_max_concurrency: poolMaxConcurrency,
      image_channel_capacity: channelCapacity,
      image_channels: runtimeChannels.map(publicRuntimeChannel),
      image_worker_channels: workerChannels.map(publicRuntimeChannel),
      completed_at: new Date().toISOString()
    }),
    jobNo
  ]);
}

async function fetchNextQueuedBatchImageRow(jobNo) {
  const claimToken = `claim:${process.pid}:${crypto.randomUUID()}`;
  const result = await mysqlExecute(`
    UPDATE ai_variant_lab_batch_items
    SET status = 'generating_image',
        error_message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ? AND status = 'queued_image'
    ORDER BY updated_at ASC, sort_order ASC, id ASC
    LIMIT 1
  `, [claimToken, jobNo]);
  if (!result.affectedRows) return null;
  const rows = await mysqlQuery(`
    SELECT item_no, target_variant_value, status, item_json, provider_job_json
    FROM ai_variant_lab_batch_items
    WHERE job_no = ? AND status = 'generating_image' AND error_message = ?
    LIMIT 1
  `, [jobNo, claimToken]);
  return rows[0] || null;
}

async function resolveImageRuntimeQueueConfig(options = {}) {
  const runtimeChannels = await aiImageRuntimePoolConfig();
  const hasChannelPool = runtimeChannels.some((channel) => channel.channelId);
  const channelCapacity = runtimeChannels.reduce((sum, channel) => sum + positiveInteger(channel.maxConcurrency || 1, 1), 0);
  const poolMaxConcurrency = hasChannelPool
    ? positiveInteger(runtimeChannels.find((channel) => channel.poolMaxConcurrency)?.poolMaxConcurrency || channelCapacity, channelCapacity || 1)
    : Math.min(4, positiveInteger(options.imageConcurrency || 4, 4));
  const effectiveConcurrency = hasChannelPool
    ? adaptiveAiImageConcurrency(Math.max(1, Math.min(poolMaxConcurrency, channelCapacity || 1)))
    : poolMaxConcurrency;
  const workerChannels = hasChannelPool ? buildWeightedChannelWorkers(runtimeChannels, effectiveConcurrency) : [];
  return {
    runtimeChannels,
    hasChannelPool,
    channelCapacity,
    poolMaxConcurrency,
    effectiveConcurrency,
    workerChannels
  };
}

async function batchImageQueueStats(jobNo, config = null) {
  const queueConfig = config || await resolveImageRuntimeQueueConfig({});
  const summary = await summarizeBatchJob(jobNo);
  return {
    ...summary,
    queued_count: summary.queued,
    active_generating_count: summary.generating,
    running_in_process: runningBatchImageJobs.has(jobNo),
    effective_image_concurrency: queueConfig.effectiveConcurrency,
    image_pool_max_concurrency: queueConfig.poolMaxConcurrency,
    image_channel_capacity: queueConfig.channelCapacity,
    global_active_image_requests: aiImageRuntimeMetrics().activeTotal,
    global_waiting_image_requests: aiImageRuntimeMetrics().waitingTotal,
    image_runtime: aiImageRuntimeMetrics(),
    image_channels: queueConfig.runtimeChannels.map(publicRuntimeChannel),
    image_worker_channels: queueConfig.workerChannels.map(publicRuntimeChannel)
  };
}

async function runBatchImageRow(jobNo, row, options = {}, runtimeChannels = [], rowIndex = 0, preferredChannel = null) {
    const item = parseStoredJson(row.item_json, {});
    const prompt = cleanText(item.image_edit_prompt_en || item.imagePrompt || "");
    const negative = cleanText(item.negative_prompt_en || item.negativePrompt || "");
    const started = Date.now();
    const attempts = [];
    let providerJobState = parseStoredJson(row.provider_job_json, null);
    try {
      await mysqlExecute(
        "UPDATE ai_variant_lab_batch_items SET status = ?, image_result_json = NULL, error_message = '', updated_at = CURRENT_TIMESTAMP WHERE item_no = ?",
        ["generating_image", row.item_no]
      );
      const imageResult = await generateImagesWithChannelRetry({
        finalPrompt: [prompt, negative ? `Negative constraints: ${negative}` : ""].filter(Boolean).join("\n\n"),
        sourceImageUrl: options.sourceImageUrl,
        ratio: options.ratio || "3:4",
        imageCount: 1,
        autoCrop: options.autoCrop === true,
        providerJob: providerJobState,
        onProviderJob: async (providerJob, index = 0) => {
          const jobs = Array.isArray(providerJobState?.jobs) ? [...providerJobState.jobs] : [];
          jobs[index] = providerJob;
          providerJobState = { jobs };
          await mysqlExecute("UPDATE ai_variant_lab_batch_items SET provider_job_json = ?, updated_at = CURRENT_TIMESTAMP WHERE item_no = ?", [
            JSON.stringify(providerJobState),
            row.item_no
          ]);
        }
      }, runtimeChannels, rowIndex, attempts, preferredChannel);
      const durableImageResult = await persistAiVariantImageResult(imageResult, {
        jobNo,
        itemNo: row.item_no,
        targetVariantValue: row.target_variant_value,
        sessionPersonId: options.sessionPersonId
      });
      const completedResult = durableImageResult;
      const elapsedMs = Date.now() - started;
      await mysqlExecute(`
        UPDATE ai_variant_lab_batch_items
        SET status = ?, image_result_json = ?, provider_job_json = NULL, error_message = '', updated_at = CURRENT_TIMESTAMP
        WHERE item_no = ?
      `, ["image_done", JSON.stringify({ ...completedResult, elapsedMs, attempts }), row.item_no]);
      return { item_no: row.item_no, target_variant_value: row.target_variant_value, elapsedMs, image_result: completedResult };
    } catch (error) {
      const publicError = formatImageGenerationError(error);
      const elapsedMs = Date.now() - started;
      const providerPending = error?.code === "provider_pending";
      await mysqlExecute(`
        UPDATE ai_variant_lab_batch_items
        SET status = ?, image_result_json = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE item_no = ?
      `, [
        providerPending ? "provider_pending" : "failed",
        JSON.stringify({ attempts, elapsedMs, failedAt: new Date().toISOString() }),
        publicError.slice(0, 1000),
        row.item_no
      ]);
      if (providerPending) scheduleProviderPendingBatchResume(jobNo, options);
      return { item_no: row.item_no, target_variant_value: row.target_variant_value, elapsedMs, error: publicError, attempts };
    }
}

function scheduleProviderPendingBatchResume(jobNo, options = {}) {
  if (pendingBatchImageResumeTimers.has(jobNo)) return;
  const delayMs = Math.max(5000, Number(process.env.AI_VARIANT_PROVIDER_REPOLL_DELAY_MS || 30000));
  const timer = setTimeout(async () => {
    pendingBatchImageResumeTimers.delete(jobNo);
    try {
      const result = await mysqlExecute(`
        UPDATE ai_variant_lab_batch_items
        SET status = 'queued_image',
            error_message = '服务商仍在生成，已自动继续拉回原任务',
            updated_at = CURRENT_TIMESTAMP
        WHERE job_no = ? AND status = 'provider_pending'
      `, [jobNo]);
      if (!result.affectedRows) return;
      await mysqlExecute("UPDATE ai_variant_lab_batch_jobs SET status = 'generating_images', updated_at = CURRENT_TIMESTAMP WHERE job_no = ?", [jobNo]);
      startBatchImageBackgroundJob(jobNo, options);
    } catch (error) {
      console.warn("[ai-variant-lab] provider image repoll scheduling failed", { jobNo, error: error?.message || error });
    }
  }, delayMs);
  timer.unref?.();
  pendingBatchImageResumeTimers.set(jobNo, timer);
}

async function persistAiVariantImageResult(imageResult = {}, context = {}) {
  const persistImages = async (images = [], scope = "generated") => Promise.all(arrayValue(images).map(async (image, index) => {
    const sourceUrl = cleanText(image?.url || image?.publishUrl || image?.previewUrl || "");
    if (!sourceUrl) return image;
    if (image?.durable === true && cleanText(image?.publishUrl || image?.localUrl || "")) return image;
    const persisted = await materializeListingMediaAssetUrl(sourceUrl, {
      source_module: "ai_variant_lab",
      source_id: cleanText(context.itemNo || ""),
      batch_id: cleanText(context.jobNo || ""),
      role: `${scope}_${index + 1}`,
      variant_target: cleanText(context.targetVariantValue || "")
    }, { personId: Number(context.sessionPersonId || 0) || null });
    if (!persisted?.finalUrl || (!persisted?.publishUrl && !persisted?.localUrl)) {
      throw statusError("AI 裂变图片已生成，但未能持久化到本地素材库，请重试该行。", 503);
    }
    return {
      ...image,
      originalAiFileUrl: sourceUrl,
      url: persisted.finalUrl,
      previewUrl: persisted.localUrl || persisted.finalUrl,
      localUrl: persisted.localUrl || "",
      publishUrl: persisted.publishUrl || persisted.finalUrl,
      durable: true,
      persistedAt: new Date().toISOString()
    };
  }));
  const durableResult = {
    ...imageResult,
    generatedImages: await persistImages(imageResult.generatedImages, "generated"),
    croppedImages: await persistImages(imageResult.croppedImages, "cropped")
  };
  const durableImages = [...arrayValue(durableResult.generatedImages), ...arrayValue(durableResult.croppedImages)];
  if (!durableImages.some((image) => image?.durable === true && image?.url)) {
    throw statusError("AI 裂变图片生成接口未返回可持久化图片，请重试该行。", 503);
  }
  return durableResult;
}

function firstDurableAiVariantImageUrl(imageResult = {}) {
  const images = [...arrayValue(imageResult.generatedImages), ...arrayValue(imageResult.croppedImages)];
  return cleanText(images.find((image) => image?.publishUrl || image?.url)?.publishUrl || images.find((image) => image?.url)?.url || "");
}

async function generateImagesWithChannelRetry(payload, runtimeChannels = [], rowIndex = 0, attempts = [], preferredChannel = null) {
  const savedProviderJob = arrayValue(payload.providerJob?.jobs)[0] || payload.providerJob;
  const orderedChannels = orderedRuntimeChannels(runtimeChannels, rowIndex, preferredChannel);
  const channels = savedProviderJob?.jobId
    ? orderedChannels.filter((channel) => (
      savedProviderJob.channelId
        ? channel.channelId === savedProviderJob.channelId
        : channel.provider === savedProviderJob.provider
    )).slice(0, 1)
    : orderedChannels;
  if (savedProviderJob?.jobId && !channels.length) {
    throw statusError("保存的服务商生图任务所属通道当前不可用，恢复该通道后即可继续拉回，无需重新生图", 503);
  }
  let lastError = null;
  for (const channel of channels) {
    const attempt = {
      channelId: channel.channelId || "",
      channelName: channel.channelName || channel.name || "",
      provider: channel.provider,
      model: channel.imageModel
    };
    try {
      const result = await generateImages({ ...payload, imageRuntimeConfig: channel });
      attempts.push({ ...attempt, ok: true });
      return result;
    } catch (error) {
      lastError = error;
      attempts.push({ ...attempt, ok: false, error: cleanText(error?.message || error).slice(0, 500) });
      if (error?.code === "provider_pending" || savedProviderJob?.jobId) throw error;
    }
  }
  throw lastError || statusError("No image provider channel is available", 400);
}

function orderedRuntimeChannels(runtimeChannels = [], rowIndex = 0, preferredChannel = null) {
  const channels = prioritizeRuntimeChannels(runtimeChannels.length ? runtimeChannels : []);
  if (channels.length <= 1) return channels;
  if (preferredChannel) {
    if (preferredChannel.dispatchMode === "speed") return [preferredChannel];
    const preferredKey = preferredChannel.channelId || preferredChannel.provider;
    return [
      preferredChannel,
      ...channels.filter((channel) => (channel.channelId || channel.provider) !== preferredKey)
    ];
  }
  const expanded = channels.flatMap((channel) => Array.from({ length: Math.max(1, Number(channel.weight || 1)) }, () => channel));
  const start = rowIndex % expanded.length;
  return [...expanded.slice(start), ...expanded.slice(0, start)].filter((channel, index, list) => (
    list.findIndex((item) => (item.channelId || item.provider) === (channel.channelId || channel.provider)) === index
  ));
}

function buildWeightedChannelWorkers(runtimeChannels = [], concurrency = 1) {
  const channels = prioritizeRuntimeChannels(runtimeChannels.filter(Boolean));
  const remaining = new Map(channels.map((channel) => [
    channel.channelId || channel.provider,
    positiveInteger(channel.maxConcurrency || 1, 1)
  ]));
  const workers = [];
  while (workers.length < concurrency && [...remaining.values()].some((count) => count > 0)) {
    for (const channel of channels) {
      const key = channel.channelId || channel.provider;
      const available = remaining.get(key) || 0;
      if (available <= 0) continue;
      workers.push(channel);
      remaining.set(key, available - 1);
      if (workers.length >= concurrency) break;
    }
  }
  return workers;
}

function prioritizeRuntimeChannels(channels = []) {
  return channels
    .map((channel, index) => ({ channel, index }))
    .sort((left, right) => (
      clampInteger(right.channel.weight || 1, 1, 20, 1) - clampInteger(left.channel.weight || 1, 1, 20, 1)
      || positiveInteger(right.channel.maxConcurrency || 1, 1) - positiveInteger(left.channel.maxConcurrency || 1, 1)
      || left.index - right.index
    ))
    .map((item) => item.channel);
}

function publicRuntimeChannel(channel = {}) {
  return {
    channelId: channel.channelId || "",
    channelName: channel.channelName || channel.name || "",
    provider: channel.provider || "",
    model: channel.imageModel || "",
    weight: channel.weight || 1,
    maxConcurrency: channel.maxConcurrency || 1
  };
}

function estimateBatchImageSeconds(count = 0) {
  return Math.max(0, Number(count || 0)) * Math.ceil(AI_VARIANT_IMAGE_TIMEOUT_MS / 1000);
}

function formatImageGenerationError(error) {
  const message = cleanText(error?.message || error || "图片生成失败");
  if (/Async image generation exceeded 300 seconds/i.test(message)) {
    return `图生图服务生成等待超过 300 秒，本任务已标记为超时失败。可稍后只重新生成失败项。原始信息：${message}`;
  }
  if (/timeout|timed out|abort|aborted|超时/i.test(message)) {
    return `图生图服务连接或结果传输超时。本任务的图片生成 API 结果等待窗口为 300 秒，网络上传和结果回传另计。可稍后只重新生成失败项。原始信息：${message}`;
  }
  if (/fetch failed|socket|econnreset|etimedout|network|502|503|504/i.test(message)) {
    return `图生图服务网络或排队异常，本任务已失败。可稍后只重新生成失败项。原始信息：${message}`;
  }
  return message;
}

function normalizeItemOverrides(overrides) {
  const map = new Map();
  const list = Array.isArray(overrides) ? overrides : Object.values(overrides || {});
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const itemNo = cleanText(item.item_no || item.itemNo || "");
    const target = cleanText(item.target_variant_value || item.targetVariantValue || "");
    if (itemNo) map.set(itemNo, item);
    if (target) map.set(target, item);
  }
  return map;
}

function applyItemOverride(item, override) {
  if (!override || typeof override !== "object") return item;
  const previousTarget = cleanText(item.target_variant_value || item.targetVariantValue || "");
  const target = cleanText(override.target_variant_value || override.targetVariantValue || item.target_variant_value || "");
  const operatorNote = cleanText(override.operator_note || override.operatorNote || item.operator_note || "");
  const reviewedImagePrompt = cleanText(override.final_image_prompt_en || override.finalImagePromptEn || override.image_edit_prompt_en || override.imageEditPromptEn || "");
  const reviewedNegativePrompt = cleanText(override.final_negative_prompt_en || override.finalNegativePromptEn || override.negative_prompt_en || override.negativePromptEn || "");
  const hasReviewedPrompt = Boolean(reviewedImagePrompt || reviewedNegativePrompt);
  const titleRu = cleanText(override.title_ru || override.titleRu || override.title || item.title_ru || "");
  const tagsRu = toArray(override.tags_ru || override.tagsRu || override.tags || item.tags_ru).map(cleanText).filter(Boolean);
  const descriptionRu = cleanText(override.description_ru || override.descriptionRu || override.description || item.description_ru || "");
  const baseImagePrompt = target && previousTarget && target !== previousTarget
    ? cleanText(item.image_edit_prompt_en || item.imagePrompt || "").replaceAll(previousTarget, target)
    : cleanText(item.image_edit_prompt_en || item.imagePrompt || "");
  const displayZh = {
    ...(item.display_zh || {}),
    ...(override.display_zh || override.displayZh || {}),
    main_image_plan: cleanText(override.mainImagePlan || override.main_image_plan || override.display_zh?.main_image_plan || item.display_zh?.main_image_plan || ""),
    title_plan: cleanText(override.titlePlan || override.title_plan || override.display_zh?.title_plan || item.display_zh?.title_plan || ""),
    tags_plan: cleanText(override.tagsPlan || override.tags_plan || override.display_zh?.tags_plan || item.display_zh?.tags_plan || ""),
    description_plan: cleanText(override.descriptionPlan || override.description_plan || override.display_zh?.description_plan || item.display_zh?.description_plan || ""),
    rich_content_plan: cleanText(override.richTextPlan || override.rich_content_plan || override.display_zh?.rich_content_plan || item.display_zh?.rich_content_plan || "")
  };
  const imagePrompt = reviewedImagePrompt || baseImagePrompt;
  const negativePrompt = reviewedNegativePrompt || cleanText(item.negative_prompt_en || item.negativePrompt || "");
  const imageEditContract = buildImageEditContract({
    variantType: item.variant_type || item.variantType || "vehicle_model_swap",
    source: cleanText(item.source_variant_value || item.sourceVariantValue || ""),
    target,
    keepFacts: toArray(item.keep_facts),
    fallback: { operatorNote }
  });
  return {
    ...item,
    ...(target ? { target_variant_value: target } : {}),
    image_edit_contract: imageEditContract,
    ...(imagePrompt ? { image_edit_prompt_en: imagePrompt } : {}),
    ...(negativePrompt ? { negative_prompt_en: negativePrompt } : {}),
    image_prompt_reviewed: hasReviewedPrompt ? true : item.image_prompt_reviewed === true,
    ...(operatorNote ? { operator_note: operatorNote } : {}),
    ...(titleRu ? { title_ru: titleRu } : {}),
    ...(tagsRu.length ? { tags_ru: tagsRu } : {}),
    ...(descriptionRu ? { description_ru: descriptionRu } : {}),
    display_zh: displayZh,
    operator_review_zh: {
      main_image_plan: displayZh.main_image_plan,
      title_plan: displayZh.title_plan,
      tags_plan: displayZh.tags_plan,
      description_plan: displayZh.description_plan,
      rich_content_plan: displayZh.rich_content_plan
    }
  };
}

async function finalizeBatchImageItemForRun(item = {}) {
  const target = cleanText(item.target_variant_value || item.targetVariantValue || "");
  const source = cleanText(item.source_variant_value || item.sourceVariantValue || "");
  const operatorNote = cleanText(item.operator_note || item.operatorNote || "");
  const mainImagePlan = cleanText(item.display_zh?.main_image_plan || item.displayZh?.main_image_plan || item.main_image_plan || item.mainImagePlan || "");
  const storedContract = nonEmptyObjectValue(item.image_edit_contract || item.imageEditContract);
  let imageEditContract = storedContract ? stripBrandAssetReferences(storedContract) : buildImageEditContract({
    variantType: item.variant_type || item.variantType || "vehicle_model_swap",
    source,
    target,
    keepFacts: toArray(item.keep_facts),
    fallback: { operatorNote }
  });
  const brandLogoOnly = isBrandLogoOnlyFission(item.variant_type || item.variantType, imageEditContract);
  const reviewedImagePrompt = !brandLogoOnly && item.image_prompt_reviewed === true ? cleanText(item.image_edit_prompt_en || item.imagePrompt || "") : "";
  const reviewedNegativePrompt = !brandLogoOnly && item.image_prompt_reviewed === true ? cleanText(item.negative_prompt_en || item.negativePrompt || "") : "";
  return {
    ...item,
    brand_asset: undefined,
    brand_identity: undefined,
    image_edit_contract: imageEditContract,
    image_edit_prompt_en: composeFinalImagePromptForRun(reviewedImagePrompt || item.image_edit_prompt_en || item.imagePrompt || "", {
      source,
      target,
      keepFacts: toArray(item.keep_facts),
      mainImagePlan,
      operatorNote,
      imageEditContract,
      templateGuidance: item.image_template_guidance,
      productTruthRules: item.image_product_truth_en,
      priorityContract: item.image_prompt_priority
    }),
    negative_prompt_en: reviewedNegativePrompt ? normalizeReviewedNegativePromptEn(reviewedNegativePrompt) : normalizeImageNegativePromptEn(item.negative_prompt_en || item.negativePrompt || "", source, operatorNote, imageEditContract)
  };
}

function stripBrandAssetReferences(contract = {}) {
  const { brand_asset, brandAsset, ...cleanContract } = objectValue(contract);
  const { reference_status, target_brand_name, ...cleanLogoPolicy } = objectValue(cleanContract.logo_policy || cleanContract.logoPolicy);
  return {
    ...cleanContract,
    logo_policy: {
      ...cleanLogoPolicy,
      mode: cleanLogoPolicy.preserve_product_printed_logo ? "preserve_existing_marks" : "plain_text_only",
      official_logo_graphics: "forbid",
      brand_asset_reference: "forbid"
    }
  };
}

export async function aiVariantLabBatchJobs(query = {}) {
  await ensureAiVariantLabSchema();
  await recoverStaleBatchImageJobs();
  const rows = await mysqlQuery(`
    SELECT j.job_no, j.job_type, j.analysis_no, j.source_product_id, j.source_variant_value, j.target_count, j.status,
           j.budget_cny, j.image_concurrency,
           JSON_UNQUOTE(JSON_EXTRACT(j.request_json, '$.workbench_snapshot.material.productName')) AS history_product_name,
           j.result_json, j.usage_json, j.cost_json,
           j.created_by_person_id, p.name AS created_by_name, j.created_at, j.updated_at
    FROM ai_variant_lab_batch_jobs j
    LEFT JOIN people p ON p.id = j.created_by_person_id
    ORDER BY j.updated_at DESC
    LIMIT ?
  `, [clampInteger(query.limit, 1, 100, 30)]);
  return {
    ok: true,
    jobs: rows.map((row) => ({
      ...row,
      request_json: row.history_product_name ? {
        workbench_snapshot: { material: { productName: row.history_product_name } }
      } : {},
      result_json: parseStoredJson(row.result_json, {}),
      usage_json: parseStoredJson(row.usage_json, {}),
      cost_json: parseStoredJson(row.cost_json, {})
    }))
  };
}

export async function aiVariantLabBatchJobDetail(jobNo, session = {}, query = {}) {
  await ensureAiVariantLabSchema();
  const key = cleanText(jobNo || "");
  if (!key) throw statusError("jobNo is required", 400);
  await recoverStaleBatchImageJob(key);
  const fullDetail = ["1", "true"].includes(String(query.full || query.include_detail || "").toLowerCase());
  const summaryOnly = !fullDetail;
  if (summaryOnly) {
    const jobs = await mysqlQuery(`
      SELECT j.job_no, j.job_type, j.analysis_no, j.source_product_id, j.source_variant_value,
             j.target_count, j.status, j.budget_cny, j.image_concurrency,
             j.created_by_person_id, p.name AS created_by_name, j.created_at, j.updated_at
      FROM ai_variant_lab_batch_jobs j
      LEFT JOIN people p ON p.id = j.created_by_person_id
      WHERE j.job_no = ? LIMIT 1
    `, [key]);
    if (!jobs.length) throw statusError(`batch job not found: ${key}`, 404);
    const items = await mysqlQuery(`
      SELECT item_no, status, error_message, updated_at,
             COALESCE(
               JSON_UNQUOTE(JSON_EXTRACT(image_result_json, '$.generatedImages[0].publishUrl')),
               JSON_UNQUOTE(JSON_EXTRACT(image_result_json, '$.generatedImages[0].url')),
               JSON_UNQUOTE(JSON_EXTRACT(image_result_json, '$.croppedImages[0].publishUrl')),
               JSON_UNQUOTE(JSON_EXTRACT(image_result_json, '$.croppedImages[0].url'))
             ) AS result_image_url
      FROM ai_variant_lab_batch_items
      WHERE job_no = ?
      ORDER BY sort_order ASC, id ASC
    `, [key]);
    const queue = await batchImageQueueStats(key, await resolveImageRuntimeQueueConfig({ imageConcurrency: positiveInteger(jobs[0].image_concurrency || 4, 4) }));
    return {
      ok: true,
      summary_only: true,
      job: jobs[0],
      queue,
      items: items.map((item) => ({
        ...item,
        image_result_json: item.result_image_url ? {
          generatedImages: [{
            url: item.result_image_url,
            publishUrl: item.result_image_url,
            previewUrl: item.result_image_url,
            durable: true
          }]
        } : {}
      }))
    };
  }
  const jobs = await mysqlQuery(`
    SELECT j.*, p.name AS created_by_name
    FROM ai_variant_lab_batch_jobs j
    LEFT JOIN people p ON p.id = j.created_by_person_id
    WHERE j.job_no = ?
    LIMIT 1
  `, [key]);
  if (!jobs.length) throw statusError(`batch job not found: ${key}`, 404);
  const items = await mysqlQuery(`
    SELECT item_no, target_variant_value, status, plan_no, item_json, image_result_json, error_message, sort_order, created_at, updated_at
    FROM ai_variant_lab_batch_items
    WHERE job_no = ?
    ORDER BY sort_order ASC, id ASC
  `, [key]);
  for (const item of items) {
    if (item.status !== "image_done") continue;
    const imageResult = parseStoredJson(item.image_result_json, {});
    const images = [...toArray(imageResult.generatedImages), ...toArray(imageResult.croppedImages)];
    if (!images.some((image) => image?.url && image?.durable !== true)) continue;
    try {
      const durableResult = await persistAiVariantImageResult(imageResult, {
        jobNo: key,
        itemNo: item.item_no,
        targetVariantValue: item.target_variant_value,
        sessionPersonId: personId(session) || jobs[0].created_by_person_id
      });
      item.image_result_json = JSON.stringify(durableResult);
      await mysqlExecute("UPDATE ai_variant_lab_batch_items SET image_result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE item_no = ?", [
        item.image_result_json,
        item.item_no
      ]);
    } catch (error) {
      item.persistence_error = cleanText(error?.message || error);
    }
  }
  const queue = await batchImageQueueStats(key, await resolveImageRuntimeQueueConfig({
    imageConcurrency: positiveInteger(jobs[0].image_concurrency || 20, 20)
  }));
  return {
    ok: true,
    job: {
      ...jobs[0],
      request_json: parseStoredJson(jobs[0].request_json, {}),
      result_json: parseStoredJson(jobs[0].result_json, {}),
      usage_json: parseStoredJson(jobs[0].usage_json, {}),
      cost_json: parseStoredJson(jobs[0].cost_json, {})
    },
    queue,
    items: items.map((item) => ({
      ...item,
      item_json: parseStoredJson(item.item_json, {}),
      image_result_json: parseStoredJson(item.image_result_json, {})
    }))
  };
}

export async function aiVariantLabManualImageResult(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  const itemNo = cleanText(body.itemNo || body.item_no || "");
  const imageUrl = cleanText(body.url || body.imageUrl || body.image_url || body.publishUrl || body.publish_url || "");
  if (!jobNo) throw statusError("jobNo is required", 400);
  if (!itemNo) throw statusError("itemNo is required", 400);
  if (!imageUrl) throw statusError("imageUrl is required", 400);
  const imageResult = {
    manual_upload: true,
    uploaded_by_person_id: personId(session),
    uploaded_at: new Date().toISOString(),
    generatedImages: [{
      url: imageUrl,
      publishUrl: cleanText(body.publishUrl || body.publish_url || imageUrl),
      previewUrl: cleanText(body.previewUrl || body.preview_url || imageUrl),
      name: cleanText(body.name || body.fileName || body.file_name || "manual-main-image"),
      source: "manual_upload"
    }]
  };
  const result = await mysqlExecute(`
    UPDATE ai_variant_lab_batch_items
    SET status = 'image_done',
        image_result_json = ?,
        error_message = '',
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ? AND item_no = ?
  `, [JSON.stringify(imageResult), jobNo, itemNo]);
  if (!result.affectedRows) throw statusError(`batch item not found: ${itemNo}`, 404);
  const summary = await summarizeBatchJob(jobNo);
  const finalStatus = summary.queued > 0 || summary.generating > 0
    ? "generating_images"
    : summary.failed > 0
    ? (summary.done > 0 ? "partially_failed" : "failed")
    : summary.pending > 0
    ? "partially_generated"
    : "image_done";
  await mysqlExecute(`
    UPDATE ai_variant_lab_batch_jobs
    SET status = ?,
        result_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ?
  `, [
    finalStatus,
    JSON.stringify({
      summary,
      manual_image_uploaded_item_no: itemNo,
      manual_image_uploaded_at: new Date().toISOString()
    }),
    jobNo
  ]);
  return {
    ok: true,
    job_no: jobNo,
    item_no: itemNo,
    image_result: imageResult,
    summary,
    session_person_id: personId(session)
  };
}

function shouldReuseAnalysis(body = {}) {
  const forced = ["1", "true", "yes"].includes(String(body.forceAnalyze || body.force_analyze || body.forceReanalyze || body.force_reanalyze || "").toLowerCase());
  if (forced) return false;
  return ["1", "true", "yes"].includes(String(body.reuseAnalysis || body.reuse_analysis || body.useHistory || body.use_history || "").toLowerCase());
}

async function findReusableVariantAnalysis({ sourceProductId = "", sourceImageUrl = "", businessMode = "" } = {}) {
  const lookup = await latestAnalysisRow({
    table: "ai_variant_lab_analyses",
    idColumn: "analysis_no",
    whereExtra: "business_mode = ?",
    extraParams: [businessMode],
    sourceProductId,
    sourceImageUrl
  });
  if (!lookup) return null;
  return {
    ok: true,
    analysis_no: lookup.recordNo,
    analysis: parseStoredJson(lookup.row.analysis_json, {}),
    reused: true,
    reused_from: "history",
    reused_at: lookup.row.updated_at || lookup.row.created_at || ""
  };
}

async function findReusableOptimizerAnalysis({ sourceProductId = "", sourceImageUrl = "" } = {}) {
  const lookup = await latestAnalysisRow({
    table: "ai_image_optimizer_jobs",
    idColumn: "job_no",
    includeStatus: true,
    whereExtra: "analysis_json IS NOT NULL AND analysis_json <> ''",
    sourceProductId,
    sourceImageUrl
  });
  if (!lookup) return null;
  return {
    ok: true,
    job_no: lookup.recordNo,
    analysis: normalizeOptimizerAnalysis(parseStoredJson(lookup.row.analysis_json, {})),
    reused: true,
    reused_from: "history",
    status: lookup.row.status || "analyzed",
    analysis_confirmed: lookup.row.status === "analysis_confirmed" || ["plan_confirmed", "generated", "partial"].includes(lookup.row.status),
    reused_at: lookup.row.updated_at || lookup.row.created_at || "",
    estimated_text_cost_cny: 0
  };
}

async function latestAnalysisRow({ table, idColumn, sourceProductId = "", sourceImageUrl = "", includeStatus = false, whereExtra = "", extraParams = [] } = {}) {
  const productId = cleanText(sourceProductId);
  const imageUrl = cleanText(sourceImageUrl);
  if (!productId && !imageUrl) return null;
  const matchWhere = [];
  const matchParams = [];
  if (productId) {
    matchWhere.push("source_product_id = ?");
    matchParams.push(productId);
  }
  if (imageUrl) {
    matchWhere.push("source_image_url = ?");
    matchParams.push(imageUrl);
  }
  const where = [...(whereExtra ? [whereExtra] : []), `(${matchWhere.join(" OR ")})`];
  const params = [...extraParams, ...matchParams];
  const rows = await mysqlQuery(`
    SELECT ${idColumn} AS record_no, source_product_id, source_image_url${includeStatus ? ", status" : ""}, analysis_json, created_at, updated_at
    FROM ${table}
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE
        WHEN ? <> '' AND source_product_id = ? THEN 0
        WHEN ? <> '' AND source_image_url = ? THEN 1
        ELSE 2
      END,
      updated_at DESC,
      created_at DESC
    LIMIT 1
  `, [...params, productId, productId, imageUrl, imageUrl]);
  if (!rows.length) return null;
  return { recordNo: rows[0].record_no, row: rows[0] };
}

export async function aiImageOptimizerAnalyze(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const sourceProductId = cleanText(body.sourceProductId || body.source_product_id || "");
  const sourceImageUrl = cleanText(body.sourceImageUrl || body.imageUrl || body.image_url || body.imagePath || body.image_path || "");
  if (body.lookupOnly || body.lookup_only) {
    const reusable = await findReusableOptimizerAnalysis({ sourceProductId, sourceImageUrl });
    return reusable || { ok: true, reusable: false };
  }
  const imageInputs = await resolveOptimizerImageInputs(body);
  const imageUrl = imageInputs[0]?.sourceUrl || imageInputs[0]?.url || "";
  const reusable = shouldReuseAnalysis(body)
    ? await findReusableOptimizerAnalysis({ sourceProductId, sourceImageUrl: imageUrl })
    : null;
  if (reusable) return reusable;
  const result = await visionWithAiProvider({
    temperature: 0.12,
    maxTokens: 1500,
    timeoutMs: 180_000,
    messages: [
      { role: "system", content: optimizerAnalyzeSystemPrompt() },
      {
        role: "user",
        content: [
          { type: "text", text: buildOptimizerAnalyzePrompt(body, imageInputs) },
          ...imageInputs.map((item) => ({ type: "image_url", image_url: { url: item.url } }))
        ]
      }
    ]
  });
  const analysis = normalizeOptimizerAnalysis(parseJsonObject(result.content, { raw_text: result.content, parse_error: true }));
  const jobNo = body.jobNo || body.job_no || makeNo("OPTJOB");
  await mysqlExecute(`
    INSERT INTO ai_image_optimizer_jobs
    (job_no, source_image_url, source_product_id, status, model, usage_json, analysis_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_image_url = VALUES(source_image_url),
      source_product_id = VALUES(source_product_id),
      status = VALUES(status),
      model = VALUES(model),
      usage_json = VALUES(usage_json),
      analysis_json = VALUES(analysis_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    jobNo,
    imageUrl,
    cleanText(body.sourceProductId || body.source_product_id || ""),
    "analyzed",
    result.model || "",
    JSON.stringify(result.usage || {}),
    JSON.stringify(analysis),
    personId(session)
  ]);
  return {
    ok: true,
    job_no: jobNo,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    estimated_text_cost_cny: estimateTextCostCny(result.usage),
    analysis
  };
}

export async function aiImageOptimizerAnalysisLookup(body = {}) {
  await ensureAiVariantLabSchema();
  const sourceProductId = cleanText(body.sourceProductId || body.source_product_id || "");
  const sourceImageUrl = cleanText(body.sourceImageUrl || body.imageUrl || body.image_url || body.imagePath || body.image_path || "");
  return await findReusableOptimizerAnalysis({ sourceProductId, sourceImageUrl }) || { ok: true, reusable: false };
}

export async function aiImageOptimizerConfirmAnalysis(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  const analysis = normalizeOptimizerAnalysis(body.analysis || {});
  if (!jobNo) throw statusError("jobNo is required", 400);
  const result = await mysqlExecute(`
    UPDATE ai_image_optimizer_jobs
    SET analysis_json = ?, plan_json = NULL, result_json = NULL, status = 'analysis_confirmed',
        created_by_person_id = COALESCE(created_by_person_id, ?), updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ?
  `, [JSON.stringify(analysis), personId(session), jobNo]);
  if (!Number(result?.affectedRows || 0)) throw statusError(`optimizer job not found: ${jobNo}`, 404);
  return { ok: true, job_no: jobNo, status: "analysis_confirmed", analysis };
}

export async function aiImageOptimizerConfirmPlan(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  if (!jobNo) throw statusError("jobNo is required", 400);
  const suppliedPlan = objectValue(body.plan);
  const plan = {
    ...normalizeOptimizationPlan(suppliedPlan, body.analysis || await resolveOptimizerAnalysis(jobNo)),
    operator_edits: objectValue(suppliedPlan.operator_edits),
    confirmed_generation_modules: arrayValue(suppliedPlan.confirmed_generation_modules)
  };
  const result = await mysqlExecute(`
    UPDATE ai_image_optimizer_jobs
    SET plan_json = ?, result_json = NULL, status = 'plan_confirmed',
        created_by_person_id = COALESCE(created_by_person_id, ?), updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ? AND status IN ('analysis_confirmed', 'planned', 'plan_confirmed', 'generated', 'partial')
  `, [JSON.stringify(plan), personId(session), jobNo]);
  if (!Number(result?.affectedRows || 0)) throw statusError("请先确认并保存识别结果", 409);
  return { ok: true, job_no: jobNo, status: "plan_confirmed", plan };
}

export async function aiImageOptimizerSaveResult(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  if (!jobNo) throw statusError("jobNo is required", 400);
  const resultJson = nonEmptyObjectValue(body.result || body.result_json) || {};
  const status = body.partial === true ? "partial" : "generated";
  const result = await mysqlExecute(`
    UPDATE ai_image_optimizer_jobs
    SET result_json = ?, status = ?, created_by_person_id = COALESCE(created_by_person_id, ?), updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ? AND status IN ('plan_confirmed', 'generated', 'partial')
  `, [JSON.stringify(resultJson), status, personId(session), jobNo]);
  if (!Number(result?.affectedRows || 0)) throw statusError("请先确认并保存生成计划", 409);
  return { ok: true, job_no: jobNo, status, result: resultJson };
}

export async function aiImageOptimizerJobDetail(jobNo = "") {
  await ensureAiVariantLabSchema();
  const key = cleanText(jobNo);
  const rows = await mysqlQuery(`
    SELECT job_no, source_image_url, source_product_id, status, model, usage_json,
           analysis_json, plan_json, result_json, created_at, updated_at
    FROM ai_image_optimizer_jobs WHERE job_no = ? LIMIT 1
  `, [key]);
  if (!rows.length) throw statusError(`optimizer job not found: ${key}`, 404);
  const row = rows[0];
  return {
    ok: true,
    job_no: row.job_no,
    source_image_url: row.source_image_url || "",
    source_product_id: row.source_product_id || "",
    status: row.status,
    model: row.model || "",
    usage: parseStoredJson(row.usage_json, {}),
    analysis: parseStoredJson(row.analysis_json, null),
    plan: parseStoredJson(row.plan_json, null),
    result: parseStoredJson(row.result_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function aiImageOptimizerPlan(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const jobNo = cleanText(body.jobNo || body.job_no || "");
  const analysis = body.analysis || await resolveOptimizerAnalysis(jobNo);
  const planRequest = {
    temperature: 0.14,
    maxTokens: 1700,
    timeoutMs: 180_000,
    messages: [
      { role: "system", content: optimizerPlanSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          goal: cleanText(body.goal || body.optimizationGoal || body.optimization_goal || "Improve Ozon main image click-through while preserving product truth."),
          optimization_level: cleanText(body.optimizationLevel || body.optimization_level || "medium"),
          analysis,
          operator_confirmed_facts: objectValue(body.operatorFacts || body.operator_facts || analysis?.operator_confirmed_facts),
          operator_note: cleanText(body.operatorNote || body.operator_note || "")
        }, null, 2)
      }
    ]
  };
  const result = await callOptimizerPlanWithRetry(planRequest);
  const plan = normalizeOptimizationPlan(parseJsonObject(result.content, { raw_text: result.content, parse_error: true }), analysis);
  const nextJobNo = jobNo || body.jobNo || body.job_no || makeNo("OPTJOB");
  await mysqlExecute(`
    INSERT INTO ai_image_optimizer_jobs
    (job_no, source_image_url, source_product_id, status, model, usage_json, analysis_json, plan_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      model = VALUES(model),
      usage_json = VALUES(usage_json),
      analysis_json = COALESCE(analysis_json, VALUES(analysis_json)),
      plan_json = VALUES(plan_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    nextJobNo,
    cleanText(body.sourceImageUrl || body.imageUrl || body.imagePath || ""),
    cleanText(body.sourceProductId || body.source_product_id || ""),
    "planned",
    result.model || "",
    JSON.stringify(result.usage || {}),
    JSON.stringify(analysis || {}),
    JSON.stringify(plan),
    personId(session)
  ]);
  return {
    ok: true,
    job_no: nextJobNo,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    estimated_text_cost_cny: estimateTextCostCny(result.usage),
    plan
  };
}

async function callOptimizerPlanWithRetry(payload = {}) {
  try {
    return await chatWithAiProvider(payload);
  } catch (error) {
    const status = Number(error?.status || 0);
    const message = String(error?.message || "");
    const transient = status === 429 || [500, 502, 503, 504].includes(status)
      || /timeout|timed out|abort|network|socket|ECONNRESET|ETIMEDOUT/i.test(message);
    if (!transient) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return await chatWithAiProvider(payload);
  }
}

export async function aiImageOptimizerReviewImage(body = {}) {
  const generatedImageUrl = cleanText(body.generatedImageUrl || body.generated_image_url || "");
  if (!generatedImageUrl) throw statusError("generatedImageUrl is required", 400);
  const referenceImageUrl = cleanText(body.referenceImageUrl || body.reference_image_url || "");
  const images = [];
  if (referenceImageUrl) images.push({
    type: "image_url",
    image_url: { url: await resolveImageUrl({ imageUrl: referenceImageUrl }) }
  });
  images.push({
    type: "image_url",
    image_url: { url: await resolveImageUrl({ imageUrl: generatedImageUrl }) }
  });
  const result = await visionWithAiProvider({
    temperature: 0.05,
    maxTokens: 900,
    timeoutMs: 180_000,
    messages: [
      { role: "system", content: optimizerImageReviewSystemPrompt() },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              image_order: referenceImageUrl ? ["reference_or_approved_main", "generated_candidate"] : ["generated_candidate"],
              role: cleanText(body.role || "detail"),
              shot: objectValue(body.shot),
              verified_facts: toArray(body.verifiedFacts || body.verified_facts),
              forbidden_changes: toArray(body.forbiddenChanges || body.forbidden_changes),
              review_instruction: "Reject only material defects. Return short actionable English corrections for one image regeneration attempt."
            }, null, 2)
          },
          ...images
        ]
      }
    ]
  });
  const review = normalizeOptimizerImageReview(parseJsonObject(result.content, { raw_text: result.content, parse_error: true }));
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    usage: result.usage || null,
    estimated_text_cost_cny: estimateTextCostCny(result.usage),
    review
  };
}

export async function aiImageOptimizerComposeText(body = {}) {
  const imageUrl = cleanText(body.imageUrl || body.image_url || "");
  if (!imageUrl) throw statusError("imageUrl is required", 400);
  const title = optimizerOverlayText(body.title || body.text || body.overlayText || body.overlay_text || "");
  const subtitle = optimizerOverlayText(body.subtitle || body.compatibility || "");
  const bullets = toArray(body.bullets || body.benefits).map(optimizerOverlayText).filter(Boolean).slice(0, 3);
  if (!title && !subtitle && !bullets.length) return { ok: true, composed: false, url: imageUrl };
  const dataUrl = await resolveImageUrl({ imageUrl });
  const sourceBuffer = dataUrlBuffer(dataUrl);
  const image = sharp(sourceBuffer).rotate();
  const metadata = await image.metadata();
  const width = Math.max(1, Number(metadata.width || 1024));
  const height = Math.max(1, Number(metadata.height || 1536));
  const overlay = optimizerTextOverlaySvg({
    width,
    height,
    title,
    subtitle,
    bullets,
    placement: cleanKey(body.placement || "top") === "bottom" ? "bottom" : "top"
  });
  const filename = `ai-material-text-${Date.now()}-${crypto.randomBytes(5).toString("hex")}.png`;
  const composedBuffer = await image.composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
  const stored = await putContentAddressedObject(composedBuffer, {
    prefix: "listing-media",
    extension: ".png",
    contentType: "image/png"
  });
  if (stored) {
    return { ok: true, composed: true, url: stored.url, text: title, subtitle, bullets };
  }
  const outputRoots = [...new Set([
    path.resolve(process.env.LISTING_MEDIA_ROOT || "public/uploads/listing-media"),
    path.resolve("public", "uploads", "listing-media")
  ])];
  await Promise.all(outputRoots.map((root) => fs.promises.mkdir(root, { recursive: true })));
  await Promise.all(outputRoots.map((root) => fs.promises.writeFile(path.join(root, filename), composedBuffer)));
  return { ok: true, composed: true, url: `/uploads/listing-media/${filename}`, text: title, subtitle, bullets };
}

export async function aiImageOptimizerTestImage(body = {}) {
  const plan = body.plan || await resolveOptimizerPlan(cleanText(body.jobNo || body.job_no || "")).catch(() => null);
  const prompt = cleanText(body.imagePrompt || body.image_prompt || plan?.image_optimization_prompt_en || "");
  if (!prompt) throw statusError("image optimization prompt is required", 400);
  return {
    ok: true,
    dry_run: body.dryRun !== false,
    prompt_package: {
      image_optimization_prompt_en: prompt,
      negative_prompt_en: cleanText(body.negativePrompt || body.negative_prompt || plan?.negative_prompt_en || ""),
      keep_facts: toArray(plan?.keep_facts),
      optimization_goals: toArray(plan?.optimization_goals),
      quality_checks: toArray(plan?.quality_checks)
    },
    preflight: optimizerPromptPreflight(prompt, plan || {})
  };
}

export async function aiProductMaterialOptimizerPrepareTemplate(body = {}, session = {}) {
  const candidates = normalizeMaterialCandidates(body.candidates || body.candidatePool || body.candidate_pool || []);
  let finalImageSlots = normalizeFinalImageSlots(body.finalImageSlots || body.final_image_slots || [], candidates);
  if (!finalImageSlots.length) throw statusError("请先选择最终图片位", 400);
  if (!finalImageSlots[0]?.url) throw statusError("主图位不能为空", 400);
  const materializedUrls = new Map();
  finalImageSlots = await Promise.all(finalImageSlots.map(async (slot, index) => {
    const sourceUrl = cleanText(slot.url);
    if (/^https:\/\//i.test(sourceUrl)) {
      materializedUrls.set(sourceUrl, sourceUrl);
      return slot;
    }
    try {
      const persisted = await materializeListingMediaAssetUrl(sourceUrl, {
        source_module: "ai_product_material_optimizer",
        source_id: cleanText(body.sourceProductId || body.source_product_id || body.optimizerJobNo || body.optimizer_job_no || ""),
        batch_id: cleanText(body.optimizerJobNo || body.optimizer_job_no || ""),
        role: index === 0 ? "optimizer_main" : `optimizer_detail_${index}`
      }, session);
      const finalUrl = cleanText(persisted?.finalUrl || persisted?.publishUrl || persisted?.localUrl);
      if (!finalUrl) throw new Error("media library returned no usable URL");
      materializedUrls.set(sourceUrl, finalUrl);
      return { ...slot, url: finalUrl };
    } catch (error) {
      throw statusError(`Selected ${index === 0 ? "main image" : `detail image ${index}`} could not be materialized: ${error?.message || "retry this image"}`, 503);
    }
  }));
  const durableCandidates = candidates.map((candidate) => ({ ...candidate, url: materializedUrls.get(candidate.url) || candidate.url }));
  const images = finalImageSlots.map((slot, index) => ({
    url: slot.url,
    name: slot.name || (index === 0 ? "主图" : `详情图${index}`),
    sort_order: index + 1,
    role: index === 0 ? "main" : slot.role || "detail",
    candidate_id: slot.candidate_id || ""
  }));
  const templatePatch = buildMaterialOptimizationTemplatePatch({
    templatePayload: body.templatePayload || body.template_payload || {},
    images,
    candidates: durableCandidates,
    finalImageSlots,
    textResults: body.textResults || body.text_results || {},
    plan: body.plan || {},
    userNote: body.userNote || body.user_note || ""
  });
  return {
    ok: true,
    candidates: durableCandidates,
    final_image_slots: finalImageSlots,
    materialized_url_map: Object.fromEntries(materializedUrls),
    images,
    template_patch: templatePatch,
    publish_preview: {
      primary_image: images[0]?.url || "",
      images: images.map((item) => item.url),
      image_count: images.length,
      uses_final_image_slots: true
    }
  };
}

export async function aiVariantLabTestImageEdit(body = {}) {
  const plan = body.plan || await resolvePlan(body).catch(() => null);
  const analysis = body.analysis || await resolveAnalysis(body).catch(() => null);
  const imagePrompt = cleanText(body.imageEditPrompt || body.image_edit_prompt || plan?.image_edit_prompt_en || plan?.image_prompt || "");
  if (!imagePrompt) throw statusError("image edit prompt is required", 400);
  return {
    ok: true,
    dry_run: body.dryRun !== false,
    provider_note: "This endpoint validates the prompt package only; it does not spend image-generation budget yet.",
    prompt_package: {
      image_edit_prompt_en: imagePrompt,
      negative_prompt_en: cleanText(body.negativePrompt || body.negative_prompt || plan?.negative_prompt_en || ""),
      keep_facts: toArray(plan?.keep_facts || analysis?.keep_facts),
      change_facts: toArray(plan?.change_facts || plan?.changeable_facts || analysis?.changeable_facts),
      quality_checks: toArray(plan?.quality_checks)
    },
    preflight: imagePromptPreflight(imagePrompt, plan || {}, analysis || {})
  };
}

export async function aiVariantLabSaveTemplate(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const templateKey = cleanKey(body.templateKey || body.template_key || DEFAULT_TEMPLATE_KEY);
  const templateName = cleanText(body.templateName || body.template_name || "AI variant template");
  const categoryKey = cleanKey(body.categoryKey || body.category_key || DEFAULT_TEMPLATE_KEY);
  const templateJson = body.template || body.template_json || buildTemplateFromBody(body);
  await mysqlExecute(`
    INSERT INTO ai_variant_templates
    (template_key, template_name, category_key, user_note, template_json, status, auto_apply, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      template_name = VALUES(template_name),
      category_key = VALUES(category_key),
      user_note = VALUES(user_note),
      template_json = VALUES(template_json),
      status = VALUES(status),
      auto_apply = VALUES(auto_apply),
      updated_at = CURRENT_TIMESTAMP
  `, [
    templateKey,
    templateName,
    categoryKey,
    cleanText(body.userNote || body.user_note || ""),
    JSON.stringify(templateJson),
    cleanText(body.status || "active"),
    body.autoApply || body.auto_apply ? 1 : 0,
    personId(session)
  ]);

  const casePayload = body.case || body.case_json;
  if (casePayload) {
    const caseKey = cleanKey(casePayload.caseKey || casePayload.case_key || makeNo("AVL-C"));
    await mysqlExecute(`
      INSERT INTO ai_variant_template_cases
      (case_key, template_key, case_name, source_model, fingerprint_json, prompt_set_json, quality_checks_json, result_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        case_name = VALUES(case_name),
        source_model = VALUES(source_model),
        fingerprint_json = VALUES(fingerprint_json),
        prompt_set_json = VALUES(prompt_set_json),
        quality_checks_json = VALUES(quality_checks_json),
        result_score = VALUES(result_score),
        updated_at = CURRENT_TIMESTAMP
    `, [
      caseKey,
      templateKey,
      cleanText(casePayload.caseName || casePayload.case_name || templateName),
      cleanText(casePayload.sourceModel || casePayload.source_model || ""),
      JSON.stringify(casePayload.fingerprint || {}),
      JSON.stringify(casePayload.promptSet || casePayload.prompt_set || {}),
      JSON.stringify(casePayload.qualityChecks || casePayload.quality_checks || []),
      finiteNumber(casePayload.resultScore || casePayload.result_score, null)
    ]);
  }

  return { ok: true, template_key: templateKey };
}

export async function aiVariantLabTemplates(query = {}) {
  await ensureAiVariantLabSchema();
  const where = [];
  const params = [];
  if (query.templateKey || query.template_key) {
    where.push("template_key = ?");
    params.push(cleanKey(query.templateKey || query.template_key));
  }
  if (query.categoryKey || query.category_key) {
    where.push("category_key = ?");
    params.push(cleanKey(query.categoryKey || query.category_key));
  }
  if (query.status) {
    where.push("status = ?");
    params.push(cleanText(query.status));
  }
  const rows = await mysqlQuery(`
    SELECT template_key, template_name, category_key, user_note, template_json, status, auto_apply, created_at, updated_at
    FROM ai_variant_templates
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
    LIMIT 100
  `, params);
  return {
    ok: true,
    templates: rows.map((row) => ({
      ...row,
      auto_apply: Boolean(row.auto_apply),
      template_json: parseStoredJson(row.template_json, {})
    }))
  };
}

export async function aiVariantLabSaveCase(body = {}, session = {}) {
  await ensureAiVariantLabSchema();
  const caseJson = buildVariantCaseFromBody(body);
  const caseNo = cleanText(body.caseNo || body.case_no || caseJson.case_no || makeNo("AVC"));
  const caseName = cleanText(body.caseName || body.case_name || caseJson.case_name || "AI variant case");
  const status = cleanText(body.status || caseJson.status || "active") || "active";
  const productSubject = objectValue(caseJson.product_facts);
  const variantContract = objectValue(caseJson.variant_contract);
  const successTargetValue = cleanText(
    body.successTargetValue
    || body.success_target_value
    || caseJson.success_target_value
    || variantContract.success_target_value
    || ""
  );
  await mysqlExecute(`
    INSERT INTO ai_variant_case_templates
    (case_no, case_name, product_subject_key, product_subject_name, variant_type, variable_slot, source_value, success_target_value, status, success_score, case_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      case_name = VALUES(case_name),
      product_subject_key = VALUES(product_subject_key),
      product_subject_name = VALUES(product_subject_name),
      variant_type = VALUES(variant_type),
      variable_slot = VALUES(variable_slot),
      source_value = VALUES(source_value),
      success_target_value = VALUES(success_target_value),
      status = VALUES(status),
      success_score = VALUES(success_score),
      case_json = VALUES(case_json),
      updated_at = CURRENT_TIMESTAMP
  `, [
    caseNo,
    caseName,
    cleanKey(body.productSubjectKey || body.product_subject_key || caseJson.product_subject_key || productSubject.product_subject_key || productSubject.product_type || ""),
    cleanText(body.productSubjectName || body.product_subject_name || caseJson.product_subject_name || productSubject.product_subject_name || productSubject.product_type || ""),
    cleanText(body.variantType || body.variant_type || caseJson.variant_type || variantContract.variant_type || ""),
    cleanText(body.variableSlot || body.variable_slot || caseJson.variable_slot || variantContract.variable_slot || ""),
    cleanText(body.sourceValue || body.source_value || caseJson.source_value || variantContract.source_value || ""),
    successTargetValue,
    status,
    finiteNumber(body.successScore || body.success_score || caseJson.success_score, null),
    JSON.stringify({ ...caseJson, case_no: caseNo, case_name: caseName, status, success_target_value: successTargetValue }),
    personId(session)
  ]);
  return { ok: true, case_no: caseNo };
}

export async function aiVariantLabCases(query = {}) {
  await ensureAiVariantLabSchema();
  const where = [];
  const params = [];
  const page = clampInteger(query.page, 1, 100000, 1);
  const pageSize = clampInteger(query.pageSize || query.page_size, 10, 100, 20);
  const offset = (page - 1) * pageSize;
  const keyword = cleanText(query.keyword || query.q || "");
  if (keyword) {
    where.push("(case_no LIKE ? OR case_name LIKE ? OR product_subject_name LIKE ? OR source_value LIKE ? OR success_target_value LIKE ?)");
    const like = `%${keyword}%`;
    params.push(like, like, like, like, like);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(cleanText(query.status));
  } else {
    where.push("status <> 'deleted'");
  }
  if (query.variantType || query.variant_type) {
    where.push("variant_type = ?");
    params.push(cleanText(query.variantType || query.variant_type));
  }
  const countRows = await mysqlQuery(`
    SELECT COUNT(*) AS total
    FROM ai_variant_case_templates
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `, params);
  const rows = await mysqlQuery(`
    SELECT case_no, case_name, product_subject_key, product_subject_name, variant_type, variable_slot, source_value,
      success_target_value, status, usage_count, success_score, case_json, created_at, updated_at
    FROM ai_variant_case_templates
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);
  return {
    ok: true,
    page,
    pageSize,
    total: Number(countRows[0]?.total || 0),
    cases: rows.map((row) => ({
      ...row,
      usage_count: Number(row.usage_count || 0),
      success_score: row.success_score == null ? null : Number(row.success_score),
      case_json: parseStoredJson(row.case_json, {})
    }))
  };
}

export async function aiVariantLabCaseDetail(caseNo) {
  await ensureAiVariantLabSchema();
  const key = cleanText(caseNo || "");
  if (!key) throw statusError("caseNo is required", 400);
  const rows = await mysqlQuery(`
    SELECT case_no, case_name, product_subject_key, product_subject_name, variant_type, variable_slot, source_value,
      success_target_value, status, usage_count, success_score, case_json, created_at, updated_at
    FROM ai_variant_case_templates
    WHERE case_no = ?
    LIMIT 1
  `, [key]);
  if (!rows.length) throw statusError(`case not found: ${key}`, 404);
  const row = rows[0];
  return {
    ok: true,
    case: {
      ...row,
      usage_count: Number(row.usage_count || 0),
      success_score: row.success_score == null ? null : Number(row.success_score),
      case_json: parseStoredJson(row.case_json, {})
    }
  };
}

export async function aiVariantLabDeleteCase(caseNo) {
  await ensureAiVariantLabSchema();
  const key = cleanText(caseNo || "");
  if (!key) throw statusError("caseNo is required", 400);
  const result = await mysqlExecute(`
    UPDATE ai_variant_case_templates
    SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE case_no = ? AND status <> 'deleted'
  `, [key]);
  if (!Number(result.affectedRows || 0)) throw statusError(`case not found: ${key}`, 404);
  return { ok: true, deleted: 1, case_no: key };
}

async function ensureAiVariantLabSchema() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_lab_analyses (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      analysis_no VARCHAR(64) NOT NULL,
      source_image_url TEXT NULL,
      source_product_id VARCHAR(128) NOT NULL DEFAULT '',
      business_mode VARCHAR(64) NOT NULL DEFAULT '',
      model VARCHAR(128) NOT NULL DEFAULT '',
      usage_json LONGTEXT NULL,
      analysis_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_lab_analyses_no (analysis_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_lab_plans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      plan_no VARCHAR(64) NOT NULL,
      analysis_no VARCHAR(64) NOT NULL DEFAULT '',
      source_variant_value VARCHAR(128) NOT NULL DEFAULT '',
      target_variant_value VARCHAR(128) NOT NULL DEFAULT '',
      template_key VARCHAR(128) NOT NULL DEFAULT '',
      model VARCHAR(128) NOT NULL DEFAULT '',
      usage_json LONGTEXT NULL,
      plan_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_lab_plans_no (plan_no),
      KEY idx_ai_variant_lab_plans_analysis (analysis_no),
      KEY idx_ai_variant_lab_plans_template (template_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      template_key VARCHAR(128) NOT NULL,
      template_name VARCHAR(255) NOT NULL DEFAULT '',
      category_key VARCHAR(128) NOT NULL DEFAULT '',
      user_note TEXT NULL,
      template_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      auto_apply TINYINT(1) NOT NULL DEFAULT 0,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_templates_key (template_key),
      KEY idx_ai_variant_templates_category (category_key),
      KEY idx_ai_variant_templates_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_template_cases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      case_key VARCHAR(128) NOT NULL,
      template_key VARCHAR(128) NOT NULL,
      case_name VARCHAR(255) NOT NULL DEFAULT '',
      source_model VARCHAR(128) NOT NULL DEFAULT '',
      fingerprint_json LONGTEXT NULL,
      prompt_set_json LONGTEXT NULL,
      quality_checks_json LONGTEXT NULL,
      result_score DECIMAL(5,2) NULL,
      success_count INT NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_template_cases_key (case_key),
      KEY idx_ai_variant_template_cases_template (template_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_case_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      case_no VARCHAR(64) NOT NULL,
      case_name VARCHAR(255) NOT NULL DEFAULT '',
      product_subject_key VARCHAR(128) NOT NULL DEFAULT '',
      product_subject_name VARCHAR(255) NOT NULL DEFAULT '',
      variant_type VARCHAR(64) NOT NULL DEFAULT '',
      variable_slot VARCHAR(64) NOT NULL DEFAULT '',
      source_value VARCHAR(128) NOT NULL DEFAULT '',
      success_target_value VARCHAR(128) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      usage_count INT NOT NULL DEFAULT 0,
      success_score DECIMAL(5,2) NULL,
      case_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_case_templates_no (case_no),
      KEY idx_ai_variant_case_templates_status (status),
      KEY idx_ai_variant_case_templates_variant (variant_type),
      KEY idx_ai_variant_case_templates_subject (product_subject_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_case_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      run_no VARCHAR(64) NOT NULL,
      case_no VARCHAR(64) NOT NULL,
      target_values_json LONGTEXT NULL,
      result_job_no VARCHAR(64) NOT NULL DEFAULT '',
      generated_draft_ids_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'planned',
      result_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_case_runs_no (run_no),
      KEY idx_ai_variant_case_runs_case (case_no),
      KEY idx_ai_variant_case_runs_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_lab_batch_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_no VARCHAR(64) NOT NULL,
      job_type VARCHAR(64) NOT NULL DEFAULT '',
      analysis_no VARCHAR(64) NOT NULL DEFAULT '',
      source_product_id VARCHAR(128) NOT NULL DEFAULT '',
      source_variant_value VARCHAR(128) NOT NULL DEFAULT '',
      target_count INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'planned',
      budget_cny DECIMAL(10,4) NULL,
      image_concurrency INT NOT NULL DEFAULT 20,
      request_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      usage_json LONGTEXT NULL,
      cost_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_lab_batch_jobs_no (job_no),
      KEY idx_ai_variant_lab_batch_jobs_status (status),
      KEY idx_ai_variant_lab_batch_jobs_analysis (analysis_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_variant_lab_batch_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      item_no VARCHAR(64) NOT NULL,
      job_no VARCHAR(64) NOT NULL,
      target_variant_value VARCHAR(128) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'planned',
      plan_no VARCHAR(64) NOT NULL DEFAULT '',
      item_json LONGTEXT NULL,
      image_result_json LONGTEXT NULL,
      provider_job_json LONGTEXT NULL,
      error_message TEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_variant_lab_batch_items_no (item_no),
      KEY idx_ai_variant_lab_batch_items_job (job_no),
      KEY idx_ai_variant_lab_batch_items_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlExecute("ALTER TABLE ai_variant_lab_batch_items ADD COLUMN provider_job_json LONGTEXT NULL AFTER image_result_json")
    .catch((error) => { if (error?.code !== "ER_DUP_FIELDNAME") throw error; });
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_image_optimizer_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_no VARCHAR(64) NOT NULL,
      source_image_url TEXT NULL,
      source_product_id VARCHAR(128) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'planned',
      model VARCHAR(128) NOT NULL DEFAULT '',
      usage_json LONGTEXT NULL,
      analysis_json LONGTEXT NULL,
      plan_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_image_optimizer_jobs_no (job_no),
      KEY idx_ai_image_optimizer_jobs_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function resolveAnalysis(body = {}) {
  if (body.analysis && typeof body.analysis === "object") return applyProductFactGate(body.analysis);
  const analysisNo = cleanText(body.analysisNo || body.analysis_no || "");
  if (!analysisNo) throw statusError("analysis or analysisNo is required", 400);
  await ensureAiVariantLabSchema();
  const rows = await mysqlQuery("SELECT analysis_json FROM ai_variant_lab_analyses WHERE analysis_no = ? LIMIT 1", [analysisNo]);
  if (!rows.length) throw statusError(`analysis not found: ${analysisNo}`, 404);
  return applyProductFactGate(parseStoredJson(rows[0].analysis_json, {}));
}

async function resolvePlan(body = {}) {
  if (body.plan && typeof body.plan === "object") return body.plan;
  const planNo = cleanText(body.planNo || body.plan_no || "");
  if (!planNo) throw statusError("plan or planNo is required", 400);
  await ensureAiVariantLabSchema();
  const rows = await mysqlQuery("SELECT plan_json FROM ai_variant_lab_plans WHERE plan_no = ? LIMIT 1", [planNo]);
  if (!rows.length) throw statusError(`plan not found: ${planNo}`, 404);
  return parseStoredJson(rows[0].plan_json, {});
}

async function findTemplate(templateKey) {
  const key = cleanKey(templateKey || "");
  if (!key) return null;
  await ensureAiVariantLabSchema();
  const rows = await mysqlQuery("SELECT template_key, template_json FROM ai_variant_templates WHERE template_key = ? AND status <> 'disabled' LIMIT 1", [key]);
  if (!rows.length) return null;
  return {
    template_key: rows[0].template_key,
    template_json: parseStoredJson(rows[0].template_json, {})
  };
}

async function resolveImageUrl(body = {}) {
  const imageDataUrl = String(body.imageDataUrl || body.image_data_url || "").trim();
  if (imageDataUrl.startsWith("data:image/")) return imageDataUrl;
  const imageUrl = String(body.imageUrl || body.sourceImageUrl || body.image_url || body.source_image_url || "").trim();
  if (/^https?:\/\//i.test(imageUrl)) {
    const localPublicFile = resolveLocalPublicImageFile(imageUrl);
    if (localPublicFile) return localImageToDataUrl(localPublicFile);
    return imageUrl;
  }
  if (imageUrl.startsWith("data:image/")) return imageUrl;
  // Keep internal AI task references in-process. The image workflow validates the
  // task path before reading it, while an HTTP round-trip is blocked by site access.
  if (isInternalAiTaskImageUrl(imageUrl)) return imageUrl;
  const imagePath = String(body.imagePath || body.image_path || imageUrl || "").trim();
  if (!imagePath) throw statusError("imageUrl, imageDataUrl, or imagePath is required", 400);
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(imagePath);
  if (fs.existsSync(resolved)) return localImageToDataUrl(resolved);
  if (imagePath.startsWith("/")) return await fetchImageAsDataUrl(new URL(imagePath, config.appBaseUrl).toString());
  throw statusError(`image not found: ${imagePath}`, 404);
}

async function resolveOptimizerImageInputs(body = {}) {
  const candidates = normalizeMaterialCandidates(body.candidates || body.candidatePool || body.candidate_pool || []);
  const selectedIds = new Set(arrayValue(body.selectedCandidateIds || body.selected_candidate_ids)
    .map((item) => cleanKey(item))
    .filter(Boolean));
  const pickedCandidates = candidates
    .filter((item, index) => item.url && (index === 0 || !selectedIds.size || selectedIds.has(item.candidate_id)))
    .slice(0, 8);
  const inputs = [];
  if (body.imageDataUrl || body.image_data_url || body.imageUrl || body.image_url || body.sourceImageUrl || body.source_image_url || body.imagePath || body.image_path) {
    inputs.push({
      role: "main",
      label: "主图",
      sourceUrl: cleanText(body.sourceImageUrl || body.imageUrl || body.image_url || body.imagePath || body.image_path || ""),
      url: await resolveImageUrl(body)
    });
  }
  for (const [index, candidate] of pickedCandidates.entries()) {
    if (inputs.some((item) => item.sourceUrl && item.sourceUrl === candidate.url)) continue;
    inputs.push({
      role: candidate.kind || (index === 0 ? "main" : "detail"),
      label: candidate.title || (index === 0 ? "主图" : `详情图 ${index}`),
      sourceUrl: candidate.url,
      url: await resolveImageUrl({ imageUrl: candidate.url })
    });
  }
  if (!inputs.length) inputs.push({
    role: "main",
    label: "主图",
    sourceUrl: cleanText(body.sourceImageUrl || body.imageUrl || body.image_url || body.imagePath || body.image_path || ""),
    url: await resolveImageUrl(body)
  });
  return inputs.slice(0, 8);
}

async function fetchImageAsDataUrl(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw statusError(`商品图片读取失败：${new URL(url).hostname} 无法访问，请检查图片是否已保存到本地素材库`, 400);
  }
  if (!response.ok) throw statusError(`failed to fetch image: ${response.status}`, 400);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "image/png";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function isInternalAiTaskImageUrl(value = "") {
  return /^\/api\/ai\/(?:file|preview-file)\/[^/]+\/(?:[^/]+\/)?[^/]+/i.test(String(value || ""));
}

function resolveLocalPublicImageFile(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    if (!new Set(["erp.hjt888.xyz", "localhost", "127.0.0.1"]).has(parsed.hostname.toLowerCase())) return "";
    const relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    if (!relative.startsWith("uploads/listing-media/")) return "";
    const publicRoot = path.resolve("public");
    const resolved = path.resolve(publicRoot, relative);
    if (!resolved.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(resolved)) return "";
    return resolved;
  } catch {
    return "";
  }
}

function localImageToDataUrl(filePath) {
  const mime = mimeFromExt(path.extname(filePath));
  const base64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${base64}`;
}

function mimeFromExt(ext) {
  const normalized = String(ext || "").toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".gif") return "image/gif";
  return "image/png";
}

function analyzeSystemPrompt() {
  return [
    "You are an ecommerce SKU fission analyst for Ozon automotive accessories.",
    "Return strict JSON only. No Markdown.",
    "All operator-facing display fields must be Simplified Chinese.",
    "Separate stable product facts from variant facts.",
    "For vehicle_model_variant, source vehicle model, logo text, grille badge, plate text, and background car model are variant facts, not keep facts.",
    "When visible text exists, classify it by image region: large title, model text, logo/badge text, license plate text, background vehicle cues, or product printed marks.",
    "Never invent material, quantity, compatibility, or certification claims."
  ].join("\n");
}

function buildAnalyzePrompt(body, businessMode) {
  const operatorNote = cleanText(body.operatorNote || body.operator_note || "");
  return [
    `Business mode: ${businessMode}.`,
    `Operator goal: ${cleanText(body.operatorGoal || body.operator_goal || "Identify the product and prepare a reusable SKU fission template.")}`,
    operatorNote ? `Operator hard constraint: ${operatorNote}` : "",
    "Analyze the image and return JSON with these keys:",
    "product_type, product_subject_ru, material, quantity, source_variant_value, visible_texts, image_text_regions, product_printed_marks_policy, editable_regions, keep_facts, changeable_facts, forbidden_changes, quality_risks, recommended_variant_mode, template_match, confidence, display_zh.",
    "image_text_regions should include large_title_text, model_text, logo_or_badge_text, license_plate_text, background_vehicle_cues, and product_printed_marks arrays when visible.",
    "product_printed_marks_policy must be replace, preserve, or uncertain.",
    "display_zh must include product_type, fixed_facts, variable_facts, forbidden_changes, recognition_summary, recommended_action, all written in Simplified Chinese.",
    "keep_facts must describe the product body that should not change.",
    "changeable_facts must include every visible source vehicle/model/logo/background text that should change during fission.",
    "Do not put source vehicle model, source logo, source license plate text, grille badge, or background car into keep_facts or forbidden_changes unless the operator explicitly says they are fixed.",
    "When the operator explicitly keeps the product logo or brand mark unchanged, put that product mark in keep_facts and remove it from changeable_facts. Background vehicles, model text, title text, and license plate text may still change when requested.",
    "Do not put product type, material, color, quantity, structure, texture, package count, dimensions, or intended use into changeable_facts.",
    "forbidden_changes should contain rules that protect product identity only, not the source vehicle identity that is supposed to change.",
    "If the product is a car door sill protector / sill plate, identify it clearly."
  ].join("\n");
}

function planSystemPrompt() {
  return [
    "You are designing a controlled SKU fission plan for Ozon listing creation.",
    "Return strict JSON only. No Markdown.",
    "The product body, material, set count, composition, viewing angle, and realistic texture must stay stable unless the operator asks otherwise.",
    "Replace source vehicle model references only where they are intended editable variant text. Operator notes override the default replacement rule.",
    "If the operator asks to keep a product sticker logo, decal, brand mark, or printed mark unchanged, treat it as a hard image constraint and never rewrite that protected mark.",
    "image_edit_prompt_en and negative_prompt_en must be English-only and must forbid Chinese text in the generated image.",
    "Output keys: variant_type, source_variant_value, target_variant_value, template_key, keep_facts, change_facts, forbidden_changes, image_edit_prompt_en, negative_prompt_en, title_prompt_ru, tags_prompt_ru, description_prompt_ru, rich_content_prompt_ru, copy_contract, quality_checks, cost_policy."
  ].join("\n");
}

function batchPlanSystemPrompt() {
  return [
    "You are building a one-to-many SKU fission batch for Ozon automotive listings.",
    "Return strict JSON only. No Markdown.",
    "All operator-facing display fields must be Simplified Chinese.",
    "Output an object with an items array. The array length must match target_variant_values exactly.",
    "For every item, keep the product body, material facts, set count, composition, viewing angle, and realistic texture stable.",
    "For every item, replace source vehicle model references only in editable context text, title text, license plate text, or background vehicle cues.",
    "For every item, include image_edit_contract with variant_type, source_value, target_value, replace_zones, preserve_zones, text_policy, and logo_policy.",
    "Operator notes are hard constraints. If the operator asks to keep a product sticker logo, decal, brand mark, or printed mark unchanged, do not replace, translate, repaint, remove, or redesign that protected product mark.",
    "image_edit_prompt_en and negative_prompt_en must be English-only. They must explicitly forbid Chinese text, Chinese characters, random text, and invented words in the generated image.",
    "Main-image recognition facts are the source of truth for title, tags, description, and rich content.",
    "Template title, tags, and description are supplemental style references only; ignore them when they conflict with recognized product facts.",
    "Each item must include: target_variant_value, image_edit_contract, image_edit_prompt_en, negative_prompt_en, title_ru, tags_ru, description_ru, rich_content_ru, copy_contract, quality_checks, display_zh.",
    "tags_ru must contain 20 to 25 Ozon search tags, each tag starts with #, contains no Chinese, uses underscores inside each tag, and the final tag list must be space-separated rather than comma-separated.",
    "description_ru must be Russian, 350 to 500 characters, never shorter than 350 characters, contain no Chinese, and mention only the item's target vehicle model.",
    "Russian title, tags, description, and rich content must not contain marketplace names or platform-sensitive words such as Ozon, Wildberries, AliExpress, marketplace, seller-service wording, fake official authorization, fake certification, unsupported warranty, or exaggerated claims.",
    "Unknown or uncertain attributes must be omitted from title, tags, description, and rich content. Never write placeholder words such as uncertain, unknown, unclear, n/a, or not visible.",
    "Buyer-facing Russian copy must not mention internal workflow language such as source product, original card, verified facts, only target model changes, or main-image recognition facts.",
    "display_zh must include main_image_plan, title_plan, tags_plan, description_plan, rich_content_plan, quality_checks, all written in Simplified Chinese for operator review.",
    "Do not invent material, dimensions, certification, installation method, or vehicle compatibility beyond the target variant."
  ].join("\n");
}

function optimizerAnalyzeSystemPrompt() {
  return [
    "You are an Ozon ecommerce product-material optimization analyst for products across all retail categories.",
    "Return strict JSON only. No Markdown.",
    "You may read source titles, tags, descriptions, and visible image text in English, Russian, or Chinese.",
    "All operator-facing analysis fields must be written in Simplified Chinese, including product recognition, current problems, improvement opportunities, quality risks, and display_zh.",
    "Diagnose the current image quality and selling clarity without changing product truth.",
    "Separate keep_facts from improvement_opportunities.",
    "Identify the exact product subtype, target buyer or verified compatibility, the buyer decision order, verified differentiators, visual category, and suitable communication tone. Never collapse a specific product into a generic category.",
    "Never invent material, dimensions, certification, installation method, or compatibility."
  ].join("\n");
}

function buildOptimizerAnalyzePrompt(body = {}, imageInputs = []) {
  const operatorFacts = objectValue(body.operatorFacts || body.operator_facts);
  const imageSummary = imageInputs.map((item, index) => `${index + 1}. ${item.label || item.role}: ${item.role}`).join("\n");
  return [
    `Operator goal: ${cleanText(body.goal || body.operatorGoal || body.operator_goal || "Find how this image can be improved for Ozon main-image conversion.")}`,
    `Product title: ${cleanText(body.title || body.productTitle || body.product_title || "")}`,
    `Tags: ${toArray(body.tags || body.keywords).join(", ")}`,
    `Description: ${cleanText(body.description || body.sourceDescription || body.source_description || "")}`,
    `OPERATOR-CONFIRMED PRODUCT FACTS (highest priority): ${JSON.stringify(operatorFacts)}`,
    "Treat operator-confirmed facts as authoritative. Use image analysis to verify or flag conflicts, never to silently replace the operator's exact product title, compatibility, selling points, or forbidden facts.",
    imageSummary ? `Images provided:\n${imageSummary}` : "",
    "Treat the first image as the default main image. Treat later images as detail/reference material unless their label says otherwise.",
    "Identify which visible product facts must stay locked and which background, layout, text, lighting, and detail-page elements can be optimized.",
    "Return JSON keys: product_type, visible_texts, keep_facts, current_problems, improvement_opportunities, forbidden_changes, optimization_goals, quality_risks, confidence, decision_context, display_zh.",
    "decision_context must contain exact_product_subtype, target_buyer_or_compatibility, purchase_decision_order, verified_differentiators, visual_category, price_positioning, communication_tone. purchase_decision_order must rank the 3 to 5 facts buyers need first for this exact product category.",
    "display_zh must include recognition_summary, product_type, fixed_facts, main_image_observation, detail_image_observation, recommended_action, all in Simplified Chinese.",
    "current_problems should focus on product clarity, text readability, composition, visual hierarchy, marketplace trust, and click-through potential.",
    "forbidden_changes must protect product identity, model, quantity, material facts, and any verified compatibility."
  ].filter(Boolean).join("\n");
}

function optimizerPlanSystemPrompt() {
  return [
    "You are planning a conservative image optimization for an existing Ozon SKU.",
    "Return strict JSON only. No Markdown.",
    "The product remains the same SKU. Do not fission to a new vehicle/model/logo.",
    "You may use English for image_optimization_prompt_en and negative_prompt_en because they are technical generation prompts.",
    "All operator-facing plan fields must be Simplified Chinese, including keep_facts, current_problems, optimization_goals, forbidden_changes, quality_checks, and display_zh.",
    "Output keys: optimization_type, keep_facts, current_problems, optimization_goals, forbidden_changes, copy_strategy, visual_language, main_overlay_ru, main_visual_directions, suite_storyboard, image_optimization_prompt_en, negative_prompt_en, title_improvement_prompt_ru, tags_improvement_prompt_ru, description_improvement_prompt_ru, quality_checks, cost_policy, display_zh.",
    "copy_strategy must contain exact_subject_ru, title_information_order, verified_benefits_ru, forbidden_generic_phrases_ru, and per_shot_message_rules. Put exact product identity before style adjectives or generic benefits.",
    "Reject generic copy such as auto accessory, high quality, stylish design, durable material, practical solution, premium quality, or improves your experience unless the phrase is made product-specific and supported by evidence.",
    "visual_language must contain tone, headline_style, hierarchy, font_weights, accent_style, alignment, max_headline_lines, max_benefit_words, and avoid. Choose these values from the product category, buyer, material, price positioning, and image composition rather than using one universal poster style.",
    "main_overlay_ru must contain title_ru, compatibility_ru, and benefits_ru. title_ru clearly names the exact product. compatibility_ru clearly states only verified compatible vehicle models or target audience. benefits_ru contains exactly 2 or 3 concise verified selling points. All values are buyer-facing Russian except exact verified Latin model names.",
    "main_visual_directions must contain 2 distinct but conservative objects with title_zh and direction_en. Each direction must preserve the same verified product while varying only commercial presentation such as background family, framing, depth, lighting, and spacing.",
    "suite_storyboard must contain 4 to 5 ordered image-shot objects. Each object must include role, title_zh, objective_zh, composition_en, must_show_en, overlay_text_ru, typography_role, and typography_direction_en. Use role values main, material, installation, structure, benefit, closeup, or size. The first shot must be main.",
    "overlay_text_ru is mandatory for every suite_storyboard item and must be a concise 2 to 5 word Russian Cyrillic buyer-facing explanation with no marketplace name. It must never be empty. Do not ask the image model to render this label.",
    "Design suite_storyboard as one coherent ecommerce image set: shared background family, lighting, camera language and product identity, while varying typography composition by shot objective. Do not repeat the same oversized heading, underline, icon grid, caption position, or poster template on every image.",
    "Do not request dimensions, claims, accessories, installation methods, or compatibility that are not verified. A size shot may omit numeric dimensions when they are unknown.",
    "display_zh must include main_image_plan, detail_image_plan, title_plan, tags_plan, description_plan, forbidden_changes, quality_checks, and suite_storyboard, all in Simplified Chinese for operator review.",
    "The image prompt should improve clarity, texture, hierarchy, readability, and conversion while preserving product truth."
  ].join("\n");
}

function optimizerImageReviewSystemPrompt() {
  return [
    "You are a strict ecommerce product-image quality reviewer.",
    "Return strict JSON only with keys: pass, score, issues_zh, corrections_en, checks.",
    "When two images are supplied, the first is product identity or approved-main reference and the second is the generated candidate.",
    "Reject material product identity changes, wrong color, wrong quantity, distorted geometry, invented accessories or claims, failed shot objective, or obvious visual inconsistency with the approved main image.",
    "The shot JSON contains the exact planned buyer-facing Russian overlay copy. Reject omitted, paraphrased, misspelled, duplicated, truncated, unreadable or invented copy, Chinese text, decorative pseudo-text, watermarks and unrelated badges. Exact verified text physically printed or engraved on the product may remain.",
    "Judge typography as part of the commercial composition: the product must remain dominant, the title must be immediately readable on mobile, compatibility must be unambiguous, and selling points must have a clear hierarchy without covering the product.",
    "Reject generic headings that could be reused unchanged for an unrelated product, repeated universal poster layouts, oversized default bold typography, mechanical underline decoration, equal icon grids, or captions that compete with the product.",
    "Across a suite, typography should share a visual language but vary its composition by shot objective and available negative space.",
    "Do not reject for minor subjective taste differences. pass must be true when the candidate is commercially usable and factually safe.",
    "issues_zh must be concise Simplified Chinese. corrections_en must be concise actionable English instructions that preserve the valid parts of the candidate."
  ].join("\n");
}

function normalizeOptimizerImageReview(value = {}) {
  const issues = toArray(value.issues_zh || value.issues).map(cleanText).filter(Boolean).slice(0, 6);
  const score = Math.max(0, Math.min(100, Number(value.score || 0)));
  const corrections = cleanText(value.corrections_en || value.corrections || "");
  const pass = value.pass === true || (value.pass !== false && score >= 75 && !issues.length);
  return {
    pass,
    score,
    issues_zh: issues,
    corrections_en: pass ? "" : corrections,
    checks: objectValue(value.checks)
  };
}

function normalizeMaterialCandidates(items = []) {
  return arrayValue(items).map((item, index) => {
    const url = cleanText(item.url || item.src || item.previewUrl || item.preview_url || "");
    const candidateId = cleanKey(item.candidateId || item.candidate_id || item.id || `candidate_${index + 1}`);
    return {
      candidate_id: candidateId,
      url,
      kind: normalizeCandidateKind(item.kind || item.type || (index === 0 ? "main" : "detail")),
      source: normalizeCandidateSource(item.source || item.origin || "original"),
      source_candidate_id: cleanKey(item.sourceCandidateId || item.source_candidate_id || ""),
      status: cleanText(item.status || (url ? "ready" : "failed")),
      version: Math.max(1, Number(item.version || 1)),
      title: cleanText(item.title || item.name || ""),
      prompt_summary: cleanText(item.promptSummary || item.prompt_summary || ""),
      failure_message: cleanText(item.failureMessage || item.failure_message || item.errorMessage || item.error_message || "")
    };
  }).filter((item) => item.url || item.status === "failed");
}

function normalizeFinalImageSlots(slots = [], candidates = []) {
  const candidateById = new Map(candidates.map((item) => [item.candidate_id, item]));
  const seenUrls = new Set();
  return arrayValue(slots)
    .map((slot, index) => {
      const candidateId = cleanKey(slot.candidateId || slot.candidate_id || slot.id || "");
      const candidate = candidateId ? candidateById.get(candidateId) : null;
      const url = cleanText(slot.url || candidate?.url || "");
      const sortOrder = Number(slot.sortOrder || slot.sort_order || slot.slot || index + 1);
      return {
        slot: sortOrder > 0 ? sortOrder : index + 1,
        role: cleanText(slot.role || (index === 0 ? "main" : "detail")),
        url,
        name: cleanText(slot.name || candidate?.title || ""),
        candidate_id: candidateId || candidate?.candidate_id || "",
        source: cleanText(slot.source || candidate?.source || ""),
        sort_order: sortOrder > 0 ? sortOrder : index + 1
      };
    })
    .filter((slot) => slot.url)
    .sort((left, right) => left.sort_order - right.sort_order)
    .filter((slot) => {
      const key = slot.url.toLowerCase();
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    })
    .map((slot, index) => ({
      ...slot,
      slot: index + 1,
      role: index === 0 ? "main" : (slot.role === "main" ? "detail" : slot.role || "detail"),
      sort_order: index + 1
    }));
}

function buildMaterialOptimizationTemplatePatch({
  templatePayload = {},
  images = [],
  candidates = [],
  finalImageSlots = [],
  textResults = {},
  plan = {},
  userNote = ""
}) {
  const editable = objectValue(templatePayload.editable_payload || templatePayload.editablePayload || {});
  const variants = arrayValue(editable.variants || templatePayload.variants).map((variant, index) => {
    const manuallyEdited = Boolean(variant?.images_manually_edited || variant?.image_edit_intent === "manual");
    return manuallyEdited ? variant : {
      ...variant,
      images: images.map((image) => ({ ...image })),
      ...(index === 0 ? { primary_image: images[0]?.url || "" } : {})
    };
  });
  const title = cleanText(textResults.title || textResults.title_ru || editable.title || templatePayload.title || "");
  const description = cleanText(textResults.description || textResults.description_ru || editable.description || templatePayload.description || "");
  const tags = toArray(textResults.tags || textResults.tags_ru || editable.hashtags || editable.tags).map(cleanText).filter(Boolean);
  return {
    ...templatePayload,
    title,
    description,
    images: images.map((image) => ({ ...image })),
    source_raw: {
      ...objectValue(templatePayload.source_raw || templatePayload.sourceRaw),
      ai_product_material_optimization: {
        candidate_count: candidates.length,
        final_image_slot_count: finalImageSlots.length,
        user_note: cleanText(userNote),
        plan
      }
    },
    editable_payload: {
      ...editable,
      title,
      name: title || editable.name || "",
      description,
      ...(tags.length ? { hashtags: tags, tags } : {}),
      images: images.map((image) => ({ ...image })),
      variants
    }
  };
}

function normalizeCandidateKind(value = "") {
  const kind = cleanKey(value);
  if (["main", "detail", "scene", "size", "selling_point", "reference"].includes(kind)) return kind;
  return "detail";
}

function normalizeCandidateSource(value = "") {
  const source = cleanKey(value);
  if (["original", "optimized", "generated", "template_reference", "retry"].includes(source)) return source;
  return "original";
}

function normalizeVariantPlan(plan, analysis, fallback) {
  const target = cleanText(plan.target_variant_value || fallback.targetVariantValue);
  const source = cleanText(plan.source_variant_value || fallback.sourceVariantValue);
  const variantType = normalizeImageVariantType(plan.variant_type || plan.variantType || fallback.variantType || fallback.variant_type || analysis.recommended_variant_mode || "vehicle_model_swap");
  const keepFacts = toArray(plan.keep_facts).length ? toArray(plan.keep_facts) : toArray(analysis.keep_facts);
  const changeFacts = toArray(plan.change_facts || plan.changeable_facts).length ? toArray(plan.change_facts || plan.changeable_facts) : toArray(analysis.changeable_facts);
  const operatorNote = cleanText(fallback.operatorNote || fallback.operator_note || "");
  const operatorInstructions = parseOperatorInstructions(operatorNote);
  const imageEditContract = buildImageEditContract({
    variantType,
    source,
    target,
    keepFacts,
    analysis,
    fallback: { ...fallback, operatorInstructions }
  });
  return {
    ...plan,
    variant_type: variantType,
    source_variant_value: source,
    target_variant_value: target,
    template_key: cleanKey(plan.template_key || fallback.templateKey),
    keep_facts: keepFacts,
    change_facts: changeFacts,
    forbidden_changes: toArray(plan.forbidden_changes).length ? toArray(plan.forbidden_changes) : [
      "Do not change product material or set quantity.",
      "Do not keep any visible source vehicle model text.",
      "Do not add unverified compatibility claims."
    ],
    image_edit_contract: imageEditContract,
    image_edit_prompt_en: normalizeImageEditPromptEn(plan.image_edit_prompt_en, source, target, keepFacts, analysis, { ...fallback, variantType, imageEditContract }),
    negative_prompt_en: normalizeImageNegativePromptEn(plan.negative_prompt_en, source, operatorNote),
    image_template_guidance: buildImageTemplateGuidance(analysis, fallback),
    image_product_truth_en: buildImageProductTruthRules(keepFacts, analysis, fallback),
    image_prompt_priority: imagePromptPriorityContract(),
    copy_contract: plan.copy_contract || buildCopyContract(plan, analysis, { ...fallback, operatorInstructions }),
    quality_checks: toArray(plan.quality_checks).length ? toArray(plan.quality_checks) : [
      "Product type and body stay consistent with the analyzed source image.",
      "Visible source variant is fully removed.",
      "Target variant is present in listing text where relevant.",
      "Material, quantity, structure, and verified facts remain unchanged."
    ],
    cost_policy: plan.cost_policy || {
      reuse_template_first: true,
      run_vision_again_only_when_template_confidence_below: 0.82,
      generate_image_only_after_text_plan_passes_quality_gate: true
    }
  };
}

export function parseOperatorInstructions(operatorNote = "") {
  const text = cleanText(operatorNote);
  const imageEditable = [];
  const imageLocked = [];
  const copyFields = [];
  const add = (list, value) => { if (!list.includes(value)) list.push(value); };
  if (!text) return { image_edit_scope: [], image_locked_scope: [], image_scope_mode: "merge", copy_generation_scope: [], source: "" };
  let imageScopeMode = "merge";

  if (/(?:主图.{0,12}(只|仅).{0,8}(改|换|替换)|(只|仅).{0,8}(改|换|替换).{0,8}主图).{0,8}(标题|型号文字|车型文字)/i.test(text)) {
    imageScopeMode = "exclusive";
    add(imageEditable, "image_title");
    add(imageLocked, "product_body");
    add(imageLocked, "background");
  }
  if (/(背景|背景车辆|背景车型).{0,12}(允许|可以|随|跟随|改|换|变化)/i.test(text) || /(改变|修改|替换|调整).{0,8}(背景|背景车辆|背景车型)/i.test(text)) add(imageEditable, "background");
  if (/(产品上的|产品).{0,8}(车型|品牌)?(标识|logo|Logo|LOGO|车标).{0,12}(允许|可以|随|跟随|改|换|变化)/i.test(text)) add(imageEditable, "product_identity");
  if (/(商品|产品).{0,8}(标题).{0,8}(重新生成|重写|跟随|变化)/i.test(text) || /标题.{0,8}(重新生成|重写)/i.test(text)) add(copyFields, "listing_title");
  if (/标签.{0,8}(重新生成|重写|跟随|变化)/i.test(text)) add(copyFields, "tags");
  if (/(描述|简介).{0,8}(重新生成|重写|跟随|变化)/i.test(text)) add(copyFields, "description");
  if (/标题.{0,12}标签.{0,12}(描述|简介).{0,12}(重新生成|重写|跟随|变化|更新)/i.test(text)) {
    add(copyFields, "listing_title");
    add(copyFields, "tags");
    add(copyFields, "description");
  }
  if (/(产品主体|产品本体|实物主体|产品).{0,8}(不变|保持不变|不要改)/i.test(text)) add(imageLocked, "product_body");
  if (/(产品上的|产品表面|产品).{0,12}(车型|品牌)?(标识|logo|Logo|LOGO|车标|车型字样|印刷文字|印字|图案).{0,12}(一律不变|不变|保持不变|不要改)/i.test(text)) add(imageLocked, "product_identity");
  if (/锁定整个产品本体|产品全锁/i.test(text)) {
    add(imageLocked, "product_body");
    add(imageLocked, "product_identity");
  }
  if (/(背景|场景).{0,8}(不变|保持不变|不要改)/i.test(text)) add(imageLocked, "background");
  if (imageEditable.includes("background")) {
    imageScopeMode = "merge";
    const lockedBackgroundIndex = imageLocked.indexOf("background");
    if (lockedBackgroundIndex >= 0) imageLocked.splice(lockedBackgroundIndex, 1);
  }
  if (imageLocked.includes("product_identity")) {
    const editableIdentityIndex = imageEditable.indexOf("product_identity");
    if (editableIdentityIndex >= 0) imageEditable.splice(editableIdentityIndex, 1);
  }
  const orderedCopyFields = ["listing_title", "tags", "description", "rich_content"].filter((field) => copyFields.includes(field));
  return { image_edit_scope: imageEditable, image_locked_scope: imageLocked, image_scope_mode: imageScopeMode, copy_generation_scope: orderedCopyFields, source: text };
}

export function applyOperatorFactOverrides(analysis = {}, operatorNote = "") {
  const source = objectValue(analysis);
  if (!shouldPreserveProductLogo(operatorNote)) return source;
  const fixedLogoRule = "产品本体及其 Logo、品牌标识、车型字样、印刷文字和图案全部保持不变";
  const changeableFacts = toArray(source.changeable_facts)
    .map(removeProtectedProductIdentity)
    .filter(Boolean);
  const displayVariableFacts = toArray(source.display_zh?.variable_facts)
    .map(removeProtectedProductIdentity)
    .filter(Boolean);
  const keepFacts = uniqueStrings([...toArray(source.keep_facts), fixedLogoRule]);
  const displayFixedFacts = uniqueStrings([...toArray(source.display_zh?.fixed_facts), fixedLogoRule]);
  return {
    ...source,
    keep_facts: keepFacts,
    changeable_facts: changeableFacts,
    display_zh: {
      ...objectValue(source.display_zh),
      fixed_facts: displayFixedFacts,
      variable_facts: displayVariableFacts
    }
  };
}

function removeProtectedProductIdentity(value = "") {
  const text = cleanText(value);
  if (!text) return "";
  const withoutIdentity = text
    .replace(/(?:产品(?:本体|上的|表面)?的?)?(?:品牌\s*)?(?:Logo|LOGO|logo|标识|车标|品牌标识|车型字样|印刷文字|印字|图案)(?:\/品牌标识)?(?:\s*[“\"']?[^、,，；;]{0,20}[”\"']?)?[、,，和及与/]*/g, "")
    .replace(/[、,，和及与/]+(?=(?:属于|可以|允许|可|随|跟随|变化|替换|修改))/g, "")
    .replace(/^[、,，和及与/\s]+|[、,，和及与/\s]+$/g, "")
    .replace(/([、,，]){2,}/g, "$1")
    .trim();
  if (!withoutIdentity || /^(?:属于|可以|允许|可|随|跟随|变化|替换|修改)/.test(withoutIdentity)) return "";
  return withoutIdentity;
}

function normalizeBatchItems(items, analysis, fallback) {
  const rawItems = Array.isArray(items) ? items : [];
  const byTarget = new Map(rawItems.map((item) => [cleanText(item.target_variant_value || item.targetVariantValue || item.target || ""), item]));
  return fallback.targets.map((target, index) => {
    const item = byTarget.get(target) || rawItems[index] || {};
    const plan = normalizeVariantPlan(item, analysis, {
      sourceVariantValue: fallback.sourceVariantValue,
      targetVariantValue: target,
      templateKey: fallback.templateKey,
      operatorNote: fallback.operatorNote
    });
    const normalized = {
      item_no: makeNo("AVL-I"),
      sort_order: index + 1,
      variant_type: plan.variant_type,
      target_variant_value: target,
      template_key: plan.template_key,
      source_variant_value: plan.source_variant_value,
      image_edit_contract: plan.image_edit_contract,
      image_edit_prompt_en: plan.image_edit_prompt_en,
      negative_prompt_en: plan.negative_prompt_en,
      image_template_guidance: plan.image_template_guidance,
      image_product_truth_en: plan.image_product_truth_en,
      image_prompt_priority: plan.image_prompt_priority,
      title_ru: normalizeOzonVariantTitle(item.title_ru || item.title || plan.title_ru, target, analysis, fallback),
      tags_ru: normalizeOzonVariantTags(item.tags_ru || item.tags, target, analysis, fallback),
      description_ru: normalizeOzonVariantDescription(item.description_ru || item.description, target, analysis, fallback),
      rich_content_ru: normalizeOzonVariantRichContent(item.rich_content_ru || item.rich_content, target, analysis, fallback),
      display_zh: normalizeBatchItemDisplayZh(item.display_zh || item.displayZh, target, analysis, fallback),
      keep_facts: plan.keep_facts,
      change_facts: plan.change_facts,
      forbidden_changes: plan.forbidden_changes,
      copy_contract: item.copy_contract || plan.copy_contract,
      quality_checks: plan.quality_checks,
      cost_policy: plan.cost_policy
    };
    return enforceCopyItemProductFacts(normalized, target, analysis, fallback);
  });
}

function buildFallbackBatchItems(targets, analysis, fallback) {
  const source = cleanText(fallback.sourceVariantValue || analysis.source_variant_value || "");
  const keepFacts = toArray(analysis.keep_facts);
  return targets.map((target) => ({
    target_variant_value: target,
    variant_type: normalizeImageVariantType(fallback.variantType || fallback.variant_type || analysis.recommended_variant_mode || "vehicle_model_swap"),
    image_edit_prompt_en: buildFallbackImagePrompt(source, target, keepFacts, analysis, fallback),
    image_edit_contract: buildImageEditContract({
      variantType: normalizeImageVariantType(fallback.variantType || fallback.variant_type || analysis.recommended_variant_mode || "vehicle_model_swap"),
      source,
      target,
      keepFacts,
      analysis,
      fallback
    }),
    negative_prompt_en: normalizeImageNegativePromptEn("", source, cleanText(fallback.operatorNote || "")),
    image_template_guidance: buildImageTemplateGuidance(analysis, fallback),
    image_product_truth_en: buildImageProductTruthRules(keepFacts, analysis, fallback),
    image_prompt_priority: imagePromptPriorityContract(),
    title_ru: buildOzonVariantTitle(target, analysis, fallback),
    tags_ru: buildOzonVariantTags(target, analysis, fallback),
    description_ru: buildOzonVariantDescription(target, analysis, fallback),
    rich_content_ru: buildOzonVariantRichContent(target, analysis, fallback),
    display_zh: buildBatchItemDisplayZh(target, analysis, fallback),
    copy_contract: {
      source_variant_value: source,
      target_variant_value: target,
      keep_product_truth: true,
      change_only_variant_identity: true
    },
    quality_checks: [
      "产品主体、材质、数量不变。",
      "源车型文字必须完全替换。",
      "标题、标签、描述中的车型必须一致。"
    ],
    template_key: cleanKey(fallback.templateKey || DEFAULT_TEMPLATE_KEY)
  }));
}

function enforceCopyItemProductFacts(item, target, analysis = {}, fallback = {}) {
  const next = { ...item };
  const titleOk = isCopyTextAlignedWithProductFacts(next.title_ru, target, analysis, fallback, { minLength: 10 });
  const tagsOk = isCopyTextAlignedWithProductFacts(toArray(next.tags_ru).join(" "), target, analysis, fallback, { minLength: 10 });
  const descriptionOk = isCopyTextAlignedWithProductFacts(next.description_ru, target, analysis, fallback, { minLength: 80 })
    && isValidOzonVariantDescription(next.description_ru, target, analysis, fallback);
  const richOk = !next.rich_content_ru || isCopyTextAlignedWithProductFacts(next.rich_content_ru, target, analysis, fallback, { minLength: 10 });
  if (!titleOk) next.title_ru = buildOzonVariantTitle(target, analysis, fallback);
  if (!tagsOk) next.tags_ru = buildOzonVariantTags(target, analysis, fallback);
  if (!descriptionOk) next.description_ru = buildOzonVariantDescription(target, analysis, fallback);
  if (!richOk) next.rich_content_ru = buildOzonVariantRichContent(target, analysis, fallback);
  next.copy_source = (!titleOk || !tagsOk || !descriptionOk || !richOk) ? "compiled_product_dna" : "ai_plan";
  if (!titleOk || !tagsOk || !descriptionOk || !richOk) {
    next.copy_contract = {
      ...(next.copy_contract || {}),
      product_fact_guard: {
        applied: true,
        reason: "Generated copy did not align with main-image product facts.",
        authoritative_product_subject_ru: productSubjectRu(analysis, fallback)
      }
    };
  }
  return next;
}

function isCopyTextAlignedWithProductFacts(text, target, analysis = {}, fallback = {}, options = {}) {
  const value = cleanText(text);
  if (!value || value.length < Number(options.minLength || 1)) return false;
  if (!isBuyerFacingCopyText(value)) return false;
  if (containsChinese(value)) return false;
  if (hasVariantSourceLeak(value, target, analysis, fallback)) return false;
  if (hasForbiddenCategoryLeak(value, analysis)) return false;
  const subjectTerms = productSubjectSearchTerms(analysis, fallback);
  if (!subjectTerms.length) return true;
  const lower = value.toLowerCase();
  return subjectTerms.some((term) => lower.includes(term.toLowerCase()));
}

function normalizeOzonVariantTags(value, target, analysis = {}, fallback = {}) {
  const raw = Array.isArray(value) ? value : toArray(value);
  const normalized = raw
    .map((tag) => normalizeOzonVariantTag(tag))
    .filter((tag) => tag && !containsChinese(tag))
    .filter((tag) => isBuyerFacingCopyText(tag))
    .filter((tag) => !hasForbiddenCategoryLeak(tag, analysis));
  const merged = uniqueStrings([...normalized, ...buildOzonVariantTags(target, analysis, fallback)]);
  return merged.slice(0, 25);
}

function normalizeOzonVariantTitle(value, target, analysis = {}, fallback = {}) {
  const sourceBasedTitle = buildVariantTitleFromSource(fallback.sourceTitle, fallback.sourceVariantValue || analysis.source_variant_value, target);
  if (sourceBasedTitle) return sourceBasedTitle;
  const text = cleanText(value);
  if (text && isBuyerFacingCopyText(text) && !containsChinese(text) && !hasVariantSourceLeak(text, target, analysis, fallback) && !hasForbiddenCategoryLeak(text, analysis)) return text;
  return buildOzonVariantTitle(target, analysis, fallback);
}

export function buildOzonVariantTitle(target, analysis = {}, fallback = {}) {
  const sourceBasedTitle = buildVariantTitleFromSource(fallback.sourceTitle, fallback.sourceVariantValue || analysis.source_variant_value, target);
  if (sourceBasedTitle) return sourceBasedTitle;
  const dna = buildCopyProductDna(analysis, fallback);
  const subject = dna.subject;
  const quantity = productQuantityRu(analysis);
  const material = dna.materialTitle ? `, ${dna.materialTitle}` : "";
  const targetModel = cleanText(target);
  const compatibility = /(?:^|\s)(?:ключа|брелока)\s*$/iu.test(subject) ? ` ${targetModel}` : ` для ${targetModel}`;
  return `${subject}${compatibility}${quantity ? `, ${quantity}` : ""}${material}`;
}

export function buildVariantTitleFromSource(sourceTitle = "", sourceModel = "", targetModel = "") {
  const title = cleanText(sourceTitle);
  const source = cleanText(sourceModel);
  const target = cleanText(targetModel);
  if (!title || !source || !target || containsChinese(title) || !isBuyerFacingCopyText(title)) return "";
  if (!containsExactVehicleModel(title, source)) return containsExactVehicleModel(title, target) ? title : "";
  const escaped = source.split(/\s+/).map(escapeRegExp).join("\\s+");
  const sourceGroup = `${escaped}(?:\\s*[/|]\\s*[A-Za-z0-9-]+(?:\\s+(?:Pro|Plus|Max))?)*`;
  return cleanText(title.replace(
    new RegExp(`(^|[^\\p{L}\\p{N}])${sourceGroup}(?=$|[^\\p{L}\\p{N}])`, "giu"),
    (_, prefix) => `${prefix}${target}`
  ));
}

function sourceListingTitle(body = {}) {
  const sourceProductInfo = objectValue(body.sourceProductInfo || body.source_product_info);
  return cleanText(body.sourceTitle || body.source_title || sourceProductInfo.title || sourceProductInfo.name || "");
}

function buildOzonVariantTags(target, analysis = {}, fallback = {}) {
  const dna = buildCopyProductDna(analysis, fallback);
  const cleanedTarget = cleanText(target);
  const maker = cleanedTarget.split(/\s+/)[0] || "";
  const modelTail = cleanedTarget.split(/\s+/).slice(1).join("_");
  const subject = dna.subject;
  const subjectTags = productSubjectTagCandidates(subject);
  const isSillPlate = isSillPlateProduct(analysis, fallback);
  const candidates = [
    cleanedTarget,
    cleanedTarget.replace(/\s+/g, ""),
    maker ? `для ${maker}` : "",
    modelTail ? `для ${modelTail}` : "",
    subject,
    ...subjectTags,
    "автоаксессуары",
    "аксессуары авто",
    "салон авто",
    ...dna.tagFacts,
    ...(isSillPlate ? [
      "защита порогов",
      "накладки на пороги",
      "защитные накладки",
      "карбоновые накладки",
      "дверные пороги",
      "пороги автомобиля",
      "защита кузова",
      "тюнинг салона",
      "комплект накладок",
      "наклейки на пороги",
      "аксессуары для салона",
      "защита от царапин",
      "декор порогов",
      "автомобильные наклейки",
      "наружные аксессуары"
    ] : [
      "органайзер авто",
      "хранение в авто"
    ]),
    "интерьер авто",
    "для автомобиля",
    ...(toArray(analysis.product_subject_ru).length ? toArray(analysis.product_subject_ru) : []),
    ...(toArray(fallback.extraTags).length ? toArray(fallback.extraTags) : [])
  ];
  return uniqueStrings(candidates.map((tag) => normalizeOzonVariantTag(tag)).filter(Boolean))
    .filter((tag) => !hasForbiddenCategoryLeak(tag, analysis))
    .slice(0, 25);
}

function normalizeOzonVariantTag(value) {
  let body = cleanText(value).replace(/^#+/, "");
  if (!body || containsChinese(body) || !isBuyerFacingCopyText(body)) return "";
  body = body
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!body) return "";
  body = body.slice(0, 24).replace(/_+$/g, "");
  return body ? `#${body}` : "";
}

function buildCopyProductDna(analysis = {}, fallback = {}) {
  const gatedAnalysis = applyProductFactGate(analysis);
  const subject = productSubjectRu(analysis, fallback);
  const factsText = [
    gatedAnalysis.product_type,
    gatedAnalysis.material,
    gatedAnalysis.color,
    gatedAnalysis.quantity,
    gatedAnalysis.product_subject_ru,
    ...toArray(gatedAnalysis.keep_facts),
    ...toArray(gatedAnalysis.visible_texts),
    ...toArray(gatedAnalysis.display_zh?.fixed_facts)
  ].map(cleanText).join(" ");
  const materialRu = copyMaterialRu(factsText, analysis, fallback);
  const finishRu = copyFinishRu(factsText);
  const quantityRu = productQuantityRu(analysis) || copyQuantityRu(factsText);
  const materialTitle = [materialRu.short, finishRu.short].filter(Boolean).join(", ");
  const materialSentence = [materialRu.sentence, finishRu.sentence].filter(Boolean).join(" ") || "Материал и фактура соответствуют исходному товару.";
  const quantitySentence = quantityRu ? `В комплекте ${quantityRu}, как на исходном изображении.` : "Количество деталей соответствует исходному изображению.";
  const tagFacts = uniqueStrings([
    ...materialRu.tags,
    ...finishRu.tags,
    quantityRu ? `${quantityRu} комплект` : "",
    /3m/i.test(factsText) ? "3M скотч" : ""
  ]);
  return {
    subject,
    materialTitle,
    materialSentence,
    quantitySentence,
    tagFacts
  };
}

function copyMaterialRu(factsText = "", analysis = {}, fallback = {}) {
  const text = cleanText([factsText, confirmedFactText(analysis.material), confirmedFactText(fallback.material)].join(" ")).toLowerCase();
  if (/abs|абс|абс-пласт|пластик|пластик/i.test(text)) {
    return {
      short: "ABS пластик",
      sentence: "Основа выполнена из ABS пластика.",
      tags: ["ABS пластик", "накладки ABS", "пластик ABS"]
    };
  }
  if (/carbon|карбон|карбонов|碳纤维|碳纖維/i.test(text)) {
    return {
      short: "карбоновая фактура",
      sentence: "Поверхность имеет карбоновую фактуру.",
      tags: ["карбоновая фактура", "карбоновые накладки", "карбон"]
    };
  }
  if (/vinyl|винил|винилов|пленк|плёнк|виниловая пленка|виниловая плёнка/i.test(text)) {
    return {
      short: "виниловая пленка",
      sentence: "Поверхность выполнена как защитная виниловая пленка.",
      tags: ["виниловая пленка", "защитная пленка"]
    };
  }
  return { short: "", sentence: "", tags: [] };
}

function copyFinishRu(factsText = "") {
  const text = cleanText(factsText).toLowerCase();
  if (/piano|gloss|глянц|лак|高光|钢琴|亮黑|亮面/i.test(text)) {
    return {
      short: "глянцевое покрытие",
      sentence: "Глянцевое покрытие сохраняет аккуратный внешний вид и отражения, как у исходного товара.",
      tags: ["глянцевые накладки", "премиальный вид"]
    };
  }
  if (/matte|матов|матовый|哑光/i.test(text)) {
    return {
      short: "матовая поверхность",
      sentence: "Матовая поверхность сохраняет спокойный визуальный стиль исходного товара.",
      tags: ["матовые накладки"]
    };
  }
  return { short: "", sentence: "", tags: [] };
}

function copyQuantityRu(factsText = "") {
  const text = cleanText(factsText);
  if (isUnknownFactValue(text)) return "";
  const match = text.match(/(\d+)\s*(?:шт|pcs|piece|件|штук)/i);
  if (match) return `${match[1]} шт.`;
  if (/四件|4\s*件|комплект.*4|4.*комплект/i.test(text)) return "4 шт.";
  return "";
}

function normalizeOzonVariantDescription(value, target, analysis = {}, fallback = {}) {
  const text = cleanText(value);
  if (isValidOzonVariantDescription(text, target, analysis, fallback)) return text;
  return buildOzonVariantDescription(target, analysis, fallback);
}

function buildOzonVariantDescription(target, analysis = {}, fallback = {}) {
  return buildBuyerFacingVariantDescription(target, analysis, fallback);
}

function buildBuyerFacingVariantDescription(target, analysis = {}, fallback = {}) {
  const subject = productSubjectRu(analysis, fallback);
  const model = cleanText(target) || "автомобиля";
  const dna = buildCopyProductDna(analysis, fallback);
  const factSentences = [dna.materialSentence, dna.quantitySentence].filter((text) => isBuyerFacingCopyText(text));
  const productUse = isSillPlateProduct(analysis, fallback)
    ? "предназначены для защиты дверных проемов и зоны посадки от царапин, потертостей и следов обуви"
    : "подходит для ежедневного использования в автомобиле и аккуратно дополняет салон";
  const careBenefit = isSillPlateProduct(analysis, fallback)
    ? "помогают дольше сохранять пороги чистыми и визуально ухоженными"
    : "помогает поддерживать порядок, защищать поверхность от повседневного износа и сохранить аккуратный внешний вид";
  const text = [
    `${subject} для ${model} ${productUse}.`,
    ...factSentences,
    "Форма, посадка и внешний вид подобраны для аккуратного размещения без изменения штатных элементов автомобиля.",
    `${sentenceStart(subject)} ${careBenefit}, поэтому аксессуар удобен для повседневной эксплуатации.`,
    "Описание не включает неподтвержденные размеры, сертификаты, гарантийные обещания или дополнительные совместимости."
  ].join(" ");
  if (text.length >= 350 && text.length <= 500) return text;
  const expanded = `${text} Подходит для тех, кто хочет сохранить чистоту и опрятный вид автомобиля без сложной доработки и лишних деталей.`;
  if (expanded.length <= 500) return expanded;
  return expanded.slice(0, 497).replace(/\s+\S*$/, "").trimEnd() + "...";
}

function buildLegacyOzonVariantDescription(target, analysis = {}, fallback = {}) {
  const dna = buildCopyProductDna(analysis, fallback);
  const subject = dna.subject;
  const model = cleanText(target);
  const text = isSillPlateProduct(analysis, fallback)
    ? `${subject} для ${model} предназначены для защиты дверных проемов и зоны посадки от царапин, потертостей и следов обуви. ${dna.materialSentence} ${dna.quantitySentence} Комплект сохраняет форму, цвет, фактуру, конструкцию и внешний вид исходного товара, аккуратно дополняет интерьер автомобиля и не требует изменения штатных элементов. Накладки подходят для ежедневной эксплуатации, помогают дольше сохранять пороги чистыми и визуально ухоженными.`
    : `${subject} для ${model} сохраняет назначение, форму и проверенные факты исходного товара. ${dna.materialSentence} ${dna.quantitySentence} Аксессуар подходит для ежедневного использования в автомобиле, аккуратно дополняет интерьер и не требует изменения штатных элементов. Материал, конструкция, комплектация и внешний вид остаются согласованными с исходной карточкой, меняется только целевая модель автомобиля.`;
  if (text.length <= 500) return text;
  return text.slice(0, 497).replace(/\s+\S*$/, "").trimEnd() + "...";
}

function isValidOzonVariantDescription(text, target, analysis = {}, fallback = {}) {
  if (!text || containsChinese(text)) return false;
  if (text.length < 350 || text.length > 500) return false;
  return isBuyerFacingCopyText(text) && !hasVariantSourceLeak(text, target, analysis, fallback) && !hasForbiddenCategoryLeak(text, analysis);
}

function hasVariantSourceLeak(text, target, analysis = {}, fallback = {}) {
  const targetText = cleanText(target).toLowerCase();
  const sourceAliases = sourceTitleVehicleAliases(fallback.sourceTitle, fallback.sourceVariantValue || analysis.source_variant_value);
  const sourceAliasKeys = new Set(sourceAliases.map((item) => item.toLowerCase()));
  const sourceRefs = uniqueStrings([
    fallback.sourceVariantValue,
    analysis.source_variant_value,
    analysis.sourceVehicleModel,
    analysis.source_vehicle_model,
    ...toArray(analysis.changeable_facts),
    ...sourceAliases
  ].map(cleanText))
    .filter((ref) => ref && ref.toLowerCase() !== targetText)
    .filter((ref) => sourceAliasKeys.has(ref.toLowerCase()) || isVariantSourceReference(ref, analysis, fallback));
  const lower = text.toLowerCase();
  return sourceRefs.some((ref) => ref.length >= 3 && containsExactVehicleModel(lower, ref));
}

function sourceTitleVehicleAliases(sourceTitle = "", sourceModel = "") {
  const title = cleanText(sourceTitle);
  const source = cleanText(sourceModel);
  if (!title || !source) return [];
  const escaped = source.split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = title.match(new RegExp(`${escaped}((?:\\s*[/|]\\s*[A-Za-z0-9-]+(?:\\s+(?:Pro|Plus|Max))?)*)`, "iu"));
  if (!match?.[1]) return [];
  return uniqueStrings([...match[1].matchAll(/[/|]\s*([A-Za-z0-9-]+(?:\s+(?:Pro|Plus|Max))?)/giu)].map((item) => item[1]));
}

function containsExactVehicleModel(text = "", model = "") {
  const value = cleanText(text);
  const target = cleanText(model);
  if (!value || !target) return false;
  const escaped = target.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(value);
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isVariantSourceReference(ref = "", analysis = {}, fallback = {}) {
  const value = cleanText(ref).toLowerCase();
  const source = cleanText(fallback.sourceVariantValue || analysis.source_variant_value || analysis.sourceVehicleModel || analysis.source_vehicle_model || "").toLowerCase();
  if (source && value.includes(source)) return true;
  return /\b(tenet|haval|chery|jaecoo|geely|omoda|exeed|changan|lada)\b/i.test(value) && /\b[a-z]?\d+[a-z]?\b/i.test(value);
}

function hasForbiddenCategoryLeak(text = "", analysis = {}) {
  const lower = cleanText(text).toLowerCase();
  if (!lower) return false;
  const subject = cleanText(analysis.product_fact_contract?.product_subject_ru || analysis.product_subject_ru || "");
  if (subject && lower.includes(subject.toLowerCase())) return false;
  const forbiddenText = [
    ...toArray(analysis.forbidden_changes),
    ...toArray(analysis.display_zh?.forbidden_changes)
  ].join(" ").toLowerCase();
  if (!/(门槛|迎宾踏板|sill|threshold|порог|накладк)/i.test(forbiddenText)) return false;
  return /(накладк[а-яё_ -]*порог|порог[а-яё_ -]*авто|дверн[а-яё_ -]*порог|sill|threshold)/i.test(lower);
}

function productSubjectRu(analysis = {}, fallback = {}) {
  const subject = confirmedFactText(analysis.product_fact_contract?.product_subject_ru || analysis.product_subject_ru || fallback.productSubjectRu || "");
  const sourceModel = cleanText(fallback.sourceVariantValue || analysis.source_variant_value || analysis.sourceVehicleModel || analysis.source_vehicle_model || "");
  const normalizedSubject = removeSourceModelFromProductSubject(subject, sourceModel);
  if (normalizedSubject && !containsChinese(normalizedSubject) && !hasForbiddenCategoryLeak(normalizedSubject, analysis)) return sentenceStart(normalizedSubject);
  const type = cleanText(analysis.product_type || fallback.productType || "");
  if (isSillPlateProduct(analysis, fallback)) return "Защитные накладки на пороги автомобиля";
  if (/扶手|подлокотник/i.test(type)) return "Органайзер в подлокотник";
  if (/收纳|органайзер/i.test(type)) return "Автомобильный органайзер";
  return "Автомобильный аксессуар";
}

export function removeSourceModelFromProductSubject(subject = "", sourceModel = "") {
  const text = cleanText(subject);
  const source = cleanText(sourceModel);
  if (!text || !source || !containsExactVehicleModel(text, source)) return text;
  const escaped = source.split(/\s+/).map(escapeRegExp).join("\\s+");
  return cleanText(text
    .replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/(?:^|\s)(?:для|на|под)\s*$/iu, "")
    .replace(/[,;:\s]+$/g, ""));
}

function productSubjectSearchTerms(analysis = {}, fallback = {}) {
  const subject = productSubjectRu(analysis, fallback);
  const genericSubjects = new Set([
    productSubjectRu({}, {}).toLowerCase()
  ]);
  if (!subject || genericSubjects.has(subject.toLowerCase())) return [];
  const words = subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(cleanText)
    .filter((word) => word.length >= 5);
  return uniqueStrings([
    subject,
    words.slice(0, 3).join(" "),
    ...words
  ].filter((term) => term.length >= 5));
}

function sentenceStart(value = "") {
  const text = cleanText(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function productQuantityRu(analysis = {}) {
  const quantity = confirmedFactText(analysis.quantity || "");
  if (!quantity || containsChinese(quantity)) return "";
  return quantity;
}

function productSubjectTagCandidates(subject = "") {
  const lower = cleanText(subject).toLowerCase();
  if (/порог|накладк|sill|threshold/.test(lower)) {
    return [
      "накладки на пороги",
      "защита порогов",
      "дверные пороги авто",
      "автомобильные накладки",
      "защитные накладки"
    ];
  }
  if (/подлокотник/.test(lower)) {
    return [
      "ящик в подлокотник",
      "органайзер в подлокотник",
      "вкладыш в подлокотник",
      "лоток в подлокотник",
      "центральный подлокотник",
      "хранение в подлокотнике"
    ];
  }
  if (/органайзер/.test(lower)) {
    return ["автоорганайзер", "органайзер в авто", "хранение в авто"];
  }
  return [];
}

function isSillPlateProduct(analysis = {}, fallback = {}) {
  const facts = [
    analysis.product_type,
    analysis.product_subject_ru,
    analysis.product_fact_contract?.product_subject_ru,
    fallback.productType,
    fallback.productSubjectRu,
    ...toArray(analysis.keep_facts),
    ...toArray(analysis.display_zh?.fixed_facts)
  ].map(cleanText).filter(Boolean);
  return facts.some((fact) => isAffirmedSillPlateFact(fact));
}

function isAffirmedSillPlateFact(value = "") {
  const text = cleanText(value);
  if (!/(门槛|迎宾踏板|门槛条|门槛保护|sill|threshold|door sill|порог|накладк)/i.test(text)) return false;
  if (/(?:不是|并非|非|不属于|不得改成|不要改成).{0,16}(?:门槛|迎宾踏板|门槛条|门槛保护)/i.test(text)) return false;
  if (/(?:not|is not|isn't|not a).{0,20}(?:sill|threshold|door sill)/i.test(text)) return false;
  if (/(?:не является|это не|не относится).{0,24}(?:порог|накладк)/i.test(text)) return false;
  return true;
}

function normalizeOzonVariantRichContent(value, target, analysis = {}, fallback = {}) {
  const text = cleanText(value);
  if (text && !containsChinese(text) && !hasVariantSourceLeak(text, target, analysis, fallback) && !hasForbiddenCategoryLeak(text, analysis)) return text;
  return buildOzonVariantRichContent(target, analysis, fallback);
}

function buildOzonVariantRichContent(target, analysis = {}, fallback = {}) {
  const subject = productSubjectRu(analysis, fallback);
  return `${subject} для ${cleanText(target)}. Сохраняет назначение, форму и проверенные факты исходного товара.`;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(statusError(message, 504)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeBatchItemDisplayZh(value, target, analysis = {}, fallback = {}) {
  const display = objectValue(value);
  if (!Object.keys(display).length) return buildBatchItemDisplayZh(target, analysis, fallback);
  const joined = JSON.stringify(display);
  if (hasForbiddenCategoryLeak(joined, analysis)) return buildBatchItemDisplayZh(target, analysis, fallback);
  if (shouldPreserveProductLogo(fallback.operatorNote || fallback.operator_note || "") && /Logo|logo|标识|车标|贴纸|商标|印刷/.test(cleanText(display.main_image_plan || "")) && /替换|改成|改为|换成/.test(cleanText(display.main_image_plan || ""))) {
    return buildBatchItemDisplayZh(target, analysis, fallback);
  }
  return display;
}

function buildBatchItemDisplayZh(target, analysis = {}, fallback = {}) {
  const subject = cleanText(analysis.product_type || productSubjectRu(analysis, fallback));
  const preserveLogo = shouldPreserveProductLogo(fallback.operatorNote || fallback.operator_note || "");
  return {
    main_image_plan: preserveLogo
      ? `主图中产品主体、结构、材质、数量和贴纸 Logo/印刷图案不变，只调整背景、车牌或可变车型线索为 ${target}。`
      : `主图中产品主体、结构、材质和数量不变，只替换可变车型文字、车牌或背景车型为 ${target}，不要改产品贴纸图案。`,
    title_plan: `标题替换为 ${target} 对应车型，保留「${subject}」这个产品类型和已确认事实。`,
    tags_plan: `标签包含 ${target}、产品类型、汽车用品和使用场景关键词，不引入未确认品类。`,
    description_plan: `描述围绕 ${target} 的「${subject}」生成，保留产品主体、用途和已确认事实。`,
    rich_content_plan: `富文本突出「${subject}」的真实用途、目标车型和产品结构，不改成其他品类。`,
    quality_checks: [
      "产品主体、材质、数量和结构不变。",
      "源车型文字必须完全替换。",
      "不得新增未经确认的品类、适配或认证信息。"
    ]
  };
}

function applyProductFactGate(analysis = {}) {
  const source = objectValue(analysis);
  const unknownFacts = uniqueStrings([
    ...toArray(source.unknown_facts),
    ...toArray(source.unknownFacts),
    ...collectUnknownFactLabels(source)
  ]);
  const next = {
    ...source,
    product_type: confirmedFactText(source.product_type),
    product_subject_ru: confirmedFactText(source.product_subject_ru),
    material: confirmedFactText(source.material),
    color: confirmedFactText(source.color),
    quantity: confirmedFactText(source.quantity),
    keep_facts: confirmedFactList(source.keep_facts),
    forbidden_changes: confirmedFactList(source.forbidden_changes),
    visible_texts: confirmedFactList(source.visible_texts),
    unknown_facts: unknownFacts,
    fact_gate: {
      applied: true,
      policy: "Only confirmed facts may enter generation prompts. Unknown facts are omitted from copy and prompts.",
      unknown_facts: unknownFacts
    }
  };
  const display = objectValue(source.display_zh || source.displayZh);
  if (Object.keys(display).length) {
    next.display_zh = {
      ...display,
      fixed_facts: confirmedFactList(display.fixed_facts),
      unknown_facts: uniqueStrings([...toArray(display.unknown_facts), ...unknownFacts])
    };
  }
  const contract = objectValue(source.product_fact_contract);
  if (Object.keys(contract).length) {
    next.product_fact_contract = {
      ...contract,
      product_subject_ru: confirmedFactText(contract.product_subject_ru),
      material: confirmedFactText(contract.material),
      color: confirmedFactText(contract.color),
      quantity: confirmedFactText(contract.quantity),
      stable_facts: confirmedFactList(contract.stable_facts),
      unknown_facts: uniqueStrings([...toArray(contract.unknown_facts), ...unknownFacts])
    };
  }
  return next;
}

function collectUnknownFactLabels(value, pathName = "") {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectUnknownFactLabels(item, `${pathName}[${index}]`));
  if (!value || typeof value !== "object") {
    return isUnknownFactValue(value) && pathName ? [pathName.replace(/\[\d+\]$/g, "")] : [];
  }
  return Object.entries(value).flatMap(([key, item]) => collectUnknownFactLabels(item, pathName ? `${pathName}.${key}` : key));
}

function confirmedFactText(value) {
  const text = cleanText(value);
  return isUnknownFactValue(text) ? "" : text;
}

function confirmedFactList(value) {
  return toArray(value)
    .map((item) => confirmedFactText(item))
    .filter(Boolean);
}

function isUnknownFactValue(value) {
  const text = cleanText(value);
  if (!text) return false;
  return UNKNOWN_FACT_RE.test(text);
}

function hasCopyPlaceholderLeak(value) {
  return UNKNOWN_FACT_RE.test(cleanText(value));
}

function hasInternalCopyLeak(value) {
  return INTERNAL_COPY_LEAK_RE.test(cleanText(value));
}

function isBuyerFacingCopyText(value) {
  const text = cleanText(value);
  return Boolean(text && !hasCopyPlaceholderLeak(text) && !hasInternalCopyLeak(text));
}

function normalizeOptimizationPlan(plan, analysis = {}) {
  const keepFacts = toArray(plan.keep_facts).length ? toArray(plan.keep_facts) : toArray(analysis.keep_facts);
  const goals = toArray(plan.optimization_goals).length ? toArray(plan.optimization_goals) : toArray(analysis.optimization_goals || analysis.improvement_opportunities);
  const displayZh = normalizeOptimizerDisplayZh(plan, analysis, keepFacts, goals);
  return {
    ...plan,
    optimization_type: cleanText(plan.optimization_type || "main_image_conversion_optimization"),
    keep_facts: keepFacts,
    current_problems: toArray(plan.current_problems).length ? toArray(plan.current_problems) : toArray(analysis.current_problems),
    optimization_goals: goals,
    copy_strategy: normalizeOptimizerCopyStrategy(plan.copy_strategy || plan.copyStrategy, analysis),
    visual_language: normalizeOptimizerVisualLanguage(plan.visual_language || plan.visualLanguage, analysis),
    main_overlay_ru: normalizeMainOverlayRu(plan.main_overlay_ru),
    main_visual_directions: normalizeMainVisualDirections(plan.main_visual_directions || plan.display_zh?.main_visual_directions),
    suite_storyboard: normalizeOptimizerStoryboard(plan.suite_storyboard || plan.display_zh?.suite_storyboard),
    forbidden_changes: toArray(plan.forbidden_changes).length ? toArray(plan.forbidden_changes) : [
      "不得改变商品 SKU 主体。",
      "不得改变已确认的车型适配关系。",
      "不得改变材质、数量、尺寸或安装事实，除非已有明确证据。",
      "不得新增虚假徽章、认证、平台标识或未支持的卖点。"
    ],
    image_optimization_prompt_en: cleanText(plan.image_optimization_prompt_en || buildFallbackOptimizationPrompt(keepFacts, goals)),
    negative_prompt_en: cleanText(plan.negative_prompt_en || "No product identity change. No fake claims. No material change. No quantity change. No unreadable text."),
    quality_checks: toArray(plan.quality_checks).length ? toArray(plan.quality_checks) : [
      "商品主体仍为同一个 SKU。",
      "主图里的产品主体比原图更清晰。",
      "图片文字清楚可读且符合事实。",
      "没有新增未经确认的卖点或认证。"
    ],
    display_zh: displayZh,
    cost_policy: plan.cost_policy || {
      dry_run_first: true,
      generate_one_candidate_before_batch: true,
      reuse_product_facts_from_variant_template_when_available: true
    }
  };
}

function normalizeOptimizerCopyStrategy(value = {}, analysis = {}) {
  const source = objectValue(value);
  return {
    exact_subject_ru: optimizerOverlayText(source.exact_subject_ru || ""),
    title_information_order: toArray(source.title_information_order).map(cleanText).filter(Boolean).slice(0, 5),
    verified_benefits_ru: toArray(source.verified_benefits_ru).map(optimizerOverlayText).filter(Boolean).slice(0, 6),
    forbidden_generic_phrases_ru: toArray(source.forbidden_generic_phrases_ru).map(cleanText).filter(Boolean).slice(0, 12),
    per_shot_message_rules: toArray(source.per_shot_message_rules).map(cleanText).filter(Boolean).slice(0, 6),
    decision_context: normalizeOptimizerDecisionContext(analysis.decision_context || analysis.decisionContext, analysis)
  };
}

function normalizeOptimizerVisualLanguage(value = {}, analysis = {}) {
  const source = objectValue(value);
  return {
    tone: cleanKey(source.tone || analysis.decision_context?.communication_tone || "clear_commercial"),
    headline_style: cleanKey(source.headline_style || "product_specific"),
    hierarchy: toArray(source.hierarchy).map(cleanKey).filter(Boolean).slice(0, 4),
    font_weights: Math.max(1, Math.min(3, Number(source.font_weights || 2))),
    accent_style: cleanKey(source.accent_style || "restrained"),
    alignment: cleanKey(source.alignment || "composition_led"),
    max_headline_lines: Math.max(1, Math.min(3, Number(source.max_headline_lines || 2))),
    max_benefit_words: Math.max(2, Math.min(8, Number(source.max_benefit_words || 5))),
    avoid: toArray(source.avoid).map(cleanText).filter(Boolean).slice(0, 12)
  };
}

function normalizeMainOverlayRu(value = {}) {
  const source = objectValue(value);
  return {
    title_ru: optimizerOverlayText(source.title_ru || source.title || ""),
    compatibility_ru: optimizerOverlayText(source.compatibility_ru || source.compatibility || source.audience_ru || ""),
    benefits_ru: toArray(source.benefits_ru || source.benefits).map(optimizerOverlayText).filter(Boolean).slice(0, 3)
  };
}

function fallbackStoryboardOverlayRu(role = "benefit") {
  return {
    main: "Главные преимущества",
    material: "Материалы и качество",
    installation: "Простая установка",
    structure: "Комплектация товара",
    benefit: "Преимущества товара",
    closeup: "Внимание к деталям",
    size: "Размер и совместимость"
  }[role] || "Подробнее о товаре";
}

function normalizeMainVisualDirections(value = []) {
  const fallback = [
    { title_zh: "明亮棚拍", direction_en: "Bright premium studio presentation with a soft neutral background, crisp product separation, natural shadow and generous spacing." },
    { title_zh: "场景质感", direction_en: "Premium contextual presentation with subtle automotive environment cues, controlled depth, realistic lighting and a clearly dominant product." }
  ];
  const rows = arrayValue(value).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      title_zh: cleanText(source.title_zh || source.title || `主视觉方向 ${index + 1}`),
      direction_en: cleanText(source.direction_en || source.direction || "")
    };
  }).filter((item) => item.direction_en).slice(0, 3);
  return rows.length >= 2 ? rows : fallback;
}

function normalizeOptimizerAnalysis(analysis = {}) {
  const displayZh = normalizeOptimizerAnalysisDisplayZh(analysis);
  return {
    ...analysis,
    decision_context: normalizeOptimizerDecisionContext(analysis.decision_context || analysis.decisionContext, analysis),
    display_zh: displayZh
  };
}

function normalizeOptimizerDecisionContext(value = {}, analysis = {}) {
  const source = objectValue(value);
  return {
    exact_product_subtype: cleanText(source.exact_product_subtype || analysis.product_type || "当前商品"),
    target_buyer_or_compatibility: cleanText(source.target_buyer_or_compatibility || ""),
    purchase_decision_order: toArray(source.purchase_decision_order).map(cleanText).filter(Boolean).slice(0, 5),
    verified_differentiators: toArray(source.verified_differentiators).map(cleanText).filter(Boolean).slice(0, 6),
    visual_category: cleanKey(source.visual_category || "general_retail"),
    price_positioning: cleanKey(source.price_positioning || "mainstream"),
    communication_tone: cleanKey(source.communication_tone || "clear_commercial")
  };
}

function normalizeOptimizerAnalysisDisplayZh(analysis = {}) {
  const display = objectValue(analysis.display_zh || analysis.displayZh);
  const productType = cleanText(display.product_type || analysis.product_type || "当前商品");
  return {
    ...display,
    recognition_summary: cleanText(display.recognition_summary || `已识别为「${productType}」，后续优化必须以图片中可见商品事实为准。`),
    product_type: productType,
    fixed_facts: toArray(display.fixed_facts).length ? toArray(display.fixed_facts) : [
      "锁定图片中可见的商品主体、结构、数量、材质和颜色，不根据标题或标签臆测。",
      "保留已确认的适配车型、使用位置和真实卖点。"
    ],
    main_image_observation: cleanText(display.main_image_observation || "主图用于判断商品主体和关键卖点，优化时只提升清晰度、构图、光线和可读性。"),
    detail_image_observation: cleanText(display.detail_image_observation || "详情图用于补充材质、结构、安装位置和使用场景，不能新增未确认事实。"),
    recommended_action: cleanText(display.recommended_action || "先确认产品事实，再按主图、详情图、标题、标签、描述分别生成优化建议。"),
    forbidden_changes: toArray(display.forbidden_changes).length ? toArray(display.forbidden_changes) : [
      "不得改变商品主体或品类。",
      "不得新增未确认的材质、尺寸、认证、安装方式或适配关系。"
    ]
  };
}

function normalizeOptimizerDisplayZh(plan = {}, analysis = {}, keepFacts = [], goals = []) {
  const display = objectValue(plan.display_zh || plan.displayZh);
  const productType = cleanText(analysis.display_zh?.product_type || analysis.product_type || "当前商品");
  const mainGoal = goals[0] || "提升主图点击率和商品识别度";
  return {
    ...display,
    main_image_plan: cleanText(display.main_image_plan || plan.main_image_plan || `主图建议：保留${productType}的主体、结构和真实材质，优化构图、光线、背景层次和卖点可读性。`),
    detail_image_plan: cleanText(display.detail_image_plan || plan.detail_image_plan || "详情图方案：围绕安装位置、使用场景、材质细节、尺寸/结构说明补充图片，不改变商品事实。"),
    suite_storyboard: normalizeOptimizerStoryboard(display.suite_storyboard || plan.suite_storyboard),
    title_plan: cleanText(display.title_plan || plan.title_plan || "标题建议：围绕已识别的产品类型、适配车型和核心用途组织标题，避免把商品识别成其他品类。"),
    tags_plan: cleanText(display.tags_plan || plan.tags_plan || "标签建议：覆盖产品类型、目标车型、使用场景和材质/功能关键词，保持 Ozon 可识别且不堆砌无关词。"),
    description_plan: cleanText(display.description_plan || plan.description_plan || "描述建议：用 150-250 个中文字符说明真实用途、结构特点、适配范围和使用价值，再交给发布链路生成目标语言文案。"),
    forbidden_changes: toArray(display.forbidden_changes).length ? toArray(display.forbidden_changes) : toArray(plan.forbidden_changes),
    quality_checks: toArray(display.quality_checks).length ? toArray(display.quality_checks) : toArray(plan.quality_checks),
    summary: cleanText(display.summary || `本次优化围绕「${mainGoal}」，所有建议以产品识别事实为准。`),
    keep_facts: toArray(display.keep_facts).length ? toArray(display.keep_facts) : keepFacts
  };
}

function normalizeOptimizerStoryboard(value = []) {
  const fallback = [
    { role: "main", title_zh: "商品主视觉", objective_zh: "在移动端快速识别商品主体和完整套装", composition_en: "Premium marketplace hero composition with the complete product set clearly separated and centered.", must_show_en: "The exact verified product, color, structure and quantity." },
    { role: "material", title_zh: "材质与工艺", objective_zh: "展示真实材质、表面处理和做工细节", composition_en: "Consistent studio close-up showing material, finish, edges and construction details.", must_show_en: "Only visible and verified material and craftsmanship details." },
    { role: "installation", title_zh: "安装位置", objective_zh: "说明商品在真实使用环境中的安装位置", composition_en: "Clean real-use installation context with the product location immediately understandable.", must_show_en: "Only the verified installation position and supported accessories." },
    { role: "benefit", title_zh: "核心价值", objective_zh: "用清晰画面解释一个已确认的购买理由", composition_en: "Benefit-focused detail composition with one clear visual message and generous spacing.", must_show_en: "One verified primary benefit without invented claims." },
    { role: "structure", title_zh: "结构与套装", objective_zh: "展示商品组成、数量和长短关系", composition_en: "Organized component layout showing the complete set and its structural relationship.", must_show_en: "The exact verified component count, proportions and structure." }
  ];
  const allowedRoles = new Set(["main", "material", "installation", "structure", "benefit", "closeup", "size"]);
  const shots = arrayValue(value).map((item, index) => {
    const source = item && typeof item === "object" ? item : {};
    const role = cleanKey(source.role || (index === 0 ? "main" : "detail"));
    return {
      role: allowedRoles.has(role) ? role : (index === 0 ? "main" : "benefit"),
      title_zh: cleanText(source.title_zh || source.title || `套图第 ${index + 1} 张`),
      objective_zh: cleanText(source.objective_zh || source.objective || "围绕已确认商品事实解决一个购买疑问"),
      composition_en: cleanText(source.composition_en || source.composition || "Use a clear premium ecommerce composition consistent with the main image."),
      must_show_en: cleanText(source.must_show_en || source.must_show || "Show only verified product facts."),
      overlay_text_ru: optimizerOverlayText(source.overlay_text_ru || source.overlayTextRu || fallbackStoryboardOverlayRu(allowedRoles.has(role) ? role : "benefit")),
      typography_role: cleanKey(source.typography_role || (index === 0 ? "identity" : role)),
      typography_direction_en: cleanText(source.typography_direction_en || "Use a product-specific native Russian ecommerce treatment that fits this shot and does not repeat the previous frame layout.")
    };
  }).filter((item) => item.title_zh || item.composition_en).slice(0, 5);
  if (!shots.length) return fallback;
  shots[0].role = "main";
  return shots;
}

function optimizerOverlayText(value = "") {
  const text = cleanText(value).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (!text || /[\u3400-\u9fff]/u.test(text)) return "";
  return text.split(" ").slice(0, 12).join(" ").slice(0, 90).trim();
}

function dataUrlBuffer(value = "") {
  const match = /^data:[^;,]+;base64,(.+)$/i.exec(String(value || ""));
  if (!match) throw statusError("resolved image data is invalid", 400);
  return Buffer.from(match[1], "base64");
}

function optimizerTextOverlaySvg({ width, height, title = "", subtitle = "", bullets = [], placement = "top" }) {
  const fontSize = Math.max(30, Math.round(width * 0.05));
  const paddingX = Math.round(width * 0.065);
  const lineHeight = Math.round(fontSize * 1.18);
  const maxChars = Math.max(12, Math.floor((width - paddingX * 2) / (fontSize * 0.58)));
  const lines = wrapOverlayText(title, maxChars, 2);
  const subtitleSize = Math.max(22, Math.round(fontSize * 0.54));
  const bulletSize = Math.max(19, Math.round(fontSize * 0.43));
  const hasDetails = Boolean(subtitle || bullets.length);
  const detailHeight = hasDetails ? Math.round(subtitleSize * 1.5 + Math.ceil(bullets.length / 2) * bulletSize * 1.75) : 0;
  const boxHeight = Math.min(Math.round(height * 0.32), Math.round(paddingX * 0.55 + lines.length * lineHeight + detailHeight + paddingX * 0.42));
  const boxY = placement === "bottom" ? height - boxHeight : 0;
  const firstBaseline = boxY + Math.round(paddingX * 0.52) + fontSize;
  const textNodes = lines.map((line, index) => `<text x="${paddingX}" y="${firstBaseline + index * lineHeight}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeSvgText(line)}</text>`).join("");
  const detailY = firstBaseline + lines.length * lineHeight + Math.round(subtitleSize * 0.25);
  const subtitleNode = subtitle ? `<text x="${paddingX}" y="${detailY}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${subtitleSize}" font-weight="600" fill="#dbeafe">${escapeSvgText(subtitle.slice(0, maxChars + 8))}</text>` : "";
  const bulletStartY = detailY + (subtitle ? Math.round(subtitleSize * 1.25) : 0);
  const bulletWidth = Math.floor((width - paddingX * 2 - 16) / 2);
  const bulletNodes = bullets.map((bullet, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = paddingX + column * (bulletWidth + 16);
    const y = bulletStartY + row * Math.round(bulletSize * 1.7);
    return `<rect x="${x}" y="${y - bulletSize}" width="${bulletWidth}" height="${Math.round(bulletSize * 1.42)}" rx="6" fill="#ffffff" fill-opacity="0.14"/><text x="${x + 10}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${bulletSize}" font-weight="600" fill="#ffffff">• ${escapeSvgText(bullet.slice(0, Math.max(16, Math.floor(maxChars / 2))))}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="${boxY}" width="${width}" height="${boxHeight}" fill="#111827" fill-opacity="0.82"/>${textNodes}${subtitleNode}${bulletNodes}</svg>`;
}

function wrapOverlayText(value, maxChars, maxLines) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) current = next;
    else {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  const consumed = lines.join(" ").split(/\s+/).length;
  if (consumed < words.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.…]+$/u, "")}…`;
  return lines.length ? lines : [""];
}

function escapeSvgText(value = "") {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildFallbackOptimizationPrompt(keepFacts, goals) {
  return [
    "Optimize this ecommerce main image for an Ozon automotive accessory listing.",
    "Keep the same product SKU and all verified product facts unchanged.",
    keepFacts.length ? `Preserve these facts: ${keepFacts.join("; ")}.` : "",
    goals.length ? `Improve these points: ${goals.join("; ")}.` : "Improve product clarity, visual hierarchy, text readability, lighting, and marketplace trust.",
    "Do not change vehicle/model compatibility, material, quantity, dimensions, or product identity."
  ].filter(Boolean).join(" ");
}

function buildOperatorImageHardRules(operatorNote = "", variantType = "") {
  const preserveLogo = shouldPreserveProductLogo(operatorNote, variantType);
  return [
    "Operator notes override default image replacement rules.",
    preserveLogo ? "Hard constraint: keep all product sticker logos, decals, brand marks, and printed marks pixel-level unchanged." : "",
    preserveLogo ? "Do not replace, translate, repaint, remove, or redesign protected marks on the product." : "",
    "Do not render Chinese text or Chinese characters in the image."
  ].filter(Boolean);
}

function isBrandLogoOnlyFission(variantType = "", contract = null) {
  return normalizeImageVariantType(variantType || contract?.variant_type || contract?.variantType || "") === "brand_logo_only_vehicle_fission";
}

function shouldPreserveProductLogo(operatorNote = "", variantType = "") {
  if (isBrandLogoOnlyFission(variantType)) return false;
  const note = cleanText(operatorNote);
  if (!note) return false;
  if (/(?:logo|Logo|LOGO|标识|车标|贴纸|商标).{0,12}(?:替换|更换|改成|改为)/.test(note)) return false;
  return /(?:logo|Logo|LOGO|标识|车标|贴纸|商标|印刷|图案)[^；;。]{0,12}(?:不变|别动|不要动|保持|保留|别改|不要改|不改)|(?:不变|别动|不要动|保持|保留|别改|不要改|不改)[^；;。]{0,12}(?:logo|Logo|LOGO|标识|车标|贴纸|商标|印刷|图案)/.test(note);
}

function normalizeImageVariantType(value = "") {
  const key = cleanKey(value);
  if (["brand_logo_only_vehicle_fission", "brand_logo_vehicle_fission", "cross_brand_logo_only"].includes(key)) return "brand_logo_only_vehicle_fission";
  if (["vehicle_model_swap", "model_swap", "vehicle_variant", "vehicle_model_variant"].includes(key)) return "vehicle_model_swap";
  if (["logo_swap", "brand_swap", "badge_swap"].includes(key)) return "logo_swap";
  if (["color_swap", "material_color_swap"].includes(key)) return "color_swap";
  if (["image_optimization", "main_image_optimization", "optimize_image", "detail_image"].includes(key)) return "image_optimization";
  if (["audience_variant", "scene_variant", "style_variant"].includes(key)) return key;
  return "generic_variant";
}

export function buildImageEditContract({ variantType = "", source = "", target = "", keepFacts = [], analysis = {}, fallback = {} } = {}) {
  const normalizedType = normalizeImageVariantType(variantType || fallback.variantType || fallback.variant_type || analysis.recommended_variant_mode || "generic_variant");
  const operatorNote = cleanText(fallback.operatorNote || fallback.operator_note || "");
  const operatorInstructions = fallback.operatorInstructions || parseOperatorInstructions(operatorNote);
  const preserveProductLogo = shouldPreserveProductLogo(operatorNote, normalizedType);
  const stableFacts = englishImageKeepFacts(keepFacts, analysis, fallback);
  const replaceZonesByType = {
    brand_logo_only_vehicle_fission: ["large_title_text", "model_text", "license_plate_text", "background_vehicle_cues", "editable_brand_text"],
    vehicle_model_swap: preserveProductLogo
      ? ["large_title_text", "model_text", "license_plate_text", "background_vehicle_cues"]
      : ["large_title_text", "model_text", "license_plate_text", "background_vehicle_cues", "editable_brand_text"],
    logo_swap: ["editable_brand_text"],
    color_swap: ["product_color_area"],
    image_optimization: [],
    audience_variant: ["editable_scene_cues", "audience_context_cues"],
    scene_variant: ["background_scene", "editable_scene_cues"],
    style_variant: ["visual_style", "background_scene"],
    generic_variant: ["explicitly_editable_regions"]
  };
  const preserveZonesByType = {
    brand_logo_only_vehicle_fission: ["product_body", "shape", "material", "quantity", "product_model_text", "product_printed_model_text", "layout", "lighting_style", "full_canvas", "title_area", "selling_point_text_blocks", "icons", "badges", "text_modules", "margins"],
    vehicle_model_swap: ["product_body", "shape", "material", "quantity", "color_scheme", "layout", "lighting_style", "full_canvas", "title_area", "selling_point_text_blocks", "icons", "badges", "text_modules", "margins"],
    logo_swap: ["product_body", "shape", "material", "quantity", "layout", "title_structure", "non_brand_text", "selling_point_text_blocks", "icons", "badges", "margins"],
    color_swap: ["logo", "title", "model_text", "shape", "quantity", "layout", "printed_text", "selling_point_text_blocks", "icons", "badges", "margins"],
    image_optimization: ["product_body", "shape", "material", "quantity", "model_text", "logo", "all_existing_readable_text"],
    audience_variant: ["product_body", "shape", "material", "quantity", "logo", "model_text"],
    scene_variant: ["product_body", "shape", "material", "quantity", "logo", "title", "model_text"],
    style_variant: ["product_body", "shape", "material", "quantity", "logo", "title", "model_text"],
    generic_variant: ["product_body", "shape", "material", "quantity", "layout"]
  };
  let replaceZones = [...(replaceZonesByType[normalizedType] || replaceZonesByType.generic_variant)];
  const preserveZones = [...(preserveZonesByType[normalizedType] || preserveZonesByType.generic_variant)];
  if (operatorInstructions.image_scope_mode === "exclusive" && operatorInstructions.image_edit_scope.includes("image_title")) {
    replaceZones = ["large_title_text", "model_text"];
  }
  if (operatorInstructions.image_edit_scope.includes("image_title")) {
    ["large_title_text", "model_text"].forEach((zone) => { if (!replaceZones.includes(zone)) replaceZones.push(zone); });
  }
  if (operatorInstructions.image_edit_scope.includes("background") && !replaceZones.includes("background_vehicle_cues")) replaceZones.push("background_vehicle_cues");
  if (operatorInstructions.image_edit_scope.includes("product_identity") && !replaceZones.includes("editable_brand_text")) replaceZones.push("editable_brand_text");
  if (operatorInstructions.image_locked_scope.includes("product_body") && !preserveZones.includes("product_body")) preserveZones.push("product_body");
  if (operatorInstructions.image_locked_scope.includes("background")) {
    replaceZones = replaceZones.filter((zone) => !["background", "background_vehicle_cues", "background_scene", "editable_scene_cues"].includes(zone));
    ["background", "background_vehicle_cues", "background_scene"].forEach((zone) => { if (!preserveZones.includes(zone)) preserveZones.push(zone); });
  }
  if (operatorInstructions.image_locked_scope.includes("product_identity")) {
    replaceZones = replaceZones.filter((zone) => !["logo_or_badge_text", "brand_mark_text", "decal_text", "printed_brand_text"].includes(zone));
    ["logo", "logo_or_badge_text", "brand_mark_text", "printed_brand_text"].forEach((zone) => { if (!preserveZones.includes(zone)) preserveZones.push(zone); });
  }
  return {
    variant_type: normalizedType,
    source_value: cleanText(source),
    target_value: cleanText(target),
    replace_zones: replaceZones,
    preserve_zones: preserveZones,
    stable_facts: stableFacts,
    text_policy: {
      keep_existing_title_area: normalizedType !== "image_optimization",
      keep_existing_layout_text_and_icons: normalizedType !== "image_optimization",
      require_target_text_visible: Boolean(target) && ["vehicle_model_swap", "logo_swap", "brand_logo_only_vehicle_fission", "generic_variant"].includes(normalizedType),
      allowed_new_text: target && normalizedType !== "image_optimization" ? [target] : [],
      forbid_new_marketing_text: true,
      forbid_random_text: true,
      forbid_chinese_text: true
    },
    operator_instructions: operatorInstructions,
    logo_policy: {
      mode: preserveProductLogo ? "preserve_existing_marks" : "plain_text_only",
      preserve_product_printed_logo: preserveProductLogo,
      target_model_on_product: normalizedType === "brand_logo_only_vehicle_fission" ? "forbid" : "allow",
      official_logo_graphics: "forbid",
      brand_asset_reference: "forbid"
    }
  };
}

function buildImageEditContractPrompt(contract = null) {
  const normalized = objectValue(contract);
  const variantType = normalizeImageVariantType(normalized.variant_type || normalized.variantType || "");
  if (!variantType || variantType === "generic_variant" && !normalized.target_value && !normalized.source_value) return "";
  const source = cleanText(normalized.source_value || normalized.sourceValue || "");
  const target = cleanText(normalized.target_value || normalized.targetValue || "");
  const replaceZones = toArray(normalized.replace_zones || normalized.replaceZones).map(cleanText).filter(Boolean);
  const preserveZones = toArray(normalized.preserve_zones || normalized.preserveZones).map(cleanText).filter(Boolean);
  const stableFacts = toArray(normalized.stable_facts || normalized.stableFacts).map(cleanText).filter(Boolean);
  const textPolicy = objectValue(normalized.text_policy || normalized.textPolicy);
  const logoPolicy = objectValue(normalized.logo_policy || normalized.logoPolicy);
  return [
    "Image edit contract: preserve the original ecommerce main-image composition unless a listed editable zone requires change.",
    buildContractReplacementRule({ variantType, source, target, replaceZones, logoPolicy }),
    "Keep the full original frame/canvas, aspect ratio, product scale, margins, and all image edges visible; do not crop, zoom in, cut off, or reframe the image.",
    textPolicy.keep_existing_title_area ? "If the source image has a large title area, keep that title area visible, readable, same size, and in the original layout; replace only the source identity words inside it." : "",
    textPolicy.keep_existing_layout_text_and_icons ? "Preserve existing selling-point text blocks, feature icons, pictograms, badges, arrows, dividers, labels, decorative modules, and their positions, size, hierarchy, colors, and spacing. Replace only source vehicle identity tokens inside those existing modules." : "",
    textPolicy.require_target_text_visible && target ? `The target text "${target}" must be visible and readable in the required editable zones.` : "",
    buildContractTextPolicyRule({ textPolicy }),
    preserveZones.length ? `Preserve zones: ${preserveZones.join(", ")}.` : "",
    stableFacts.length ? `Stable product facts: ${stableFacts.join("; ")}.` : "",
    "Keep the physical product body, structure, material facts, quantity facts, texture, lighting direction, and intended use unchanged."
  ].filter(Boolean).join(" ");
}

function buildContractReplacementRule({ variantType, source, target, replaceZones = [], logoPolicy = {} } = {}) {
  const from = source ? `"${source}"` : "the configured source value";
  const to = target ? `"${target}"` : "the configured target value";
  const zones = replaceZones.length ? ` Editable replacement zones: ${replaceZones.join(", ")}.` : "";
  if (variantType === "vehicle_model_swap") {
    const logoRule = logoPolicy.preserve_product_printed_logo
      ? "Keep product sticker logos, decals, brand marks, and printed marks unchanged."
      : "Replace only editable brand or model words with plain readable text. Do not generate or imitate any logo, emblem, badge, symbol, or trademark graphic.";
    return `Replace every visible source vehicle identity ${from} with ${to}.${zones} ${logoRule}`;
  }
  if (variantType === "logo_swap") return `Replace only editable source brand text ${from} with plain readable target text ${to}.${zones} Do not generate, copy, reconstruct, or imitate any official logo, emblem, badge, symbol, or trademark graphic.`;
  if (variantType === "brand_logo_only_vehicle_fission") {
    return `Replace only editable brand wording with the target brand name as plain readable text; never generate, copy, reconstruct, or imitate an official logo, emblem, badge, symbol, or trademark graphic. Never print, add, or alter the target model on the physical product. Update the external headline and background vehicle to ${to}.${zones}`;
  }
  if (variantType === "color_swap") return `Change only the configured product color or finish from ${from} to ${to}.${zones} Do not change logos, title text, model text, printed text, shape, or quantity.`;
  if (variantType === "image_optimization") return "Do not replace vehicle model, logo, title, readable text, or product identity. Optimize only clarity, lighting, background cleanliness, and product prominence.";
  return `Replace ${from} with ${to} only in explicitly editable regions.${zones}`;
}

function buildContractTextPolicyRule({ textPolicy = {} } = {}) {
  const allowed = toArray(textPolicy.allowed_new_text).map(cleanText).filter(Boolean);
  return [
    "Text policy: do not add new English descriptions, slogans, feature labels, decorative words, random letters, or invented words.",
    "Existing readable text, selling-point copy, labels, icons, pictograms, and badge modules from the reference image are not new text; preserve them when they are product-neutral and do not express the source vehicle identity.",
    allowed.length ? `Only allowed new readable text: ${allowed.map((item) => `"${item}"`).join(", ")}.` : "Do not add any new readable text.",
    "Do not remove, translate, rewrite, summarize, hide, blur, or replace existing non-variant product-neutral text or icon labels.",
    "No Chinese text or Chinese characters."
  ].filter(Boolean).join(" ");
}

function normalizeImageEditPromptEn(value, source, target, keepFacts, analysis = {}, fallback = {}) {
  const operatorNote = cleanText(fallback.operatorNote || fallback.operator_note || "");
  const proposed = cleanText(value);
  const preserveLogo = shouldPreserveProductLogo(operatorNote, fallback.variantType || fallback.variant_type || fallback.imageEditContract?.variant_type || fallback.image_edit_contract?.variant_type);
  const conflictsWithLogoRule = preserveLogo && /replace[^.]{0,120}(?:logo|decal|brand mark|printed mark)|(?:logo|decal|brand mark|printed mark)[^.]{0,120}replace/i.test(proposed);
  const hasChineseText = containsChinese(proposed);
  const imageEditContract = nonEmptyObjectValue(fallback.imageEditContract || fallback.image_edit_contract) || buildImageEditContract({
    variantType: fallback.variantType || fallback.variant_type,
    source,
    target,
    keepFacts,
    analysis,
    fallback
  });
  const base = proposed && !hasChineseText && !conflictsWithLogoRule
    ? proposed
    : buildFallbackImagePrompt(source, target, keepFacts, analysis, { ...fallback, imageEditContract });
  return appendImagePromptSafetyRules(base, source, target, operatorNote, imageEditContract);
}

function normalizeImageNegativePromptEn(value, source, operatorNote = "", imageEditContract = null) {
  const base = containsChinese(value)
    ? ""
    : cleanText(value);
  return uniqueStrings([
    ...splitPromptSentences(base),
    ...GLOBAL_IMAGE_BASELINE_NEGATIVE_RULES,
    source ? `No ${source}.` : "",
    "No source vehicle text.",
    "No Chinese text.",
    "No Chinese characters.",
    "No random text.",
    "No invented words.",
    "No generated, copied, reconstructed, or imitated official automotive logo, emblem, badge, symbol, or trademark graphic.",
    "No automotive logo reference image.",
    "No extra English descriptions.",
    "No slogans.",
    "No feature labels.",
    "No missing existing large title area.",
    "No missing existing selling point text blocks.",
    "No missing existing icons, pictograms, badges, labels, arrows, dividers, or decorative modules.",
    "No cropped frame.",
    "No zoomed-in composition.",
    "No remaining source identity text.",
    "No material change.",
    "No quantity change.",
    "No deformed product.",
    shouldPreserveProductLogo(operatorNote, imageEditContract?.variant_type || imageEditContract?.variantType) ? "Do not alter product sticker logos, decals, brand marks, or printed marks." : ""
  ]).join(" ");
}

function normalizeReviewedNegativePromptEn(value = "") {
  return uniqueStrings(splitPromptSentences(containsChinese(value) ? "" : value)).join(" ");
}

function splitPromptSentences(value = "") {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function composeFinalImagePromptForRun(prompt, { source = "", target = "", keepFacts = [], mainImagePlan = "", operatorNote = "", imageEditContract = null, templateGuidance = null, productTruthRules = [], priorityContract = null } = {}) {
  const brandLogoOnly = isBrandLogoOnlyFission("", imageEditContract);
  const cleanPrompt = brandLogoOnly || containsChinese(prompt) ? "" : cleanText(prompt);
  if (!brandLogoOnly && isFinalizedImagePrompt(cleanPrompt)) {
    return uniqueStrings([
      normalizeFinalizedImagePrompt(cleanPrompt),
      "Across every mode, never generate, copy, reconstruct, imitate, or use a reference image for an official automotive logo, emblem, badge, symbol, or trademark graphic. Express brand and vehicle identity with plain readable text only."
    ]).join(" ");
  }
  const userConstraints = brandLogoOnly ? [] : buildUserInstructionConstraintsEn({ mainImagePlan, operatorNote });
  const templateRules = normalizeTemplateGuidanceRules(templateGuidance);
  const productTruth = normalizeImageRuleList(productTruthRules).length
    ? normalizeImageRuleList(productTruthRules)
    : buildImageProductTruthRules(keepFacts, {}, {});
  const priorityRules = normalizeImageRuleList(priorityContract?.priority_rules || priorityContract).length
    ? normalizeImageRuleList(priorityContract?.priority_rules || priorityContract)
    : imagePromptPriorityContract().priority_rules;
  const contractPrompt = buildImageEditContractPrompt(imageEditContract);
  const baseline = [
    "Global baseline constraints: generated image must be marketplace-safe, factual, and free of Chinese text.",
    "Do not add watermark, platform logos, fake certification badges, fake authorization marks, sensitive marketplace names, gibberish text, random text, or extra accessories.",
    "Across every mode, never generate, copy, reconstruct, imitate, or use a reference image for an official automotive logo, emblem, badge, symbol, or trademark graphic. Express brand and vehicle identity with plain readable text only.",
    "Do not make exaggerated, unverifiable, or official-authorization claims in visible text."
  ];
  return uniqueStrings([
    "Prompt priority order: global baseline rules > user instructions > recognized product facts > matched visual template > draft AI prompt.",
    ...priorityRules,
    productTruth.length ? `Recognized product facts are authoritative: ${productTruth.join("; ")}.` : "",
    templateRules.length ? `Matched visual template guidance, layout only: ${templateRules.join(" ")}` : "",
    contractPrompt || cleanPrompt || buildFallbackImagePrompt(source, target, keepFacts, {}, { operatorNote }),
    contractPrompt && cleanPrompt ? `Draft AI prompt for secondary detail only: ${cleanPrompt}` : "",
    mainImagePlan || operatorNote ? "Final operator-reviewed instructions below have higher priority than the draft prompt." : "",
    ...userConstraints,
    ...baseline
  ]).join(" ");
}

function isFinalizedImagePrompt(value = "") {
  const text = cleanText(value);
  return text.includes("Prompt priority order:") || text.includes("Global baseline constraints:");
}

function normalizeFinalizedImagePrompt(value = "") {
  return uniqueStrings(splitPromptSentences(value)).join(" ");
}

function buildUserInstructionConstraintsEn({ mainImagePlan = "", operatorNote = "" } = {}) {
  const text = cleanText([mainImagePlan, operatorNote].filter(Boolean).join("。"));
  if (!text) return [];
  const rules = [];
  const protectedElements = extractProtectedElementsFromChineseInstruction(text);
  const editableElements = extractEditableElementsFromChineseInstruction(text);
  if (protectedElements.length) {
    rules.push(`User priority: keep these elements unchanged: ${protectedElements.join(", ")}.`);
    rules.push("Do not replace, translate, repaint, remove, deform, redesign, or obscure the user-protected elements.");
  }
  if (editableElements.length) {
    rules.push(`User priority: only these elements may be adjusted when needed: ${editableElements.join(", ")}.`);
  }
  if (/不要.*中文|不能.*中文|禁止.*中文|无中文|不出现中文|不要出现中文|no chinese/i.test(text)) {
    rules.push("User priority: do not render Chinese text or Chinese characters anywhere in the image.");
  }
  if (/突出产品|产品更突出|主体突出|提升产品|清晰|质感|背景/.test(text)) {
    rules.push("User priority: improve product prominence, clarity, lighting, and background presentation without changing product identity.");
  }
  if (!rules.length && !containsChinese(text)) {
    rules.push(`User priority instruction: ${text}`);
  }
  return rules;
}

function imagePromptPriorityContract() {
  return {
    priority_rules: [
      "If template guidance conflicts with user instructions, follow user instructions.",
      "If template guidance conflicts with recognized product facts, follow recognized product facts.",
      "If draft AI prompt conflicts with global baseline, user instructions, recognized product facts, or template guidance, ignore the conflicting draft prompt part.",
      "Template guidance may control layout, composition, visual hierarchy, and style only; it must not overwrite product material, quantity, shape, size, texture, reflection, highlight, printed marks, or user-protected elements."
    ]
  };
}

function buildImageTemplateGuidance(analysis = {}, fallback = {}) {
  const match = normalizeImageTemplateMatch(analysis.template_match || fallback.templateMatch || inferTemplateMatch(analysis));
  const profile = IMAGE_TEMPLATE_PROFILES[match.layout_key] || IMAGE_TEMPLATE_PROFILES.product_scene;
  return {
    template_key: match.template_key || profile.key,
    layout_key: profile.key,
    confidence: finiteNumber(match.confidence, 0.5),
    reason: cleanText(match.reason || ""),
    rules: profile.rules
  };
}

function normalizeImageTemplateMatch(value = {}) {
  const match = objectValue(value);
  const text = cleanText([
    match.layout_key,
    match.layoutKey,
    match.template_key,
    match.templateKey,
    match.reason
  ].join(" ")).toLowerCase();
  const layoutKey = text.includes("poster") || text.includes("海报") || text.includes("ozon")
    ? "ozon_poster"
    : text.includes("white") || text.includes("clean") || text.includes("白底")
      ? "clean_product"
      : "product_scene";
  return {
    ...match,
    layout_key: cleanKey(match.layout_key || match.layoutKey || layoutKey) || layoutKey,
    template_key: cleanKey(match.template_key || match.templateKey || match.key || layoutKey) || layoutKey,
    confidence: finiteNumber(match.confidence, 0.5),
    reason: cleanText(match.reason || "")
  };
}

function normalizeTemplateGuidanceRules(guidance = null) {
  const object = objectValue(guidance);
  const rules = normalizeImageRuleList(object.rules || object.template_rules || object.layout_rules || guidance);
  return rules.filter((rule) => !templateRuleLooksLikeProductFact(rule));
}

function templateRuleLooksLikeProductFact(rule = "") {
  const text = cleanText(rule).toLowerCase();
  return /\b(abs|tpu|carbon fiber|vinyl|rubber|metal|leather|4 pcs|2 pcs|glossy black|piano lacquer)\b/.test(text)
    && !/must not|do not let|not overwrite|not change/.test(text);
}

function buildImageProductTruthRules(keepFacts = [], analysis = {}, fallback = {}) {
  const facts = englishImageKeepFacts(keepFacts, analysis, fallback);
  return uniqueStrings([
    ...facts,
    cleanText(analysis.material || fallback.material) && !containsChinese(analysis.material || fallback.material) ? `material: ${cleanText(analysis.material || fallback.material)}` : "",
    cleanText(analysis.color || fallback.color) && !containsChinese(analysis.color || fallback.color) ? `color: ${cleanText(analysis.color || fallback.color)}` : "",
    cleanText(analysis.quantity || fallback.quantity) && !containsChinese(analysis.quantity || fallback.quantity) ? `quantity: ${cleanText(analysis.quantity || fallback.quantity)}` : "",
    "keep recognized product structure, dimensions, curvature, edge shape, thickness, texture, reflection, highlight, material, and quantity unchanged"
  ]).filter(Boolean);
}

function normalizeImageRuleList(value = []) {
  return toArray(value)
    .filter((item) => typeof item === "string" || typeof item === "number")
    .flatMap((item) => typeof item === "string" ? item.split(/\n+/) : [item])
    .map(cleanText)
    .filter(Boolean);
}

function extractProtectedElementsFromChineseInstruction(text = "") {
  const source = cleanText(text);
  const candidates = [
    [/产品主体|主体|产品/g, "physical product body"],
    [/材质|材料/g, "material"],
    [/颜色|色彩/g, "color"],
    [/结构|形状|外形/g, "structure and shape"],
    [/数量|件套|套装/g, "set quantity"],
    [/logo|Logo|LOGO|标识|商标|车标/g, "logo / brand mark"],
    [/贴纸|印刷|图案|文字/g, "sticker printing / printed pattern"],
    [/角度|构图/g, "viewing angle and composition"]
  ];
  return extractInstructionElements(source, candidates, /不变|不要动|别动|保持|保留|不改|不要改|不能改|锁定/);
}

function extractEditableElementsFromChineseInstruction(text = "") {
  const source = cleanText(text);
  const candidates = [
    [/背景|场景/g, "background / scene"],
    [/车牌/g, "license plate text"],
    [/车型|目标车型|可变车型/g, "editable vehicle model cues"],
    [/光线|灯光/g, "lighting"],
    [/氛围|风格/g, "visual atmosphere"],
    [/标题|大字|文案/g, "large editable display text"]
  ];
  return extractInstructionElements(source, candidates, /可以|可|只|调整|替换|改|变化|优化|突出/);
}

function extractInstructionElements(text, candidates, actionPattern) {
  const result = [];
  for (const [pattern, label] of candidates) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const start = Math.max(0, match.index - 16);
      const end = Math.min(text.length, match.index + match[0].length + 16);
      const context = text.slice(start, end);
      if (actionPattern.test(context)) result.push(label);
    }
  }
  return uniqueStrings(result);
}

function appendImagePromptSafetyRules(prompt, source, target, operatorNote = "", imageEditContract = null) {
  const preserveLogo = shouldPreserveProductLogo(operatorNote, imageEditContract?.variant_type || imageEditContract?.variantType);
  const contractPrompt = buildImageEditContractPrompt(imageEditContract);
  const cleanedPrompt = cleanText(prompt);
  const shouldPrependContract = contractPrompt && !cleanedPrompt.includes(contractPrompt);
  return uniqueStrings([
    shouldPrependContract ? contractPrompt : "",
    cleanedPrompt,
    "Do not render Chinese text, Chinese characters, random text, or invented words anywhere in the image.",
    "Do not add new English descriptions, slogans, feature labels, decorative words, random letters, or invented words.",
    "Preserve existing non-variant selling-point text blocks, feature icons, pictograms, badges, labels, arrows, dividers, decorative modules, and the large title area.",
    "Do not crop, zoom in, cut off, stretch, or reframe the original ecommerce composition.",
    "If a large title exists in the source image, do not remove, shrink, hide, crop, or cover that title area.",
    target ? `Only allowed new readable target text: ${target}.` : "",
    preserveLogo ? "Hard constraint: keep product sticker logos, decals, brand marks, and printed marks pixel-level unchanged." : "",
    preserveLogo ? "Do not replace, translate, repaint, remove, or redesign protected product marks." : "",
    preserveLogo ? `Express ${target} through editable background/context cues only; do not change protected printing on the product.` : "",
    !preserveLogo && source ? `Remove visible source value ${source} only from contract-approved editable zones.` : ""
  ]).join(" ");
}

function englishImageKeepFacts(keepFacts = [], analysis = {}, fallback = {}) {
  const facts = [];
  const productType = cleanText(analysis.product_type || fallback.productType || "");
  if (productType && !containsChinese(productType)) facts.push(`product type: ${productType}`);
  if (isSillPlateProduct(analysis, fallback)) facts.push("car door sill protector / sill plate product");
  const material = cleanText(analysis.material || analysis.material_zh || fallback.material || "");
  if (material && !containsChinese(material)) facts.push(`material: ${material}`);
  const color = cleanText(analysis.color || analysis.color_zh || fallback.color || "");
  if (color && !containsChinese(color)) facts.push(`color: ${color}`);
  const quantity = cleanText(analysis.quantity || fallback.quantity || "");
  if (quantity && !containsChinese(quantity)) facts.push(`set quantity: ${quantity}`);
  for (const fact of toArray(keepFacts)) {
    const english = translateImageFactToEnglish(fact);
    if (english) facts.push(english);
  }
  return uniqueStrings(facts).slice(0, 8);
}

function translateImageFactToEnglish(value = "") {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = cleanText(value);
  if (!text) return "";
  if (!containsChinese(text)) return text;
  const facts = [];
  if (/防踢垫|座椅靠背保护|靠背防护|收纳挂袋/.test(text)) facts.push("car seat back protector / kick mat organizer");
  if (isAffirmedSillPlateFact(text)) facts.push("car door sill protector / sill plate product");
  if (/碳纤维|碳纖維/.test(text)) facts.push("carbon fiber texture");
  if (/黑|灰/.test(text)) facts.push("black and dark gray color scheme");
  if (/白色|白线|白色线条/.test(text)) facts.push("white line accents");
  if (/长条|条形/.test(text)) facts.push("long strip sticker shape");
  if (/4件|四件|4\s*pcs|4\s*piece/i.test(text)) facts.push("four-piece set");
  if (/车门/.test(text) || isAffirmedSillPlateFact(text)) facts.push("intended for car door sill threshold area");
  if (/材质|材料/.test(text) && !facts.some((item) => item.includes("texture"))) facts.push("material and texture must remain unchanged");
  return uniqueStrings(facts).join("; ");
}

function buildFallbackImagePrompt(source, target, keepFacts, analysis = {}, fallback = {}) {
  const operatorNote = cleanText(fallback.operatorNote || fallback.operator_note || "");
  const preserveLogo = shouldPreserveProductLogo(operatorNote, fallback.variantType || fallback.variant_type || fallback.imageEditContract?.variant_type || fallback.image_edit_contract?.variant_type);
  const imageEditContract = nonEmptyObjectValue(fallback.imageEditContract || fallback.image_edit_contract) || buildImageEditContract({
    variantType: fallback.variantType || fallback.variant_type,
    source,
    target,
    keepFacts,
    analysis,
    fallback
  });
  const contractPrompt = buildImageEditContractPrompt(imageEditContract);
  const stableFacts = englishImageKeepFacts(keepFacts, analysis, fallback);
  return [
    contractPrompt || "Edit the product main image for an ecommerce automotive accessory listing.",
    !contractPrompt && preserveLogo
      ? "Keep every product sticker logo, decal, brand mark, and printed mark exactly unchanged."
      : (!contractPrompt ? `Replace visible ${source || "source vehicle model"} text only in editable model text, large title text, license plates, or background vehicle cues with ${target}.` : ""),
    "Keep the physical product body unchanged.",
    "Preserve the original ecommerce layout modules, including existing title blocks, selling-point copy blocks, icons, pictograms, labels, badges, arrows, dividers, decorative shapes, margins, and spacing.",
    "Do not crop, zoom in, cut off, stretch, or reframe the original canvas.",
    stableFacts.length ? `Keep these stable facts: ${stableFacts.join("; ")}.` : "",
    !contractPrompt && (preserveLogo ? `Update only the background/context vehicle cues to fit ${target}.` : "Update the background vehicle cues and editable large title/model text to match the target variant."),
    "Keep the layout, realistic texture, product structure, material facts, quantity facts, and intended use unchanged.",
    "Do not add new English descriptions, slogans, feature labels, decorative words, random letters, or invented words.",
    target ? `Only allowed new readable target text: ${target}.` : "",
    "No Chinese text. No Chinese characters. No random text. No invented words."
  ].filter(Boolean).join(" ");
}

function buildCopyContract(plan, analysis, body = {}) {
  const target = cleanText(plan.target_variant_value || body.targetVariantValue || body.target_model || "");
  const source = cleanText(plan.source_variant_value || body.sourceVariantValue || body.source_model || "");
  const productSubject = productSubjectRu(analysis, { productSubjectRu: body.productSubject });
  const material = cleanText(analysis.material || body.material || "");
  const color = cleanText(analysis.color || body.color || "");
  const quantity = cleanText(analysis.quantity || body.quantity || "");
  const productFactContract = buildProductFactContract(analysis, { ...body, targetVariantValue: target, sourceVariantValue: source });
  const productDna = buildCopyProductDna(analysis, { ...body, targetVariantValue: target, sourceVariantValue: source });
  const operatorInstructions = body.operatorInstructions || parseOperatorInstructions(body.operatorNote || body.operator_note || "");
  return {
    language: "ru",
    source_priority: [
      "Main image recognition facts are authoritative.",
      "Variant target changes only the configured variant value.",
      "Template copy is style guidance only and must not override product facts.",
      "Source title, tags, and description may be stale or copied from another product."
    ],
    product_fact_contract: productFactContract,
    product_dna: productDna,
    product_subject_ru: productSubject,
    target_variant_value: target,
    source_variant_value: source,
    operator_instructions: operatorInstructions,
    generation_scope: operatorInstructions.copy_generation_scope,
    preserve_facts: [
      productSubject,
      material ? `material: ${material}` : "",
      color ? `color: ${color}` : "",
      quantity ? `quantity: ${quantity}` : ""
    ].filter(Boolean),
    replace_rules: [
      source && target ? `Replace all ${source} references with ${target}.` : "",
      "Do not mention the source variant in title, tags, description, or rich content.",
      "Keep product subject, material, color, quantity, structure, and intended use consistent with the main image.",
      "If template fields conflict with main-image facts, ignore the template product wording.",
      "Do not include marketplace names, platform-sensitive words, fake official authorization, fake certification, unsupported warranty, or exaggerated claims."
    ].filter(Boolean),
    title_prompt_ru: `Write a Russian marketplace title around the recognized product DNA: ${productSubject}${target ? ` for ${target}` : ""}${productDna.materialTitle ? `, ${productDna.materialTitle}` : ""}. Keep material, color, quantity, and product type factual. Do not mention ${source || "the source model"}.`,
    tags_prompt_ru: `Generate concise Russian search tags around recognized product DNA: ${productSubject}${target ? ` ${target}` : ""}. Include only product facts from the main image, target variant, and product DNA tags.`,
    description_prompt_ru: "Write a Russian product description around the recognized product DNA and main-image facts. Template details are supplemental only. Do not include marketplace names or invent certification, exact dimensions, official authorization, warranty, or unsupported compatibility.",
    rich_content_prompt_ru: "Generate compact Russian rich-content section copy based on the final main image: product type, protection benefit, material/finish, set count, and target vehicle/model if present."
  };
}

function buildProductFactContract(analysis = {}, body = {}) {
  const gatedAnalysis = applyProductFactGate(analysis);
  const productSubject = productSubjectRu(gatedAnalysis, { productSubjectRu: body.productSubject });
  const material = confirmedFactText(gatedAnalysis.material || body.material || "");
  const color = confirmedFactText(gatedAnalysis.color || body.color || "");
  const quantity = confirmedFactText(gatedAnalysis.quantity || body.quantity || "");
  const keepFacts = uniqueStrings([
    productSubject,
    ...toArray(gatedAnalysis.keep_facts),
    material ? `material: ${material}` : "",
    color ? `color: ${color}` : "",
    quantity ? `quantity: ${quantity}` : ""
  ].filter(Boolean));
  const variableFacts = uniqueStrings([
    cleanText(body.sourceVariantValue || body.source_variant_value || analysis.source_variant_value || ""),
    cleanText(body.targetVariantValue || body.target_variant_value || ""),
    ...toArray(gatedAnalysis.changeable_facts)
  ].filter(Boolean));
  const productDna = buildCopyProductDna(gatedAnalysis, body);
  return {
    authority: "main_image_recognition",
    product_subject_ru: productSubject,
    product_type: confirmedFactText(gatedAnalysis.product_type || body.productType || ""),
    material,
    color,
    quantity,
    stable_facts: keepFacts,
    copy_product_dna: productDna,
    variable_facts: variableFacts,
    forbidden_changes: uniqueStrings([
      "Do not change product subject.",
      "Do not change material, color, quantity, structure, or intended use unless the operator explicitly edits the facts.",
      "Do not let template title, tags, or description override main-image recognition facts.",
      "Do not include marketplace names, platform-sensitive words, fake official authorization, fake certification, unsupported warranty, or exaggerated claims.",
      ...toArray(gatedAnalysis.forbidden_changes)
    ]),
    unknown_facts: toArray(gatedAnalysis.unknown_facts)
  };
}

function inferTemplateMatch(analysis = {}) {
  const text = JSON.stringify(analysis).toLowerCase();
  const isPoster = /(poster|banner|layout|text_blocks|visible_texts|selling|badge|headline|комплект|шт|защита|海报|卖点|标题|尺寸)/i.test(text);
  const isClean = /(white background|clean background|studio|白底|干净)/i.test(text);
  const isSillPlate = /(sill|threshold|порог|накладк|door)/i.test(text);
  const hasVehicle = /(tenet|t4|t7|car|vehicle|model|авто|машин)/i.test(text);
  const layoutKey = isPoster ? "ozon_poster" : (isClean ? "clean_product" : "product_scene");
  return {
    template_key: isSillPlate ? SILL_PLATE_TEMPLATE_KEY : DEFAULT_TEMPLATE_KEY,
    layout_key: layoutKey,
    confidence: isSillPlate && hasVehicle ? (isPoster ? 0.9 : 0.86) : (isPoster ? 0.74 : 0.62),
    reason: isPoster
      ? "Detected ecommerce poster-style visual structure; use template as layout guidance only."
      : isSillPlate
        ? "Detected car sill plate / door threshold protector pattern."
        : "No specialized product template matched with high confidence."
  };
}

function imagePromptPreflight(prompt, plan, analysis) {
  const source = cleanText(plan.source_variant_value || analysis.source_variant_value || "");
  const target = cleanText(plan.target_variant_value || "");
  const warnings = [];
  if (source && !prompt.toLowerCase().includes(source.toLowerCase())) warnings.push("source variant is not named in prompt");
  if (target && !prompt.toLowerCase().includes(target.toLowerCase())) warnings.push("target variant is not named in prompt");
  if (!/keep|unchanged|preserve/i.test(prompt)) warnings.push("prompt does not explicitly preserve product facts");
  return {
    pass: warnings.length === 0,
    warnings
  };
}

async function resolveOrCreateAnalysis(body = {}, session = {}) {
  if (body.analysis && typeof body.analysis === "object") {
    return { analysis: body.analysis, analysis_no: cleanText(body.analysisNo || body.analysis_no || "") };
  }
  if (body.analysisNo || body.analysis_no) {
    return { analysis: await resolveAnalysis(body), analysis_no: cleanText(body.analysisNo || body.analysis_no || "") };
  }
  if (body.imageDataUrl || body.image_data_url || body.imageUrl || body.image_url || body.sourceImageUrl || body.source_image_url || body.imagePath || body.image_path) {
    const result = await aiVariantLabAnalyzeImage({
      ...body,
      businessMode: body.businessMode || body.business_mode || "vehicle_model_variant"
    }, session);
    return { analysis: result.analysis, analysis_no: result.analysis_no, usage: result.usage };
  }
  throw statusError("analysis, analysisNo, or source image is required", 400);
}

async function replaceBatchItems(jobNo, items) {
  await mysqlExecute("DELETE FROM ai_variant_lab_batch_items WHERE job_no = ?", [jobNo]);
  for (let offset = 0; offset < items.length; offset += 50) {
    const chunk = items.slice(offset, offset + 50);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    await mysqlExecute(`
      INSERT INTO ai_variant_lab_batch_items
      (item_no, job_no, target_variant_value, status, plan_no, item_json, sort_order)
      VALUES ${placeholders}
    `, chunk.flatMap((item) => [
        item.item_no,
        jobNo,
        item.target_variant_value,
        "planned",
        "",
        JSON.stringify(item),
        item.sort_order || 0
      ]));
  }
}

async function summarizeBatchJob(jobNo) {
  const rows = await mysqlQuery(`
    SELECT status, COUNT(*) AS count
    FROM ai_variant_lab_batch_items
    WHERE job_no = ?
    GROUP BY status
  `, [jobNo]);
  const summary = { total: 0, planned: 0, queued: 0, generating: 0, providerPending: 0, done: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    const count = Number(row.count || 0);
    summary.total += count;
    if (row.status === "planned") summary.planned += count;
    if (row.status === "queued_image") summary.queued += count;
    if (row.status === "generating_image") summary.generating += count;
    if (row.status === "provider_pending") summary.providerPending += count;
    if (row.status === "image_done") summary.done += count;
    if (row.status === "failed") summary.failed += count;
  }
  summary.pending = summary.total - summary.done - summary.failed;
  return summary;
}

async function recoverStaleBatchImageJobs() {
  const rows = await mysqlQuery(`
    SELECT job_no
    FROM ai_variant_lab_batch_jobs
    WHERE status IN ('generating_images', 'partially_generated')
      AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
    ORDER BY updated_at ASC
    LIMIT 20
  `, [staleImageJobSeconds()]);
  for (const row of rows) {
    await recoverStaleBatchImageJob(row.job_no);
  }
}

async function recoverStaleBatchImageJob(jobNo) {
  const key = cleanText(jobNo || "");
  if (!key) return;
  const staleMessage = "图片任务因服务重启或进程中断，已恢复排队；若服务商已有结果，将继续使用原任务号拉回，不会重复提交。";
  const result = await mysqlExecute(`
    UPDATE ai_variant_lab_batch_items
    SET status = 'queued_image',
        error_message = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ?
      AND status IN ('generating_image', 'provider_pending')
      AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)
  `, [staleMessage, key, staleImageJobSeconds()]);
  if (!result.affectedRows) {
    const summary = await summarizeBatchJob(key);
    if (summary.generating > 0) {
      const existingRows = await mysqlQuery("SELECT result_json FROM ai_variant_lab_batch_jobs WHERE job_no = ? LIMIT 1", [key]);
      const existingResult = parseStoredJson(existingRows[0]?.result_json, {});
      await mysqlExecute(`
        UPDATE ai_variant_lab_batch_jobs
        SET status = ?,
            result_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_no = ? AND status <> ?
      `, [
        "generating_images",
        JSON.stringify({
          ...existingResult,
          summary,
          status_corrected_at: new Date().toISOString()
        }),
        key,
        "generating_images"
      ]);
    }
    return;
  }
  const summary = await summarizeBatchJob(key);
  const existingRows = await mysqlQuery("SELECT result_json FROM ai_variant_lab_batch_jobs WHERE job_no = ? LIMIT 1", [key]);
  const existingResult = parseStoredJson(existingRows[0]?.result_json, {});
  const finalStatus = summary.pending > 0
    ? "generating_images"
    : summary.failed > 0
    ? (summary.done > 0 ? "partially_failed" : "failed")
    : "image_done";
  await mysqlExecute(`
    UPDATE ai_variant_lab_batch_jobs
    SET status = ?,
        result_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE job_no = ?
  `, [
    finalStatus,
    JSON.stringify({
      ...existingResult,
      summary,
      recovered_stale_generating_items: Number(result.affectedRows || 0),
      stale_after_seconds: staleImageJobSeconds(),
      recovered_at: new Date().toISOString()
    }),
    key
  ]);
}

function staleImageJobSeconds() {
  return Math.ceil(AI_VARIANT_IMAGE_TIMEOUT_MS / 1000) + 90;
}

export async function recoverAiVariantLabImageBatchesOnStartup() {
  await ensureAiVariantLabSchema();
  await mysqlExecute(`
    UPDATE ai_variant_lab_batch_items
    SET status = 'queued_image',
        error_message = '服务重启后已恢复排队，将优先使用已保存的服务商任务号继续拉回图片',
        updated_at = CURRENT_TIMESTAMP
    WHERE status IN ('generating_image', 'provider_pending')
  `);
  const rows = await mysqlQuery(`
    SELECT job_no, result_json, image_concurrency, created_by_person_id
    FROM ai_variant_lab_batch_jobs
    WHERE status = 'generating_images'
    ORDER BY updated_at ASC
    LIMIT 50
  `);
  let resumed = 0;
  for (const row of rows) {
    const result = parseStoredJson(row.result_json, {});
    const sourceImageUrl = cleanText(result.source_image_url || "");
    if (!sourceImageUrl) continue;
    if (startBatchImageBackgroundJob(row.job_no, {
      sourceImageUrl,
      ratio: result.ratio || "3:4",
      autoCrop: result.auto_crop === true,
      imageConcurrency: positiveInteger(row.image_concurrency || result.effective_image_concurrency || 4, 4),
      sessionPersonId: Number(row.created_by_person_id || 0) || null
    })) resumed += 1;
  }
  return { ok: true, resumed };
}

async function resolveOptimizerAnalysis(jobNo) {
  if (!jobNo) throw statusError("jobNo or analysis is required", 400);
  await ensureAiVariantLabSchema();
  const rows = await mysqlQuery("SELECT analysis_json FROM ai_image_optimizer_jobs WHERE job_no = ? LIMIT 1", [jobNo]);
  if (!rows.length) throw statusError(`optimizer job not found: ${jobNo}`, 404);
  return parseStoredJson(rows[0].analysis_json, {});
}

async function resolveOptimizerPlan(jobNo) {
  if (!jobNo) throw statusError("jobNo or plan is required", 400);
  await ensureAiVariantLabSchema();
  const rows = await mysqlQuery("SELECT plan_json FROM ai_image_optimizer_jobs WHERE job_no = ? LIMIT 1", [jobNo]);
  if (!rows.length) throw statusError(`optimizer job not found: ${jobNo}`, 404);
  return parseStoredJson(rows[0].plan_json, {});
}

function optimizerPromptPreflight(prompt, plan) {
  const warnings = [];
  if (!/keep|preserve|same|unchanged/i.test(prompt)) warnings.push("prompt does not explicitly preserve product identity");
  if (!/improve|optimi[sz]e|clear|readable|quality|hierarchy/i.test(prompt)) warnings.push("prompt does not clearly state optimization goals");
  if (!toArray(plan.forbidden_changes).length) warnings.push("forbidden changes are missing");
  return { pass: warnings.length === 0, warnings };
}

function normalizeTargetValues(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、/|]+/);
  const seen = new Set();
  const targets = [];
  for (const item of list) {
    const text = cleanText(typeof item === "object" ? item.targetVariantValue || item.target_variant_value || item.model || item.value : item);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    targets.push(text);
  }
  return targets.slice(0, 100);
}

function normalizeBudget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Number(number.toFixed(4)) : null;
}

function estimateTextCostCny(usage) {
  const prompt = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const completion = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  const inputRate = 0.375;
  const outputRate = 2.25;
  return Number(((prompt / 1_000_000) * inputRate + (completion / 1_000_000) * outputRate).toFixed(6));
}

function buildTemplateFromBody(body) {
  return {
    category_key: cleanKey(body.categoryKey || body.category_key || DEFAULT_TEMPLATE_KEY),
    fingerprint: body.fingerprint || {},
    prompt_set: body.promptSet || body.prompt_set || {},
    quality_checks: body.qualityChecks || body.quality_checks || [],
    copy_contract: body.copyContract || body.copy_contract || null
  };
}

function buildVariantCaseFromBody(body) {
  const supplied = objectValue(body.case || body.case_json);
  const sampleRows = arrayValue(body.sampleRows || body.sample_rows);
  const firstSample = objectValue(sampleRows[0]);
  const listingTemplateSnapshot = objectValue(
    supplied.listing_template_snapshot
    || body.listingTemplateSnapshot
    || body.listing_template_snapshot
  );
  const productFacts = objectValue(supplied.product_facts || body.productFacts || body.product_facts);
  const variantContract = objectValue(supplied.variant_contract || body.variantContract || body.variant_contract);
  const sourceTrace = objectValue(supplied.source_trace || body.sourceTrace || body.source_trace);
  const sampleOutputs = objectValue(supplied.sample_outputs || body.sampleOutputs || body.sample_outputs);
  const sampleAssets = objectValue(supplied.sample_assets || body.sampleAssets || body.sample_assets);
  return {
    ...supplied,
    case_no: cleanText(supplied.case_no || body.caseNo || body.case_no || ""),
    case_name: cleanText(supplied.case_name || body.caseName || body.case_name || ""),
    product_subject_key: cleanKey(supplied.product_subject_key || body.productSubjectKey || body.product_subject_key || productFacts.product_type || ""),
    product_subject_name: cleanText(supplied.product_subject_name || body.productSubjectName || body.product_subject_name || productFacts.product_type || ""),
    variant_type: cleanText(supplied.variant_type || body.variantType || body.variant_type || variantContract.variant_type || ""),
    variable_slot: cleanText(supplied.variable_slot || body.variableSlot || body.variable_slot || variantContract.variable_slot || ""),
    source_value: cleanText(supplied.source_value || body.sourceValue || body.source_value || variantContract.source_value || ""),
    success_target_value: cleanText(
      supplied.success_target_value
      || body.successTargetValue
      || body.success_target_value
      || firstSample.target_variant_value
      || variantContract.success_target_value
      || ""
    ),
    status: cleanText(supplied.status || body.status || "active"),
    product_facts: productFacts,
    variant_contract: variantContract,
    listing_template_snapshot: listingTemplateSnapshot,
    source_trace: sourceTrace,
    sample_outputs: sampleOutputs,
    sample_assets: sampleAssets,
    sample_rows: sampleRows,
    saved_from: cleanText(body.savedFrom || body.saved_from || supplied.saved_from || "ai_variant_lab"),
    saved_at: supplied.saved_at || new Date().toISOString()
  };
}

function parseJsonObject(text, fallback) {
  if (typeof text !== "string") return text && typeof text === "object" ? text : fallback;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(JSON_OBJECT_RE);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }
}

function parseStoredJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const next = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    next.push(text);
  }
  return next;
}

function containsChinese(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyObjectValue(value) {
  const object = objectValue(value);
  return Object.keys(object).length ? object : null;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 128);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, number);
}

function personId(session) {
  const id = Number(session?.personId || session?.person_id || session || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function makeNo(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}
