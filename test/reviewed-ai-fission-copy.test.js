import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectReviewedAiFissionCopy, applyReviewedAiFissionCopy, writeReviewedAiFissionCopyBackup } from "../scripts/lib/reviewed-ai-fission-copy.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const sku = { offer_id: "target-F7", title: "manual title F7", price: 199, images: ["https://example.com/new.png", "https://example.com/detail.png"], main_tags: ["#HAVAL_H3"], dynamic_attributes: { 23171: { attribute_id: 23171, value: "#HAVAL_H3" } } };
  const state = {
    drafts: [{ id: 1, tenant_id: "2", template_id: 100, parent_draft_id: 10, status: "draft", product_name: "manual title F7", template_payload_json: JSON.stringify({ images: sku.images, editable_payload: { variants: [sku], description: "manual description F7" } }), manual_facts_json: JSON.stringify({ hashtags: ["#HAVAL_H3"], price: 199 }), ai_payload_json: '{"ai_optimization":{"source":"ai_variant_lab"}}', updated_at: "2026-11-12 00:00:00" },
      { id: 10, tenant_id: "2", template_id: 90, status: "draft" }],
    templates: [{ id: 100, tenant_id: "2", status: "active", source_type: "ai_optimization_v2_lightweight", title: "manual title F7", editable_payload_json: JSON.stringify({ variants: [sku], price: 199 }), attributes_json: JSON.stringify([{ attribute_id: 23171, value: "#HAVAL_H3", required: true }]), updated_at: "2026-11-12 00:00:00" }]
  }, calls = [];
  let transaction;
  const db = {
    beginTransaction: async () => { calls.push("begin"); transaction = clone(state); },
    commit: async () => { calls.push("commit"); transaction = undefined; },
    rollback: async () => { calls.push("rollback"); if (transaction) { Object.assign(state, transaction); transaction = undefined; } },
    query: async (sql, params = []) => {
      calls.push(sql);
      const selected = /^SELECT (\*|id, tenant_id) FROM (listing_drafts|listing_category_templates) WHERE (id|template_id) = \?/.exec(sql);
      if (selected) return [clone(state[selected[2] === "listing_drafts" ? "drafts" : "templates"].filter(row => Number(row[selected[3]]) === Number(params[0])))];
      const updated = /^UPDATE (listing_drafts|listing_category_templates) SET (.+), updated_at = CURRENT_TIMESTAMP WHERE/.exec(sql);
      if (updated) {
        db.updateCount = (db.updateCount || 0) + 1;
        if (db.failUpdate === db.updateCount) throw Error("simulated SQL failure");
        const columns = updated[2].split(", ").map(part => part.split(" =")[0]), id = params[columns.length];
        const row = state[updated[1] === "listing_drafts" ? "drafts" : "templates"].find(item => item.id === id && item.tenant_id === params[columns.length + 1]);
        columns.forEach((column, index) => { row[column] = params[index]; }); row.updated_at = "2026-11-12 01:00:00";
        return [{ affectedRows: 1 }];
      }
      throw Error(`Unexpected SQL: ${sql}`);
    }
  };
  const op = (target, before, after) => ({ path: target, before_value: before, after_value: after });
  const manifest = { version: 1, tenant_id: "2", reason: "Reviewed stale H3 copy aliases in F7 draft; keep current manual title, price and media", drafts: [{ id: 1, template_id: 100, parent_draft_id: 10, changes: [
    { column: "template_payload_json", operations: [op(["editable_payload", "variants", "0", "main_tags"], ["#HAVAL_H3"], ["#HAVAL_F7"])] },
    { column: "manual_facts_json", operations: [op(["hashtags"], ["#HAVAL_H3"], ["#HAVAL_F7"])] }
  ] }], templates: [{ id: 100, draft_id: 1, changes: [
    { column: "editable_payload_json", operations: [op(["variants", "0", "main_tags"], ["#HAVAL_H3"], ["#HAVAL_F7"])] },
    { column: "attributes_json", operations: [op(["0", "value"], "#HAVAL_H3", "#HAVAL_F7")] }
  ] }] };
  return { state, calls, db, manifest };
}
const audit = async f => (await inspectReviewedAiFissionCopy(f.db, f.manifest)).reviewed_manifest;
const backup = async () => "/private/reviewed-backup.json";

