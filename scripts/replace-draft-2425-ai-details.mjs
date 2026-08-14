import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createSession, destroySession } from "../src/server/session.js";
import { mysqlQuery } from "../src/mysql-pool.js";

const baseUrl = "http://127.0.0.1:8788";
const draftId = 2425;
const detailPaths = [
  "output/ai-suite/draft-2425/detail-capacity.png",
  "output/ai-suite/draft-2425/detail-materials.png",
  "output/ai-suite/draft-2425/detail-installation.png"
].map((item) => resolve(item));

let token = "";
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    body: options.body == null || typeof options.body === "string" ? options.body : JSON.stringify(options.body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} (${response.status}): ${data?.error || text}`);
  return data;
}

async function uploadDetail(filePath) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(filePath)], { type: "image/png" }), basename(filePath));
  form.append("source_module", "ai_ecommerce_suite_workbench");
  form.append("role", "listing_detail");
  const response = await fetch(`${baseUrl}/api/listing/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || `详情图上传失败：${response.status}`);
  return data.publishUrl || data.url || data.previewUrl;
}

try {
  const [owner] = await mysqlQuery(`
    SELECT p.id, p.name, p.role, p.username
    FROM listing_drafts d
    JOIN people p ON p.id = d.created_by_person_id
    WHERE d.id = ? LIMIT 1
  `, [draftId]);
  if (!owner) throw new Error("找不到草稿创建人");
  token = await createSession(owner.id, owner.name, owner.role, owner.username);
  const draft = await api(`/api/listing/drafts/${draftId}`);
  const detailUrls = [];
  for (const filePath of detailPaths) detailUrls.push(await uploadDetail(filePath));
  const payload = draft.template_payload || {};
  const editable = payload.editable_payload || {};
  const existingImages = draft.effective_images || draft.source_images || editable.images || [];
  const mainImage = typeof existingImages[0] === "string" ? existingImages[0] : existingImages[0]?.url;
  if (!mainImage) throw new Error("草稿缺少主图");
  const images = [mainImage, ...detailUrls];
  const imageObjects = images.map((url, index) => ({ url, role: index === 0 ? "main" : "detail", sort_order: index + 1 }));
  const variants = (Array.isArray(editable.variants) ? editable.variants : []).map((variant, index) => ({
    ...variant,
    ...(index === 0 ? { primary_image: mainImage } : {}),
    images: imageObjects,
    images_manually_edited: true,
    image_edit_intent: "ai_generated"
  }));
  const saved = await api(`/api/listing/drafts/${draftId}`, {
    method: "PUT",
    body: {
      ...draft,
      source_images: images,
      template_payload: {
        ...payload,
        images: imageObjects,
        editable_payload: { ...editable, images: imageObjects, variants }
      },
      manual_facts: {
        ...(draft.manual_facts || {}),
        detail_image_source: "ai_generated",
        generated_detail_image_urls: detailUrls
      }
    }
  });
  console.log(JSON.stringify({ ok: true, draftId: saved.id, mainImage, detailUrls, imageCount: images.length }, null, 2));
} finally {
  if (token) await destroySession(token).catch(() => {});
  process.exit(0);
}
