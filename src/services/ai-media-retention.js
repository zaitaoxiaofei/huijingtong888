import { createHash } from "node:crypto";

export const AI_MEDIA_RETENTION_DAYS = 7;
export const AI_MEDIA_RETENTION_FORMAT = "ai-media-retention-v1";
const MAX_AUDIT_ROW_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_REFERENCE_BYTES = 32 * 1024 * 1024;
const legacyScalarColumns = new Set(["asset_variants.tags_json", "asset_variant_jobs.progress_json"]);
const lineageColumns = ["source_id", "batch_id", "source_batch_id", "source_product_id", "workbench_id", "result_id", "variant_task_id", "variant_result_id", "source_package_id", "optimizer_job_no", "item_no", "workflow_id"];
export const AI_MEDIA_RETENTION_SOURCES = Object.freeze({
  material_assets: ["ai_generated", "ai_variant", "ai_variant_workbench", "ai_product_material_optimizer", "asset_variant_engine", "asset_variant"],
  listing_media_assets: ["asset_variant", "ai_variant_workbench", "ai_variant_rich_text", "ai_product_material_optimizer", "ai_optimization_v2", "ai_optimization_v2_lightweight", "ai_material_optimizer", "ai_variant_lab", "ai_generated", "ai_ecommerce_suite_workbench"],
  listing_ai_variant_assets: ["ai_variant_workbench", "asset_variant_engine", "ai_variant_lab", "ai_product_material_optimizer", "ai_ecommerce_suite_workbench"]
});
const eligibleStatuses = new Set(["active", "approved", "archived", "deleted", "completed", "ready", "success", "generated", "image_done", "pending_review", "public_ready", "local_only"]);
const terminal = new Set(["completed", "done", "success", "succeeded", "failed", "cancelled", "image_done", "image_dry_run", "partially_failed", "partially_generated", "uploaded"]);
const requiredRoots = ["listing_drafts", "listing_category_templates", "listing_publish_records", "online_products", "products"];
const rootTables = [
  ...requiredRoots, "listing_frozen_content", "listing_shop_copies", "listing_variant_workbench_drafts",
  "ai_variant_case_templates", "ai_variant_template_cases", "ai_variant_templates", "ai_variant_case_runs",
  "asset_tail_templates", "shop_watermark_templates", "shops", "ozon_plugin_collected_products", "listing_collected_product_details",
  "order_items", "inbound_records", "product_development_candidates", "product_development_ideas", "ai_vehicle_catalog", "ozon_reviews",
  "asset_variant_ai_cache", "asset_variant_video_cache", "ai_variant_lab_analyses", "ai_variant_lab_plans",
  "material_assets", "listing_media_assets", "listing_ai_variant_assets", "asset_variants", "asset_variant_jobs", "ai_generation_tasks",
  "ai_variant_lab_batch_jobs", "ai_variant_lab_batch_items", "ai_material_optimization_batches", "ai_material_optimization_items", "ai_credit_tasks",
  "listing_publish_tasks", "listing_publish_task_items", "listing_ozon_seller_media_upload_jobs", "ai_variant_draft_save_batches", "ai_variant_draft_save_items"
];
const activeTables = new Set(["asset_variant_jobs", "ai_generation_tasks", "ai_variant_lab_batch_jobs", "ai_variant_lab_batch_items", "ai_material_optimization_batches", "ai_material_optimization_items",
  "listing_publish_tasks", "listing_publish_task_items", "listing_ozon_seller_media_upload_jobs", "ai_variant_draft_save_batches", "ai_variant_draft_save_items"]);