test("read-only audit supplies row and unchanged-field hashes without changing current manual copy or data", async () => {
  const f = fixture(), before = clone(f.state), plan = await inspectReviewedAiFissionCopy(f.db, f.manifest);
  assert.equal(plan.summary.changed_rows, 2); assert.equal(plan.summary.changed_columns, 4);
  for (const item of [...plan.reviewed_manifest.drafts, ...plan.reviewed_manifest.templates]) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/); assert.match(item.unchanged_sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(f.state, before); assert.ok(f.calls.every(sql => !/UPDATE|FOR UPDATE/.test(sql)));
});

test("apply backs up exact current rows before transaction, changes reviewed copy only and retries idempotently", async () => {
  const f = fixture(), before = clone(f.state), manifest = await audit(f); let backups = 0;
  const saveBackup = async (_directory, content) => {
    backups++; f.calls.push("backup"); assert.ok(!f.calls.includes("begin"));
    assert.deepEqual(content.before.map(item => item.row), [before.drafts[0], before.templates[0]]);
    return "/private/backup.json";
  };
  const result = await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup: saveBackup });
  assert.equal(result.verified, true); assert.equal(result.changed_rows, 2); assert.equal(f.calls.at(-1), "commit");
  assert.ok(f.calls.indexOf("backup") < f.calls.indexOf("begin"));
  const payload = JSON.parse(f.state.drafts[0].template_payload_json), original = JSON.parse(before.drafts[0].template_payload_json);
  original.editable_payload.variants[0].main_tags = ["#HAVAL_F7"];
  assert.deepEqual(payload, original); assert.equal(f.state.drafts[0].product_name, "manual title F7");
  assert.equal(JSON.parse(f.state.drafts[0].manual_facts_json).price, 199);
  assert.deepEqual(f.state.drafts[1], before.drafts[1]);
  f.calls.length = 0;
  assert.equal((await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup: saveBackup })).changed_rows, 0);
  assert.equal(backups, 1); assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  assert.ok(f.calls.every(sql => !/publish|request/i.test(sql)));
});

test("stale manual copy, price, identity or timestamp fails CAS before any update", async () => {
  for (const mutate of [
    f => { f.state.drafts[0].product_name = "later human title"; },
    f => { const p = JSON.parse(f.state.drafts[0].manual_facts_json); p.price++; f.state.drafts[0].manual_facts_json = JSON.stringify(p); },
    f => { f.state.drafts[0].updated_at = "later"; },
    f => { f.state.drafts[0].template_id = 101; },
    f => { const p = JSON.parse(f.state.drafts[0].template_payload_json); p.editable_payload.variants[0].main_tags = ["#human"]; f.state.drafts[0].template_payload_json = JSON.stringify(p); }
  ]) {
    const f = fixture(), manifest = await audit(f); mutate(f);
    await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }));
    assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  }
});

test("after-state idempotence still rejects any changed price or unrelated copy", async () => {
  const f = fixture(), manifest = await audit(f);
  await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup });
  f.state.drafts[0].product_name = "human subsequent edit";
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }), /changed after audit/);
});

test("missing hashes, foreign tenants/parents/templates and shared templates including deleted references fail closed", async () => {
  for (const mutate of [
    f => { f.manifest.drafts[0].sha256 = undefined; },
    f => { f.state.drafts[0].tenant_id = "3"; },
    f => { f.state.drafts[1].tenant_id = "3"; },
    f => { f.state.templates[0].tenant_id = "3"; },
    f => { f.state.drafts.push({ id: 12, tenant_id: "2", template_id: 100, status: "deleted" }); },
    f => { f.state.drafts.push({ id: 12, tenant_id: "3", template_id: 100, status: "draft" }); }
  ]) {
    const f = fixture(); f.manifest = await audit(f); mutate(f);
    await assert.rejects(applyReviewedAiFissionCopy(f.db, f.manifest, "/private", { backup }));
    assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  }
});

