import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { writeAiFissionCleanupBackup } from "./ai-fission-variant-cleanup.mjs";

const fail = message => { throw Object.assign(new Error(message), { safe: true }); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const reviewedCopyHash = value => createHash("sha256").update(canonical(value)).digest("hex");
const equal = (left, right) => canonical(left) === canonical(right);
const clone = value => JSON.parse(JSON.stringify(value));
const validId = id => Number.isSafeInteger(id) && id > 0;
const validHash = value => /^[a-f0-9]{64}$/.test(value || "");
const copyKeys = new Set(["title", "name", "description", "tags", "hashtags", "main_tags", "rich_content_json", "richContentJson", "rich_content", "richContent"]);
const richKeys = new Set(["rich_content_json", "richContentJson", "rich_content", "richContent"]);
const valueKeys = new Set(["value", "values", "selected_values", "selectedValues", "label", "display_value_zh", "displayValueZh"]);
const ids = new Set([4180, 4191, 23171, 11254]);
const definitions = {
  drafts: { table: "listing_drafts", scalar: ["product_name"], json: ["template_payload_json", "manual_facts_json"] },
  templates: { table: "listing_category_templates", scalar: ["title", "description"], json: ["attributes_json", "editable_payload_json"] }
};
const query = async (db, sql, params = []) => (await db.query(sql, params))[0];
function json(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : clone(value); } catch { fail("Invalid reviewed JSON"); }
  if (!parsed || typeof parsed !== "object" || Object.hasOwn(parsed, "_listing_frozen_content_v1")) fail("Frozen or invalid payload requires a separate reviewed migration");
  return parsed;
}
function at(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) fail("Reviewed path does not exist");
    current = current[key];
  }
  return current;
}
function set(value, path, replacement) {
  const parent = at(value, path.slice(0, -1));
  parent[path.at(-1)] = clone(replacement);
}
function copyPath(payload, column, path) {
  if (!Array.isArray(path) || !path.length || path.length > 12 || path.some(key => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) fail("Invalid reviewed path");
  let owner = payload, rest = [...path];
  if (["editable_payload", "editablePayload"].includes(rest[0])) { owner = at(owner, [rest.shift()]); }
  if (column === "manual_facts_json" && rest[0] === "user_facts") owner = at(owner, [rest.shift()]);
  if (rest[0] === "variants") { rest.shift(); const index = rest.shift(); if (!/^\d+$/.test(index || "") || !Array.isArray(owner.variants)) fail("Invalid variant path"); owner = at(owner.variants, [index]); }
  if (rest.length === 1 && copyKeys.has(rest[0])) return richKeys.has(rest[0]) ? 11254 : 0;
  let attribute;
  if (column === "attributes_json" && Array.isArray(owner)) {
    const index = rest.shift(); if (!/^\d+$/.test(index || "")) fail("Invalid attribute path"); attribute = at(owner, [index]);
  } else if (["attributes", "category_attributes"].includes(rest[0])) {
    const key = rest.shift(), index = rest.shift();
    if (!/^\d+$/.test(index || "") || !Array.isArray(owner[key])) fail("Invalid attribute path");
    attribute = at(owner[key], [index]);
  } else if (["dynamic_attributes", "dynamicAttributes"].includes(rest[0])) {
    const key = rest.shift(), entryKey = rest.shift();
    attribute = at(owner[key], [entryKey]);
    attribute = { ...attribute, attribute_id: attribute?.attribute_id || attribute?.id || entryKey };
  }
  const id = Number(attribute?.attribute_id || attribute?.id || 0);
  if (!ids.has(id) || rest.length !== 1 || !valueKeys.has(rest[0])) fail("Only reviewed copy values may change");
  return id;
}
function richProjection(value, key = "", inText = false) {
  if (Array.isArray(value)) return value.map(item => richProjection(item, key, inText));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
    richProjection(item, name, inText || ["text", "title"].includes(name))]));
  if (typeof value === "string" && (key === "alt" || key === "title" || inText && ["content", "value", "text"].includes(key))) return "<reviewed-copy>";
  return value;
}
function richDocuments(value, result = []) {
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (object(parsed) && Array.isArray(parsed.content)) result.push(parsed); } catch {}
  } else if (object(value) && Array.isArray(value.content)) result.push(value);
  else if (value && typeof value === "object") Object.values(value).forEach(item => richDocuments(item, result));
  return result;
}
function guardRich(before, after) {
  if (equal(before, after)) return;
  const previous = richDocuments(before), next = richDocuments(after);
  if (!previous.length || previous.length !== next.length) fail("Unknown or newly created rich layout requires separate review");
  for (let index = 0; index < previous.length; index += 1) {
    // Media/link paths, ordering, repeated images and custom layout remain exact.
    if (!equal(richProjection(previous[index]), richProjection(next[index]))) fail("Rich media or layout changes are not permitted");
    const urls = value => (canonical(value).match(/https?:[^\s"<>\\]+/g) || []).sort();
    if (!equal(urls(previous[index]), urls(next[index]))) fail("Rich links must remain unchanged");
  }
  const envelope = value => {
    if (typeof value === "string") {
      try { const parsed = JSON.parse(value); if (object(parsed) && Array.isArray(parsed.content)) return richProjection(parsed); } catch {}
      return value;
    }
    if (Array.isArray(value)) return value.map(envelope);
    if (object(value)) return Array.isArray(value.content) ? richProjection(value) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, envelope(item)]));
    return value;
  };
  if (!equal(envelope(before), envelope(after))) fail("Rich selected-value metadata must remain unchanged");
}
function guardCopyValue(before, after, attributeId, key) {
  if (attributeId === 11254) return guardRich(before, after);
  const text = value => typeof value === "string" || Array.isArray(value) && value.every(item => typeof item === "string");
  if (!attributeId || !["values", "selected_values", "selectedValues"].includes(key)) {
    if (!text(before) || !text(after)) fail("Reviewed copy must remain text or a text list");
    return;
  }
  const project = value => {
    if (!Array.isArray(value)) fail("Selected copy values must remain a list");
    return value.map(item => {
      if (typeof item === "string") return "<reviewed-copy>";
      if (!object(item)) fail("Invalid selected copy value");
      return Object.fromEntries(Object.entries(item).map(([name, content]) => {
        if (!["value", "label", "display_value_zh", "displayValueZh"].includes(name)) return [name, content];
        if (typeof content !== "string") fail("Selected copy must remain text");
        return [name, "<reviewed-copy>"];
      }));
    });
  };
  if (!equal(project(before), project(after))) fail("Selected copy metadata must remain unchanged");
}
function validate(manifest, applying) {
  if (manifest?.version !== 1 || !/^(?:admin|[1-9][0-9]*)$/.test(manifest.tenant_id || "") || typeof manifest.reason !== "string" || !manifest.reason.trim()
    || !Array.isArray(manifest.drafts) || !manifest.drafts.length || manifest.drafts.length > 50 || !Array.isArray(manifest.templates) || manifest.templates.length > 50) fail("Explicit v1 tenant, reason and at most 50 reviewed drafts/templates required");
  for (const [kind, definition] of Object.entries(definitions)) {
    const seen = new Set();
    for (const item of manifest[kind]) {
      if (!validId(item.id) || seen.has(item.id) || !Array.isArray(item.changes) || item.changes.length > 6) fail("Invalid or duplicate reviewed row");
      seen.add(item.id);
      if (kind === "drafts" ? !validId(item.template_id) || !Number.isSafeInteger(item.parent_draft_id) || item.parent_draft_id < 0 : !validId(item.draft_id)) fail("Reviewed draft/template identities required");
      if (applying && (!validHash(item.sha256) || !validHash(item.unchanged_sha256))) fail("Apply requires audit-generated row and unchanged-field hashes");
      const columns = new Set();
      for (const change of item.changes) {
        if (columns.has(change.column)) fail("Duplicate reviewed column"); columns.add(change.column);
        if (definition.scalar.includes(change.column)) {
          if (typeof change.before_value !== "string" || typeof change.after_value !== "string") fail("Reviewed scalar copy must be text");
        } else if (definition.json.includes(change.column)) {
          if (!Array.isArray(change.operations) || !change.operations.length || change.operations.length > 2000) fail("Explicit reviewed JSON operations required");
          const paths = new Set();
          for (const op of change.operations) {
            if (!Object.hasOwn(op, "before_value") || !Object.hasOwn(op, "after_value")) fail("Explicit before/after values required");
            const key = canonical(op.path); if (paths.has(key)) fail("Duplicate reviewed operation"); paths.add(key);
          }
        } else fail("Unapproved table or column");
      }
    }
  }
  if (manifest.templates.some(template => !manifest.drafts.some(draft => draft.id === template.draft_id && draft.template_id === template.id))) fail("Template changes must name their reviewed draft");
}
function planRow(row, item, definition, applying) {
  const projected = clone(row); delete projected.updated_at;
  const updates = {}; let allAfter = true;
  for (const change of item.changes) {
    if (definition.scalar.includes(change.column)) {
      const current = row[change.column];
      if (!equal(current, change.before_value) && !equal(current, change.after_value)) fail("Reviewed scalar changed after preparation");
      allAfter &&= equal(current, change.after_value);
      if (!equal(current, change.after_value)) updates[change.column] = change.after_value;
      projected[change.column] = "<reviewed-copy>";
    } else {
      const desired = json(row[change.column]), masked = clone(desired);
      for (const op of change.operations) {
        const kind = copyPath(desired, change.column, op.path), current = at(desired, op.path);
        if (!equal(current, op.before_value) && !equal(current, op.after_value)) fail("Reviewed copy path changed after preparation");
        guardCopyValue(op.before_value, op.after_value, kind, op.path.at(-1));
        allAfter &&= equal(current, op.after_value);
        set(desired, op.path, op.after_value); set(masked, op.path, "<reviewed-copy>");
      }
      projected[change.column] = masked;
      if (!equal(json(row[change.column]), desired)) updates[change.column] = JSON.stringify(desired);
    }
  }
  const hash = reviewedCopyHash(row), unchanged = reviewedCopyHash(projected);
  if (applying && (unchanged !== item.unchanged_sha256 || hash !== item.sha256 && !allAfter)) fail("Reviewed row changed after audit");
  return { ...item, sha256: item.sha256 || hash, unchanged_sha256: item.unchanged_sha256 || unchanged, updates, already_applied: allAfter };
}

