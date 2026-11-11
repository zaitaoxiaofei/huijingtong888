import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAiFissionVariantCleanup, applyAiFissionVariantCleanup, writeAiFissionCleanupBackup } from "../scripts/lib/ai-fission-variant-cleanup.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const legacy = [{ offer_id: "TENET-old-2" }, { offer_id: "TENET-old-3" }, { offer_id: "TENET-old-4" }];
const retained = { offer_id: "VAR-current", title: "人工编辑标题", images: ["https://example.com/generated-main.png"], dynamic_attributes: { 1: { value: "current selected value" } } };
const payload = variants => JSON.stringify({ description: "保留人工描述", images: ["https://example.com/shared.png"], editable_payload: { variants, rich_content_json: "unchanged rich content" } });
function fixture() {
  const source = { id: 1, tenant_id: "admin", template_id: 10, status: "draft", template_payload_json: payload([{ offer_id: "source-current" }]) };
  const draft = { id: 2, tenant_id: "admin", template_id: 20, parent_draft_id: 1, status: "draft", template_payload_json: payload([retained, ...legacy]), manual_facts_json: JSON.stringify({ variants: [retained, ...legacy], user_facts: { keep: true } }), updated_at: "2026-11-11 00:00:00" };
  const template = { id: 20, tenant_id: "admin", status: "active", source_type: "ai_optimization_v2_lightweight", editable_payload_json: JSON.stringify({ variants: [retained, ...legacy], dimensions: { weight_g: 200 } }), updated_at: draft.updated_at };
  const state = { source, draft, template, references: [{ id: 2 }] }, calls = [];
  let before;
  const db = {
    beginTransaction: async () => { calls.push("begin"); before = clone(state); },
    commit: async () => { calls.push("commit"); },
    rollback: async () => { calls.push("rollback"); Object.assign(state, before); },
    query: async (sql, params) => {
      calls.push(sql);
      if (sql.startsWith("SELECT * FROM listing_drafts")) return [[clone(params[0] === 1 ? state.source : state.draft)]];
      if (sql.startsWith("SELECT * FROM listing_category_templates")) return [[clone(state.template)]];
      if (sql.startsWith("SELECT id FROM listing_drafts")) return [clone(state.references)];
      const update = /^UPDATE (listing_drafts|listing_category_templates) SET (\w+)/.exec(sql);
      if (update) { (update[1] === "listing_drafts" ? state.draft : state.template)[update[2]] = params[0]; return [{ affectedRows: 1 }]; }
      const selected = /^SELECT (\w+) FROM (listing_drafts|listing_category_templates)/.exec(sql);
      if (selected) return [[{ [selected[1]]: (selected[2] === "listing_drafts" ? state.draft : state.template)[selected[1]] }]];
      throw Error(`Unexpected fixture SQL: ${sql}`);
    }
  };
  const manifest = { version: 1, tenant_id: "admin", source_draft_id: 1, source_template_id: 10, remove_offer_ids: legacy.map(item => item.offer_id), drafts: [{ id: 2, template_id: 20, retained_offer_id: retained.offer_id }] };
  return { db, state, calls, manifest };
}

test("audit only plans exact legacy SKU removal and preserves target images, edits and all other data", async () => {
  const { db, state, calls, manifest } = fixture(), before = clone(state);
  const plan = await inspectAiFissionVariantCleanup(db, manifest);
  assert.equal(plan.changes.length, 3);
  assert.deepEqual(plan.summary.drafts[0].removed, { template_payload_json: 3, manual_facts_json: 3, editable_payload_json: 3 });
  for (const change of plan.changes) {
    const parsed = JSON.parse(change.value), variants = parsed.editable_payload?.variants || parsed.variants;
    assert.deepEqual(variants, [retained]);
  }
  assert.equal(JSON.parse(plan.changes[0].value).description, "保留人工描述");
  assert.equal(JSON.parse(plan.changes[0].value).editable_payload.rich_content_json, "unchanged rich content");
  assert.equal(JSON.parse(plan.changes[1].value).user_facts.keep, true);
  assert.deepEqual(state, before);
  assert.ok(calls.every(sql => !sql.includes("UPDATE") && !sql.includes("FOR UPDATE")));
});