test("unknown columns, media/price/identity paths, whole payloads and frozen payloads are refused", async () => {
  for (const target of [["images"], ["editable_payload", "variants", "0", "price"], ["editable_payload", "variants", "0", "offer_id"], ["editable_payload", "variants"], ["source_raw", "description"]]) {
    const f = fixture(); f.manifest.drafts[0].changes = [{ column: "template_payload_json", operations: [{ path: target, before_value: "old", after_value: "new" }] }];
    await assert.rejects(audit(f));
  }
  const f = fixture(); f.manifest.drafts[0].changes[0].column = "publish_payload_json"; await assert.rejects(audit(f));
  const frozen = fixture(); frozen.state.drafts[0].template_payload_json = '{"_listing_frozen_content_v1":{}}'; await assert.rejects(audit(frozen), /Frozen/);
});

function richFixture(change) {
  const f = fixture(), rich = { content: [{ widgetName: "raShowcase", blocks: [{ img: { src: "https://example.com/a.png", srcMobile: "https://example.com/b.png", alt: "H3" }, text: { size: "size2", content: ["H3 description"] } }] }], version: 0.3 };
  const old = [{ value: JSON.stringify(rich), dictionary_value_id: 0 }], next = clone(old), document = JSON.parse(next[0].value); change(document, next); next[0].value = JSON.stringify(document);
  f.state.templates[0].attributes_json = JSON.stringify([{ attribute_id: 11254, values: old }]);
  f.manifest.templates[0].changes = [{ column: "attributes_json", operations: [{ path: ["0", "values"], before_value: old, after_value: next }] }];
  return f;
}
test("rich text-only corrections preserve precise custom layout, media paths/order and selected metadata", async () => {
  const valid = richFixture(document => { document.content[0].blocks[0].text.content = ["F7 description"]; document.content[0].blocks[0].img.alt = "F7"; });
  assert.equal((await inspectReviewedAiFissionCopy(valid.db, valid.manifest)).summary.changed_rows, 2);
  for (const change of [
    document => { document.content[0].blocks[0].img.src = "https://example.com/new.png"; },
    document => { const image = document.content[0].blocks[0].img; [image.src, image.srcMobile] = [image.srcMobile, image.src]; },
    document => { document.content[0].blocks[0].text.size = "size9"; },
    (_document, next) => { next[0].dictionary_value_id = 4; }
  ]) { const f = richFixture(change); await assert.rejects(audit(f), /Rich/); }
});

test("backup failure prevents transaction; SQL error rolls back both draft/template updates", async () => {
  const f = fixture(), before = clone(f.state), manifest = await audit(f);
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup: async () => { throw Error("fsync failed"); } }));
  assert.ok(!f.calls.includes("begin")); assert.deepEqual(f.state, before);
  f.db.failUpdate = 2;
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }));
  assert.equal(f.calls.at(-1), "rollback"); assert.deepEqual(f.state, before);
  assert.equal(f.db.updateCount, 2);
});

test("frozen draft is refused even for scalar-only or manual-facts-only repair", async () => {
  for (const changes of [[{ column: "product_name", before_value: "manual title F7", after_value: "F7" }], [fixture().manifest.drafts[0].changes[1]]]) {
    const f = fixture(); f.manifest.drafts[0].changes = changes;
    f.state.drafts[0].template_payload_json = '{"_listing_frozen_content_v1":{}}';
    await assert.rejects(audit(f), /Frozen/);
  }
});

test("no-op preflight cannot become an unbacked locked write", async () => {
  const f = fixture(), original = clone(f.state), manifest = await audit(f);
  await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup });
  const begin = f.db.beginTransaction;
  f.db.beginTransaction = async () => { Object.assign(f.state, clone(original)); await begin(); };
  f.calls.length = 0;
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }), /without a durable backup/);
  assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
});

