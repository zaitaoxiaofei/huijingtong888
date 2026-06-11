import { materialAssets } from "../src/services/material-assets.js";
import { materializeListingMediaAssetUrl } from "../src/services/listing-automation.js";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";

const write = process.argv.includes("--write");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.min(Math.max(Number(limitArg?.split("=")[1] || 200), 1), 5000);

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function shouldMaterialize(row = {}) {
  const values = [row.thumbnail_url, row.url, row.local_url, row.publish_url].map((value) => String(value || "").trim());
  const sourceUrl = values.find(Boolean);
  if (!sourceUrl || /^data:/i.test(sourceUrl)) return false;
  if (row.local_url && (row.publish_url || !/^https?:\/\//i.test(row.url || ""))) return false;
  if (/^\/api\/ai\/file\//i.test(sourceUrl)) return true;
  if (/^https?:\/\//i.test(sourceUrl)) return true;
  return false;
}

async function main() {
  if (write) await materialAssets({ limit: 1 });
  const rows = await mysqlQuery(`
    SELECT *
    FROM material_assets
    WHERE asset_type = 'image'
      AND status <> 'deleted'
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `, [limit]);
  const candidates = rows.filter(shouldMaterialize);
  console.log(`material-assets candidates=${candidates.length} scanned=${rows.length} mode=${write ? "write" : "dry-run"}`);
  let updated = 0;
  let skipped = 0;
  for (const row of candidates) {
    const sourceUrl = String(row.thumbnail_url || row.url || row.local_url || row.publish_url || "").trim();
    if (!write) {
      console.log(`would-update id=${row.id} ${sourceUrl}`);
      updated += 1;
      continue;
    }
    const result = await materializeListingMediaAssetUrl(sourceUrl, {
      source_module: row.source_type || "material_asset_repair",
      source_id: row.source_id || String(row.id),
      batch_id: row.source_package_id || row.variant_task_id || "",
      role: row.role || "material_asset"
    });
    if (!result?.finalUrl || result.status === "skipped") {
      skipped += 1;
      console.log(`skip id=${row.id} status=${result?.status || "empty"} error=${result?.error || ""}`);
      continue;
    }
    const metadata = parseJson(row.metadata_json, {});
    const nextMetadata = {
      ...metadata,
      mediaMaterialization: {
        sourceUrl,
        localUrl: result.localUrl || "",
        publishUrl: result.publishUrl || "",
        finalUrl: result.finalUrl || "",
        status: result.status || "",
        listingMediaAssetId: result.asset?.id || null,
        repairedBy: "scripts/materialize-material-assets.mjs"
      }
    };
    const nextUrl = result.publishUrl || result.localUrl || result.finalUrl;
    const nextThumb = result.localUrl || result.finalUrl;
    console.log(`update id=${row.id} ${sourceUrl} -> ${nextUrl}`);
    await mysqlExecute(`
      UPDATE material_assets
      SET url = ?,
          thumbnail_url = ?,
          local_url = ?,
          publish_url = ?,
          metadata_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      nextUrl,
      nextThumb,
      result.localUrl || row.local_url || "",
      result.publishUrl || row.publish_url || "",
      JSON.stringify(nextMetadata),
      row.id
    ]);
    updated += 1;
  }
  console.log(`done updated=${updated} skipped=${skipped} mode=${write ? "write" : "dry-run"}`);
}

main().finally(() => closeMysqlPool());