export async function inspectReviewedAiFissionCopy(db, manifest, { lock = false, applying = lock } = {}) {
  validate(manifest, applying);
  const suffix = lock ? " FOR UPDATE" : "", planned = { drafts: [], templates: [] }, snapshots = [];
  for (const kind of ["drafts", "templates"]) for (const item of [...manifest[kind]].sort((a, b) => a.id - b.id)) {
    const definition = definitions[kind], [row] = await query(db, `SELECT * FROM ${definition.table} WHERE id = ?${suffix}`, [item.id]);
    if (!row || String(row.tenant_id ?? "admin") !== manifest.tenant_id || row.status === "deleted") fail("Reviewed row ownership or status changed");
    if (Buffer.byteLength(canonical(row)) > 8 * 1024 * 1024) fail("Reviewed row exceeds the repair size limit");
    if (kind === "drafts") {
      if (row.status !== "draft" || Number(row.template_id) !== item.template_id || Number(row.parent_draft_id || 0) !== item.parent_draft_id) fail("Reviewed draft identity changed");
      json(row.template_payload_json);
      if (item.parent_draft_id) {
        const [parent] = await query(db, `SELECT id, tenant_id FROM listing_drafts WHERE id = ?${suffix}`, [item.parent_draft_id]);
        if (!parent || String(parent.tenant_id ?? "admin") !== manifest.tenant_id) fail("Reviewed parent belongs to another tenant");
      }
      const [template] = await query(db, `SELECT id, tenant_id FROM listing_category_templates WHERE id = ?${suffix}`, [item.template_id]);
      if (!template || String(template.tenant_id ?? "admin") !== manifest.tenant_id) fail("Reviewed template belongs to another tenant");
    }
    const templateId = kind === "drafts" ? item.template_id : item.id;
    const references = await query(db, `SELECT id, tenant_id FROM listing_drafts WHERE template_id = ?${suffix}`, [templateId]);
    const expectedDraft = kind === "drafts" ? item.id : item.draft_id;
    if (kind === "templates" && (references.length !== 1 || Number(references[0].id) !== expectedDraft || String(references[0].tenant_id ?? "admin") !== manifest.tenant_id)) fail("Reviewed template is shared or foreign");
    const result = planRow(row, item, definition, applying);
    planned[kind].push(result); snapshots.push({ table: definition.table, row });
  }
  const reviewed = { ...manifest, drafts: planned.drafts.map(({ updates, already_applied, ...item }) => item), templates: planned.templates.map(({ updates, already_applied, ...item }) => item) };
  const summary = { rows: snapshots.length, changed_rows: Object.values(planned).flat().filter(item => Object.keys(item.updates).length).length,
    changed_columns: Object.values(planned).flat().reduce((sum, item) => sum + Object.keys(item.updates).length, 0) };
  return { reviewed_manifest: reviewed, summary, planned, snapshots };
}

