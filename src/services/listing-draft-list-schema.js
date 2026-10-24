import { createHash } from "node:crypto";

export const LISTING_DRAFT_LIST_INDEXES = [
  { name: "idx_listing_drafts_tenant_created", columns: ["tenant_id", "created_at", "id"] },
  { name: "idx_listing_drafts_tenant_creator_created", columns: ["tenant_id", "created_by_person_id", "created_at", "id"] }
];

// Performance-only additive migration. Ownership, JSON, images and business
// rows are never rewritten. Refuse a same-name index with a different shape.
export async function migrateListingDraftListIndexes(query, { database, apply = false } = {}) {
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error("Explicit valid database required");
  const [selected] = await query("SELECT DATABASE() AS database_name");
  if (selected?.database_name !== database) throw new Error("Selected database differs from requested database");
  const lockName = `draft_list_v1:${createHash("sha256").update(database).digest("hex").slice(0, 32)}`;
  let locked = false;
  try {
    if (apply) {
      const [lock] = await query("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
      if (Number(lock?.acquired) !== 1) throw new Error("Draft list index migration lock unavailable");
      locked = true;
    }
    const [table] = await query("SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'listing_drafts'");
    if (!table) return { mode: apply ? "apply" : "dry-run", database, changes_database: false, absent_table: true };
    if (String(table.engine).toUpperCase() !== "INNODB") throw new Error("listing_drafts must use InnoDB");
    const definitions = await query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'listing_drafts'");
    const columns = new Set(definitions.map((item) => item.name));
    for (const index of LISTING_DRAFT_LIST_INDEXES) {
      if (index.columns.some((column) => !columns.has(column))) throw new Error("Missing draft list index source columns");
    }
    const indexes = await query("SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name, SEQ_IN_INDEX AS seq, SUB_PART AS prefix_length, NON_UNIQUE AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'listing_drafts' ORDER BY INDEX_NAME, SEQ_IN_INDEX");
    const missing = [];
    for (const index of LISTING_DRAFT_LIST_INDEXES) {
      const found = indexes.filter((item) => item.name === index.name);
      if (!found.length) missing.push(index);
      else if (found.length !== index.columns.length || found.some((item, ordinal) => item.column_name !== index.columns[ordinal] || item.prefix_length != null || Number(item.non_unique) !== 1)) {
        throw new Error(`Unexpected existing index definition: ${index.name}`);
      }
    }
    if (apply && missing.length) {
      await query(`ALTER TABLE listing_drafts ${missing.map((index) => `ADD INDEX ${index.name} (${index.columns.join(", ")})`).join(", ")}, ALGORITHM=INPLACE, LOCK=NONE`);
      const after = await migrateListingDraftListIndexes(query, { database });
      if (after.missing_indexes.length) throw new Error("Draft list index migration verification failed");
    }
    return { mode: apply ? "apply" : "dry-run", database, changes_database: apply && missing.length > 0, missing_indexes: missing.map((index) => index.name), data_rows_changed: 0 };
  } finally {
    if (locked) await query("SELECT RELEASE_LOCK(?)", [lockName]);
  }
}
