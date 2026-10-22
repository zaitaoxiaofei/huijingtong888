export const AI_VARIANT_SOURCE_COLUMN = "ai_variant_source_key";
export const AI_VARIANT_SOURCE_INDEX = "idx_listing_drafts_tenant_ai_source";

const sourceId = `COALESCE(
  NULLIF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(manual_facts_json), manual_facts_json, '{}'), '$.user_facts.source_product_id')), ''),
  NULLIF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(manual_facts_json), manual_facts_json, '{}'), '$.source_product_id')), ''),
  JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(ai_payload_json), ai_payload_json, '{}'), '$.manual_facts.source_product_id'))
)`;

export const AI_VARIANT_SOURCE_EXPRESSION = `CASE WHEN CHAR_LENGTH(${sourceId}) <= 128 THEN ${sourceId} ELSE NULL END`;
export const AI_VARIANT_SOURCE_COLUMN_SQL = `${AI_VARIANT_SOURCE_COLUMN} VARCHAR(128) GENERATED ALWAYS AS (${AI_VARIANT_SOURCE_EXPRESSION}) VIRTUAL`;
export const AI_VARIANT_SOURCE_INDEX_SQL = `KEY ${AI_VARIANT_SOURCE_INDEX} (tenant_id, ${AI_VARIANT_SOURCE_COLUMN})`;

function normalizedExpression(value) {
  return String(value || "").replace(/\\'/g, "'").replace(/_utf8mb4(?=')/gi, "").split(/('(?:''|[^'])*')/g)
    .map((part, index) => index % 2 ? part : part.replace(/[\s`()]/g, "").toLowerCase()).join("");
}

export async function inspectAiVariantDraftHistorySchema(query) {
  const columns = await query(`SELECT column_name, column_type, extra, generation_expression
    FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'listing_drafts'`);
  if (!columns.length) return { exists: false, ready: true, missing_column: true, missing_index: true };
  const field = value => String(value || "");
  const column = columns.find(row => field(row.column_name || row.COLUMN_NAME) === AI_VARIANT_SOURCE_COLUMN);
  if (column && (field(column.column_type || column.COLUMN_TYPE).toLowerCase() !== "varchar(128)"
    || !/VIRTUAL GENERATED/i.test(field(column.extra || column.EXTRA))
    || normalizedExpression(column.generation_expression || column.GENERATION_EXPRESSION) !== normalizedExpression(AI_VARIANT_SOURCE_EXPRESSION))) {
    throw new Error(`Unexpected generated column definition: listing_drafts.${AI_VARIANT_SOURCE_COLUMN}`);
  }
  const indexes = await query(`SELECT index_name, column_name, seq_in_index, non_unique, sub_part, is_visible
    FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'listing_drafts' AND index_name = ?
    ORDER BY seq_in_index`, [AI_VARIANT_SOURCE_INDEX]);
  if (indexes.length && (indexes.length !== 2 || indexes.some(row => Number(row.non_unique ?? row.NON_UNIQUE) !== 1
    || (row.sub_part ?? row.SUB_PART) != null || (row.is_visible || row.IS_VISIBLE) !== "YES")
    || (indexes[0].column_name || indexes[0].COLUMN_NAME) !== "tenant_id"
    || (indexes[1].column_name || indexes[1].COLUMN_NAME) !== AI_VARIANT_SOURCE_COLUMN)) {
    throw new Error(`Unexpected index definition: listing_drafts.${AI_VARIANT_SOURCE_INDEX}`);
  }
  return { exists: true, ready: Boolean(column && indexes.length), missing_column: !column, missing_index: !indexes.length };
}

export async function assertAiVariantDraftHistorySchemaReady(query) {
  const status = await inspectAiVariantDraftHistorySchema(query).catch(error => { error.statusCode = 503; throw error; });
  if (!status.ready) throw Object.assign(new Error("AI 裂变草稿来源索引迁移未完成，请先运行 scripts/migrate-ai-variant-draft-history-index.mjs --apply。"), { statusCode: 503 });
  return status;
}
