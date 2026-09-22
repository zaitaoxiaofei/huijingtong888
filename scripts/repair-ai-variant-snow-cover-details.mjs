import fs from "node:fs";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const SNOW_COVER_TITLE = /Зимний чехол.*лобовое стекло.*капот/i;

function loadDotEnv() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, index).trim();
    if (!(key in process.env)) process.env[key] = line.slice(index + 1);
  }
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function imageUrl(value) {
  return typeof value === "string" ? value.trim() : String(value?.url || value?.src || "").trim();
}

function imageObjects(values) {
  return values.map(imageUrl).filter(Boolean).map((url, index) => ({ url, sort_order: index + 1 }));
}

function sourceVariantImages(request = {}) {
  const material = request?.workbench_snapshot?.material || {};
  const payload = material.templatePayload || {};
  const editable = payload.editable_payload || payload.editablePayload || {};
  return Array.isArray(editable.variants?.[0]?.images) ? editable.variants[0].images : [];
}

function repairedPayload(row) {
  const request = parseJson(row.request_json, {});
  const sourceImages = sourceVariantImages(request);
  const sourceUrls = sourceImages.map(imageUrl).filter(Boolean);
  const childSourceUrls = parseJson(row.source_images_json, []).map(imageUrl).filter(Boolean);
  const childPayload = parseJson(row.template_payload_json, {});
  const editable = childPayload.editable_payload || childPayload.editablePayload || {};
  const childVariantUrls = (editable.variants?.[0]?.images || []).map(imageUrl).filter(Boolean);
  const mainUrl = childVariantUrls[0] || childSourceUrls[0];
  const detailUrls = sourceUrls.slice(1);
  if (!mainUrl || !detailUrls.length) return null;
  const urls = [mainUrl, ...detailUrls];
  const images = imageObjects(urls);
  const variants = Array.isArray(editable.variants) ? editable.variants.map((variant, index) => index === 0
    ? { ...variant, primary_image: mainUrl, images }
    : variant) : [];
  return {
    sourceImages: urls,
    templatePayload: {
      ...childPayload,
      images,
      primary_image: mainUrl,
      editable_payload: { ...editable, images, primary_image: mainUrl, variants }
    },
    detailCount: detailUrls.length
  };
}

loadDotEnv();
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4"
});

try {
  const [rows] = await connection.query(`
    SELECT d.id, d.internal_code, d.product_name, d.source_images_json, d.template_payload_json, j.request_json
    FROM listing_drafts d
    JOIN ai_variant_lab_batch_jobs j
      ON j.job_no = JSON_UNQUOTE(JSON_EXTRACT(d.ai_payload_json, '$.ai_optimization.job_no'))
    WHERE d.creation_method = 'ai_fission'
      AND JSON_UNQUOTE(JSON_EXTRACT(d.ai_payload_json, '$.ai_optimization.source')) = 'ai_variant_lab'
      AND JSON_UNQUOTE(JSON_EXTRACT(j.request_json, '$.workbench_snapshot.material.sourceType')) = 'record'
      AND JSON_LENGTH(COALESCE(JSON_EXTRACT(d.template_payload_json, '$.editable_payload.variants[0].images'), JSON_ARRAY())) = 1
      AND JSON_LENGTH(COALESCE(JSON_EXTRACT(j.request_json, '$.workbench_snapshot.material.templatePayload.editable_payload.variants[0].images'), JSON_ARRAY())) > 1
    ORDER BY d.id
  `);
  const repairs = rows.map((row) => ({ row, payload: repairedPayload(row) })).filter((item) => item.payload);
  if (repairs.some(({ row }) => !SNOW_COVER_TITLE.test(String(row.product_name || "")))) {
    throw new Error("候选集包含非汽车挡雪被草稿，已停止修复。");
  }
  if (!repairs.length) throw new Error("没有找到可修复的汽车挡雪被 AI 裂变草稿。");
  if (APPLY) {
    await connection.beginTransaction();
    try {
      for (const { row, payload } of repairs) {
        await connection.execute(`UPDATE listing_drafts
          SET source_images_json = ?, template_payload_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`, [JSON.stringify(payload.sourceImages), JSON.stringify(payload.templatePayload), row.id]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", repaired: repairs.length, sample: repairs.slice(0, 5).map(({ row, payload }) => ({ id: row.id, offerId: row.internal_code, imageCount: payload.sourceImages.length, reusedDetails: payload.detailCount })) }, null, 2));
} finally {
  await connection.end();
}