test("unreviewed source, child, tenant, shared template, extra SKU and frozen identities fail closed", async () => {
  for (const mutate of [
    f => { f.state.source.tenant_id = "2"; },
    f => { f.state.draft.tenant_id = "2"; },
    f => { f.state.draft.parent_draft_id = 99; },
    f => { f.state.template.tenant_id = "2"; },
    f => { f.state.references.push({ id: 3 }); },
    f => { f.state.source.template_payload_json = payload([legacy[0]]); },
    f => { f.state.draft.template_payload_json = payload([retained, ...legacy, { offer_id: "unreviewed-real-sibling" }]); },
    f => { f.state.draft.template_payload_json = JSON.stringify({ _listing_frozen_content_v1: {} }); },
    f => { f.manifest.drafts[0].template_id = 10; }
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(inspectAiFissionVariantCleanup(f.db, f.manifest));
    assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  }
});

test("apply locks reviewed rows, persists original backup before writes and a fresh no-op does not update", async () => {
  const f = fixture(), before = clone(f.state), audit = await inspectAiFissionVariantCleanup(f.db, f.manifest);
  let backups = 0;
  const backup = async (_dir, content) => {
    backups++; f.calls.push("backup");
    assert.deepEqual(content.before[0], { draft: before.draft, template: before.template });
    assert.ok(!f.calls.some(sql => sql.startsWith("UPDATE")));
    return "/private/backup.json";
  };
  const result = await applyAiFissionVariantCleanup(f.db, audit.reviewed_manifest, "/private", { backup });
  assert.equal(result.backup_file, "/private/backup.json");
  assert.ok(f.calls.indexOf("backup") < f.calls.findIndex(sql => sql.startsWith("UPDATE")));
  assert.equal(f.calls.at(-1), "commit");
  assert.ok(f.calls.filter(sql => sql.startsWith("SELECT *") && f.calls.indexOf(sql) > f.calls.indexOf("begin")).every(sql => sql.endsWith("FOR UPDATE")));
  assert.deepEqual(JSON.parse(f.state.draft.template_payload_json).editable_payload.variants, [retained]);
  f.calls.length = 0;
  const again = await inspectAiFissionVariantCleanup(f.db, f.manifest);
  assert.equal((await applyAiFissionVariantCleanup(f.db, again.reviewed_manifest, "/private", { backup })).changed_fields, 0);
  assert.equal(backups, 1);
  assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
});

test("stale audit or backup failure rolls back before any business write", async () => {
  for (const kind of ["source", "child", "backup"]) {
    const f = fixture(), audit = await inspectAiFissionVariantCleanup(f.db, f.manifest);
    if (kind === "source") f.state.source.updated_at = "later";
    if (kind === "child") f.state.draft.updated_at = "later";
    await assert.rejects(applyAiFissionVariantCleanup(f.db, audit.reviewed_manifest, "/private", { backup: async () => { throw Error("backup unavailable"); } }));
    assert.equal(f.calls.at(-1), "rollback");
    assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  }
});

test("backup creates a durable new private file and rejects public or symlinked destinations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fission-private-"));
  try {
    await chmod(directory, 0o700);
    const file = await writeAiFissionCleanupBackup(directory, { before: "original" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { before: "original" });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(writeAiFissionCleanupBackup("relative", {}));
    const publicDirectory = path.join(directory, "public");
    await mkdir(publicDirectory, { mode: 0o700 });
    await assert.rejects(writeAiFissionCleanupBackup(publicDirectory, {}), /public media/);
    if (process.platform !== "win32") {
      const link = `${directory}-link`;
      await symlink(directory, link);
      try { await assert.rejects(writeAiFissionCleanupBackup(link, {}), /symlinks/); }
      finally { await rm(link); }
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("isolated MySQL apply preserves other values and rolls back a mid-update failure", { skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated MySQL socket" }, async () => {
  const mysql = await import("mysql2/promise");
  const db = await mysql.default.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", dateStrings: true, jsonStrings: true });
  const database = `ozon_fission_cleanup_test_${randomBytes(8).toString("hex")}`;
  let created = false;
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), "fission-mysql-private-"));
  try {
    const [[server]] = await db.query("SELECT @@skip_networking networking_disabled");
    assert.equal(Number(server.networking_disabled), 1, "Never run fixtures on a networked server");
    await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
    await db.changeUser({ database });
    await db.query("CREATE TABLE listing_drafts (id BIGINT PRIMARY KEY, tenant_id VARCHAR(80), template_id BIGINT, parent_draft_id BIGINT, status VARCHAR(32), template_payload_json LONGTEXT, manual_facts_json LONGTEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    await db.query("CREATE TABLE listing_category_templates (id BIGINT PRIMARY KEY, tenant_id VARCHAR(80), status VARCHAR(32), source_type VARCHAR(80), editable_payload_json LONGTEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB");
    const f = fixture();
    for (const row of [f.state.source, f.state.draft]) await db.query("INSERT INTO listing_drafts (id,tenant_id,template_id,parent_draft_id,status,template_payload_json,manual_facts_json) VALUES (?,?,?,?,?,?,?)", [row.id, row.tenant_id, row.template_id, row.parent_draft_id || null, row.status, row.template_payload_json, row.manual_facts_json || "{}"]);
    const template = f.state.template;
    await db.query("INSERT INTO listing_category_templates (id,tenant_id,status,source_type,editable_payload_json) VALUES (?,?,?,?,?)", [template.id, template.tenant_id, template.status, template.source_type, template.editable_payload_json]);
    await chmod(backupDirectory, 0o700);
    const audit = await inspectAiFissionVariantCleanup(db, f.manifest);
    const originalQuery = db.query.bind(db);
    let updates = 0;
    db.query = (sql, params) => {
      if (sql.startsWith("UPDATE") && ++updates === 2) throw Error("Injected second update failure");
      return originalQuery(sql, params);
    };
    await assert.rejects(applyAiFissionVariantCleanup(db, audit.reviewed_manifest, backupDirectory), /Injected/);
    db.query = originalQuery;
    assert.equal((await inspectAiFissionVariantCleanup(db, f.manifest)).changes.length, 3, "The first UPDATE must have rolled back");
    const applied = await applyAiFissionVariantCleanup(db, audit.reviewed_manifest, backupDirectory);
    assert.equal(applied.changed_fields, 3);
    const [[saved]] = await db.query("SELECT * FROM listing_drafts WHERE id = 2");
    assert.deepEqual(JSON.parse(saved.template_payload_json).editable_payload.variants, [retained]);
    assert.deepEqual(JSON.parse(saved.manual_facts_json).variants, [retained]);
    assert.equal(JSON.parse(saved.template_payload_json).description, "保留人工描述");
    assert.equal((await readdir(backupDirectory)).length, 2, "Both failed and successful attempts retain their original backups");
    const fresh = await inspectAiFissionVariantCleanup(db, f.manifest);
    const noOp = await applyAiFissionVariantCleanup(db, fresh.reviewed_manifest, backupDirectory);
    assert.equal(noOp.changed_fields, 0);
    assert.equal(noOp.backup_file, null);
  } finally {
    if (created) await db.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await db.end();
    await rm(backupDirectory, { recursive: true });
  }
});
