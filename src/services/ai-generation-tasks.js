import { createHash, randomUUID } from "node:crypto";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { ensureAssetVariantImagePublishUrl, generateAssetVariantVideoFromImage, generateListingVariantMediaFromImage } from "./asset-variant-engine.js";
import { generateDeepSeekListingContent } from "./listing-automation.js";
import { generateCommerceCopy, generateImages } from "../server/services/ai/aiWorkflowService.js";
import { broadcastGlobalEvent } from "../server/notifications.js";
import { aiImageRuntimePoolConfig } from "./ai-provider-settings.js";
import { adaptiveAiImageConcurrency } from "./ai-image-runtime-limiter.js";

const SUPPORTED_FIELDS = new Set(["mainImage", "detailImages", "title", "tags", "description", "richText", "video", "commerceCopy"]);
const MAX_TASK_INPUT_JSON_BYTES = 220_000;
const MAX_TASK_TEXT_BYTES = 24_000;
const WORKER_LIMITS = {
  title: 3,
  tags: 3,
  description: 3,
  richText: 3,
  video: 1
};
const IMAGE_FIELDS = new Set(["mainImage", "detailImages"]);
const AI_IMAGE_TASK_CONCURRENCY_CAP = Math.max(1, Number(process.env.AI_IMAGE_TASK_CONCURRENCY_CAP || 6));
const AI_PROVIDER_REPOLL_DELAY_SECONDS = Math.max(5, Number(process.env.AI_PROVIDER_REPOLL_DELAY_SECONDS || 30));
let imageWorkerLimitCache = { value: 3, expiresAt: 0 };

const VEHICLE_BRANDS = [
  "TENET",
  "HAVAL",
  "BELGEE",
  "CHERY",
  "TIGGO",
  "GEELY",
  "OMODA",
  "JAECOO",
  "EXEED",
  "CHANGAN",
  "CHERY TIGGO"
];

let schemaReady = false;
let workerStarted = false;
let workerTimer = null;
const activeByField = new Map();

