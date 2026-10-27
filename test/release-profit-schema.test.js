import assert from "node:assert/strict";
import test from "node:test";
import { inspectReleaseProfitSchema } from "../scripts/lib/release-profit-schema.mjs";

const state = "order_profit_calc_state", revisions = "order_profit_calc_revisions";
const column = (name, type, nullable = false, extra = "") => ({
  COLUMN_NAME: name, COLUMN_TYPE: type, IS_NULLABLE: nullable ? "YES" : "NO", EXTRA: extra
});
const index = (name, names, unique = true) => names.split(",").map((namePart, ordinal) => ({
  INDEX_NAME: name, COLUMN_NAME: namePart, NON_UNIQUE: Number(!unique), SEQ_IN_INDEX: ordinal + 1,
  SUB_PART: null, EXPRESSION: null, IS_VISIBLE: "YES", INDEX_TYPE: "BTREE"
}));
function fixture() {
  return new Map([
    [state, { engine: "InnoDB", columns: [
      column("tenant_key", "varchar(128)"), column("order_item_id", "bigint unsigned"), column("order_id", "bigint unsigned"),
      column("formula_version", "varchar(32)"), column("legacy_baseline", "tinyint(1)"),
      column("current_estimate_revision_id", "bigint unsigned", true), column("current_actual_revision_id", "bigint unsigned", true),
      column("revision_count", "int unsigned"), column("created_at", "datetime", false, "DEFAULT_GENERATED"),
      column("updated_at", "datetime", false, "DEFAULT_GENERATED")
    ], indexes: [...index("PRIMARY", "tenant_key,order_item_id"), ...index("idx_profit_calc_state_order", "tenant_key,order_id", false)] }],
    [revisions, { engine: "InnoDB", columns: [
      column("id", "bigint unsigned", false, "auto_increment"), column("tenant_key", "varchar(128)"),
      column("order_item_id", "bigint unsigned"), column("order_id", "bigint unsigned"), column("revision_no", "int unsigned"),
      column("layer", "varchar(16)"), column("formula_version", "varchar(32)"), column("legacy_baseline", "tinyint(1)"),
      column("input_completeness", "varchar(32)"), column("input_hash", "char(64)"), column("output_hash", "char(64)"),
      column("idempotency_key", "char(64)"), column("rate_version_json", "longtext", true), column("cost_version_json", "longtext", true),
      column("inputs_json", "longtext"), column("outputs_json", "longtext"), column("parent_revision_id", "bigint unsigned", true),
      column("source", "varchar(64)"), column("reason", "varchar(1000)"), column("actor_id", "bigint unsigned", true),
      column("command_id", "varchar(128)", true), column("created_at", "datetime", false, "DEFAULT_GENERATED")
    ], indexes: [...index("PRIMARY", "id"), ...index("uk_profit_calc_revision_no", "tenant_key,order_item_id,revision_no"),
      ...index("uk_profit_calc_revision_key", "tenant_key,order_item_id,layer,idempotency_key"),
      ...index("idx_profit_calc_revision_order", "tenant_key,order_id,id", false)] }]
  ]);
}
function inspector(tables, statements = []) {
  return async (sql, parameters) => {
    statements.push({ sql, parameters });
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.match(sql, /information_schema\.(?:TABLES|COLUMNS|STATISTICS)/i);
    if (/information_schema\.TABLES/i.test(sql)) return [...tables].map(([name, value]) => ({ TABLE_NAME: name, ENGINE: value.engine }));
    const table = tables.get(parameters[0]);
    if (/information_schema\.COLUMNS/i.test(sql)) return table.columns;
    if (/information_schema\.STATISTICS/i.test(sql)) return table.indexes;
    assert.fail("Unexpected query");
  };
}

test("existing canonical profit schemas are ready using only metadata reads", async () => {
  const statements = [];
  assert.deepEqual(await inspectReleaseProfitSchema(inspector(fixture(), statements)), { missing_tables: [] });
  assert.equal(statements.length, 5);
  assert.equal(statements.some(({ sql }) => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE)\b/i.test(sql)), false);
});

test("first-time missing tables are reported without querying business data or creating them", async () => {
  const statements = [];
  assert.deepEqual(await inspectReleaseProfitSchema(inspector(new Map(), statements)), { missing_tables: [state, revisions] });
  assert.equal(statements.length, 1);
  const tables = fixture(); tables.delete(revisions);
  assert.deepEqual(await inspectReleaseProfitSchema(inspector(tables)), { missing_tables: [revisions] });
});

test("legacy integer display widths do not falsely reject compatible financial columns", async () => {
  const tables = fixture();
  for (const table of tables.values()) for (const column of table.columns) {
    column.COLUMN_TYPE = column.COLUMN_TYPE.replace(/^bigint\b/, "bigint(20)").replace(/^int\b/, "int(10)");
  }
  assert.deepEqual(await inspectReleaseProfitSchema(inspector(tables)), { missing_tables: [] });
});

for (const [label, change] of [
  ["wrong column type", tables => { tables.get(state).columns[1].COLUMN_TYPE = "varchar(64)"; }],
  ["wrong nullable column", tables => { tables.get(state).columns[1].IS_NULLABLE = "YES"; }],
  ["missing column", tables => { tables.get(state).columns.pop(); }],
  ["generated financial field", tables => { tables.get(state).columns[3].EXTRA = "VIRTUAL GENERATED"; }],
  ["missing primary key", tables => { tables.get(state).indexes = tables.get(state).indexes.filter(row => row.INDEX_NAME !== "PRIMARY"); }],
  ["wrong unique key columns", tables => { tables.get(revisions).indexes.find(row => row.INDEX_NAME === "uk_profit_calc_revision_key").COLUMN_NAME = "order_id"; }],
  ["nonunique retry key", tables => { tables.get(revisions).indexes.find(row => row.INDEX_NAME === "uk_profit_calc_revision_key").NON_UNIQUE = 1; }],
  ["prefix index", tables => { tables.get(state).indexes[0].SUB_PART = 8; }],
  ["invisible reader index", tables => { tables.get(state).indexes.at(-1).IS_VISIBLE = "NO"; }],
  ["wrong engine", tables => { tables.get(state).engine = "MyISAM"; }],
  ["unexpected unique restriction", tables => { tables.get(revisions).indexes.push(...index("uk_unreviewed", "order_id")); }]
]) test(`existing incompatible profit schemas are refused: ${label}`, async () => {
  const tables = fixture(); change(tables);
  await assert.rejects(inspectReleaseProfitSchema(inspector(tables)), { code: "RELEASE_PROFIT_SCHEMA_INCOMPATIBLE" });
});

test("safe additional reader indexes do not manufacture a migration", async () => {
  const tables = fixture(); tables.get(revisions).indexes.push(...index("idx_safe_read", "created_at", false));
  assert.deepEqual(await inspectReleaseProfitSchema(inspector(tables)), { missing_tables: [] });
});

test("a missing companion table never masks an incompatible existing state table", async () => {
  const tables = fixture(); tables.delete(revisions); tables.get(state).columns[1].COLUMN_TYPE = "bigint";
  await assert.rejects(inspectReleaseProfitSchema(inspector(tables)), { code: "RELEASE_PROFIT_SCHEMA_INCOMPATIBLE" });
});