test("selected copy metadata cannot be changed through a reviewed text values array", async () => {
  const f = fixture(), old = [{ value: "#HAVAL_H3", dictionary_value_id: 0, metadata: "keep" }];
  f.state.templates[0].attributes_json = JSON.stringify([{ attribute_id: 23171, values: old }]);
  f.manifest.templates[0].changes = [{ column: "attributes_json", operations: [{ path: ["0", "values"], before_value: old, after_value: [{ ...old[0], value: "#HAVAL_F7", metadata: "changed" }] }] }];
  await assert.rejects(audit(f), /metadata must remain unchanged/);
  f.manifest.templates[0].changes[0].operations[0].after_value[0].metadata = "keep";
  assert.equal((await inspectReviewedAiFissionCopy(f.db, f.manifest)).summary.changed_rows, 2);
});

test("any lock-time row change is refused when durable backup captures another state", async () => {
  const f = fixture(), original = clone(f.state), manifest = await audit(f);
  await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup });
  // Partial replay is not normally accepted by CAS; restore the other row's original
  // SHA to model one already-after row moving back while another is pending.
  f.state.templates = clone(original.templates);
  const begin = f.db.beginTransaction;
  f.db.beginTransaction = async () => { f.state.drafts = clone(original.drafts); await begin(); };
  f.calls.length = 0;
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }), /differ from the durable backup/);
  assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
});

test("durable private backups preserve complete rows and never overwrite previous backups", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-fission-copy-"));
  try {
    await chmod(directory, 0o700);
    const value = { before: fixture().state }, file = await writeReviewedAiFissionCopyBackup(directory, value), second = await writeReviewedAiFissionCopyBackup(directory, value);
    assert.notEqual(file, second); assert.deepEqual(JSON.parse(await readFile(file, "utf8")), value);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fixedRich(image) {
  return { content: [{ widgetName: "raShowcase", type: "billboard", blocks: [{ imgLink: "", img: { src: image, srcMobile: image, alt: "人工审核标题 F7", position: "width_full", positionMobile: "width_full", widthMobile: 1024, heightMobile: 1536 },
    title: { items: [{ type: "text", content: "人工审核标题 F7" }], size: "size4", align: "left", color: "color1" },
    text: { size: "size2", align: "left", color: "color1", items: [{ type: "text", content: "人工审核描述，保留所有文字" }] } }] }], version: 0.3 };
}
function imageSyncFixture(mutate = () => {}) {
  const f = fixture(), main = "https://example.com/new.png", old = fixedRich("https://example.com/old.png"), next = clone(old);
  next.content[0].blocks[0].img.src = main; next.content[0].blocks[0].img.srcMobile = main;
  mutate(old, next);
  const before = JSON.stringify(old), after = JSON.stringify(next), payload = JSON.parse(f.state.drafts[0].template_payload_json);
  payload.editable_payload.variants[0].rich_content_json = before;
  f.state.drafts[0].template_payload_json = JSON.stringify(payload);
  const values = [{ value: before, dictionary_value_id: 0, metadata: "preserve" }];
  f.state.templates[0].attributes_json = JSON.stringify([{ attribute_id: 11254, values }]);
  f.manifest.drafts[0].expected_main_image = main;
  f.manifest.drafts[0].changes = [{ column: "template_payload_json", operations: [{ path: ["editable_payload", "variants", "0", "rich_content_json"], before_value: before, after_value: after }] }];
  f.manifest.templates[0].expected_main_image = main;
  f.manifest.templates[0].changes = [{ column: "attributes_json", operations: [{ path: ["0", "values"], before_value: values, after_value: [{ ...values[0], value: after }] }] }];
  return f;
}

test("reviewed fixed-rich image mode changes only two URLs to current draft-owned SKU main and is idempotent", async () => {
  const f = imageSyncFixture(), before = clone(f.state), manifest = await audit(f); let backups = 0;
  const save = async () => { backups++; return "/private/image-backup.json"; };
  assert.equal((await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup: save })).changed_rows, 2);
  const payload = JSON.parse(f.state.drafts[0].template_payload_json), expected = JSON.parse(before.drafts[0].template_payload_json);
  expected.editable_payload.variants[0].rich_content_json = JSON.stringify(fixedRich("https://example.com/new.png"));
  assert.deepEqual(payload, expected);
  assert.deepEqual(JSON.parse(f.state.templates[0].attributes_json)[0].values, [{ value: JSON.stringify(fixedRich("https://example.com/new.png")), dictionary_value_id: 0, metadata: "preserve" }]);
  assert.equal((await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup: save })).changed_rows, 0); assert.equal(backups, 1);
});

