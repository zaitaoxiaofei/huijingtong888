import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA_MIGRATIONS, migrationNeedsApply } from "../scripts/lib/release-database-plan.mjs";

const cases = [
  ["migrate-order-search-indexes.mjs",
    { ok: true, mode: "dry-run", before: { exists: true, present: true, valid: true } },
    { ok: true, mode: "dry-run", before: { exists: true, present: false, valid: false } }],
  ["migrate-listing-draft-list-indexes.mjs",
    { mode: "dry-run", changes_database: false, missing_indexes: [] },
    { mode: "dry-run", changes_database: false, missing_indexes: ["idx_listing_drafts_tenant_created"] }],
  ["migrate-listing-frozen-content.mjs",
    { mode: "dry-run", changes_database: false, table_exists: true },
    { mode: "dry-run", changes_database: false, table_exists: false }],
  ["migrate-ai-credits.mjs",
    { ok: true, mode: "dry-run", create_tables: [], incompatible_tables: [] },
    { ok: true, mode: "dry-run", create_tables: ["ai_credit_accounts"], incompatible_tables: [] }],
  ["migrate-order-profit-daily-fx.mjs",
    { mode: "read_only", schema: { available: true, compatible: true } },
    { mode: "read_only", schema: { available: false, compatible: false } }],
  ["migrate-order-profit-fx-policy.mjs",
    { mode: "read_only", schema: { available: true, compatible: true }, daily_fx_schema: { available: true, compatible: true }, activated_now: false },
    { mode: "read_only", schema: { available: false, compatible: false }, daily_fx_schema: { available: false, compatible: false }, activated_now: false }],
  ["migrate-ogl-dispatch-schema.mjs",
    { ok: true, mode: "dry-run", before: { ready: true, missing_tables: [], invalid: [] } },
    { ok: true, mode: "dry-run", before: { ready: false, missing_tables: ["ogl_dispatch_events"], invalid: [] } }],
  ["migrate-enterprise-messages.mjs",
    { mode: "dry-run", exists: true, ready: true, problems: [], account_kind: { exists: true, ready: true } },
    { mode: "dry-run", exists: true, ready: false, problems: [], account_kind: { exists: false, ready: false } }],
  ["migrate-subscription-vouchers.mjs",
    { mode: "dry-run", changes_database: false, exists: true, ready: true, problems: [] },
    { mode: "dry-run", changes_database: false, exists: false, ready: false, problems: ["table:tenant_subscription_vouchers"] }],
  ["migrate-ai-variant-draft-history-index.mjs",
    { ok: true, mode: "dry-run", before: { exists: true, ready: true, missing_column: false, missing_index: false } },
    { ok: true, mode: "dry-run", before: { exists: true, ready: false, missing_column: false, missing_index: true } }],
  ["migrate-order-profit-calculation-versions.mjs",
    { missing_tables: [] },
    { missing_tables: ["order_profit_calc_revisions"] }]
];

test("the release plan covers every always-run migration in dependency order", () => {
  assert.deepEqual(SCHEMA_MIGRATIONS, cases.map(([filename]) => filename));
  assert.equal(SCHEMA_MIGRATIONS.length, 11);
});

for (const [filename, ready, pending] of cases) {
  test(`${filename} distinguishes an already-installed schema from pending work`, () => {
    assert.equal(migrationNeedsApply(filename, ready), false);
    assert.equal(migrationNeedsApply(filename, pending), true);
  });
  test(`${filename} refuses malformed or incomplete inspector output`, () => {
    for (const value of [null, [], "{broken", "false", false, {}, { ...ready, mode: "apply", missing_tables: undefined }]) {
      assert.throws(() => migrationNeedsApply(filename, value), { code: "RELEASE_DATABASE_PLAN_INVALID" });
    }
    const incomplete = structuredClone(ready);
    delete incomplete[Object.keys(incomplete).at(-1)];
    assert.throws(() => migrationNeedsApply(filename, incomplete), { code: "RELEASE_DATABASE_PLAN_INVALID" });
  });
}

