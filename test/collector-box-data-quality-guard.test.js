import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const draftPreparerSource = readFileSync(new URL("../src/services/listing-draft-preparer.js", import.meta.url), "utf8");
const normalizerSource = readFileSync(new URL("../src/services/listing-collected-normalizer.js", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const listingAutomationViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const listingRecordEditorSource = readFileSync(new URL("../frontend/admin/views/listing/ListingRecordEditorView.vue", import.meta.url), "utf8");
const listingPublishRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");

test("collector-box template creation blocks incomplete unresolved category data", () => {
  assert.match(serviceSource, /function collectorBoxTemplateBlockingIssues/);
  assert.match(serviceSource, /function buildCollectorBoxQualitySummary/);
  assert.match(serviceSource, /title === `Ozon \$\{sku\}`/);
  assert.match(serviceSource, /categoryId\.startsWith\("frontend:"\)/);
  assert.match(serviceSource, /categoryId\.startsWith\("pending:"\)/);
  assert.match(serviceSource, /error\.validation = \{/);
  assert.match(serviceSource, /allow_incomplete/);
});

test("collector-box UI flags incomplete collected rows before opening listing editor", () => {
  assert.match(collectorBoxSource, /function collectorDataQualityIssues/);
  assert.match(collectorBoxSource, /采集数据不完整/);
  assert.match(collectorBoxSource, /采集不完整/);
  assert.match(collectorBoxSource, /collectorDataQualityOk\(row\)/);
});

test("collector-box list uses stored quality summary without returning edit payload JSON", () => {
  assert.match(serviceSource, /quality_status VARCHAR\(32\) NOT NULL DEFAULT 'unknown'/);
  assert.match(serviceSource, /quality_issues_json LONGTEXT NULL/);
  assert.match(serviceSource, /facts_status VARCHAR\(32\) NOT NULL DEFAULT 'unknown'/);
  assert.match(serviceSource, /quality_status, quality_issues_json, facts_status/);
  const fnStart = serviceSource.indexOf("export async function collectorBoxProducts");
  const fnEnd = serviceSource.indexOf("export async function collectorBoxProductDetail", fnStart);
  const fnSource = serviceSource.slice(fnStart, fnEnd);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  assert.doesNotMatch(fnSource, /listing_template_id,\s*edit_payload_json,\s*edited_at/);
  assert.doesNotMatch(fnSource, /JSON_EXTRACT\(/);
  assert.match(fnSource, /category_name,\s*price, currency/);
  assert.match(fnSource, /"status <> 'deleted'"/);
  assert.doesNotMatch(fnSource, /LOWER\(TRIM\(COALESCE\(status/);
  assert.match(serviceSource, /idx_ozon_plugin_tenant_status_updated/);
});

test("collector-box pagination skips repeated count and summary scans", () => {
  assert.match(collectorBoxSource, /countMode: "skip"/);
  assert.match(collectorBoxSource, /result\.total !== undefined && result\.total !== null/);
  assert.match(serviceSource, /const includeCount = !\["skip", "none", "false", "0"\]\.includes\(countMode\)/);
  assert.match(serviceSource, /includeCount \? row\(countSql, params\) : Promise\.resolve\(null\)/);
});

test("collector-box incomplete rows can still open manual listing editor", () => {
  assert.match(collectorBoxSource, /openMode: "listing_editor"/);
  assert.match(collectorBoxSource, /allowIncomplete: true/);
  assert.doesNotMatch(collectorBoxSource, /if \(qualityIssues\.length\) \{[\s\S]{0,180}return;\s*\}/);
  assert.match(serviceSource, /const allowManualEditor = String\(body\?\.openMode \|\| body\?\.open_mode \|\| ""\)\.trim\(\) === "listing_editor"/);
  assert.match(serviceSource, /const allowIncomplete = allowManualEditor \|\| Boolean\(body\?\.allow_incomplete \|\| body\?\.allowIncomplete\)/);
  assert.match(serviceSource, /const fallbackCategoryId = `pending:\$\{detail\.sku \|\| Date\.now\(\)\}`/);
  assert.doesNotMatch(serviceSource, /const fallbackCategoryId = `frontend:/);
  assert.match(draftPreparerSource, /fallback: `pending:\$\{source\.sku/);
});

test("unconfirmed collected categories never appear as selected draft categories", () => {
  assert.match(normalizerSource, /manual_confirmation_required/);
  assert.match(listingAutomationViewSource, /categoryDiagnostics\.confidence === "manual_confirmation_required"/);
  assert.match(listingAutomationViewSource, /templateEditor\.ozon_category_id = categoryNeedsConfirmation \? "" : ozonCategoryValue/);
  assert.match(listingAutomationViewSource, /templateEditor\.category_name = categoryNeedsConfirmation \? ""/);
  assert.match(listingAutomationViewSource, /该类目尚未确认，请重新选择正式 Ozon 类目/);
  assert.match(serviceSource, /source: "collector_existing_uncached"/);
  assert.match(serviceSource, /confidence: "manual_confirmation_required"/);
});

test("collector-box category resolution matches Russian category names", () => {
  assert.match(serviceSource, /name_ru LIKE \? OR path_ru LIKE \?/);
  assert.match(serviceSource, /WHEN name_ru = \? THEN 2/);
  assert.match(serviceSource, /WHEN path_ru LIKE \? THEN 6/);
});

test("collector-box accepts collected official category pairs before local cache warmup", () => {
  const resolverStart = serviceSource.indexOf("async function resolveCollectorBoxListingCategory");
  const resolverEnd = serviceSource.indexOf("export async function saveListingCollectedProductDetail", resolverStart);
  const resolverSource = serviceSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /return cached \? normalizeOzonCategoryRow\(cached\) : \{/);
  assert.doesNotMatch(resolverSource, /if \(!cached[^\n]+continue;/);
});

test("collector-box reused unresolved category templates are upgraded from collected category ids", () => {
  assert.match(serviceSource, /async function repairCollectorBoxTemplateCategoryDisplay/);
  assert.match(serviceSource, /await resolveCollectorBoxListingCategory\(detail, \{\}, null\)/);
  assert.match(serviceSource, /categoryId\.startsWith\("pending:"\)/);
  assert.match(serviceSource, /const nextCategoryId = resolvedDescriptionCategoryId && resolvedTypeId/);
  assert.match(serviceSource, /SET ozon_category_id = \?, category_name = \?, editable_payload_json = \?, updated_at = CURRENT_TIMESTAMP/);
  assert.match(serviceSource, /description_category_id: resolvedDescriptionCategoryId/);
  assert.match(serviceSource, /type_id: resolvedTypeId/);
});

test("collector-box stores and displays collected prices as CNY", () => {
  assert.match(serviceSource, /currency: "CNY"/);
  assert.match(serviceSource, /priceCurrency: "CNY"/);
  assert.match(collectorBoxSource, /function formatCurrency/);
  assert.match(collectorBoxSource, /return "人民币"/);
  assert.doesNotMatch(collectorBoxSource, /detail\.currency \|\| "RUB"/);
});

test("collector-box list and detail expose collected dimensions and weight", () => {
  assert.match(serviceSource, /length_cm DECIMAL\(10,2\) NULL/);
  assert.match(serviceSource, /width_cm DECIMAL\(10,2\) NULL/);
  assert.match(serviceSource, /height_cm DECIMAL\(10,2\) NULL/);
  assert.match(serviceSource, /weight_g DECIMAL\(12,2\) NULL/);
  assert.match(serviceSource, /function collectorBoxStoredDimensions/);
  assert.match(serviceSource, /const dimensions = normalizeCollectedDimensions\(editPayload, rawPayload, row\)/);
  assert.match(serviceSource, /length_cm: dimensions\.length_cm/);
  assert.match(collectorBoxSource, /function prepareCollectorRows/);
  assert.match(collectorBoxSource, /function rowDimensions/);
  assert.match(collectorBoxSource, /label="尺寸\/重量"/);
  assert.match(collectorBoxSource, /formatRowDimensions\(row\)/);
  assert.match(collectorBoxSource, /dimensionCmValue\(.*dimensions\.unit/s);
});

test("listing templates drafts and publish editors default prices to CNY", () => {
  assert.match(serviceSource, /currency_code: String\(body\?\.currency_code \|\| body\?\.currencyCode \|\| "CNY"\)/);
  assert.match(serviceSource, /currency_code: request\?\.currency_code \|\| "CNY"/);
  assert.match(serviceSource, /DEFAULT 'CNY'/);
  assert.match(draftPreparerSource, /currency_code: source\.currency \|\| editPayload\.currency \|\| followPayload\.currecny \|\| "CNY"/);
  assert.match(listingAutomationViewSource, /currency_code: "CNY"/);
  assert.match(listingAutomationViewSource, /editorCurrencyCode = computed\(\(\) => String\(templateEditor\.currency_code \|\| "CNY"\)/);
  assert.match(listingRecordEditorSource, /currency_code: "CNY"/);
  assert.match(listingPublishRecordsSource, /row\.currency_code \|\| "CNY"/);
});