test("image opt-in refuses arbitrary URLs, copy changes, custom/multiple-image layouts and metadata edits", async () => {
  for (const mutate of [
    (_old, next) => { next.content[0].blocks[0].img.src = "https://example.com/arbitrary.png"; },
    (_old, next) => { next.content[0].blocks[0].img.srcMobile = "https://example.com/arbitrary.png"; },
    (_old, next) => { next.content[0].blocks[0].title.items[0].content = "changed title"; },
    (_old, next) => { next.content[0].blocks[0].text.items[0].content = "changed description"; },
    (_old, next) => { next.content[0].blocks[0].img.alt = "changed alt"; },
    (old, next) => { old.content[0].blocks[0].text.size = "custom"; next.content[0].blocks[0].text.size = "custom"; },
    (old, next) => { old.content[0].blocks.push(clone(old.content[0].blocks[0])); next.content[0].blocks.push(clone(next.content[0].blocks[0])); },
    (old, next) => { old.link = "https://example.com/keep"; next.link = old.link; }
  ]) await assert.rejects(audit(imageSyncFixture(mutate)), /Rich/);
  const f = imageSyncFixture(); f.manifest.templates[0].changes[0].operations[0].after_value[0].metadata = "changed";
  await assert.rejects(audit(f), /Rich/);
});

test("image mode requires actual first SKU image and never falls back to common/template images", async () => {
  for (const mutate of [
    f => { f.manifest.templates[0].expected_main_image = "https://example.com/template-shared.png"; },
    f => { const p = JSON.parse(f.state.drafts[0].template_payload_json); p.editable_payload.variants[0].images = []; p.editable_payload.images = [f.manifest.drafts[0].expected_main_image]; f.state.drafts[0].template_payload_json = JSON.stringify(p); },
    f => { f.state.drafts[0].tenant_id = "3"; },
    f => { f.manifest.templates[0].draft_id = 10; },
    f => { f.manifest.drafts[0].expected_main_image = ""; }
  ]) { const f = imageSyncFixture(); mutate(f); await assert.rejects(audit(f)); }
});

test("reviewed image hash rejects a later SKU main change before any write", async () => {
  const f = imageSyncFixture(), manifest = await audit(f), payload = JSON.parse(f.state.drafts[0].template_payload_json);
  payload.editable_payload.variants[0].images[0] = "https://example.com/later.png"; f.state.drafts[0].template_payload_json = JSON.stringify(payload);
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }));
  assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
});

test("default copy review still rejects fixed-rich image changes without explicit row opt-in", async () => {
  const f = imageSyncFixture(); delete f.manifest.drafts[0].expected_main_image; delete f.manifest.templates[0].expected_main_image;
  await assert.rejects(audit(f), /Rich/);
});

