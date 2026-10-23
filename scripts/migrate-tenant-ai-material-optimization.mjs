import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA, AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA, verifyAiMaterialOptimizationSchema } from "../src/services/ai-material-optimization-schema.js";

const tables = [
  ["ai_material_optimization_batches", "uq_ai_material_batch_no", "batch_no", AI_MATERIAL_OPTIMIZATION_BATCH_SCHEMA],
  ["ai_material_optimization_items", "uq_ai_material_item_no", "item_no", AI_MATERIAL_OPTIMIZATION_ITEM_SCHEMA]
];
const parse = value => { try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; } };
export function aiMaterialRecordFingerprint(row) {
  const canonical = value => value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? value.toString("hex")
    : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(row))).digest("hex");
}
const businessKey = key => key === "admin" || /^[1-9]\d*$/.test(String(key));

// Default mode only inspects. Applying structural changes never assigns legacy
// rows to a customer/default enterprise. Conflicts keep their original identity
// in ownership_review_json and move together into a non-business quarantine key.
export async function migrateTenantAiMaterialOptimization(connection, { apply = false, reviewManifest = null } = {}) {
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  const report = { ok: true, mode: apply ? "apply" : "dry-run", tables: [], review: [], reviewed_batches: [], reviewable_batches: [], missing_dependencies: [], historical_assignment: "none; unproven records remain quarantined" };
  let locked = false;
  try {
    if (apply) {
      const [lock] = await query("SELECT GET_LOCK(CONCAT('material_tenant_', LEFT(SHA2(DATABASE(), 256), 32)), 60) acquired");
      if (Number(lock?.acquired) !== 1) throw new Error("Material optimization migration lock unavailable");
      locked = true;
    }
    const before = new Map();
    for (const [table, unique, key, schema] of tables) {
      const exists = (await query("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table])).length > 0;
      if (!exists) { report.tables.push({ table, create: true }); if (apply) await query(schema); before.set(table, []); continue; }
      const columns = await query(`SHOW COLUMNS FROM ${table}`), indexes = await query(`SHOW INDEX FROM ${table}`);
      const tenant = columns.find(row => row.Field === "tenant_id");
      const uniqueGroups = indexes.filter(row => row.Key_name !== "PRIMARY" && Number(row.Non_unique) === 0).sort((a,b) => a.Seq_in_index-b.Seq_in_index).reduce((map,row) => {
        map.set(row.Key_name, [...(map.get(row.Key_name) || []),row.Column_name]); return map;
      },new Map());
      const invalid = [...uniqueGroups].filter(([name, parts]) => !parts.includes("tenant_id") || name === unique && parts.join(",") !== `tenant_id,${key}`).map(([name]) => name);
      report.tables.push({ table, add_tenant_column: !tenant,
        tenant_definition: tenant ? { type: tenant.Type, nullable: tenant.Null, default: tenant.Default } : null,
        change_tenant_definition: !tenant || !/^varchar\(64\)$/i.test(tenant.Type) || tenant.Null !== "NO" || tenant.Default !== "legacy_review",
        add_checkpoint: table.endsWith("items") && !columns.some(row => row.Field === "checkpoint_json"),
        add_review_metadata: !columns.some(row => row.Field === "ownership_review_json"),
        remove_unscoped_unique_indexes: invalid, replace_unique: uniqueGroups.get(unique)?.join(",") !== `tenant_id,${key}` });
      before.set(table, await query(`SELECT * FROM ${table}`));
      if (!apply) continue;
      if (!tenant) await query(`ALTER TABLE ${table} ADD COLUMN tenant_id VARCHAR(64) NOT NULL DEFAULT 'legacy_review' AFTER id`);
      else {
        await query(`UPDATE ${table} SET tenant_id = 'legacy_review' WHERE tenant_id IS NULL OR tenant_id = ''`);
        await query(`ALTER TABLE ${table} MODIFY tenant_id VARCHAR(64) NOT NULL DEFAULT 'legacy_review'`);
      }
      if (table.endsWith("items") && !columns.some(row => row.Field === "checkpoint_json")) await query(`ALTER TABLE ${table} ADD COLUMN checkpoint_json LONGTEXT NULL AFTER operator_facts_json`);
      if (!columns.some(row => row.Field === "ownership_review_json")) await query(`ALTER TABLE ${table} ADD COLUMN ownership_review_json LONGTEXT NULL`);
      for (const name of invalid) {
        if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Unexpected index identifier");
        await query(`ALTER TABLE ${table} DROP INDEX \`${name}\``);
      }
      if (uniqueGroups.get(unique)?.join(",") !== `tenant_id,${key}`) await query(`ALTER TABLE ${table} ADD UNIQUE KEY ${unique} (tenant_id, ${key})`);
    }
    const dependencies = ["tenants","tenant_members","people","listing_drafts","ai_image_optimizer_jobs"];
    const available = new Set();
    for (const table of dependencies) {
      const rows = await query("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [table]);
      const required = table === "listing_drafts" ? ["id","tenant_id"] : table === "ai_image_optimizer_jobs" ? ["id","tenant_id","job_no"] : ["id"];
      const fields = new Set(rows.map(row => row.COLUMN_NAME || row.column_name));
      const ready = table === "tenant_members" ? ["tenant_id","person_id","active"].every(column => fields.has(column)) : required.every(column => fields.has(column));
      if (ready) available.add(table); else report.missing_dependencies.push(table);
    }
    const batches = before.get(tables[0][0]) || [], items = before.get(tables[1][0]) || [];
    const reviewed = new Map();
    report.reviewable_batches = batches.map(batch => ({ batch_id: Number(batch.id), expected_batch_sha256: aiMaterialRecordFingerprint(batch),
      items: items.filter(item => item.batch_no === batch.batch_no && String(item.tenant_id || "") === String(batch.tenant_id || "")).map(item => ({ item_id: Number(item.id), expected_sha256: aiMaterialRecordFingerprint(item) })) }));
    if (reviewManifest) {
      if (!String(reviewManifest.reason || "").trim() || !Array.isArray(reviewManifest.batches) || !reviewManifest.batches.length) throw new Error("Explicit review reason and batches required");
      for (const entry of reviewManifest.batches) {
        const batch = batches.find(row => Number(row.id) === Number(entry.batch_id));
        if (!batch || reviewed.has(Number(batch.id)) || !businessKey(entry.target_tenant) || aiMaterialRecordFingerprint(batch) !== entry.expected_batch_sha256
          || Number(batch.created_by_person_id) !== Number(entry.actor_person_id)) throw new Error("Reviewed material batch identity or fingerprint changed");
        const members = items.filter(item => item.batch_no === batch.batch_no && String(item.tenant_id || "") === String(batch.tenant_id || ""));
        if (!Array.isArray(entry.items) || !members.length || entry.items.length !== members.length || Number(batch.total_count) !== members.length
          || new Set(entry.items.map(item => Number(item.item_id))).size !== members.length) throw new Error("Reviewed material batch must include its exact complete item set");
        if (!["tenants","tenant_members","people","listing_drafts","ai_image_optimizer_jobs"].every(table => available.has(table))) throw new Error("Reviewed material batch dependencies unavailable");
        const needsActiveActor = [batch,...members].some(record => ["queued","running"].includes(record.status));
        const memberships = await query(`SELECT t.id FROM tenants t JOIN tenant_members tm ON tm.tenant_id = t.id JOIN people p ON p.id = tm.person_id
          WHERE (CAST(t.id AS CHAR) = ? OR (? = 'admin' AND t.slug = 'default')) AND tm.person_id = ?${needsActiveActor ? " AND tm.active = 1 AND p.active = 1" : ""}`,[entry.target_tenant,entry.target_tenant,entry.actor_person_id]);
        if (memberships.length !== 1) throw new Error("Reviewed material original membership unavailable");
        for (const item of members) {
          const checked = entry.items.find(row => Number(row.item_id) === Number(item.id));
          if (!checked || aiMaterialRecordFingerprint(item) !== checked.expected_sha256 || Number(item.created_by_person_id) !== Number(entry.actor_person_id)
            || Number(checked.source_draft_id) !== Number(item.source_draft_id) || Number(checked.result_draft_id || 0) !== Number(item.result_draft_id || 0)
            || String(checked.optimizer_job_no || "") !== String(item.optimizer_job_no || "")) throw new Error("Reviewed material item identity or fingerprint changed");
          for (const id of [item.source_draft_id,item.result_draft_id].filter(Boolean)) {
            const draft = await query("SELECT COALESCE(tenant_id, 'admin') tenant_id FROM listing_drafts WHERE id = ?",[id]);
            if (draft.length !== 1 || String(draft[0].tenant_id) !== String(entry.target_tenant)) throw new Error("Reviewed material draft ownership mismatch");
          }
          if (!item.source_draft_id) throw new Error("Reviewed material source draft missing");
          if (item.optimizer_job_no && !(await query("SELECT id FROM ai_image_optimizer_jobs WHERE tenant_id = ? AND job_no = ?",[entry.target_tenant,item.optimizer_job_no])).length) throw new Error("Reviewed optimizer task ownership mismatch");
        }
        reviewed.set(Number(batch.id),{ ...entry, members });
        report.reviewed_batches.push({ batch_id:Number(batch.id),item_ids:members.map(item => Number(item.id)),target_tenant:entry.target_tenant });
      }
    }
    const reasonsByItem = new Map();
    const membershipReasons = async row => {
      const reasons = [];
      if (!businessKey(row.tenant_id)) reasons.push("missing_reviewed_enterprise");
      if (!Number(row.created_by_person_id)) reasons.push("missing_original_actor");
      if (businessKey(row.tenant_id) && Number(row.created_by_person_id)) {
        if (!["tenants","tenant_members","people"].every(table => available.has(table))) reasons.push("membership_dependency_missing");
        else {
          // A former employee's completed work keeps its proven enterprise.
          // Current activity controls resumable execution, not history ownership.
          const needsActiveActor = ["queued","running"].includes(row.status);
          const members = await query(`SELECT t.id FROM tenants t JOIN tenant_members tm ON tm.tenant_id = t.id JOIN people p ON p.id = tm.person_id
            WHERE (CAST(t.id AS CHAR) = ? OR (? = 'admin' AND t.slug = 'default')) AND tm.person_id = ?${needsActiveActor ? " AND tm.active = 1 AND p.active = 1" : ""}`, [row.tenant_id,row.tenant_id,row.created_by_person_id]);
          if (members.length !== 1) reasons.push("original_membership_unavailable");
        }
      }
      return reasons;
    };
    for (const row of items) {
      const reasons = await membershipReasons(row);
      for (const [field,id] of [["source_draft_id",row.source_draft_id],["result_draft_id",row.result_draft_id]]) {
        if (!id) { if (field === "source_draft_id") reasons.push("source_draft_missing"); continue; }
        if (!available.has("listing_drafts")) { reasons.push(`${field}_dependency_missing`); continue; }
        const drafts = await query("SELECT COALESCE(tenant_id, 'admin') tenant_id FROM listing_drafts WHERE id = ?", [id]);
        if (drafts.length !== 1 || String(drafts[0].tenant_id) !== String(row.tenant_id)) reasons.push(`${field}_ownership_unproven`);
      }
      if (row.optimizer_job_no) {
        if (!available.has("ai_image_optimizer_jobs")) reasons.push("optimizer_dependency_missing");
        else if (!(await query("SELECT id FROM ai_image_optimizer_jobs WHERE tenant_id = ? AND job_no = ?", [row.tenant_id || "legacy_review",row.optimizer_job_no])).length) reasons.push("optimizer_job_ownership_unproven");
      }
      const batch = batches.filter(batch => batch.batch_no === row.batch_no && String(batch.tenant_id || "") === String(row.tenant_id || ""));
      if (batch.length !== 1 || Number(batch[0]?.created_by_person_id) !== Number(row.created_by_person_id)) reasons.push("batch_actor_mismatch");
      reasonsByItem.set(Number(row.id),reasons);
    }
    const quarantinedItems = new Set();
    if (apply) await connection.beginTransaction();
    try {
      const quarantine = async (table,row,key,reasons,tenant) => {
        report.review.push({ table,id:Number(row.id),record_no:row[key],reasons });
        if (!apply) return;
        // Repeated apply preserves the first original identity and status.
        const existing = parse(row.ownership_review_json);
        const metadata = Object.keys(existing).length ? existing : { tenant_id: row.tenant_id ?? null,created_by_person_id:row.created_by_person_id,status:row.status,stage:row.stage || null,reasons,original_record:row };
        const status = ["queued","running"].includes(row.status) ? "paused_review" : row.status;
        await query(`UPDATE ${table} SET tenant_id = ?,status = ?,ownership_review_json = ? WHERE id = ?`, [tenant,status,JSON.stringify(metadata),row.id]);
      };
      for (const batch of batches) {
        const approval = reviewed.get(Number(batch.id));
        if (approval) {
          if (apply) {
            const reviewEntry = { reason:reviewManifest.reason,target_tenant:approval.target_tenant };
            const existing = parse(batch.ownership_review_json);
            const original = Object.keys(existing).length ? existing : { tenant_id:batch.tenant_id ?? null,created_by_person_id:batch.created_by_person_id,status:batch.status,original_record:batch };
            const metadata = { ...original,reviewed_target_tenant:approval.target_tenant,review_history:[...(original.review_history || []),reviewEntry] };
            await query("UPDATE ai_material_optimization_batches SET tenant_id = ?,status = ?,ownership_review_json = ? WHERE id = ?",[approval.target_tenant,["queued","running"].includes(batch.status) ? "paused_review" : batch.status,JSON.stringify(metadata),batch.id]);
            for (const item of approval.members) {
              const existingItem = parse(item.ownership_review_json);
              const originalItem = Object.keys(existingItem).length ? existingItem : { tenant_id:item.tenant_id ?? null,created_by_person_id:item.created_by_person_id,status:item.status,stage:item.stage,original_record:item };
              const itemMetadata = {...originalItem,reviewed_target_tenant:approval.target_tenant,review_history:[...(originalItem.review_history || []),reviewEntry]};
              await query("UPDATE ai_material_optimization_items SET tenant_id = ?,status = ?,ownership_review_json = ? WHERE id = ?",[approval.target_tenant,["queued","running"].includes(item.status) ? "paused_review" : item.status,JSON.stringify(itemMetadata),item.id]);
            }
          }
          for (const item of approval.members) quarantinedItems.add(Number(item.id));
          continue;
        }
        const members = items.filter(item => item.batch_no === batch.batch_no && String(item.tenant_id || "") === String(batch.tenant_id || ""));
        const reasons = await membershipReasons(batch);
        if (members.some(item => reasonsByItem.get(Number(item.id))?.length)) reasons.push("item_ownership_unproven");
        if (!members.length && Number(batch.total_count || 0) > 0) reasons.push("batch_members_missing");
        if (!reasons.length) continue;
        const tenant = `legacy_review:b${batch.id}`;
        await quarantine(tables[0][0],batch,"batch_no",reasons,tenant);
        for (const item of members) { quarantinedItems.add(Number(item.id)); await quarantine(tables[1][0],item,"item_no",[...new Set([...(reasonsByItem.get(Number(item.id)) || []),"batch_ownership_unproven"])],tenant); }
      }
      for (const item of items) if (!quarantinedItems.has(Number(item.id)) && reasonsByItem.get(Number(item.id))?.length) {
        await quarantine(tables[1][0],item,"item_no",reasonsByItem.get(Number(item.id)),`legacy_review:i${item.id}`);
      }
      if (apply) await connection.commit();
    } catch(error) { if (apply) await connection.rollback(); throw error; }
    if (apply) await verifyAiMaterialOptimizationSchema(query);
    return report;
  } finally {
    if (locked) await query("SELECT RELEASE_LOCK(CONCAT('material_tenant_', LEFT(SHA2(DATABASE(), 256), 32)))");
  }
}
async function main() {
  const args = process.argv.slice(2), value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length+1);
  const socketPath = value("--mysql-admin-socket"),database = value("--database");
  if (!socketPath || !database) throw new Error("Explicit --mysql-admin-socket and --database required; business defaults are never loaded");
  const connection = await mysql.createConnection({ socketPath,database,user:"root" });
  try {
    const manifestPath = value("--review-manifest");
    const reviewManifest = manifestPath ? JSON.parse(await fs.readFile(manifestPath,"utf8")) : null;
    console.log(JSON.stringify(await migrateTenantAiMaterialOptimization(connection,{apply:args.includes("--apply"),reviewManifest}),null,2));
  }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
