import test from "node:test";
import assert from "node:assert/strict";
import { inspectPeopleAccountKind, preparePeopleAccountKind } from "../src/services/people-account-kind.js";
import { normalizeAccountKindReview, applyAccountKindReview } from "../scripts/lib/people-account-kind-review.mjs";

const manifest = { version: 1, reviewed_by_person_id: 1, reason: "Reviewed automation identity", accounts: [{ person_id: 20, expected_account_kind: "person", account_kind: "system" }] };
const column = { Type: "varchar(16)", Null: "NO", Default: "person", Collation: "ascii_bin" };

test("account kind preparation is additive, idempotent and does not classify existing accounts", async () => {
  const calls = []; let exists = false;
  const query = async sql => {
    calls.push(sql);
    if (sql.startsWith("SHOW")) return exists ? [column] : [];
    assert.match(sql, /^ALTER TABLE people ADD COLUMN account_kind .* DEFAULT 'person'$/);
    exists = true; return {};
  };
  assert.deepEqual(await inspectPeopleAccountKind(query), { exists: false, ready: false });
  await preparePeopleAccountKind(query); await preparePeopleAccountKind(query);
  assert.equal(calls.filter(sql => sql.startsWith("ALTER")).length, 1);
  await assert.rejects(preparePeopleAccountKind(async () => [{ ...column, Default: "system" }]), /incompatible/);
});

test("review validation requires exact unique IDs, explicit before/after kinds and review context", () => {
  assert.equal(normalizeAccountKindReview(manifest).accounts[0].person_id, 20);
  for (const value of [{}, { ...manifest, accounts: [] }, { ...manifest, reviewed_by_person_id: 0 }, { ...manifest, reason: "" },
    { ...manifest, accounts: [{ person_id: 20, account_kind: "system" }] },
    { ...manifest, accounts: [manifest.accounts[0], manifest.accounts[0]] },
    { ...manifest, accounts: [{ ...manifest.accounts[0], account_kind: "e2e" }] }]) assert.throws(() => normalizeAccountKindReview(value));
});

function reviewHarness({ activeGrant = true, currentKind = "person", failAudit = false } = {}) {
  const calls = [];
  const connection = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT id, account_kind")) return [[{ id: params[0], active: 1, account_kind: params[0] === 20 ? currentKind : "person" }]];
    if (sql.includes("FROM platform_grants")) return [activeGrant ? [{ person_id: 1 }] : []];
    if (sql.startsWith("INSERT") && failAudit) throw new Error("audit failure");
    return [{ affectedRows: sql.startsWith("DELETE") ? 2 : 1 }];
  } };
  return { calls, connection };
}

test("reviewed classification locks explicit people, audits changes, revokes sessions and preserves memberships", async () => {
  const h = reviewHarness();
  assert.deepEqual(await applyAccountKindReview(h.connection, manifest), { changed_person_ids: [20], revoked_sessions: 2 });
  assert.deepEqual(h.calls.filter(call => call.sql.startsWith("SELECT id")).map(call => call.params[0]), [1, 20]);
  assert.ok(h.calls.some(call => call.sql.startsWith("INSERT INTO people_account_kind_audit")));
  assert.deepEqual(h.calls.find(call => call.sql.startsWith("UPDATE")).params, ["system", 20]);
  assert.ok(h.calls.every(call => !/UPDATE tenant_members|DELETE FROM tenant_members|UPDATE platform_grants/.test(call.sql)));
});

test("review rejects an unauthorized reviewer and stale expected kind before writing", async () => {
  for (const options of [{ activeGrant: false }, { currentKind: "system" }]) {
    const h = reviewHarness(options);
    await assert.rejects(applyAccountKindReview(h.connection, manifest));
    assert.ok(h.calls.every(call => call.sql.startsWith("SELECT")));
  }
  const h = reviewHarness({ failAudit: true });
  await assert.rejects(applyAccountKindReview(h.connection, manifest), /audit failure/);
});
