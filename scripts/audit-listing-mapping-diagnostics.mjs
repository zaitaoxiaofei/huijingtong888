import { closeMysqlPool } from "../src/mysql-pool.js";
import {
  collectorBoxMappingDiagnostics,
  collectorBoxProducts,
  listingCategoryTemplates,
  listingTemplateMappingDiagnostics,
  repairListingTemplateMapping
} from "../src/services/listing-automation.js";

const sampleLimit = Math.max(1, Number(process.env.LISTING_MAPPING_AUDIT_LIMIT || 50));
const tenantId = String(process.env.LISTING_MAPPING_AUDIT_TENANT || "admin").trim() || "admin";
const timeoutMs = Math.max(1000, Number(process.env.LISTING_MAPPING_AUDIT_TIMEOUT_MS || 45000));
const repairPreview = process.env.LISTING_MAPPING_REPAIR_PREVIEW === "1";
const repairApply = process.env.LISTING_MAPPING_REPAIR_APPLY === "1";
const allowEmptySchemaRepair = process.env.LISTING_MAPPING_REPAIR_ALLOW_EMPTY_SCHEMA === "1";

function withTimeout(promise, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarizeDiagnostics(items = []) {
  const summary = {
    total: items.length,
    ok: 0,
    categoryOk: 0,
    blockers: 0,
    warnings: 0,
    missingRequired: 0,
    dictionaryUnresolved: 0,
    outsideCategory: 0,
    nameOnlyMatches: 0,
    avgScore: 0
  };
  let scoreTotal = 0;
  for (const item of items) {
    const result = item.result || {};
    const resultSummary = result.summary || {};
    if (result.ok) summary.ok += 1;
    if (result.category?.ok) summary.categoryOk += 1;
    summary.blockers += Number(resultSummary.blockers || 0);
    summary.warnings += Number(resultSummary.warnings || 0);
    summary.missingRequired += Number(resultSummary.missing_required || 0);
    summary.dictionaryUnresolved += Number(resultSummary.dictionary_unresolved || 0);
    summary.outsideCategory += Number(resultSummary.outside_category || 0);
    summary.nameOnlyMatches += Number(resultSummary.name_only_matches || 0);
    scoreTotal += Number(result.score || 0);
  }
  summary.avgScore = summary.total ? Math.round(scoreTotal / summary.total) : 0;
  return summary;
}

function topIssues(items = [], limit = 12) {
  const counts = new Map();
  for (const item of items) {
    for (const issue of item.result?.issues || []) {
      const key = `${issue.level || "info"}:${issue.code || issue.title || "unknown"}`;
      const current = counts.get(key) || { key, level: issue.level || "info", code: issue.code || "", title: issue.title || "", count: 0, examples: [] };
      current.count += 1;
      if (current.examples.length < 3) current.examples.push(item.label);
      counts.set(key, current);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function printSection(title, summary, issues) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.table([summary]);
  if (issues.length) {
    console.log("Top issues:");
    console.table(issues.map((item) => ({
      level: item.level,
      code: item.code,
      title: item.title,
      count: item.count,
      examples: item.examples.join(", ")
    })));
  }
}

function printRepairPreview(items = []) {
  if (!items.length) return;
  console.log("\nTemplate repair preview");
  console.log("-----------------------");
  console.table(items.map((item) => ({
    template: item.label,
    original: item.preview?.summary?.original_attribute_count || 0,
    normalized: item.preview?.summary?.normalized_attribute_count || 0,
    unmapped: item.preview?.summary?.unmapped_attribute_count || 0,
    schema: item.preview?.summary?.schema_attribute_count || 0,
    applied: Boolean(item.preview?.applied),
    skipped: item.preview?.skipped || ""
  })));
}

function shouldApplyRepair(preview = {}) {
  const summary = preview.summary || {};
  if (allowEmptySchemaRepair) return true;
  if (!Number(summary.schema_attribute_count || 0)) return false;
  if (!Number(summary.normalized_attribute_count || 0)) return false;
  return true;
}

async function auditCollectorBox() {
  const page = await collectorBoxProducts({ page: 1, pageSize: sampleLimit, tenantId });
  const rows = page.rows || [];
  const items = [];
  for (const row of rows) {
    try {
      const result = await collectorBoxMappingDiagnostics(row.sku, { tenantId, auto_sync: false });
      items.push({ label: `collector:${row.sku}`, result });
    } catch (error) {
      items.push({
        label: `collector:${row.sku}`,
        result: {
          ok: false,
          score: 0,
          category: { ok: false },
          summary: { blockers: 1, warnings: 0 },
          issues: [{ level: "blocker", code: "audit_error", title: error.message || String(error) }]
        }
      });
    }
  }
  return items;
}

async function auditTemplates() {
  const rows = (await listingCategoryTemplates(null)).slice(0, sampleLimit);
  const items = [];
  for (const row of rows) {
    try {
      const result = await listingTemplateMappingDiagnostics(row.id, { auto_sync: false });
      let preview = null;
      if (repairPreview || repairApply) {
        preview = await repairListingTemplateMapping(row.id, { auto_sync: false, apply: false });
        if (repairApply) {
          if (shouldApplyRepair(preview)) {
            preview = await repairListingTemplateMapping(row.id, { auto_sync: false, apply: true });
          } else {
            preview = {
              ...preview,
              skipped: "empty_schema_or_normalized_attributes"
            };
          }
        }
      }
      items.push({ label: `template:${row.id}`, result, preview });
    } catch (error) {
      items.push({
        label: `template:${row.id}`,
        result: {
          ok: false,
          score: 0,
          category: { ok: false },
          summary: { blockers: 1, warnings: 0 },
          issues: [{ level: "blocker", code: "audit_error", title: error.message || String(error) }]
        }
      });
    }
  }
  return items;
}

try {
  const collectorItems = await withTimeout(auditCollectorBox(), "collector mapping audit");
  const templateItems = await withTimeout(auditTemplates(), "template mapping audit");
  printSection("Collector box mapping audit", summarizeDiagnostics(collectorItems), topIssues(collectorItems));
  printSection("Listing template mapping audit", summarizeDiagnostics(templateItems), topIssues(templateItems));
  if (repairPreview || repairApply) printRepairPreview(templateItems);
} finally {
  await closeMysqlPool();
}