test("image mode accepts only a unique valid URL on the actual first image object and preserves its metadata", async () => {
  for (const image of [
    { url: "https://example.com/new.png", media_id: "keep", manual: true },
    { image_url: "https://example.com/new.png", media_id: "keep" },
    { imageUrl: "https://example.com/new.png", media_id: "keep" },
    { url: "https://example.com/new.png", image_url: "https://example.com/new.png", imageUrl: "" }
  ]) {
    const f = imageSyncFixture(), p = JSON.parse(f.state.drafts[0].template_payload_json);
    p.editable_payload.variants[0].images[0] = image; f.state.drafts[0].template_payload_json = JSON.stringify(p);
    const manifest = await audit(f); await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup });
    assert.deepEqual(JSON.parse(f.state.drafts[0].template_payload_json).editable_payload.variants[0].images[0], image);
  }
  for (const image of [{ url: "https://example.com/new.png", image_url: "https://example.com/conflict.png" }, { src: "https://example.com/new.png" }, { url: "javascript:invalid" }, { imageUrl: 123 }]) {
    const f = imageSyncFixture(), p = JSON.parse(f.state.drafts[0].template_payload_json);
    p.editable_payload.variants[0].images[0] = image; p.editable_payload.variants[0].images[1] = "https://example.com/new.png";
    f.state.drafts[0].template_payload_json = JSON.stringify(p); await assert.rejects(audit(f), /first-SKU main image/);
  }
});

test("template-only image sync derives authority from its reviewed locked draft, never template common images", async () => {
  const f = imageSyncFixture(); delete f.manifest.drafts[0].expected_main_image; f.manifest.drafts[0].changes = [];
  const templatePayload = JSON.parse(f.state.templates[0].editable_payload_json); templatePayload.images = ["https://example.com/template-shared.png"];
  f.state.templates[0].editable_payload_json = JSON.stringify(templatePayload);
  const manifest = await audit(f); assert.equal((await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup })).changed_rows, 1);
  assert.equal(JSON.parse(f.state.templates[0].editable_payload_json).images[0], "https://example.com/template-shared.png");
});

test("image mode rejects lock-time main edits and rolls back a later template write failure", async () => {
  const f = imageSyncFixture(), manifest = await audit(f), begin = f.db.beginTransaction;
  f.db.beginTransaction = async () => {
    const p = JSON.parse(f.state.drafts[0].template_payload_json); p.editable_payload.variants[0].images[0] = "https://example.com/concurrent.png";
    f.state.drafts[0].template_payload_json = JSON.stringify(p); await begin();
  };
  await assert.rejects(applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup }), /first-SKU main image/);
  assert.ok(f.calls.every(sql => !sql.startsWith("UPDATE")));
  const rollback = imageSyncFixture(), before = clone(rollback.state), reviewed = await audit(rollback); rollback.db.failUpdate = 2;
  await assert.rejects(applyReviewedAiFissionCopy(rollback.db, reviewed, "/private", { backup }), /simulated SQL failure/);
  assert.deepEqual(rollback.state, before); assert.equal(rollback.calls.at(-1), "rollback");
});

test("image mode synchronizes repeated canonical value/label/display documents while preserving all metadata", async () => {
  const f = imageSyncFixture(), op = f.manifest.templates[0].changes[0].operations[0];
  for (const key of ["label", "display_value_zh", "displayValueZh"]) {
    op.before_value[0][key] = op.before_value[0].value; op.after_value[0][key] = op.after_value[0].value;
  }
  op.before_value[0].metadata = op.before_value[0].value; op.after_value[0].metadata = op.before_value[0].metadata;
  f.state.templates[0].attributes_json = JSON.stringify([{ attribute_id: 11254, values: op.before_value }]);
  const manifest = await audit(f); await applyReviewedAiFissionCopy(f.db, manifest, "/private", { backup });
  assert.deepEqual(JSON.parse(f.state.templates[0].attributes_json)[0].values, op.after_value);
  const invalid = imageSyncFixture(); invalid.manifest.templates[0].changes = clone(f.manifest.templates[0].changes);
  invalid.manifest.templates[0].changes[0].operations[0].after_value[0].metadata = op.after_value[0].value;
  invalid.state.templates[0].attributes_json = JSON.stringify([{ attribute_id: 11254, values: op.before_value }]);
  await assert.rejects(audit(invalid), /Rich/);
});
