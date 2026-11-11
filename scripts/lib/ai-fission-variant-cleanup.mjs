import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const fail = message => { throw Object.assign(new Error(message), { safe: true }); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const owned = (row, tenant) => row && String(row.tenant_id ?? "admin") === tenant;
const offer = variant => String(variant?.offer_id || variant?.offerId || "");
const run = async (db, sql, params = []) => (await db.query(sql, params))[0];
const rowId = value => Number.isSafeInteger(value) && value > 0;
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");

function validate(manifest, applying) {
  if (manifest?.version !== 1 || !/^(?:admin|[1-9][0-9]*)$/.test(manifest.tenant_id || "")
    || !rowId(manifest.source_draft_id) || !rowId(manifest.source_template_id)
    || !Array.isArray(manifest.remove_offer_ids) || !manifest.remove_offer_ids.length
    || manifest.remove_offer_ids.some(id => typeof id !== "string" || !id.trim())
    || new Set(manifest.remove_offer_ids).size !== manifest.remove_offer_ids.length
    || !Array.isArray(manifest.drafts) || !manifest.drafts.length || manifest.drafts.length > 20) fail("Explicit v1 reviewed source, tenant, SKU removal list and child drafts required");
  const ids = new Set(), templates = new Set();
  for (const draft of manifest.drafts) {
    if (!rowId(draft.id) || !rowId(draft.template_id) || ids.has(draft.id) || templates.has(draft.template_id)
      || draft.id === manifest.source_draft_id || draft.template_id === manifest.source_template_id
      || typeof draft.retained_offer_id !== "string" || !draft.retained_offer_id
      || manifest.remove_offer_ids.includes(draft.retained_offer_id)) fail("Invalid or overlapping reviewed child identity");
    if (applying && !validHash(draft.sha256)) fail("Apply requires the audit-generated child hashes");
    ids.add(draft.id); templates.add(draft.template_id);
  }
  if (applying && !validHash(manifest.source_sha256)) fail("Apply requires the audit-generated source hash");
}

function json(text, label) {
  let value;
  try { value = typeof text === "string" ? JSON.parse(text) : text; } catch { fail(`Invalid JSON in ${label}`); }
  if (!object(value) || Object.hasOwn(value, "_listing_frozen_content_v1")) fail(`Unsupported or frozen payload in ${label}`);
  return value;
}

function prune(text, keys, retained, remove, label, required = true) {
  const value = json(text || "{}", label);
  let holder = value;
  for (const key of keys.slice(0, -1)) holder = holder?.[key];
  const key = keys.at(-1), variants = holder?.[key];
  if (variants === undefined && !required) return { value: text, removed: 0 };
  if (!Array.isArray(variants) || variants.filter(variant => offer(variant) === retained).length !== 1
    || variants.some(variant => offer(variant) !== retained && !remove.has(offer(variant)))) fail(`Unreviewed SKU rows in ${label}`);
  const next = variants.filter(variant => !remove.has(offer(variant)));
  const removed = variants.length - next.length;
  if (removed) holder[key] = next;
  return { value: removed ? JSON.stringify(value) : text, removed };
}

export async function inspectAiFissionVariantCleanup(db, manifest, { lock = false } = {}) {
  validate(manifest, lock);
  const suffix = lock ? " FOR UPDATE" : "";
  const [source] = await run(db, `SELECT * FROM listing_drafts WHERE id = ?${suffix}`, [manifest.source_draft_id]);
  if (!owned(source, manifest.tenant_id) || source.status !== "draft"
    || Number(source.template_id) !== manifest.source_template_id) fail("Reviewed source draft identity changed");
  const sourcePayload = json(source.template_payload_json, "source draft");
  const sourceVariants = sourcePayload.editable_payload?.variants;
  const remove = new Set(manifest.remove_offer_ids);
  if (!Array.isArray(sourceVariants) || !sourceVariants.length || sourceVariants.some(variant => remove.has(offer(variant)))) fail("Removal list overlaps the current source SKU list");
  const sourceHash = digest(source);
  if (lock && sourceHash !== manifest.source_sha256) fail("Source draft changed after audit; audit and review again");
  const changes = [], snapshots = [], drafts = [];
  for (const item of [...manifest.drafts].sort((a, b) => a.id - b.id)) {
    const [draft] = await run(db, `SELECT * FROM listing_drafts WHERE id = ?${suffix}`, [item.id]);
    const [template] = await run(db, `SELECT * FROM listing_category_templates WHERE id = ?${suffix}`, [item.template_id]);
    if (!owned(draft, manifest.tenant_id) || draft.status !== "draft" || Number(draft.parent_draft_id) !== manifest.source_draft_id
      || Number(draft.template_id) !== item.template_id || !owned(template, manifest.tenant_id)
      || template.status === "deleted" || template.source_type !== "ai_optimization_v2_lightweight") fail(`Reviewed child ownership or parent changed: ${item.id}`);
    const references = await run(db, `SELECT id FROM listing_drafts WHERE template_id = ?${suffix}`, [item.template_id]);
    if (references.length !== 1 || Number(references[0].id) !== item.id) fail(`Child template is shared: ${item.template_id}`);
    const hash = digest({ draft, template });
    if (lock && hash !== item.sha256) fail(`Child changed after audit; audit and review again: ${item.id}`);
    const fields = [
      ["listing_drafts", "template_payload_json", draft, ["editable_payload", "variants"], true],
      ["listing_drafts", "manual_facts_json", draft, ["variants"], false],
      ["listing_category_templates", "editable_payload_json", template, ["variants"], true]
    ];
    const removed = {};
    for (const [table, column, row, keys, required] of fields) {
      const result = prune(row[column], keys, item.retained_offer_id, remove, `${table}.${column} #${row.id}`, required);
      removed[column] = result.removed;
      if (result.removed) changes.push({ table, column, id: Number(row.id), value: result.value });
    }
    snapshots.push({ draft, template });
    drafts.push({ ...item, sha256: hash, removed });
  }
  return {
    reviewed_manifest: { ...manifest, source_sha256: sourceHash, drafts: drafts.map(({ removed, ...item }) => item) },
    summary: { drafts: drafts.map(({ id, template_id, removed }) => ({ id, template_id, removed })), changed_fields: changes.length },
    changes, snapshots
  };
}

// Refuse public/shared or symlinked destinations; create a new durable private
// file before executing the first UPDATE. Never overwrite an existing backup.
export async function writeAiFissionCleanupBackup(directory, value) {
  if (!path.isAbsolute(directory)) fail("An absolute existing private backup directory is required");
  const absolute = path.resolve(directory);
  for (let current = absolute; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail("Backup directory ancestors must not be symlinks");
    if (current === path.dirname(current)) break;
  }
  const info = await lstat(absolute);
  if (!info.isDirectory() || process.platform !== "win32" && (info.mode & 0o077)) fail("Backup directory must be private (0700)");
  const resolved = await realpath(absolute);
  if (/(?:^|[\\/])(?:public|uploads)(?:[\\/]|$)/i.test(resolved)) fail("Backup must remain outside public media directories");
  const file = path.join(resolved, `ai-fission-variant-cleanup-${randomUUID()}.json`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  return file;
}

export async function applyAiFissionVariantCleanup(db, manifest, backupDirectory, { backup = writeAiFissionCleanupBackup } = {}) {
  validate(manifest, true);
  await db.beginTransaction();
  try {
    const plan = await inspectAiFissionVariantCleanup(db, manifest, { lock: true });
    let backupFile = null;
    if (plan.changes.length) {
      backupFile = await backup(backupDirectory, {
        version: 1, created_at: new Date().toISOString(), manifest: plan.reviewed_manifest,
        before: plan.snapshots, changed_fields: plan.changes.map(({ value, ...change }) => change)
      });
      for (const change of plan.changes) {
        const result = await run(db, `UPDATE ${change.table} SET ${change.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id, 'admin') = ?`, [change.value, change.id, manifest.tenant_id]);
        if (result.affectedRows !== 1) fail("Expected one owned row per cleanup update");
        const [saved] = await run(db, `SELECT ${change.column} FROM ${change.table} WHERE id = ?`, [change.id]);
        if (canonical(json(saved?.[change.column], "saved payload")) !== canonical(json(change.value, "planned payload"))) fail("Saved cleanup payload differs from the reviewed change");
      }
    }
    await db.commit();
    return { ...plan.summary, backup_file: backupFile };
  } catch (error) { await db.rollback(); throw error; }
}