export async function ensureAiGenerationTaskSchema() {
  if (schemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_generation_tasks (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      task_no VARCHAR(64) NOT NULL,
      source_module VARCHAR(64) NOT NULL DEFAULT '',
      workflow_id VARCHAR(128) NOT NULL DEFAULT '',
      result_id VARCHAR(128) NOT NULL DEFAULT '',
      source_batch_id VARCHAR(128) NOT NULL DEFAULT '',
      source_product_id VARCHAR(128) NOT NULL DEFAULT '',
      field_key VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      priority INT NOT NULL DEFAULT 0,
      input_json LONGTEXT NULL,
      output_json LONGTEXT NULL,
      error_json LONGTEXT NULL,
      provider_job_json LONGTEXT NULL,
      depends_on_task_ids VARCHAR(500) NOT NULL DEFAULT '',
      attempts INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 2,
      created_by_person_id BIGINT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_generation_task_no (task_no),
      INDEX idx_ai_generation_tasks_workflow (workflow_id, result_id),
      INDEX idx_ai_generation_tasks_status (status, priority, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  const providerJobColumns = await mysqlQuery("SHOW COLUMNS FROM ai_generation_tasks LIKE 'provider_job_json'");
  if (!providerJobColumns.length) await mysqlExecute("ALTER TABLE ai_generation_tasks ADD COLUMN provider_job_json LONGTEXT NULL AFTER error_json");
  schemaReady = true;
}

export async function createAiGenerationTasks(body = {}, session = null) {
  await ensureAiGenerationTaskSchema();
  startAiGenerationTaskWorker();
  const tasks = normalizeTaskPayloads(body);
  if (!tasks.length) {
    const error = new Error("请至少提交一个生成任务");
    error.status = 400;
    throw error;
  }
  const created = [];
  for (const task of tasks) {
    const fieldKey = cleanText(task.fieldKey || task.field_key || body.fieldKey || body.field_key);
    if (!SUPPORTED_FIELDS.has(fieldKey)) {
      const error = new Error(`暂不支持的生成字段：${fieldKey || "-"}`);
      error.status = 400;
      throw error;
    }
    const input = {
      ...(body.input || {}),
      ...(task.input || {}),
      row: task.row || body.row || body.currentRow || null,
      asset: task.asset || body.asset || null
    };
    const compactInput = compactAiGenerationTaskInput(input, fieldKey);
    const taskNo = buildTaskNo(fieldKey, task, compactInput);
    await mysqlExecute(`
      INSERT INTO ai_generation_tasks
        (task_no, source_module, workflow_id, result_id, source_batch_id, source_product_id, field_key, status, priority, input_json, depends_on_task_ids, max_attempts, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `, [
      taskNo,
      cleanText(task.sourceModule || task.source_module || body.sourceModule || body.source_module || "ai_generation"),
      cleanText(task.workflowId || task.workflow_id || body.workflowId || body.workflow_id || ""),
      cleanText(task.resultId || task.result_id || body.resultId || body.result_id || ""),
      cleanText(task.sourceBatchId || task.source_batch_id || body.sourceBatchId || body.source_batch_id || ""),
      cleanText(task.sourceProductId || task.source_product_id || body.sourceProductId || body.source_product_id || ""),
      fieldKey,
      Number(task.priority ?? body.priority ?? 0) || 0,
      JSON.stringify(compactInput),
      normalizeDependsOn(task.dependsOnTaskIds || task.depends_on_task_ids || body.dependsOnTaskIds || body.depends_on_task_ids),
      Math.max(1, Math.min(5, Number(task.maxAttempts || task.max_attempts || body.maxAttempts || body.max_attempts || 2) || 2)),
      Number(session?.personId || session?.id || 0) || null
    ]);
    const rows = await mysqlQuery("SELECT * FROM ai_generation_tasks WHERE task_no = ? LIMIT 1", [taskNo]);
    created.push(mapTaskRow(rows[0]));
  }
  scheduleWorkerTick(10);
  return { ok: true, tasks: created, taskIds: created.map((task) => task.taskId), taskId: created[0]?.taskId || "" };
}

export async function aiGenerationTasks(query = {}, session = null) {
  await ensureAiGenerationTaskSchema();
  startAiGenerationTaskWorker();
  const filters = [];
  const params = [];
  const currentPersonId = Number(session?.personId || session?.id || 0) || 0;
  if (currentPersonId) {
    filters.push("created_by_person_id = ?");
    params.push(currentPersonId);
  }
  const taskIds = parseCsv(query.taskIds || query.task_ids || query.id || query.ids);
  if (taskIds.length) {
    filters.push(`task_no IN (${taskIds.map(() => "?").join(",")})`);
    params.push(...taskIds);
  }
  for (const [key, column] of [
    ["workflowId", "workflow_id"],
    ["resultId", "result_id"],
    ["sourceBatchId", "source_batch_id"],
    ["sourceProductId", "source_product_id"],
    ["fieldKey", "field_key"],
    ["status", "status"]
  ]) {
    const value = cleanText(query[key] || query[toSnake(key)]);
    if (value) {
      filters.push(`${column} = ?`);
      params.push(value);
    }
  }
  const limit = Math.max(1, Math.min(200, Number(query.limit || 50) || 50));
  const includePayload = String(query.includePayload || query.include_payload || "").toLowerCase() === "1"
    || String(query.includePayload || query.include_payload || "").toLowerCase() === "true"
    || taskIds.length > 0;
  const rows = await mysqlQuery(`
    SELECT id, task_no, source_module, workflow_id, result_id, source_batch_id, source_product_id,
      field_key, status, priority, depends_on_task_ids, attempts, max_attempts, created_by_person_id,
      started_at, finished_at, created_at, updated_at${includePayload ? ", input_json, output_json, error_json, provider_job_json" : ""}
    FROM ai_generation_tasks
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `, params);
  return rows.map((row) => mapTaskRow(row, { includePayload }));
}

export async function cleanupAiGenerationTaskHistory(options = {}) {
  await ensureAiGenerationTaskSchema();
  const retentionDays = Math.max(1, Math.min(365, Number(options.retentionDays || options.retention_days || 30) || 30));
  const batchSize = Math.max(100, Math.min(5000, Number(options.batchSize || options.batch_size || 1000) || 1000));
  let deleted = 0;
  while (true) {
    const result = await mysqlExecute(`
      DELETE FROM ai_generation_tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND COALESCE(finished_at, updated_at, created_at) < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
      LIMIT ${batchSize}
    `, [retentionDays]);
    const affected = Number(result?.affectedRows || 0);
    deleted += affected;
    if (affected < batchSize) break;
  }
  return { ok: true, retentionDays, deleted };
}

export async function retryAiGenerationTask(taskId, session = null) {
  await ensureAiGenerationTaskSchema();
  const taskNo = cleanText(taskId);
  if (!taskNo) {
    const error = new Error("缺少任务ID");
    error.status = 400;
    throw error;
  }
  const currentPersonId = Number(session?.personId || session?.id || 0) || 0;
  const ownershipSql = currentPersonId ? " AND created_by_person_id = ?" : "";
  const ownershipParams = currentPersonId ? [currentPersonId] : [];
  await mysqlExecute(`
    UPDATE ai_generation_tasks
    SET status = 'queued', error_json = NULL, output_json = NULL, started_at = NULL, finished_at = NULL
    WHERE task_no = ? AND status IN ('failed', 'cancelled', 'provider_pending')${ownershipSql}
  `, [taskNo, ...ownershipParams]);
  startAiGenerationTaskWorker();
  scheduleWorkerTick(10);
  const rows = await mysqlQuery(`SELECT * FROM ai_generation_tasks WHERE task_no = ?${ownershipSql} LIMIT 1`, [taskNo, ...ownershipParams]);
  return { ok: true, task: mapTaskRow(rows[0]) };
}

export async function recoverAiGenerationTasksOnStartup() {
  await ensureAiGenerationTaskSchema();
  await mysqlExecute("UPDATE ai_generation_tasks SET status = 'queued', started_at = NULL WHERE status IN ('running', 'provider_pending')");
  startAiGenerationTaskWorker();
  scheduleWorkerTick(100);
  return { ok: true };
}

export function startAiGenerationTaskWorker() {
  if (workerStarted) return;
  workerStarted = true;
  scheduleWorkerTick(100);
}

function scheduleWorkerTick(delay = 1000) {
  if (workerTimer) return;
  workerTimer = setTimeout(async () => {
    workerTimer = null;
    try {
      await processQueuedTasks();
    } catch (error) {
      console.warn("[ai-generation-task] worker tick failed", error);
    } finally {
      if (workerStarted) scheduleWorkerTick(1500);
    }
  }, delay);
  workerTimer.unref?.();
}

async function processQueuedTasks() {
  await ensureAiGenerationTaskSchema();
  const imageLimit = adaptiveAiImageConcurrency(await resolveImageWorkerLimit());
  const activeImages = Array.from(IMAGE_FIELDS).reduce((sum, key) => sum + (activeByField.get(key) || 0), 0);
  const imageSlots = Math.max(0, imageLimit - activeImages);
  if (imageSlots) {
    const imageRows = await mysqlQuery(`
      SELECT * FROM ai_generation_tasks
      WHERE status IN ('queued', 'provider_pending')
        AND field_key IN ('mainImage', 'detailImages')
        AND (status = 'queued' OR updated_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${AI_PROVIDER_REPOLL_DELAY_SECONDS} SECOND))
        AND (depends_on_task_ids = '' OR depends_on_task_ids IS NULL)
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ${imageSlots}
    `);
    for (const row of imageRows) void claimAndRunTask(row);
  }
  for (const fieldKey of SUPPORTED_FIELDS) {
    if (IMAGE_FIELDS.has(fieldKey)) continue;
    const active = activeByField.get(fieldKey) || 0;
    const limit = WORKER_LIMITS[fieldKey] || 1;
    const slots = Math.max(0, limit - active);
    if (!slots) continue;
    const rows = await mysqlQuery(`
      SELECT * FROM ai_generation_tasks
      WHERE status = 'queued'
        AND field_key = ?
        AND (depends_on_task_ids = '' OR depends_on_task_ids IS NULL)
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ${slots}
    `, [fieldKey]);
    for (const row of rows) void claimAndRunTask(row);
  }
}

async function resolveImageWorkerLimit() {
  if (imageWorkerLimitCache.expiresAt > Date.now()) return imageWorkerLimitCache.value;
  try {
    const channels = await aiImageRuntimePoolConfig();
    const configured = channels.reduce((sum, channel) => sum + Math.max(1, Number(channel.maxConcurrency || 3)), 0);
    const poolLimit = Math.max(1, Number(channels[0]?.poolMaxConcurrency || configured || 3));
    imageWorkerLimitCache = {
      value: Math.max(1, Math.min(AI_IMAGE_TASK_CONCURRENCY_CAP, configured, poolLimit)),
      expiresAt: Date.now() + 10_000
    };
  } catch {
    imageWorkerLimitCache = { value: Math.min(3, AI_IMAGE_TASK_CONCURRENCY_CAP), expiresAt: Date.now() + 10_000 };
  }
  return imageWorkerLimitCache.value;
}

async function claimAndRunTask(row) {
  const claimed = await mysqlExecute(`
    UPDATE ai_generation_tasks
    SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), error_json = NULL
    WHERE id = ? AND status IN ('queued', 'provider_pending')
  `, [row.id]);
  if (!claimed.affectedRows) return;
  const fieldKey = row.field_key;
  activeByField.set(fieldKey, (activeByField.get(fieldKey) || 0) + 1);
  executeClaimedTask(row)
    .catch((error) => console.warn("[ai-generation-task] task failed", row.task_no, error))
    .finally(() => {
      activeByField.set(fieldKey, Math.max(0, (activeByField.get(fieldKey) || 1) - 1));
      scheduleWorkerTick(10);
    });
}

async function executeClaimedTask(row) {
  const startedAt = Date.now();
  broadcastTaskStatus(row, "running", { queuedMs: elapsedSince(row.created_at) });
  try {
    const input = parseJson(row.input_json, {});
    let providerJobState = parseJson(row.provider_job_json, null);
    const output = await runTaskHandler(row.field_key, {
      ...input,
      providerJob: providerJobState,
      onProviderJob: async (providerJob, index = 0) => {
        const jobs = Array.isArray(providerJobState?.jobs) ? [...providerJobState.jobs] : [];
        jobs[index] = providerJob;
        providerJobState = { jobs };
        return mysqlExecute(
        "UPDATE ai_generation_tasks SET provider_job_json = ? WHERE id = ?",
          [JSON.stringify(providerJobState), row.id]
        );
      }
    });
    await mysqlExecute(`
      UPDATE ai_generation_tasks
      SET status = 'done', output_json = ?, error_json = NULL, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(output || {}), row.id]);
    broadcastTaskStatus(row, "done", { queuedMs: elapsedSince(row.created_at, startedAt), runMs: Date.now() - startedAt });
  } catch (error) {
    const providerPending = error?.code === "provider_pending";
    const failed = !providerPending && Number(row.attempts || 0) + 1 >= Number(row.max_attempts || 0);
    await mysqlExecute(`
      UPDATE ai_generation_tasks
      SET status = CASE WHEN ? = 1 THEN 'provider_pending' WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          error_json = ?,
          finished_at = CASE WHEN ? = 1 THEN NULL WHEN attempts >= max_attempts THEN CURRENT_TIMESTAMP ELSE NULL END
      WHERE id = ?
    `, [providerPending ? 1 : 0, JSON.stringify(normalizeTaskError(error)), providerPending ? 1 : 0, row.id]);
    broadcastTaskStatus(row, providerPending ? "provider_pending" : (failed ? "failed" : "queued"), { queuedMs: elapsedSince(row.created_at, startedAt), runMs: Date.now() - startedAt });
  }
}

function broadcastTaskStatus(row, status, timing = {}) {
  broadcastGlobalEvent("ai-task", {
    taskId: row.task_no || "",
    fieldKey: row.field_key || "",
    status,
    queuedMs: Number(timing.queuedMs || 0),
    runMs: Number(timing.runMs || 0),
    updatedAt: new Date().toISOString()
  }, { personId: row.created_by_person_id });
}

function elapsedSince(value, fallback = Date.now()) {
  const at = new Date(value || "").getTime();
  return Number.isFinite(at) ? Math.max(0, fallback - at) : 0;
}

async function runTaskHandler(fieldKey, input) {
  if (["mainImage", "detailImages"].includes(fieldKey)) {
    const output = await generateImages(input);
    return persistGeneratedImageOutput(output, input, fieldKey);
  }
  if (fieldKey === "commerceCopy") return generateCommerceCopy(input);
  if (["title", "tags", "description"].includes(fieldKey)) return generateTextFieldOutput(fieldKey, input);
  if (fieldKey === "richText") return generateRichTextOutput(input);
  if (fieldKey === "video") {
    const imageUrl = cleanText(input.imageUrl || input.image_url || input.mainImageUrl || input.main_image_url || input.row?.generatedMainImageUrl);
    if (!imageUrl) throw new Error("视频生成缺少新主图，不能使用母素材参考图");
    const videoPayload = {
      imageUrl,
      title: input.title || input.row?.title || input.row?.originalTitle || input.row?.product?.title || input.row?.product?.name,
      productName: input.productName || input.product_name || input.row?.product?.name,
      categoryName: input.categoryName || input.category_name || input.row?.product?.category,
      sourceId: input.sourceId || input.source_id || input.row?.sourceProductId || input.row?.product?.sourceId || input.row?.id
    };
    if (input.listingVariantMedia) return generateListingVariantMediaFromImage(videoPayload);
    const videoResult = await generateAssetVariantVideoFromImage(videoPayload);
    return { video: videoResult?.video || videoResult };
  }
  const error = new Error(`字段 ${fieldKey} 的异步生成处理器尚未接入`);
  error.status = 400;
  throw error;
}

async function persistGeneratedImageOutput(output = {}, input = {}, fieldKey = "mainImage") {
  const context = {
    sourceId: input.sourceId || input.source_id || input.row?.sourceProductId || input.row?.id || "",
    batchId: input.sourceBatchId || input.source_batch_id || input.row?.batchId || input.row?.batch_id || "",
    shopId: input.shopId ?? input.shop_id ?? input.row?.shopId ?? input.row?.shop_id ?? null,
    resultId: input.resultId || input.result_id || input.row?.id || "",
    workflowId: input.workflowId || input.workflow_id || "",
    sourceModule: "ai_product_material_optimizer",
    role: fieldKey === "mainImage" ? "generated_main" : "generated_detail"
  };
  const persist = async (item, index) => {
    const sourceUrl = cleanText(item?.publishUrl || item?.publish_url || item?.url || item?.previewUrl || item?.preview_url);
    if (!sourceUrl) return item;
    const asset = await ensureAssetVariantImagePublishUrl(sourceUrl, { ...context, sortOrder: index + 1 });
    const stableUrl = cleanText(asset.publishUrl || asset.previewUrl || asset.url || sourceUrl);
    return {
      ...item,
      url: stableUrl,
      publishUrl: cleanText(asset.publishUrl || stableUrl),
      previewUrl: cleanText(asset.previewUrl || stableUrl),
      assetId: asset.assetId || null,
      assetStatus: asset.status || ""
    };
  };
  return {
    ...output,
    generatedImages: await Promise.all((output.generatedImages || []).map(persist)),
    croppedImages: await Promise.all((output.croppedImages || []).map(persist))
  };
}

async function generateTextFieldOutput(fieldKey, input = {}) {
  const context = buildTextGenerationContext(fieldKey, input);
  const result = await generateDeepSeekListingContent({
    type: fieldKey,
    context
  });
  const fields = result?.data?.fields || {};
  const content = cleanText(result?.data?.content);
  if (fieldKey === "title") {
    const title = alignVariantTargetText(cleanText(fields.title || fields.content || content), context);
    if (!title) throw new Error("标题生成任务未返回可用内容");
    assertVariantTextMatchesTarget(fieldKey, title, context);
    return {
      title,
      titles: [title],
      provider: result?.provider || "",
      model: result?.model || ""
    };
  }
  if (fieldKey === "tags") {
    const tags = normalizeVariantTags(normalizeTextList(fields.tags || fields.keywords || content), context);
    if (!tags.length) tags.push(...fallbackVariantTags(context));
    if (!tags.length) throw new Error("标签生成任务未返回可用内容");
    assertVariantTextMatchesTarget(fieldKey, tags.join(" "), context);
    return {
      tags,
      keywords: tags,
      provider: result?.provider || "",
      model: result?.model || ""
    };
  }
  let description = alignVariantTargetText(plainDescriptionText(
    fields.summary,
    fields.description,
    fields.content,
    content
  ), context);
  if (hasCjkText(description)) description = "";
  if (!description) description = fallbackVariantDescription(context);
  if (!description) throw new Error("描述生成任务未返回可用内容");
  assertVariantTextMatchesTarget(fieldKey, description, context);
  return {
    description,
    summary: description,
    provider: result?.provider || "",
    model: result?.model || ""
  };
}

function normalizeVariantTags(tags = [], context = {}) {
  const targetModel = cleanText(context.targetModel);
  if (!targetModel) return tags;
  const target = normalizeVehicleText(targetModel);
  const sourceModel = resolveSourceVehicleModel(context);
  const source = normalizeVehicleText(sourceModel);
  const cleaned = normalizeTextList(tags)
    .map((tag) => alignVariantTargetText(tag, context))
    .filter((tag) => {
      const normalized = normalizeVehicleText(tag);
      return !source || source === target || !vehicleTextContainsModel(normalized, source);
    })
    .filter((tag) => {
      const normalized = normalizeVehicleText(tag);
      return !normalized || !target || vehicleTextContainsModel(normalized, target) || !extractVehicleModel(tag);
    });
  if (target && !cleaned.some((tag) => vehicleTextContainsModel(normalizeVehicleText(tag), target))) {
    cleaned.unshift(`#${target}`);
  }
  return cleaned.slice(0, 25);
}

function plainDescriptionText(...values) {
  for (const value of values) {
    const text = unwrapGeneratedText(value, ["summary", "description", "content", "text"], { allowJsonFallback: false });
    if (isPlainDescription(text)) return text;
  }
  return "";
}

function isPlainDescription(value = "") {
  const text = cleanText(value);
  if (!text || text === "{}" || text === "[]") return false;
  if (/^\s*[\[{]/.test(text)) return false;
  if (/"richJson"\s*:|\\?"fields\\?"\s*:|\\?"content\\?"\s*:/.test(text)) return false;
  return true;
}

function fallbackVariantTags(context = {}) {
  const targetModel = cleanText(context.targetModel);
  if (!targetModel) return [];
  const normalizedTarget = normalizeVehicleText(targetModel);
  const category = cleanGeneratedListingText(context.productType || context.categoryName);
  const material = cleanGeneratedListingText(normalizeTextList(context.material)[0] || cleanText(context.material));
  return normalizeVariantTags([
    `#${normalizedTarget}`,
    `#${targetModel.replace(/\s+/g, "_")}`,
    "#накладки_на_пороги",
    "#защита_порогов",
    material ? `#${material.replace(/\s+/g, "_")}` : "",
    category ? "#автоаксессуары" : ""
  ], context);
}

function fallbackVariantDescription(context = {}) {
  const targetModel = cleanText(context.targetModel);
  const material = cleanGeneratedListingText(normalizeTextList(context.material)[0] || cleanText(context.material)) || "нержавеющая сталь";
  const productType = cleanGeneratedListingText(context.productType || context.categoryName) || "автоаксессуар";
  if (!targetModel) return "";
  return cleanText([
    `${productType} для ${targetModel} помогает защитить зону порогов от царапин, потертостей, пыли и следов ежедневного использования.`,
    `Материал ${material} выглядит аккуратно, хорошо сочетается с интерьером автомобиля и подходит для повседневной эксплуатации.`,
    "Комплект помогает сохранить более ухоженный вид салона без лишнего декора и подходит для покупателей, которым важны практичная защита и спокойный внешний вид аксессуара."
  ].join(" "));
}

function cleanGeneratedListingText(value = "") {
  const text = cleanText(value);
  if (!text || hasCjkText(text)) return "";
  return text;
}

function hasCjkText(value = "") {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(value || ""));
}

function alignVariantTargetText(value = "", context = {}) {
  const targetModel = cleanText(context.targetModel);
  if (!targetModel) return cleanText(value);
  let text = cleanText(value);
  if (!text) return "";
  const sourceModel = resolveSourceVehicleModel(context);
  const target = normalizeVehicleText(targetModel);
  const replacements = [
    sourceModel,
    ...extractVehicleModels(text).filter((model) => {
      const normalized = normalizeVehicleText(model);
      return normalized && normalized !== target;
    })
  ].filter(Boolean);
  for (const model of [...new Set(replacements)]) {
    text = replaceVehicleModel(text, model, targetModel);
  }
  return text;
}

function replaceVehicleModel(text = "", fromModel = "", toModel = "") {
  const from = cleanText(fromModel);
  const to = cleanText(toModel);
  if (!from || !to) return cleanText(text);
  const loose = from.replace(/\s+/g, "\\s*");
  return cleanText(text).replace(new RegExp(`(^|[^A-Za-z0-9])(${loose})(?=[^A-Za-z0-9]|$)`, "gi"), `$1${to}`);
}

function assertVariantTextMatchesTarget(fieldKey, output, context = {}) {
  const targetModel = cleanText(context.targetModel);
  if (!targetModel || !["title", "tags", "description", "richText"].includes(fieldKey)) return;
  const text = String(output || "");
  const target = normalizeVehicleText(targetModel);
  const hasTargetModel = target && vehicleTextContainsModelInText(text, target);
  if (target && !hasTargetModel) {
    const error = new Error(`生成结果未匹配目标车型 ${targetModel}，请重试`);
    error.status = 422;
    error.code = "target_model_mismatch";
    throw error;
  }
  const sourceModel = resolveSourceVehicleModel(context);
  const source = normalizeVehicleText(sourceModel);
  const sourceIsTargetPrefix = source && target && target.includes(source);
  if (source && source !== target && vehicleTextContainsModelInText(text, source) && !(hasTargetModel && sourceIsTargetPrefix)) {
    const error = new Error(`生成结果混入母素材车型 ${sourceModel}，请重试`);
    error.status = 422;
    error.code = "source_model_contamination";
    throw error;
  }
  const otherModels = extractVehicleModels(text)
    .map((model) => normalizeVehicleText(model))
    .filter((model) => model && model !== target)
    .filter((model) => !(hasTargetModel && target && target.includes(model)));
  if (otherModels.length) {
    const error = new Error("生成结果混入非目标车型，请重试");
    error.status = 422;
    error.code = "other_model_contamination";
    throw error;
  }
  if (fieldKey === "description" && hasCjkText(text)) {
    const error = new Error("生成描述混入中文，请重试");
    error.status = 422;
    error.code = "description_contains_chinese";
    throw error;
  }
}

function normalizeVehicleText(value = "") {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function vehicleTextContainsModel(normalizedText = "", normalizedModel = "") {
  const text = cleanText(normalizedText);
  const model = cleanText(normalizedModel);
  if (!text || !model) return false;
  const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(model)}([^A-Z0-9]|$)`);
  return pattern.test(` ${text} `);
}

function vehicleTextContainsModelInText(value = "", normalizedModel = "") {
  const model = cleanText(normalizedModel);
  if (!model) return false;
  const tokens = cleanText(value).toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (tokens.includes(model)) return true;
  for (let index = 0; index < tokens.length; index += 1) {
    if (`${tokens[index] || ""}${tokens[index + 1] || ""}` === model) return true;
    if (`${tokens[index] || ""}${tokens[index + 1] || ""}${tokens[index + 2] || ""}` === model) return true;
  }
  return false;
}

function resolveSourceVehicleModel(context = {}) {
  const sourceContext = context.sourceContext || {};
  const row = sourceContext.currentRow || {};
  const product = row.product || {};
  const productDNA = sourceContext.productDNA || {};
  const base = productDNA.base || {};
  const promptVariables = sourceContext.promptVariables || {};
  const values = [
    sourceContext.sourceModel,
    sourceContext.source_model,
    base.model,
    product.model,
    row.sourceModel,
    row.source_model,
    promptVariables.productDNA?.base?.model,
    sourceContext.originalTitle,
    sourceContext.originalDescription,
    ...(Array.isArray(sourceContext.originalTags) ? sourceContext.originalTags : []),
    base.title,
    product.title,
    product.name,
    product.description
  ];
  for (const value of values) {
    const extracted = extractVehicleModel(value);
    if (extracted) return extracted;
  }
  return "";
}

function extractVehicleModel(value = "") {
  return extractVehicleModels(value)[0] || "";
}

function extractVehicleModels(value = "") {
  const text = cleanText(value).toUpperCase();
  if (!text) return [];
  const brandPattern = VEHICLE_BRANDS.map(escapeRegExp).join("|");
  return [...text.matchAll(new RegExp(`\\b(${brandPattern})\\s*([A-Z0-9][A-Z0-9-]{0,8})\\b`, "gi"))]
    .map((match) => `${match[1].toUpperCase()} ${match[2].toUpperCase()}`.replace(/\s+/g, " ").trim());
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unwrapGeneratedText(value, keys = [], options = {}) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => unwrapGeneratedText(item, keys, options)).filter(Boolean).join("\n");
  if (typeof value === "object") {
    for (const key of keys) {
      const text = unwrapGeneratedText(value[key], keys, options);
      if (text) return text;
    }
    const nestedFields = value.fields && typeof value.fields === "object" ? value.fields : null;
    if (nestedFields) {
      for (const key of keys) {
        const text = unwrapGeneratedText(nestedFields[key], keys, options);
        if (text) return text;
      }
    }
    return "";
  }
  const text = cleanText(value);
  if (!text) return "";
  if (/^\s*[\[{]/.test(text)) {
    const parsed = parseJson(text, null);
    if (parsed) return unwrapGeneratedText(parsed, keys, options) || (options.allowJsonFallback === false ? "" : text);
  }
  return text;
}

function buildTextGenerationContext(fieldKey, input = {}) {
  const row = input.row || {};
  const product = row.product || input.product || {};
  const sourceContext = input.sourceContext || input.source_context || {};
  const productDNA = input.productDNA || input.product_dna || sourceContext?.productDNA || {};
  const base = productDNA.base || {};
  const strategyPrompt = cleanText(input.strategyPrompt || input.strategy_prompt || sourceContext?.strategyPrompt);
  const targetModel = input.targetModel || input.target_model || input.vehicle_model || input.variantTarget || input.variant_target || sourceContext?.variantTarget || sourceContext?.target?.label || row.variantTarget || base.model || product.model;
  return {
    productName: input.productName || input.product_name || base.title || product.title || product.name || row.title,
    categoryName: input.categoryName || input.category_name || base.category || base.productType || product.category,
    brand: input.brand || base.brand || product.brand,
    targetModel,
    material: input.material || base.material || row.attributes?.material || product.material,
    color: input.color || base.color || row.attributes?.color || product.color,
    productType: input.productType || input.product_type || base.productType || product.category,
    sellingPoints: input.sellingPoints || input.selling_points || productDNA.sellingPoints || product.description || row.description,
    tags: normalizeTextList(input.tags || row.tags),
    title: input.title || row.title || product.title || product.name,
    summary: input.summary || input.description || row.description || product.description,
    optimizationTarget: input.optimizationTarget || input.optimization_target || "商品裂变",
    strategies: input.strategies || [],
    rules: input.rules || [],
    sourceContext: {
      ...sourceContext,
      field: fieldKey,
      currentRow: row,
      productDNA: productDNA || null,
      sourceModel: sourceContext?.sourceModel || sourceContext?.source_model || base.model || product.model || row.product?.model || resolveSourceVehicleModel({ sourceContext: { ...sourceContext, currentRow: row, productDNA } }) || "",
      variantStrategy: input.variantStrategy || input.variant_strategy || sourceContext?.variantStrategy || null,
      promptVariables: input.promptVariables || input.prompt_variables || sourceContext?.promptVariables || null,
      strategyPrompt: [
        strategyPrompt,
        "For variant output, use the exact target vehicle model string in the generated result. Do not use the source vehicle model in title, tags, or description.",
        fieldKey === "description" ? "Description output must be natural plain text only. Do not return JSON, markdown code fences, rich content JSON, or an empty object." : ""
      ].filter(Boolean).join("\n")
    },
    target: {
      outputContract: fieldKey === "tags"
        ? { content: "string", fields: { tags: ["string"] } }
        : fieldKey === "title"
          ? { content: "string", fields: { title: "string" } }
          : { content: "string", fields: { summary: "string" } }
    }
  };
}

async function generateRichTextOutput(input = {}) {
  const row = input.row || {};
  const product = row.product || input.product || {};
  const mainImageSource = cleanText(input.mainImageUrl || input.imageUrl || row.generatedMainImageUrl);
  const mainImageAsset = await ensureAssetVariantImagePublishUrl(mainImageSource, {
    sourceId: input.sourceId || input.source_id || row.sourceProductId || row.id || product.sourceId || "",
    batchId: input.sourceBatchId || input.source_batch_id || row.batchId || row.batch_id || "",
    shopId: input.shopId ?? input.shop_id ?? row.shopId ?? row.shop_id ?? null,
    resultId: input.resultId || input.result_id || row.id || "",
    workflowId: input.workflowId || input.workflow_id || "",
    sourceModule: "ai_variant_rich_text",
    role: "rich_text_main"
  });
  const mainImage = cleanText(mainImageAsset.url || mainImageSource);
  const title = cleanText(input.title);
  const description = plainDescriptionText(input.description);
  const tags = Array.isArray(input.tags) ? input.tags : [];
  if (!mainImage) throw new Error("富文本生成缺少新主图");
  if (!title) throw new Error("富文本生成缺少新标题");
  if (!description) throw new Error("富文本生成缺少新描述");
  const targetContext = buildTextGenerationContext("description", input);
  assertVariantTextMatchesTarget("description", description, targetContext);
  const richText = JSON.stringify({
    content: [
      {
        widgetName: "raShowcase",
        type: "billboard",
        blocks: [
          {
            imgLink: "",
            img: {
              src: mainImage,
              srcMobile: mainImage,
              alt: title,
              position: "width_full",
              positionMobile: "width_full",
              widthMobile: 1024,
              heightMobile: 1536
            },
            title: { items: [{ type: "text", content: title }], size: "size4", align: "left", color: "color1" },
            text: { size: "size2", align: "left", color: "color1", items: [{ type: "text", content: description }] }
          }
        ]
      }
    ],
    version: 0.3
  }, null, 2);
  return {
    richText,
    richTextContent: richText,
    imageUrl: mainImage,
    imageStatus: mainImageAsset.status || "",
    imagePublishUrl: mainImageAsset.publishUrl || "",
    imagePreviewUrl: mainImageAsset.previewUrl || "",
    strategy: input.strategy || row.prompt?.richTextStrategy || "main_image_description"
  };
}

function normalizeTextList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return normalizeTextList(parsed);
  } catch {}
  return text.split(/\s+|[,，、;；|]/).map(cleanText).filter(Boolean);
}

function normalizeTaskPayloads(body = {}) {
  if (Array.isArray(body.tasks)) return body.tasks;
  return [body];
}

function compactAiGenerationTaskInput(input = {}, fieldKey = "") {
  if (fieldKey === "commerceCopy") return fitJsonBytes(pruneEmpty(input), MAX_TASK_INPUT_JSON_BYTES);
  const sourceContext = input.sourceContext || input.source_context || {};
  const row = input.row || {};
  let compact = {
    finalPrompt: limitText(input.finalPrompt || input.prompt || "", 24000),
    ratio: cleanText(input.ratio || ""),
    imageCount: Math.max(1, Math.min(8, Number(input.imageCount || input.count || 1) || 1)),
    autoCrop: input.autoCrop !== false,
    cropMode: cleanText(input.cropMode || input.crop_mode || "auto"),
    sourceImageUrl: cleanText(input.sourceImageUrl || input.source_image_url || ""),
    sourceImageUrls: normalizeTextList(input.sourceImageUrls || input.source_image_urls).slice(0, 8),
    productImageCount: Math.max(0, Math.min(8, Number(input.productImageCount || input.product_image_count || 0) || 0)),
    fallbackSourceImageUrl: cleanText(input.fallbackSourceImageUrl || input.fallback_source_image_url || ""),
    mode: cleanText(input.mode || ""),
    listingVariantMedia: Boolean(input.listingVariantMedia || input.listing_variant_media),
    productName: limitText(input.productName || input.product_name || ""),
    categoryName: limitText(input.categoryName || input.category_name || ""),
    brand: limitText(input.brand || ""),
    targetModel: limitText(input.targetModel || input.target_model || input.vehicle_model || input.variantTarget || input.variant_target || sourceContext.variantTarget || sourceContext.variant_target || ""),
    material: limitText(input.material || ""),
    color: limitText(input.color || ""),
    productType: limitText(input.productType || input.product_type || ""),
    sellingPoints: limitText(input.sellingPoints || input.selling_points || ""),
    tags: normalizeTextList(input.tags).slice(0, 24),
    title: limitText(input.title || ""),
    summary: limitText(input.summary || ""),
    description: limitText(input.description || ""),
    optimizationTarget: limitText(input.optimizationTarget || input.optimization_target || ""),
    strategies: normalizeTextList(input.strategies).slice(0, 12).map((item) => limitText(item, 2000)),
    rules: normalizeTextList(input.rules).slice(0, 20).map((item) => limitText(item, 2000)),
    imageUrl: cleanText(input.imageUrl || input.image_url || input.mainImageUrl || input.main_image_url || ""),
    mainImageUrl: cleanText(input.mainImageUrl || input.main_image_url || input.imageUrl || input.image_url || ""),
    sourceId: cleanText(input.sourceId || input.source_id || ""),
    sourceBatchId: cleanText(input.sourceBatchId || input.source_batch_id || row.sourceBatchId || ""),
    workflowId: cleanText(input.workflowId || input.workflow_id || ""),
    resultId: cleanText(input.resultId || input.result_id || row.id || ""),
    strategy: limitText(input.strategy || row.prompt?.richTextStrategy || ""),
    sourceContext: compactSourceContext(sourceContext, fieldKey),
    productDNA: compactProductDNA(input.productDNA || input.product_dna || sourceContext.productDNA),
    variantStrategy: compactVariantStrategy(input.variantStrategy || input.variant_strategy || sourceContext.variantStrategy),
    row: compactTaskRow(row)
  };
  compact = pruneEmpty(compact);
  return fitJsonBytes(compact, MAX_TASK_INPUT_JSON_BYTES);
}

function compactSourceContext(sourceContext = {}, fieldKey = "") {
  return pruneEmpty({
    field: cleanText(sourceContext.field || fieldKey),
    taskMode: cleanText(sourceContext.taskMode || sourceContext.task_mode || ""),
    variantType: cleanText(sourceContext.variantType || sourceContext.variant_type || ""),
    variantTarget: cleanText(sourceContext.variantTarget || sourceContext.variant_target || sourceContext.target?.label || ""),
    sourceModel: cleanText(sourceContext.sourceModel || sourceContext.source_model || ""),
    originalTitle: limitText(sourceContext.originalTitle || sourceContext.original_title || "", 6000),
    originalTags: normalizeTextList(sourceContext.originalTags || sourceContext.original_tags).slice(0, 24),
    originalDescription: limitText(sourceContext.originalDescription || sourceContext.original_description || "", 12000),
    target: sourceContext.target ? pruneEmpty({
      label: cleanText(sourceContext.target.label || ""),
      model: cleanText(sourceContext.target.model || "")
    }) : null,
    productDNA: compactProductDNA(sourceContext.productDNA),
    variantStrategy: compactVariantStrategy(sourceContext.variantStrategy),
    strategyPrompt: limitText(sourceContext.strategyPrompt || sourceContext.strategy_prompt || "", 16000)
  });
}

function compactProductDNA(productDNA = {}) {
  const base = productDNA?.base || {};
  const constraints = productDNA?.constraints || {};
  return pruneEmpty({
    base: pruneEmpty({
      title: limitText(base.title || "", 4000),
      category: limitText(base.category || "", 2000),
      brand: cleanText(base.brand || ""),
      model: cleanText(base.model || ""),
      productType: limitText(base.productType || base.product_type || "", 2000),
      material: limitText(base.material || "", 2000),
      color: limitText(base.color || "", 1000)
    }),
    sellingPoints: normalizeTextList(productDNA?.sellingPoints || productDNA?.selling_points).slice(0, 12).map((item) => limitText(item, 1000)),
    constraints: pruneEmpty({
      knownFacts: normalizeTextList(constraints.knownFacts || constraints.known_facts).slice(0, 12).map((item) => limitText(item, 1000)),
      unknownFacts: normalizeTextList(constraints.unknownFacts || constraints.unknown_facts).slice(0, 8).map((item) => limitText(item, 1000)),
      forbiddenClaims: normalizeTextList(constraints.forbiddenClaims || constraints.forbidden_claims).slice(0, 8).map((item) => limitText(item, 1000)),
      noFabricationRules: normalizeTextList(constraints.noFabricationRules || constraints.no_fabrication_rules).slice(0, 8).map((item) => limitText(item, 1000))
    })
  });
}

function compactVariantStrategy(strategy = {}) {
  return pruneEmpty({
    variantType: cleanText(strategy?.variantType || strategy?.variant_type || ""),
    rawTargets: limitText(strategy?.rawTargets || strategy?.raw_targets || "", 6000),
    selectedFields: normalizeTextList(strategy?.selectedFields || strategy?.selected_fields).slice(0, 12),
    negativePrompt: limitText(strategy?.negativePrompt || strategy?.negative_prompt || "", 6000)
  });
}

function compactTaskRow(row = {}) {
  const product = row.product || {};
  return pruneEmpty({
    id: cleanText(row.id || ""),
    sourceBatchId: cleanText(row.sourceBatchId || row.source_batch_id || ""),
    sourceProductId: cleanText(row.sourceProductId || row.source_product_id || product.id || ""),
    variantTarget: cleanText(row.variantTarget || row.variant_target || ""),
    variantType: cleanText(row.variantType || row.variant_type || ""),
    title: limitText(row.title || "", 6000),
    tags: normalizeTextList(row.tags).slice(0, 24),
    description: limitText(row.description || "", 12000),
    generatedMainImageUrl: cleanText(row.generatedMainImageUrl || row.generated_main_image_url || ""),
    product: pruneEmpty({
      id: cleanText(product.id || ""),
      name: limitText(product.name || "", 4000),
      title: limitText(product.title || "", 4000),
      category: limitText(product.category || "", 2000),
      brand: cleanText(product.brand || ""),
      model: cleanText(product.model || ""),
      material: limitText(product.material || "", 2000),
      color: limitText(product.color || "", 1000),
      imageUrl: cleanText(product.imageUrl || product.image_url || "")
    })
  });
}

function fitJsonBytes(value, maxBytes) {
  let json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return value;
  const trimmed = {
    ...value,
    sellingPoints: limitText(value.sellingPoints || "", 6000),
    summary: limitText(value.summary || "", 6000),
    description: limitText(value.description || "", 6000),
    sourceContext: {
      ...(value.sourceContext || {}),
      originalDescription: limitText(value.sourceContext?.originalDescription || "", 6000),
      strategyPrompt: limitText(value.sourceContext?.strategyPrompt || "", 6000),
      productDNA: compactProductDNA(value.sourceContext?.productDNA || {})
    },
    row: {
      ...(value.row || {}),
      description: limitText(value.row?.description || "", 6000),
      product: {
        ...(value.row?.product || {}),
        description: undefined
      }
    }
  };
  json = JSON.stringify(pruneEmpty(trimmed));
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return pruneEmpty(trimmed);
  return pruneEmpty({
    finalPrompt: value.finalPrompt,
    ratio: value.ratio,
    imageCount: value.imageCount,
    autoCrop: value.autoCrop,
    cropMode: value.cropMode,
    sourceImageUrl: value.sourceImageUrl,
    fallbackSourceImageUrl: value.fallbackSourceImageUrl,
    mode: value.mode,
    listingVariantMedia: value.listingVariantMedia,
    productName: value.productName,
    categoryName: value.categoryName,
    brand: value.brand,
    targetModel: value.targetModel,
    material: value.material,
    color: value.color,
    productType: value.productType,
    tags: value.tags,
    title: limitText(value.title || "", 4000),
    summary: limitText(value.summary || value.description || "", 4000),
    description: limitText(value.description || value.summary || "", 4000),
    optimizationTarget: value.optimizationTarget,
    rules: value.rules,
    imageUrl: value.imageUrl,
    mainImageUrl: value.mainImageUrl,
    sourceId: value.sourceId,
    sourceBatchId: value.sourceBatchId,
    workflowId: value.workflowId,
    resultId: value.resultId,
    strategy: value.strategy,
    sourceContext: pruneEmpty({
      field: value.sourceContext?.field,
      taskMode: value.sourceContext?.taskMode,
      variantType: value.sourceContext?.variantType,
      variantTarget: value.sourceContext?.variantTarget,
      sourceModel: value.sourceContext?.sourceModel
    }),
    row: pruneEmpty({
      id: value.row?.id,
      sourceBatchId: value.row?.sourceBatchId,
      sourceProductId: value.row?.sourceProductId,
      variantTarget: value.row?.variantTarget,
      variantType: value.row?.variantType,
      title: limitText(value.row?.title || "", 4000),
      tags: value.row?.tags,
      description: limitText(value.row?.description || "", 4000),
      generatedMainImageUrl: value.row?.generatedMainImageUrl,
      product: value.row?.product
    })
  });
}

function pruneEmpty(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== "");
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, pruneEmpty(item)])
    .filter(([, item]) => item != null && item !== "" && !(Array.isArray(item) && !item.length) && !(typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length)));
}

function limitText(value = "", maxBytes = MAX_TASK_TEXT_BYTES) {
  let text = cleanText(value);
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, Math.max(0, Math.floor(text.length * 0.8)));
  return text;
}

function buildTaskNo(fieldKey, task, input) {
  const explicit = cleanText(task.taskId || task.task_id || task.taskNo || task.task_no);
  if (explicit) return explicit;
  const stable = cleanText(task.idempotencyKey || task.idempotency_key);
  if (stable) return `aitask-${createHash("sha1").update(`${fieldKey}:${stable}`).digest("hex").slice(0, 24)}`;
  return `aitask-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function mapTaskRow(row = null, options = {}) {
  if (!row) return null;
  const includePayload = options.includePayload !== false;
  return {
    id: Number(row.id || 0),
    taskId: row.task_no || "",
    taskNo: row.task_no || "",
    sourceModule: row.source_module || "",
    workflowId: row.workflow_id || "",
    resultId: row.result_id || "",
    sourceBatchId: row.source_batch_id || "",
    sourceProductId: row.source_product_id || "",
    fieldKey: row.field_key || "",
    status: row.status || "",
    priority: Number(row.priority || 0),
    input: includePayload ? parseJson(row.input_json, null) : null,
    output: includePayload ? parseJson(row.output_json, null) : null,
    error: includePayload ? parseJson(row.error_json, null) : null,
    providerJob: includePayload ? parseJson(row.provider_job_json, null) : null,
    dependsOnTaskIds: parseCsv(row.depends_on_task_ids),
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    createdByPersonId: Number(row.created_by_person_id || 0) || null,
    startedAt: row.started_at || "",
    finishedAt: row.finished_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function normalizeTaskError(error) {
  return {
    code: cleanText(error?.code || error?.validation?.code || "generation_failed"),
    message: cleanText(error?.message || error || "生成任务失败"),
    status: Number(error?.status || error?.statusCode || 0) || undefined,
    validation: error?.validation || null,
    at: new Date().toISOString()
  };
}

function normalizeDependsOn(value) {
  return parseCsv(value).slice(0, 20).join(",");
}

function parseCsv(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value || "").split(",").map(cleanText).filter(Boolean);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toSnake(value = "") {
  return String(value).replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function cleanText(value = "") {
  return String(value ?? "").trim();
}

export const __test__ = {
  assertVariantTextMatchesTarget,
  fallbackVariantDescription,
  normalizeVariantTags,
  extractVehicleModels,
  hasCjkText
};
