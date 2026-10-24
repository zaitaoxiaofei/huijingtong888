// Bounded, read-only evidence for the next storage migration. Counts exact
// duplicate JSON sections; it does not guess semantic equality or delete data.
export async function auditListingDraftStorage(query, { tenantId, afterId = 0, limit = 200 } = {}) {
  if (!/^(?:admin|[1-9][0-9]*)$/.test(String(tenantId || ""))) throw new Error("An explicit enterprise storage ID is required");
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid audit cursor or limit (1-1000)");
  const scope = tenantId === "admin" ? "(tenant_id = ? OR tenant_id IS NULL)" : "tenant_id = ?";
  const [totals] = await query(`
    SELECT COUNT(*) AS sampled_drafts, MAX(id) AS last_id,
      COALESCE(SUM(OCTET_LENGTH(template_payload_json)),0) AS template_payload_bytes,
      COALESCE(SUM(OCTET_LENGTH(manual_facts_json)),0) AS manual_facts_bytes,
      COALESCE(SUM(OCTET_LENGTH(ai_payload_json)),0) AS ai_payload_bytes,
      COALESCE(SUM(OCTET_LENGTH(source_images_json)),0) AS source_image_reference_bytes,
      COALESCE(SUM(template_attributes = editable_attributes),0) AS duplicate_template_attribute_sections,
      COALESCE(SUM(IF(template_attributes = editable_attributes,OCTET_LENGTH(template_attributes),0)),0) AS duplicate_template_attribute_bytes,
      COALESCE(SUM(manual_attributes = editable_attributes),0) AS duplicate_manual_attribute_sections,
      COALESCE(SUM(IF(manual_attributes = editable_attributes,OCTET_LENGTH(manual_attributes),0)),0) AS duplicate_manual_attribute_bytes,
      COALESCE(SUM(user_facts = ai_manual_facts),0) AS duplicate_ai_fact_sections,
      COALESCE(SUM(IF(user_facts = ai_manual_facts,OCTET_LENGTH(user_facts),0)),0) AS duplicate_ai_fact_bytes
    FROM (
      SELECT sample.*,
        JSON_EXTRACT(IF(JSON_VALID(template_payload_json),template_payload_json,'{}'),'$.attributes') AS template_attributes,
        JSON_EXTRACT(IF(JSON_VALID(template_payload_json),template_payload_json,'{}'),'$.editable_payload.attributes') AS editable_attributes,
        JSON_EXTRACT(IF(JSON_VALID(manual_facts_json),manual_facts_json,'{}'),'$.attributes') AS manual_attributes,
        JSON_EXTRACT(IF(JSON_VALID(manual_facts_json),manual_facts_json,'{}'),'$.user_facts') AS user_facts,
        JSON_EXTRACT(IF(JSON_VALID(ai_payload_json),ai_payload_json,'{}'),'$.manual_facts') AS ai_manual_facts
      FROM (
        SELECT id,template_payload_json,manual_facts_json,ai_payload_json,source_images_json
        FROM listing_drafts WHERE ${scope} AND id > ? AND status <> 'deleted'
        ORDER BY id LIMIT ?
      ) sample
    ) sections
  `, [String(tenantId), afterId, limit]);
  return {
    mode: "read-only", enterprise: String(tenantId), after_id: afterId, limit,
    ...Object.fromEntries(Object.entries(totals || {}).map(([key,value]) => [key,value == null ? null : Number(value)])),
    exact_sections_only: true, whole_database_estimate: false, database_mutations: 0
  };
}
