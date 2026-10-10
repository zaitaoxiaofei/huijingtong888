export function assertTenantIdColumnType(table, columnType) {
  if (!columnType || /^varchar\(80\)$/i.test(String(columnType))) return;
  throw new Error(`${table}.tenant_id has unexpected type ${columnType}; expected VARCHAR(80); no schema changes were applied`);
}

export function assertNoDuplicateTenantRequest(duplicate) {
  if (!duplicate) return;
  throw new Error(`listing_publish_tasks has duplicate request_id ${duplicate.request_id} in tenant ${duplicate.tenant_key}; no schema changes were applied`);
}

export function assertNoDuplicateCategoryUsage(duplicate) {
  if (!duplicate) return;
  throw new Error(`ozon_category_usage has duplicate ${duplicate.source_module}/${duplicate.source_id}/${duplicate.description_category_id}:${duplicate.type_id} in tenant ${duplicate.tenant_key}; no schema changes were applied`);
}