const fail = (message, code = "AI_MEDIA_RETENTION_REFUSED") => Object.assign(new Error(message), { code });
const identifier = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw fail("Unsafe retention SQL identifier");
  return `\`${value}\``;
};
function normalized(value, key = "") {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(item => normalized(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(name => [name, normalized(value[name], name)]));
  if (typeof value === "string" && /_at$/.test(key) && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)) return new Date(`${value.replace(" ", "T")}Z`).toISOString();
  return value;
}
export const aiMediaRetentionFingerprint = value => createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex");
const clone = value => JSON.parse(JSON.stringify(normalized(value)));
function timestamp(value) {
  if (!value) return NaN;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:/.test(text) ? `${text.replace(" ", "T")}Z` : text);
}
function dateOptions({ now = new Date(), limit = 200, maxScanRows = 500000 } = {}) {
  const time = timestamp(now);
  if (!Number.isFinite(time) || !Number.isSafeInteger(limit) || limit < 1 || limit > 25000
    || !Number.isSafeInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > 2000000) throw fail("Invalid retention audit bounds");
  return { now: time, cutoff: time - AI_MEDIA_RETENTION_DAYS * 86400000, limit, maxScanRows };
}
function canonical(value) {
  const text = String(value || "").trim();
  try { const url = new URL(text); url.search = ""; url.hash = ""; return url.toString(); } catch { return text.replace(/\\/g, "/"); }
}
function managedKey(value, storage = {}) {
  try {
    const url = new URL(String(value)), allowed = new Set([`${storage.bucket}.${storage.region}.aliyuncs.com`.toLowerCase()]);
    if (storage.publicBaseUrl) allowed.add(new URL(storage.publicBaseUrl).host.toLowerCase());
    if (!allowed.has(url.host.toLowerCase()) || url.username || url.password || !["https:", "http:"].includes(url.protocol)) return "";
    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch { return ""; }
}
const deletableKey = key => /^(?:ai-unused|listing-media)\/[A-Za-z0-9_./-]+$/.test(key) && key.split("/").every(part => part && part !== "." && part !== "..");
function strings(value, output = new Set(), ids = new Set(), key = "") {
  if (value == null) return output;
  if (Array.isArray(value)) { for (const item of value) strings(item, output, ids, key); return output; }
  if (typeof value === "object") { for (const [name, item] of Object.entries(value)) strings(item, output, ids, name); return output; }
  if (/^(?:material_asset_id|materialAssetId|listing_media_asset_id|media_asset_id|asset_id|assetIds|asset_ids)$/.test(key)) ids.add(String(value));
  if (typeof value !== "string") return output;
  const text = value.trim();
  if (!text) return output;
  if (/^(?:https?:\/\/|\/(?:api|uploads)\/|(?:public\/)?uploads\/|[a-z]:[\\/])/i.test(text)) output.add(canonical(text));
  if (/^[\[{]/.test(text)) {
    try { strings(JSON.parse(text), output, ids); } catch { /* The caller separately rejects malformed JSON columns. */ }
  }
  for (const match of text.matchAll(/(?:material_asset_id|materialAssetId|listing_media_asset_id|media_asset_id|asset_id)["']?\s*[:=]\s*["']?([0-9]+)/g)) ids.add(match[1]);
  for (const match of text.replaceAll("\\/", "/").matchAll(/https?:\/\/[^\s"'<>\\]+/g)) output.add(canonical(match[0].replace(/[),;]+$/, "")));
  return output;
}
function candidate(row, table, cutoff) {
  const source = String(row[table === "material_assets" ? "source_type" : "source_module"] || "");
  return AI_MEDIA_RETENTION_SOURCES[table]?.includes(source) && eligibleStatuses.has(String(row.status || ""))
    && (table !== "listing_ai_variant_assets" || ["generated", "completed", "ready", "saved", "failed", "done"].includes(String(row.field_status || "")))
    && (table !== "listing_ai_variant_assets" || !/^(?:source|reference|input|original)/i.test(String(row.field_key || "")))
    && !/(?:^|[_-])(?:source|raw|reference|input|original)/i.test(String(row.role || ""))
    && timestamp(row.created_at) < cutoff && timestamp(row.updated_at || row.created_at) < cutoff;
}
function outputStrings(item) {
  if (Array.isArray(item.row.output_urls)) return new Set(item.row.output_urls.map(canonical));
  const fields = item.table === "material_assets" ? ["url", "thumbnail_url", "local_url", "publish_url"]
    : item.table === "listing_ai_variant_assets" ? ["asset_json"] : ["preview_url", "publish_url", "local_path"];
  return strings(Object.fromEntries(fields.map(key => [key, item.row[key]])));
}
function projectCandidate(row, table) {
  const outputs = [...outputStrings({ row, table })];
  const fields = ["id", "tenant_id", "source_type", "source_module", "role", "status", "field_key", "field_status", "created_at", "updated_at", ...lineageColumns];
  const projection = Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  projection.lineage = lineageOf(row);
  projection.output_urls = outputs.slice(0, 1000).filter(value => value.length <= 16384);
  const projected = clone(projection);
  return { table, id: String(row.id), row: projected, row_sha256: aiMediaRetentionFingerprint(row),
    projection_sha256: aiMediaRetentionFingerprint(projected), projection_complete: projection.output_urls.length === outputs.length };
}
function lineageOf(row) {
  if (row.lineage && typeof row.lineage === "object") return row.lineage;
  const object = value => { try { const data = typeof value === "string" ? JSON.parse(value) : value; return data && !Array.isArray(data) && typeof data === "object" ? data : {}; } catch { return {}; } };
  const metadata = object(row.metadata_json), input = object(row.input_json);
  const values = (...items) => [...new Set(items.filter(value => typeof value === "string" || typeof value === "number").map(value => String(value).trim()).filter(value => value && value.length <= 256))].slice(0, 16);
  return {
    batches: values(row.batch_id, row.source_batch_id, row.source_package_id, row.optimizer_job_no, metadata.assetVariantBatchId, metadata.sourceBatchId, input.sourceBatchId),
    sources: values(row.source_id, row.source_product_id, row.item_no, metadata.sourceId, input.sourceId, input.sourceProductId),
    workflows: values(row.workflow_id, row.workbench_id, row.variant_task_id, metadata.workflowId, input.workflowId),
    results: values(row.result_id, row.variant_result_id, metadata.resultId, input.resultId),
    tasks: values(row.task_no, row.variant_task_id)
  };
}
function sourceFamilies(row, table = "") {
  const source = String(row.source_module || row.source_type || "");
  if (/^ai_variant_lab/.test(table) || source === "ai_variant_lab") return ["lab"];
  if (table === "asset_variant_jobs" || ["asset_variant", "asset_variant_engine"].includes(source)) return ["matrix"];
  if (/^ai_material_optimization/.test(table)) return ["optimizer"];
  if (source === "ai_product_material_optimizer") return ["optimizer", "generation"];
  if (["ai_generated", "ai_variant", "ai_variant_workbench"].includes(source) || table === "listing_ai_variant_assets") return ["generation", "lab", "optimizer"];
  return ["generation"];
}
function taskGuard(table, row, tenant) {
  if (!/^(?:ai_variant_lab_batch_|asset_variant_jobs$|ai_material_optimization_|ai_generation_tasks$)/.test(table)) return null;
  const line = lineageOf(row), families = sourceFamilies(row, table), clauses = [];
  const nonempty = value => typeof value === "string" && value.trim() ? value.trim() : "";
  if (/^ai_variant_lab_batch_/.test(table)) {
    if (nonempty(row.job_no)) clauses.push({ batches: [row.job_no] });
    if (nonempty(row.item_no)) clauses.push({ sources: [row.item_no] });
  } else if (table === "asset_variant_jobs" && nonempty(row.batch_id)) clauses.push({ batches: [row.batch_id] });
  else if (/^ai_material_optimization_/.test(table) && nonempty(row.optimizer_job_no)) clauses.push({ batches: [row.optimizer_job_no] });
  else if (table === "ai_generation_tasks") {
    if (line.batches.length && line.sources.length) clauses.push({ batches: line.batches, sources: line.sources });
    if (line.workflows.length) clauses.push({ workflows: line.workflows, ...(line.results.length ? { results: line.results } : {}) });
    else if (line.results.length) clauses.push({ results: line.results });
    if (line.tasks.length && clauses.length) clauses.push({ tasks: line.tasks });
  }
  return { tenant, families, clauses, table, id: String(row.id ?? "composite") };
}
function lineageReasons(item, scan, defaultId) {
  const tenant = tenantKey(item.row.tenant_id, defaultId), families = sourceFamilies(item.row, item.table), line = lineageOf(item.row);
  return scan.taskGuards.filter(guard => guard.tenant === tenant && guard.families.some(family => families.includes(family))
    && (!guard.clauses.length || !Object.hasOwn(item.row, "lineage") || item.row.lineage_complete === false
      || guard.clauses.some(clause => Object.entries(clause).every(([key, values]) => values.some(value => line[key]?.includes(value))))))
    .slice(0, 5).map(guard => `unresolved_task_lineage:${guard.table}:${guard.id}`);
}
function scanTargets(items, objects, storage) {
  const urls = new Set(), keys = new Set();
  for (const item of items) for (const text of outputStrings(item)) { urls.add(text); const key = managedKey(text, storage); if (key) keys.add(key); }
  for (const item of objects) if (deletableKey(item.object_key)) keys.add(item.object_key);
  return { urls, keys };
}
function expiredWorkIndexFilter(table, names, cutoff) {
  if (!Object.hasOwn(AI_MEDIA_RETENTION_SOURCES, table)) return "";
  const source = table === "material_assets" ? "source_type" : "source_module";
  if (![source, "status", "created_at", "updated_at"].every(name => names.has(name))) return "";
  if (table === "listing_ai_variant_assets" && !["field_status", "field_key"].every(name => names.has(name))) return "";
  const literals = values => values.map(value => `'${value}'`).join(",");
  const date = new Date(cutoff).toISOString().slice(0, 19).replace("T", " ");
  const clauses = [`${identifier(source)} IN (${literals(AI_MEDIA_RETENTION_SOURCES[table])})`, `status IN (${literals([...eligibleStatuses])})`,
    `created_at<'${date}'`, `COALESCE(updated_at,created_at)<'${date}'`];
  if (names.has("role")) clauses.push("COALESCE(role,'') NOT REGEXP '(^|[_-])(source|raw|reference|input|original)'");
  if (table === "listing_ai_variant_assets") clauses.push(`field_status IN (${literals(["generated", "completed", "ready", "saved", "failed", "done"])})`, "COALESCE(field_key,'') NOT REGEXP '^(source|reference|input|original)'");
  return `WHERE NOT COALESCE((${clauses.join(" AND ")}),0)`;
}
function tenantKey(value, defaultId) { return value == null || value === "" || value === "admin" || Number(value) === defaultId ? "admin" : String(value); }
async function identity(query) {
  const [row] = await query("SELECT DATABASE() AS database_name, @@server_uuid AS server_uuid");
  const [defaultTenant] = await query("SELECT id FROM tenants WHERE slug = 'default' LIMIT 1");
  if (!row?.database_name || !row?.server_uuid || !Number.isSafeInteger(Number(defaultTenant?.id)) || Number(defaultTenant.id) <= 0) throw fail("Database identity or default enterprise cannot be verified");
  return { database: row.database_name, server_uuid: row.server_uuid, default_tenant_id: Number(defaultTenant.id) };
}
async function schema(query) {
  const columns = await query("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION");
  const indexes = await query("SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS column_names, COUNT(*) AS column_count, MAX(SUB_PART IS NOT NULL) AS has_prefix FROM information_schema.statistics WHERE table_schema=DATABASE() AND NON_UNIQUE=0 GROUP BY TABLE_NAME, INDEX_NAME");
  const tables = new Map();
  for (const column of columns) {
    if (!tables.has(column.table_name)) tables.set(column.table_name, []);
    tables.get(column.table_name).push(column);
  }
  // An id inside a composite tenant key is not globally unique. Advancing by
  // that id alone could skip another enterprise's reference on a page boundary.
  const uniqueIdTables = new Set(indexes.filter(index => index.column_names === "id" && Number(index.column_count) === 1 && !Number(index.has_prefix)
    && tables.get(index.table_name)?.some(column => column.column_name === "id" && column.is_nullable === "NO")).map(index => index.table_name));
  const primaryKeys = new Map(indexes.filter(index => index.index_name === "PRIMARY" && !Number(index.has_prefix))
    .map(index => [index.table_name, String(index.column_names || "").split(","), Number(index.column_count)])
    .filter(([table, names, count]) => names.length === count && names.every(name => tables.get(table)?.some(column => column.column_name === name)))
    .map(([table, names]) => [table, names]));
  return { tables, uniqueIdTables, primaryKeys };
}
async function loadCandidates(query, tables, options) {
  const rows = [], cursors = {};
  for (const table of Object.keys(AI_MEDIA_RETENTION_SOURCES)) {
    if (!tables.has(table)) continue;
    const sourceColumn = table === "material_assets" ? "source_type" : "source_module";
    const sources = AI_MEDIA_RETENTION_SOURCES[table];
    const textColumns = tables.get(table).filter(column => /text|char|json|blob/i.test(column.data_type));
    const bytes = textColumns.map(column => `COALESCE(OCTET_LENGTH(${identifier(column.column_name)}),0)`).join("+") || "0";
    const after = String(options.afterIds?.[table] || "0");
    if (!/^(?:0|[1-9][0-9]*)$/.test(after)) throw fail("Invalid retention cursor");
    let cursor = after, count = 0;
    cursors[table] = "0";
    while (count < options.limit) {
      const pageSize = Math.min(10, options.limit - count);
      const data = await query(`SELECT * FROM ${identifier(table)} WHERE ${identifier(sourceColumn)} IN (${sources.map(() => "?").join(",")}) AND created_at < ? AND updated_at < ? AND (${bytes})<=${MAX_AUDIT_ROW_BYTES} AND id > ? ORDER BY id LIMIT ?`,
        [...sources, new Date(options.cutoff), new Date(options.cutoff), cursor, pageSize]);
      if (!data.length) break;
      for (const row of data) if (candidate(row, table, options.cutoff)) rows.push(projectCandidate(row, table));
      count += data.length; cursor = String(data[data.length - 1].id); cursors[table] = cursor;
      if (data.length < pageSize) break;
    }
  }
  return { rows, cursors };
}

async function scanReferences(query, tables, { excludeRows, cutoff, maxScanRows, storage, defaultId, targets, uniqueIdTables, primaryKeys, ignoreExpiredWorkIndexes = false }) {
  const references = new Map(), assetIds = new Set(), blockedTenants = new Set(), warnings = [], missing = [], aliases = new Map();
  const blockers = { count: 0, sources: [], groups: {} }, largeRows = [], taskGuards = [];
  const blockTenant = (table, row, reason) => {
    const tenant = tenantKey(row.tenant_id, defaultId);
    if (reason === "unsettled_ai_credit") blockedTenants.add(tenant);
    else { const guard = taskGuard(table, row, tenant); if (guard) taskGuards.push(guard); }
    blockers.count++;
    if (blockers.sources.length < 500) blockers.sources.push({ table, id: String(row.id ?? "composite"), tenant_id: tenant,
      status: String(row.status || ""), updated_at: normalized(row.updated_at || row.created_at || null), reason });
    const group = `${table}:${tenant}:${String(row.status || "")}:${reason}`;
    blockers.groups[group] = (blockers.groups[group] || 0) + 1;
  };
  let scanned = 0, referenceBytes = 0;
  const protect = (token, reason) => {
    if (!references.has(token)) {
      referenceBytes += Buffer.byteLength(token);
      if (references.size >= 200000 || referenceBytes > 32 * 1024 * 1024) throw fail("Reference scan incomplete: token memory bound exceeded", "AI_MEDIA_RETENTION_SCAN_INCOMPLETE");
      references.set(token, []);
    }
    const reasons = references.get(token); if (reasons.length < 5 && !reasons.includes(reason)) reasons.push(reason);
  };
  // Keep only aliases that resolve to this bounded candidate set, rather than
  // retaining every URL in every enterprise's entire product catalog in RAM.
  if (tables.has("media_migration_map")) {
    const keyset = uniqueIdTables.has("media_migration_map");
    let offset = 0, lastId = null;
    for (;;) {
      const maps = await query(`SELECT id, source_url, oss_url FROM media_migration_map WHERE status='verified'${keyset && lastId !== null ? " AND id > ?" : ""} ORDER BY id LIMIT ?${keyset ? "" : " OFFSET ?"}`,
        keyset ? lastId === null ? [50] : [lastId, 50] : [50, offset]);
      for (const map of maps) {
        if (++scanned > maxScanRows) throw fail("Reference scan incomplete: alias bound exceeded", "AI_MEDIA_RETENTION_SCAN_INCOMPLETE");
        const objectKey = managedKey(map.oss_url, storage);
        if (objectKey && targets.keys.has(objectKey)) {
          const source = canonical(map.source_url);
          if (!aliases.has(source)) aliases.set(source, new Set());
          aliases.get(source).add(objectKey);
        }
      }
      if (maps.length < 50) break;
      if (keyset) lastId = nextPageId(maps, lastId);
      else offset += maps.length;
    }
  }
  for (const table of rootTables) {
    const columns = tables.get(table);
    if (!columns) { if (requiredRoots.includes(table)) missing.push(table); continue; }
    const names = new Set(columns.map(column => column.column_name));
    const rowKeys = primaryKeys.get(table) || (uniqueIdTables.has(table) ? ["id"] : []);
    const selected = columns.filter(column => rowKeys.includes(column.column_name) || lineageColumns.includes(column.column_name) || ["id", "tenant_id", "status", "source_type", "source_module", "role", "field_key", "field_status", "created_at", "updated_at", "imported_to_listing", "result_draft_id", "job_no", "batch_no", "task_no", "workflow_id"].includes(column.column_name)
      || /json$|url|(?:^|_)(?:image|images|path|reference|logo|watermark|output_dir|asset|assets|media)(?:_|$)/i.test(column.column_name));
    const textColumns = selected.filter(column => /text|char|json|blob/i.test(column.data_type));
    const bytes = textColumns.map(column => `COALESCE(OCTET_LENGTH(${identifier(column.column_name)}),0)`).join("+") || "0";
    const projection = selected.map(column => !rowKeys.includes(column.column_name) && column.column_name !== "id" && /text|char|json|blob/i.test(column.data_type)
      ? `CASE WHEN (${bytes})<=${MAX_AUDIT_ROW_BYTES} THEN ${identifier(column.column_name)} ELSE NULL END AS ${identifier(column.column_name)}` : identifier(column.column_name));
    const excludedWork = ignoreExpiredWorkIndexes ? expiredWorkIndexFilter(table, names, cutoff) : "";
    const keyset = uniqueIdTables.has(table);
    let offset = 0, lastId = null;
    for (;;) {
      const after = keyset && lastId !== null ? `${excludedWork ? "AND" : "WHERE"} ${identifier("id")} > ?` : "";
      const rows = await query(`SELECT ${projection.join(",")}, ((${bytes})>${MAX_AUDIT_ROW_BYTES}) AS __retention_oversized, (${bytes}) AS __retention_row_bytes FROM ${identifier(table)} ${excludedWork} ${after} ${names.has("id") ? "ORDER BY id" : ""} LIMIT ?${keyset ? "" : " OFFSET ?"}`,
        keyset ? lastId === null ? [10] : [lastId, 10] : [10, offset]);
      for (let row of rows) {
        if (++scanned > maxScanRows) throw fail("Reference scan incomplete: row bound exceeded", "AI_MEDIA_RETENTION_SCAN_INCOMPLETE");
        let deferredColumns = null, largeSummary = null, largeReadOk = true, locator = "", locatorValues = [];
        if (Number(row.__retention_oversized)) {
          const summary = { table, key: Object.fromEntries(rowKeys.map(name => [name, normalized(row[name])])), bytes: Number(row.__retention_row_bytes), read: false };
          largeSummary = summary;
          if (largeRows.length < 100) largeRows.push(summary);
          if (!rowKeys.length || rowKeys.some(name => row[name] == null) || !Number.isFinite(summary.bytes)) {
            warnings.push(`${table}:${row.id ?? "composite"}:single_row_byte_bound_or_key_unavailable`); continue;
          }
          locator = rowKeys.map(name => `${identifier(name)} <=> ?`).join(" AND "); locatorValues = rowKeys.map(name => row[name]);
          // Fetch at most one large row, separately from the ten-row page. The
          // SQL byte condition bounds allocation even if it changed meanwhile.
          if (summary.bytes <= MAX_SINGLE_REFERENCE_BYTES) {
            const [full] = await query(`SELECT /* ai_retention_single_reference */ ${selected.map(column => identifier(column.column_name)).join(",")} FROM ${identifier(table)} WHERE ${locator} AND (${bytes})<=${MAX_SINGLE_REFERENCE_BYTES} LIMIT 1`, locatorValues);
            if (!full) { warnings.push(`${table}:${row.id ?? "composite"}:single_row_changed_or_unavailable`); continue; }
            row = full; summary.read = true;
          } else {
            const shortProjection = selected.map(column => !rowKeys.includes(column.column_name) && /text|char|json|blob/i.test(column.data_type)
              ? `CASE WHEN COALESCE(OCTET_LENGTH(${identifier(column.column_name)}),0)<=16384 THEN ${identifier(column.column_name)} ELSE NULL END AS ${identifier(column.column_name)}` : identifier(column.column_name));
            const lengths = textColumns.flatMap(column => [`'${column.column_name}'`, `COALESCE(OCTET_LENGTH(${identifier(column.column_name)}),0)`]);
            const [small] = await query(`SELECT /* ai_retention_reference_lengths */ ${shortProjection.join(",")}, JSON_OBJECT(${lengths.join(",")}) AS __retention_column_bytes FROM ${identifier(table)} WHERE ${locator} LIMIT 1`, locatorValues);
            if (!small) { warnings.push(`${table}:${row.id ?? "composite"}:large_row_changed_or_unavailable`); continue; }
            const sizes = typeof small.__retention_column_bytes === "string" ? JSON.parse(small.__retention_column_bytes) : small.__retention_column_bytes;
            summary.mode = "per_column";
            if (sizes && typeof sizes === "object") summary.column_bytes = Object.fromEntries(textColumns.map(column => [column.column_name, Number(sizes[column.column_name])]));
            if (!sizes || textColumns.some(column => !Number.isSafeInteger(Number(sizes[column.column_name])) || Number(sizes[column.column_name]) < 0 || Number(sizes[column.column_name]) > MAX_SINGLE_REFERENCE_BYTES)) {
              warnings.push(`${table}:${row.id ?? "composite"}:single_column_byte_bound_exceeded`); continue;
            }
            deferredColumns = new Set(textColumns.filter(column => Number(sizes[column.column_name]) > 16384 && !rowKeys.includes(column.column_name)).map(column => column.column_name));
            row = small;
          }
        }
        if (excludeRows.has(`${table}:${row.id}`)) continue;
        if (ignoreExpiredWorkIndexes && candidate(row, table, cutoff)) continue;
        if (row.status === "deleted" && !["material_assets", "listing_media_assets"].includes(table)) continue;
        const uncertainFailure = activeTables.has(table) && row.status === "failed" && (
          row.provider_job_json && !["", "null", "{}", "[]"].includes(String(row.provider_job_json).trim())
          || deferredColumns?.has("provider_job_json") || deferredColumns?.has("checkpoint_json")
          || /"(?:state|status|draft_state)"\s*:\s*"(?:submitting|submitted|unknown|running|pending)"/.test(String(row.checkpoint_json || ""))
        );
        if (uncertainFailure) blockTenant(table, row, "unknown_provider_result");
        if (activeTables.has(table) && terminal.has(String(row.status)) && !uncertainFailure && timestamp(row.updated_at || row.created_at) < cutoff) continue;
        if (table === "asset_variants" && !Number(row.imported_to_listing) && timestamp(row.updated_at || row.created_at) < cutoff
          && ["draft", "generated", "ready", "completed", "failed", "cancelled", "archived", "deleted"].includes(String(row.status))) continue;
        if (table === "ai_credit_tasks" && !["succeeded", "failed"].includes(String(row.status))) blockTenant(table, row, "unsettled_ai_credit");
        if (activeTables.has(table) && /unknown|review|submitted|submitting/.test(String(row.status))) blockTenant(table, row, "unknown_task_status");
        for (const column of selected) {
          let value = row[column.column_name];
          if (deferredColumns?.has(column.column_name)) {
            const [field] = await query(`SELECT /* ai_retention_reference_column */ ${identifier(column.column_name)} AS __retention_value FROM ${identifier(table)} WHERE ${locator} AND COALESCE(OCTET_LENGTH(${identifier(column.column_name)}),0)<=${MAX_SINGLE_REFERENCE_BYTES} LIMIT 1`, locatorValues);
            if (!field) { warnings.push(`${table}:${row.id ?? "composite"}:${column.column_name}:column_changed_or_unavailable`); largeReadOk = false; continue; }
            value = field.__retention_value;
          }
          if (value == null || value === "") continue;
          let referenceValue = value;
          if (/json$/i.test(column.column_name) && typeof value === "string") {
            try { referenceValue = JSON.parse(value); } catch {
              if (!legacyScalarColumns.has(`${table}.${column.column_name}`) || /^[\s]*[\[{]/.test(value)) {
                warnings.push(`${table}:${row.id ?? "composite"}:${column.column_name}:invalid_json`); continue;
              }
            }
          }
          const found = strings(referenceValue, new Set(), assetIds, column.column_name);
          for (const text of found) {
            if (targets.urls.has(text)) protect(`url:${text}`, `${table}:${row.id ?? "composite"}`);
            const objectKey = managedKey(text, storage);
            if (objectKey && targets.keys.has(objectKey)) protect(`key:${objectKey}`, `${table}:${row.id ?? "composite"}`);
            for (const target of aliases.get(text) || []) protect(`key:${target}`, "media_migration_map:live_alias");
          }
        }
        if (largeSummary && deferredColumns) largeSummary.read = largeReadOk;
      }
      if (rows.length < 10) break;
      if (keyset) lastId = nextPageId(rows, lastId);
      else offset += rows.length;
    }
  }
  return { references, assetIds, blockedTenants, taskGuards, blockers, largeRows, warnings, missing, scanned, complete: !warnings.length && !missing.length };
}
function nextPageId(rows, previous) {
  const value = rows[rows.length - 1]?.id;
  if (value == null || typeof value === "number" && !Number.isSafeInteger(value) || String(value) === "" || String(value) === previous) {
    throw fail("Reference scan incomplete: unique id cursor did not advance", "AI_MEDIA_RETENTION_SCAN_INCOMPLETE");
  }
  return String(value);
}
function rowReasons(item, scan, storage, defaultId) {
  const found = outputStrings(item), reasons = [];
  if (!scan.complete) reasons.push("reference_scan_incomplete");
  if (item.projection_complete === false) reasons.push("output_projection_incomplete");
  if (scan.blockedTenants.has(tenantKey(item.row.tenant_id, defaultId))) reasons.push("unresolved_ai_or_credit_work");
  reasons.push(...lineageReasons(item, scan, defaultId));
  if (scan.assetIds.has(item.id)) reasons.push("explicit_business_asset_id");
  for (const text of found) {
    if (scan.references.has(`url:${text}`)) reasons.push(...scan.references.get(`url:${text}`));
    const key = managedKey(text, storage);
    if (key && scan.references.has(`key:${key}`)) reasons.push(...scan.references.get(`key:${key}`));
  }
  return [...new Set(reasons)];
}

export async function auditAiMediaRetention({ query, storage = {}, headObject = null, objects = [], priorManifests = [], afterIds = {}, now = new Date(), limit = 200, maxScanRows = 500000, reviewCurrentVersions = false } = {}) {
  if (typeof query !== "function") throw fail("Explicit database query required");
  const options = dateOptions({ now, limit, maxScanRows }), database = await identity(query), { tables, uniqueIdTables, primaryKeys } = await schema(query);
  const { rows: candidates, cursors } = await loadCandidates(query, tables, { ...options, afterIds });
  const priorItems = priorManifests.flatMap(prior => prior.rows || []);
  const targets = scanTargets([...candidates, ...priorItems], objects, storage);
  const scan = await scanReferences(query, tables, { ...options, targets, uniqueIdTables, primaryKeys, storage, defaultId: database.default_tenant_id, ignoreExpiredWorkIndexes: true, excludeRows: new Set(candidates.map(item => `${item.table}:${item.id}`)) });
  const kept = [], rows = [], objectMap = new Map();
  const addObject = (objectKey, origin, item = null) => {
    const existing = objectMap.get(objectKey) || { object_key: objectKey, origin, source_ids: [], source_tenants: [], source_lineages: [] };
    if (origin === "reviewed_ai_index") existing.origin = origin;
    if (item) {
      if (!existing.source_ids.includes(String(item.id))) existing.source_ids.push(String(item.id));
      const tenant = tenantKey(item.row.tenant_id, database.default_tenant_id);
      if (!existing.source_tenants.includes(tenant)) existing.source_tenants.push(tenant);
      if (!existing.source_lineages.some(proof => proof.table === item.table && proof.id === item.id)) existing.source_lineages.push({ table: item.table, id: item.id,
        row: { tenant_id: item.row.tenant_id, source_type: item.row.source_type || "", source_module: item.row.source_module || "", lineage: lineageOf(item.row), lineage_complete: Object.hasOwn(item.row, "lineage") } });
    }
    objectMap.set(objectKey, existing);
  };
  for (const item of candidates) {
    const reasons = rowReasons(item, scan, storage, database.default_tenant_id);
    if (reasons.length) { kept.push({ table: item.table, id: item.id, reasons }); continue; }
    rows.push(item);
    for (const value of outputStrings(item)) {
      const objectKey = managedKey(value, storage);
      if (deletableKey(objectKey)) addObject(objectKey, "reviewed_ai_index", item);
    }
  }
  for (const object of objects) {
    // An unindexed permanent object has no trustworthy AI provenance. Age alone
    // never authorizes deleting product/collector/unknown permanent media.
    if (String(object.object_key || "").startsWith("ai-unused/") && deletableKey(object.object_key)) addObject(object.object_key, "temporary_ai_namespace");
  }
  for (const prior of priorManifests) {
    const { manifest_sha256, ...body } = prior || {};
    if (prior?.format !== AI_MEDIA_RETENTION_FORMAT || aiMediaRetentionFingerprint(body) !== manifest_sha256
      || aiMediaRetentionFingerprint(prior.database) !== aiMediaRetentionFingerprint(database)
      || prior.storage?.bucket !== (storage.bucket || "") || prior.storage?.region !== (storage.region || "")) throw fail("Prior retention provenance manifest is invalid or belongs to another database/storage");
    for (const item of prior.rows || []) {
      if (!candidate(item.row, item.table, options.cutoff) || aiMediaRetentionFingerprint(item.row) !== (item.projection_sha256 || item.row_sha256)) throw fail("Prior AI index provenance changed");
      for (const value of outputStrings(item)) {
        const objectKey = managedKey(value, storage);
        if (deletableKey(objectKey)) addObject(objectKey, "reviewed_ai_index", item);
      }
    }
  }
  const objectRows = [], keptObjects = [];
  const pending = [...objectMap.values()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => { while (cursor < pending.length) {
    const object = pending[cursor++];
    const reasons = [...(scan.references.get(`key:${object.object_key}`) || [])];
    if (object.source_ids.some(id => scan.assetIds.has(id))) reasons.push("explicit_business_asset_id");
    if (object.source_tenants.some(tenant => scan.blockedTenants.has(tenant))) reasons.push("unresolved_ai_or_credit_work");
    for (const proof of object.source_lineages) reasons.push(...lineageReasons(proof, scan, database.default_tenant_id));
    if (object.origin === "temporary_ai_namespace" && scan.taskGuards.length) reasons.push("unattributed_temporary_object_with_unknown_task");
    if (!scan.complete || reasons.length || scan.blockedTenants.size && object.origin === "temporary_ai_namespace") {
      keptObjects.push({ ...object, reasons: !scan.complete ? ["reference_scan_incomplete"] : reasons.length ? reasons : ["unresolved_ai_or_credit_work"] }); continue;
    }
    if (!headObject) { keptObjects.push({ ...object, reasons: ["physical_gc_not_requested"] }); continue; }
    const head = await headObject(object.object_key);
    if (head?.missing) { keptObjects.push({ ...object, reasons: ["object_already_missing"] }); continue; }
    if (head?.version_id && reviewCurrentVersions !== true) { keptObjects.push({ ...object, reasons: ["versioned_object_not_reviewed"] }); continue; }
    if (!head?.fingerprint || !/^[a-f0-9]{64}$/.test(head.fingerprint) || timestamp(head.last_modified) >= options.cutoff || !Number.isFinite(timestamp(head.last_modified))) {
      keptObjects.push({ ...object, reasons: ["object_recent_or_head_unverified"] }); continue;
    }
    objectRows.push({ ...object, head: clone(head), ...(head.version_id ? { reviewed_version_id: head.version_id, version_review_fingerprint: head.fingerprint, older_versions_unenumerated: true } : {}) });
  } }));
  objectRows.sort((a, b) => a.object_key.localeCompare(b.object_key));
  const manifest = { format: AI_MEDIA_RETENTION_FORMAT, database, created_at: new Date(options.now).toISOString(), cutoff: new Date(options.cutoff).toISOString(), retention_days: AI_MEDIA_RETENTION_DAYS,
    max_scan_rows: maxScanRows, next_after_ids: cursors, storage: { bucket: storage.bucket || "", region: storage.region || "", publicBaseUrl: storage.publicBaseUrl || "" }, rows, objects: objectRows,
    scan: { complete: scan.complete, scanned_rows: scan.scanned, warnings: scan.warnings.slice(0, 50), missing_roots: scan.missing, blockers: scan.blockers, large_rows: scan.largeRows }, kept, kept_objects: keptObjects };
  return { ...manifest, manifest_sha256: aiMediaRetentionFingerprint(manifest) };
}

// Enrich a previously completed read-only plan without repeating its full scan.
// Applying the new plan still repeats all live reference checks under freeze.
export async function reviewAiMediaRetentionCurrentVersions({ query, manifest, storage = {}, headObject, now = new Date() } = {}) {
  const { manifest_sha256, ...body } = manifest || {};
  if (typeof query !== "function" || typeof headObject !== "function" || body.format !== AI_MEDIA_RETENTION_FORMAT || !body.scan?.complete
    || aiMediaRetentionFingerprint(body) !== manifest_sha256 || body.retention_days !== AI_MEDIA_RETENTION_DAYS) throw fail("A complete checksummed retention plan is required for version review");
  if (timestamp(now) < timestamp(body.created_at) || timestamp(now) - timestamp(body.created_at) > 24 * 3600000) throw fail("Retention manifest is stale");
  const actual = await identity(query);
  if (aiMediaRetentionFingerprint(actual) !== aiMediaRetentionFingerprint(body.database) || body.storage?.bucket !== (storage.bucket || "")
    || body.storage?.region !== (storage.region || "") || body.storage?.publicBaseUrl !== (storage.publicBaseUrl || "")) throw fail("Version review database or storage does not match the original plan");
  const cutoff = timestamp(body.cutoff);
  if (!Number.isFinite(cutoff) || cutoff > timestamp(body.created_at) - AI_MEDIA_RETENTION_DAYS * 86400000) throw fail("Retention cutoff is not seven days old");
  const next = clone(body), kept = [], promoted = [], seen = new Set((next.objects || []).map(item => item.object_key));
  for (const item of next.kept_objects || []) {
    if (item.reasons?.length !== 1 || item.reasons[0] !== "versioned_object_not_reviewed") { kept.push(item); continue; }
    if (!deletableKey(item.object_key) || !["reviewed_ai_index", "temporary_ai_namespace"].includes(item.origin) || seen.has(item.object_key)) throw fail("Unreviewed or duplicated version object provenance");
    const head = await headObject(item.object_key);
    if (!head?.version_id || typeof head.version_id !== "string" || !/^[a-f0-9]{64}$/.test(head.fingerprint || "")
      || !Number.isSafeInteger(head.size) || head.size < 0 || !Number.isFinite(timestamp(head.last_modified)) || timestamp(head.last_modified) >= cutoff) {
      kept.push({ ...item, reasons: ["current_version_recent_or_unverified"] }); continue;
    }
    const { reasons, ...object } = item;
    promoted.push({ ...object, head: clone(head), reviewed_version_id: head.version_id, version_review_fingerprint: head.fingerprint, older_versions_unenumerated: true });
    seen.add(item.object_key);
  }
  next.objects.push(...promoted); next.objects.sort((a, b) => a.object_key.localeCompare(b.object_key));
  next.kept_objects = kept;
  next.version_review = { policy: "exact_current_version_only", source_manifest_sha256: manifest_sha256, reviewed_at: new Date(timestamp(now)).toISOString(), older_versions_unenumerated: true };
  return { ...next, manifest_sha256: aiMediaRetentionFingerprint(next) };
}

export async function applyAiMediaRetention({ query, transaction, manifest, headObject = null, deleteObject = null, maintenance = null, deleteObjects = false, now = new Date() } = {}) {
  if (!manifest || manifest.format !== AI_MEDIA_RETENTION_FORMAT || manifest.retention_days !== AI_MEDIA_RETENTION_DAYS) throw fail("Reviewed retention manifest required");
  const { manifest_sha256, ...body } = manifest;
  if (aiMediaRetentionFingerprint(body) !== manifest_sha256 || !manifest.scan.complete) throw fail("Retention manifest checksum or reference scan invalid");
  if (timestamp(now) < timestamp(manifest.created_at) || timestamp(now) - timestamp(manifest.created_at) > 24 * 3600000) throw fail("Retention manifest is stale");
  if (typeof query !== "function" || typeof transaction !== "function") throw fail("Explicit database transaction required");
  const actual = await identity(query);
  if (aiMediaRetentionFingerprint(actual) !== aiMediaRetentionFingerprint(manifest.database)) throw fail("Retention manifest belongs to another database");
  const { tables, uniqueIdTables, primaryKeys } = await schema(query), cutoff = timestamp(manifest.cutoff);
  if (!Number.isFinite(cutoff) || cutoff > timestamp(manifest.created_at) - AI_MEDIA_RETENTION_DAYS * 86400000) throw fail("Retention cutoff is not seven days old");
  if ((manifest.rows.length || deleteObjects) && typeof maintenance !== "function") throw fail("Offline writer-freeze evidence is required for index deletion as well as object GC");
  if (deleteObjects && (typeof headObject !== "function" || typeof deleteObject !== "function")) throw fail("OSS fingerprint helpers required");
  const assertMaintenance = async () => { if ((await maintenance(manifest))?.verified !== true) throw fail("Writer freeze evidence was not verified"); };
  if (manifest.rows.length || deleteObjects) await assertMaintenance();
  const selected = new Set(manifest.rows.map(item => `${item.table}:${item.id}`));
  const targets = scanTargets(manifest.rows, manifest.objects, manifest.storage);
  const scan = await scanReferences(query, tables, { excludeRows: selected, targets, uniqueIdTables, primaryKeys, cutoff, maxScanRows: manifest.max_scan_rows, storage: manifest.storage, defaultId: actual.default_tenant_id, ignoreExpiredWorkIndexes: true });
  if (!scan.complete) throw fail("Current reference scan is incomplete");
  const result = { format: AI_MEDIA_RETENTION_FORMAT, manifest_sha256, rows_deleted: 0, objects_deleted: 0, reclaimed_bytes: 0, rows: [], objects: [],
    older_versions_unenumerated: manifest.objects.some(object => Boolean(object.reviewed_version_id)), physical_gc: deleteObjects ? "offline" : "not_requested" };
  for (const item of manifest.rows) {
    if (!Object.hasOwn(AI_MEDIA_RETENTION_SOURCES, item.table) || !/^[1-9][0-9]*$/.test(item.id) || !candidate(item.row, item.table, cutoff)
      || !/^[a-f0-9]{64}$/.test(item.row_sha256) || aiMediaRetentionFingerprint(item.row) !== (item.projection_sha256 || item.row_sha256)) throw fail("Unreviewed candidate row");
    const reasons = rowReasons(item, scan, manifest.storage, actual.default_tenant_id);
    if (reasons.length) { result.rows.push({ table: item.table, id: item.id, retained: true, reasons }); continue; }
    await assertMaintenance();
    const changed = await transaction(async db => {
      const [current] = await db.query(`SELECT * FROM ${identifier(item.table)} WHERE id=? FOR UPDATE`, [item.id]);
      if (!current) return "already_missing";
      if (aiMediaRetentionFingerprint(current) !== item.row_sha256 || !candidate(current, item.table, cutoff)) return "row_changed";
      await db.execute(`DELETE FROM ${identifier(item.table)} WHERE id=?`, [item.id]);
      return "deleted";
    });
    if (changed === "deleted") result.rows_deleted++;
    result.rows.push({ table: item.table, id: item.id, status: changed });
  }
  if (deleteObjects) {
    // Rows that changed or could not be removed now become ordinary references.
    // No candidate exclusion is allowed in the final physical-object scan.
    const final = await scanReferences(query, tables, { excludeRows: new Set(), targets, uniqueIdTables, primaryKeys, cutoff, maxScanRows: manifest.max_scan_rows, storage: manifest.storage, defaultId: actual.default_tenant_id });
    if (!final.complete) throw fail("Final object reference scan incomplete");
    let cursor = 0, failure = null;
    await Promise.all(Array.from({ length: Math.min(6, manifest.objects.length) }, async () => { while (!failure && cursor < manifest.objects.length) {
      const object = manifest.objects[cursor++];
      try {
      if (!deletableKey(object.object_key) || !["reviewed_ai_index", "temporary_ai_namespace"].includes(object.origin)) throw fail("Unreviewed physical object provenance");
      const reasons = [...(final.references.get(`key:${object.object_key}`) || [])];
      if ((object.source_ids || []).some(id => final.assetIds.has(id))) reasons.push("explicit_business_asset_id");
      if ((object.source_tenants || []).some(tenant => final.blockedTenants.has(tenant))) reasons.push("unresolved_ai_or_credit_work");
      for (const proof of object.source_lineages || []) reasons.push(...lineageReasons(proof, final, actual.default_tenant_id));
      if (object.origin === "temporary_ai_namespace" && final.taskGuards.length) reasons.push("unattributed_temporary_object_with_unknown_task");
      if (object.origin === "reviewed_ai_index" && !object.source_lineages?.length && final.taskGuards.length) reasons.push("legacy_object_lineage_unavailable");
      if (reasons.length || object.origin === "temporary_ai_namespace" && final.blockedTenants.size) { result.objects.push({ object_key: object.object_key, retained: true, reasons }); continue; }
      await assertMaintenance();
      const head = await headObject(object.object_key);
      if (head.missing) { result.objects.push({ object_key: object.object_key, already_missing: true }); continue; }
      if (head.fingerprint !== object.head.fingerprint || timestamp(head.last_modified) >= cutoff) { result.objects.push({ object_key: object.object_key, retained: true, reasons: ["oss_object_changed"] }); continue; }
      if (head.version_id && (object.reviewed_version_id !== head.version_id || object.version_review_fingerprint !== head.fingerprint)) {
        result.objects.push({ object_key: object.object_key, retained: true, reasons: ["versioned_object_not_reviewed"] }); continue;
      }
      const removed = await deleteObject(object.object_key, object.head.fingerprint, { reviewedVersionId: object.reviewed_version_id || null });
      if (removed.deleted) { result.objects_deleted++; result.reclaimed_bytes += Number(removed.bytes || head.size || 0); }
      result.objects.push(removed);
      } catch (error) { failure ||= error; }
    } }));
    if (failure) throw failure;
  }
  return result;
}

export function createAiMediaRetentionSweep(dependencies) {
  let afterIds = null;
  return async () => {
    // A new business reference can be saved between a scan and index deletion.
    // Without a common writer lock, even deleting an index is maintenance-only.
    if (typeof dependencies.saveManifest !== "function") throw fail("Private durable retention manifest callback required before index deletion");
    afterIds ||= await dependencies.loadCursor?.() || {};
    const manifest = await auditAiMediaRetention({ ...dependencies, afterIds, headObject: null, objects: [], limit: 200 });
    const saved = await dependencies.saveManifest(manifest);
    afterIds = manifest.next_after_ids;
    await dependencies.saveCursor?.(afterIds);
    if (!manifest.scan.complete) return { ok: true, retained: true, reason: "reference_scan_incomplete", rows_deleted: 0, objects_deleted: 0 };
    return { ok: true, manifest_file: saved || null, manifest_sha256: manifest.manifest_sha256, pending_offline_gc: true,
      rows_queued: manifest.rows.length, rows_deleted: 0, objects_deleted: 0, physical_gc: "not_requested" };
  };
}
