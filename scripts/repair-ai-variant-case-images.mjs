import fs from "node:fs";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const TEMP_AI_FILE_RE = /\/api\/ai\/file\//i;

function loadDotEnv() {
  const file = ".env";
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isTempAiUrl(value) {
  return TEMP_AI_FILE_RE.test(String(value || ""));
}

function cleanUrl(value) {
  return String(value || "").trim();
}

function firstStableUrl(...values) {
  const urls = values.map(cleanUrl).filter(Boolean);
  return urls.find((url) => !isTempAiUrl(url)) || "";
}

function firstTempUrl(...values) {
  return values.map(cleanUrl).filter((url) => url && isTempAiUrl(url))[0] || "";
}

function generatedResultUrls(imageResult = {}) {
  const images = [
    ...(Array.isArray(imageResult.croppedImages) ? imageResult.croppedImages : []),
    ...(Array.isArray(imageResult.generatedImages) ? imageResult.generatedImages : [])
  ];
  return images.map((item) => cleanUrl(item?.url)).filter(Boolean);
}

function mainImageAssetUrls(asset = {}) {
  return [
    asset.publishUrl,
    asset.url,
    asset.localUrl,
    asset.downloadUrl,
    asset.originalAiFileUrl
  ].map(cleanUrl).filter(Boolean);
}

function assetStableUrl(asset = {}) {
  return firstStableUrl(...mainImageAssetUrls(asset));
}

function indexAssetRows(rows = []) {
  const byResultId = new Map();
  const byTarget = new Map();
  const byOriginalUrl = new Map();
  for (const row of rows) {
    const asset = parseJson(row.asset_json, {});
    const normalized = { row, asset, stableUrl: assetStableUrl(asset) };
    const resultId = cleanUrl(row.result_id);
    const target = cleanUrl(row.variant_target).toLowerCase();
    const original = cleanUrl(asset.originalAiFileUrl || asset.url || asset.downloadUrl);
    if (resultId && !byResultId.has(resultId)) byResultId.set(resultId, normalized);
    if (target && !byTarget.has(target)) byTarget.set(target, normalized);
    if (original && !byOriginalUrl.has(original)) byOriginalUrl.set(original, normalized);
  }
  return { byResultId, byTarget, byOriginalUrl };
}

function findAssetMatch(indexes, sampleRow = {}) {
  const resultId = cleanUrl(sampleRow.item_no);
  const target = cleanUrl(sampleRow.target_variant_value).toLowerCase();
  const currentAsset = sampleRow.assets?.main_image || {};
  const originals = [
    currentAsset.originalAiFileUrl,
    sampleRow.generated_main_image_original_url,
    sampleRow.generated_main_image_url,
    ...generatedResultUrls(sampleRow.image_result)
  ].map(cleanUrl).filter(Boolean);
  return (
    (resultId && indexes.byResultId.get(resultId))
    || (target && indexes.byTarget.get(target))
    || originals.map((url) => indexes.byOriginalUrl.get(url)).find(Boolean)
    || null
  );
}

async function materializeIfPossible(url, caseNo, sampleRow) {
  if (!APPLY || !url) return "";
  const { materializeListingMediaAssetUrl } = await import("../src/services/listing-automation.js");
  const result = await materializeListingMediaAssetUrl(url, {
    source_module: "ai_variant_case_repair",
    source_id: caseNo,
    batch_id: sampleRow.item_no || "",
    role: "ai_variant_case_image_repair"
  });
  return firstStableUrl(result.finalUrl, result.publishUrl, result.localUrl);
}

async function main() {
  loadDotEnv();
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: "utf8mb4"
  });

  const [caseRows] = await connection.query(`
    SELECT case_no, case_name, case_json
    FROM ai_variant_case_templates
    WHERE status != 'deleted'
    ORDER BY updated_at DESC
  `);
  const [assetRows] = await connection.query(`
    SELECT result_id, variant_target, asset_json
    FROM listing_ai_variant_assets
    WHERE field_key = 'main_image' AND status != 'deleted'
    ORDER BY updated_at DESC, id DESC
  `);

  const assetIndexes = indexAssetRows(assetRows);
  const summary = {
    mode: APPLY ? "apply" : "dry-run",
    cases: caseRows.length,
    repairedCases: 0,
    changedRows: 0,
    stableRows: 0,
    unrepairedRows: 0
  };
  const details = [];

  for (const row of caseRows) {
    const caseJson = parseJson(row.case_json, {});
    const sampleRows = Array.isArray(caseJson.sample_rows) ? caseJson.sample_rows : [];
    let changed = false;
    let firstStableGeneratedUrl = "";

    for (const sampleRow of sampleRows) {
      const currentAsset = sampleRow.assets?.main_image || {};
      const currentUrls = [
        ...mainImageAssetUrls(currentAsset),
        sampleRow.generated_main_image_url,
        sampleRow.generated_main_image_original_url,
        ...generatedResultUrls(sampleRow.image_result)
      ];
      let stableUrl = firstStableUrl(...currentUrls);
      let assetMatch = null;
      if (!stableUrl) {
        assetMatch = findAssetMatch(assetIndexes, sampleRow);
        stableUrl = assetMatch?.stableUrl || "";
      }
      if (!stableUrl) {
        stableUrl = await materializeIfPossible(firstTempUrl(...currentUrls), row.case_no, sampleRow);
      }
      if (!stableUrl) {
        summary.unrepairedRows += 1;
        continue;
      }

      summary.stableRows += 1;
      const beforeRowJson = JSON.stringify(sampleRow);
      if (!sampleRow.generated_main_image_original_url && isTempAiUrl(sampleRow.generated_main_image_url)) {
        sampleRow.generated_main_image_original_url = sampleRow.generated_main_image_url;
      }
      if (sampleRow.generated_main_image_url !== stableUrl) {
        sampleRow.generated_main_image_url = stableUrl;
        changed = true;
      }
      sampleRow.assets = sampleRow.assets || {};
      sampleRow.assets.main_image = {
        ...(assetMatch?.asset || {}),
        ...currentAsset,
        url: stableUrl,
        publishUrl: currentAsset.publishUrl || assetMatch?.asset?.publishUrl || stableUrl,
        localUrl: currentAsset.localUrl || assetMatch?.asset?.localUrl || "",
        downloadUrl: currentAsset.downloadUrl || assetMatch?.asset?.downloadUrl || "",
        originalAiFileUrl: currentAsset.originalAiFileUrl || sampleRow.generated_main_image_original_url || ""
      };
      sampleRow.row_snapshot = sampleRow.row_snapshot || {};
      sampleRow.row_snapshot.generated_main_image_url = stableUrl;
      if (!firstStableGeneratedUrl) firstStableGeneratedUrl = stableUrl;
      if (JSON.stringify(sampleRow) !== beforeRowJson) summary.changedRows += 1;
    }

    if (firstStableGeneratedUrl) {
      caseJson.sample_assets = caseJson.sample_assets || {};
      if (!caseJson.sample_assets.generated_main_image_original_url && isTempAiUrl(caseJson.sample_assets.generated_main_image_url)) {
        caseJson.sample_assets.generated_main_image_original_url = caseJson.sample_assets.generated_main_image_url;
      }
      if (caseJson.sample_assets.generated_main_image_url !== firstStableGeneratedUrl) {
        caseJson.sample_assets.generated_main_image_url = firstStableGeneratedUrl;
        caseJson.sample_assets.generated_main_image_asset_url = firstStableGeneratedUrl;
        changed = true;
      }
    }

    if (changed) {
      summary.repairedCases += 1;
      details.push({ case_no: row.case_no, case_name: row.case_name, target: caseJson.success_target_value || "" });
      if (APPLY) {
        await connection.execute(
          "UPDATE ai_variant_case_templates SET case_json = ?, updated_at = CURRENT_TIMESTAMP WHERE case_no = ?",
          [JSON.stringify(caseJson), row.case_no]
        );
      }
    }
  }

  await connection.end();
  console.log(JSON.stringify({ ...summary, details: details.slice(0, 50) }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