test("read-only changes_database:false does not hide a missing table or index", () => {
  assert.equal(migrationNeedsApply("migrate-order-search-indexes.mjs", {
    ok: true, mode: "dry-run", changes_database: false, before: { exists: true, present: false, valid: false }
  }), true);
  assert.equal(migrationNeedsApply("migrate-listing-frozen-content.mjs", { mode: "dry-run", changes_database: false, table_exists: false }), true);
});

test("optional indexes do not manufacture base tables absent from a fresh database", () => {
  assert.equal(migrationNeedsApply("migrate-order-search-indexes.mjs", {
    ok: true, mode: "dry-run", before: { exists: false, present: false, valid: false }
  }), false);
  assert.equal(migrationNeedsApply("migrate-listing-draft-list-indexes.mjs", { mode: "dry-run", changes_database: false, absent_table: true }), false);
  assert.equal(migrationNeedsApply("migrate-ai-variant-draft-history-index.mjs", {
    ok: true, mode: "dry-run", before: { exists: false, ready: true, missing_column: true, missing_index: true }
  }), false);
});

test("message table creation and account-kind column preparation are separate pending facts", () => {
  assert.equal(migrationNeedsApply("migrate-enterprise-messages.mjs", {
    mode: "dry-run", exists: false, ready: false, account_kind: { exists: true, ready: true }
  }), true);
});

const incompatible = [
  ["migrate-order-search-indexes.mjs", { before: { exists: true, present: true, valid: false } }],
  ["migrate-ai-credits.mjs", { ok: false, incompatible_tables: [{ table: "ai_credit_accounts", reasons: ["money column"] }] }],
  ["migrate-order-profit-daily-fx.mjs", { schema: { available: true, compatible: false } }],
  ["migrate-order-profit-fx-policy.mjs", { daily_fx_schema: { available: true, compatible: false } }],
  ["migrate-ogl-dispatch-schema.mjs", { before: { ready: false, missing_tables: [], invalid: ["unsafe global natural key"] } }],
  ["migrate-enterprise-messages.mjs", { ready: false, problems: ["column:text"] }],
  ["migrate-enterprise-messages.mjs", { ready: false, account_kind: { exists: true, ready: false } }],
  ["migrate-subscription-vouchers.mjs", { ready: false, problems: ["index:uk_subscription_voucher_hash"] }],
  ["migrate-ai-variant-draft-history-index.mjs", { before: { exists: true, ready: true, missing_column: true, missing_index: false } }],
  ["migrate-order-profit-calculation-versions.mjs", { missing_tables: ["orders"] }]
];

for (const [filename, overrides] of incompatible) test(`${filename} refuses incompatible or contradictory readiness`, () => {
  const [, ready] = cases.find(([name]) => name === filename);
  assert.throws(() => migrationNeedsApply(filename, { ...ready, ...overrides }), { code: "RELEASE_DATABASE_PLAN_INVALID" });
});

test("truthy strings, false confirmations, duplicate items and activation are refused", () => {
  const inputs = [
    ["migrate-listing-frozen-content.mjs", { mode: "dry-run", table_exists: "true" }],
    ["migrate-ai-credits.mjs", { ok: "true", mode: "dry-run", create_tables: [], incompatible_tables: [] }],
    ["migrate-listing-draft-list-indexes.mjs", { mode: "dry-run", missing_indexes: ["idx_duplicate", "idx_duplicate"] }],
    ["migrate-order-profit-fx-policy.mjs", { ...cases[5][1], activated_now: true }],
    ["migrate-listing-frozen-content.mjs", { mode: "dry-run", changes_database: true, table_exists: true }]
  ];
  for (const [filename, report] of inputs) assert.throws(() => migrationNeedsApply(filename, report), { code: "RELEASE_DATABASE_PLAN_INVALID" });
  assert.throws(() => migrationNeedsApply("unreviewed-migration.mjs", {}), { code: "RELEASE_DATABASE_PLAN_INVALID" });
});

test("classification leaves the inspected schema facts unchanged", () => {
  for (const [filename, ready, pending] of cases) for (const report of [ready, pending]) {
    const before = structuredClone(report);
    migrationNeedsApply(filename, report);
    assert.deepEqual(report, before);
  }
});