export async function writeReviewedAiFissionCopyBackup(directory, value) {
  const file = await writeAiFissionCleanupBackup(directory, value);
  if (process.platform !== "win32") { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  return file;
}

export async function applyReviewedAiFissionCopy(db, manifest, directory, { backup = writeReviewedAiFissionCopyBackup } = {}) {
  const before = await inspectReviewedAiFissionCopy(db, manifest, { applying: true });
  const backupFile = before.summary.changed_rows ? await backup(directory, { version: 1, created_at: new Date().toISOString(), manifest, before: before.snapshots }) : null;
  await db.beginTransaction();
  try {
    const plan = await inspectReviewedAiFissionCopy(db, manifest, { lock: true });
    if (plan.summary.changed_rows && !backupFile) fail("Locked rows now require changes without a durable backup; audit again");
    if (plan.summary.changed_rows && !equal(plan.snapshots, before.snapshots)) fail("Locked rows differ from the durable backup; audit again");
    for (const [kind, definition] of Object.entries(definitions)) for (const item of plan.planned[kind]) {
      const columns = Object.keys(item.updates); if (!columns.length) continue;
      const result = await query(db, `UPDATE ${definition.table} SET ${columns.map(column => `${column} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id, 'admin') = ?`, [...columns.map(column => item.updates[column]), item.id, manifest.tenant_id]);
      if (result.affectedRows !== 1) fail("Expected exactly one owned repair row");
    }
    const verified = await inspectReviewedAiFissionCopy(db, manifest, { lock: true });
    if (verified.summary.changed_rows) fail("Saved copy differs from the reviewed after-state");
    await db.commit();
    return { ...plan.summary, backup_file: backupFile, verified: true };
  } catch (error) { await db.rollback(); throw error; }
}
