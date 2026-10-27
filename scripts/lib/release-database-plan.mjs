export const SCHEMA_MIGRATIONS = Object.freeze([
  "migrate-order-search-indexes.mjs",
  "migrate-listing-draft-list-indexes.mjs",
  "migrate-listing-frozen-content.mjs",
  "migrate-ai-credits.mjs",
  "migrate-order-profit-daily-fx.mjs",
  "migrate-order-profit-fx-policy.mjs",
  "migrate-ogl-dispatch-schema.mjs",
  "migrate-enterprise-messages.mjs",
  "migrate-subscription-vouchers.mjs",
  "migrate-ai-variant-draft-history-index.mjs",
  "migrate-order-profit-calculation-versions.mjs"
]);

// A dry-run's changes_database:false describes that read, not whether apply
// would change anything. Each inspector has its own explicit pending contract.
export function migrationNeedsApply(filename, report) {
  const invalid = reason => {
    throw Object.assign(new Error(`Invalid read-only migration report for ${filename}: ${reason}`), { code: "RELEASE_DATABASE_PLAN_INVALID" });
  };
  const object = (value, name) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
    return value;
  };
  const boolean = (value, name) => {
    if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
    return value;
  };
  const list = (value, name) => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)
      || new Set(value).size !== value.length) invalid(`${name} must be a distinct string array`);
    return value;
  };
  const schema = (value, name) => {
    object(value, name);
    const available = boolean(value.available, `${name}.available`);
    const compatible = boolean(value.compatible, `${name}.compatible`);
    if (available !== compatible) {
      if (available) invalid(`${name} is incompatible`);
      invalid(`${name} cannot be compatible while absent`);
    }
    return available;
  };
  if (!SCHEMA_MIGRATIONS.includes(filename)) invalid("unknown migration");
  object(report, "report");
  const profitSchema = filename === "migrate-order-profit-calculation-versions.mjs";
  if (!profitSchema) {
    const mode = filename.includes("-daily-fx.") || filename.includes("-fx-policy.") ? "read_only" : "dry-run";
    if (report.mode !== mode) invalid(`mode must be ${mode}`);
    if (["migrate-order-search-indexes.mjs", "migrate-ai-credits.mjs", "migrate-ogl-dispatch-schema.mjs", "migrate-ai-variant-draft-history-index.mjs"].includes(filename)
      && !boolean(report.ok, "ok")) invalid("inspector refused the schema");
    if (Object.hasOwn(report, "changes_database") && report.changes_database !== false) invalid("read-only inspection changed the database");
  }
  switch (filename) {
    case "migrate-order-search-indexes.mjs": {
      const before = object(report.before, "before");
      const exists = boolean(before.exists, "before.exists"), present = boolean(before.present, "before.present"), valid = boolean(before.valid, "before.valid");
      if ((!exists && (present || valid)) || (!present && valid)) invalid("inconsistent order search index state");
      if (present && !valid) invalid("existing order search index is incompatible");
      return exists && !present;
    }
    case "migrate-listing-draft-list-indexes.mjs": {
      if (Object.hasOwn(report, "absent_table") && boolean(report.absent_table, "absent_table")) return false;
      return list(report.missing_indexes, "missing_indexes").length > 0;
    }
    case "migrate-listing-frozen-content.mjs":
      return !boolean(report.table_exists, "table_exists");
    case "migrate-ai-credits.mjs":
      if (list(report.incompatible_tables, "incompatible_tables").length) invalid("AI credit tables are incompatible");
      return list(report.create_tables, "create_tables").length > 0;
    case "migrate-order-profit-daily-fx.mjs":
      return !schema(report.schema, "schema");
    case "migrate-order-profit-fx-policy.mjs": {
      const available = schema(report.schema, "schema");
      schema(report.daily_fx_schema, "daily_fx_schema");
      if (boolean(report.activated_now, "activated_now")) invalid("read-only policy inspection activated a policy");
      return !available;
    }
    case "migrate-ogl-dispatch-schema.mjs": {
      const before = object(report.before, "before");
      const ready = boolean(before.ready, "before.ready");
      const missing = list(before.missing_tables, "before.missing_tables");
      if (list(before.invalid, "before.invalid").length) invalid("OGL schema is incompatible");
      if (ready !== (missing.length === 0)) invalid("inconsistent OGL readiness");
      return missing.length > 0;
    }
    case "migrate-enterprise-messages.mjs": {
      const exists = boolean(report.exists, "exists"), ready = boolean(report.ready, "ready");
      const account = object(report.account_kind, "account_kind");
      const accountExists = boolean(account.exists, "account_kind.exists"), accountReady = boolean(account.ready, "account_kind.ready");
      if ((accountExists && !accountReady) || (!accountExists && accountReady)) invalid("people.account_kind is incompatible");
      if (exists && list(report.problems, "problems").length) invalid("enterprise messages schema is incompatible");
      if (ready !== (exists && accountReady)) invalid("inconsistent enterprise messages readiness");
      return !exists || !accountExists;
    }
    case "migrate-subscription-vouchers.mjs": {
      const exists = boolean(report.exists, "exists"), ready = boolean(report.ready, "ready");
      const problems = list(report.problems, "problems");
      if ((exists && (!ready || problems.length)) || (!exists && ready)) invalid("subscription voucher schema is incompatible");
      return !exists;
    }
    case "migrate-ai-variant-draft-history-index.mjs": {
      const before = object(report.before, "before");
      const exists = boolean(before.exists, "before.exists"), ready = boolean(before.ready, "before.ready");
      const missingColumn = boolean(before.missing_column, "before.missing_column"), missingIndex = boolean(before.missing_index, "before.missing_index");
      if (exists && ready !== (!missingColumn && !missingIndex)) invalid("inconsistent draft history readiness");
      if (!exists && (!ready || !missingColumn || !missingIndex)) invalid("inconsistent absent draft table state");
      return exists && (missingColumn || missingIndex);
    }
    case "migrate-order-profit-calculation-versions.mjs": {
      const missing = list(report.missing_tables, "missing_tables");
      if (missing.some(table => !["order_profit_calc_state", "order_profit_calc_revisions"].includes(table))) invalid("unexpected profit calculation table");
      return missing.length > 0;
    }
  }
}
