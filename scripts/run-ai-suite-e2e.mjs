import { generateCommerceCopy, generateImages } from "../src/server/services/ai/aiWorkflowService.js";
import { createSession, destroySession } from "../src/server/session.js";
import { mysqlQuery } from "../src/mysql-pool.js";

const baseUrl = "http://127.0.0.1:8788";
const category = {
  ozonCategoryId: "82169566:92186",
  descriptionCategoryId: "82169566",
  typeId: "92186",
  name: "汽车用品 / 收纳箱和汽车包 / 汽车收纳袋"
};
const productUrls = [
  "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/90/90f38ca673d346062b39b0b62bb187713da7086570d413d9fa8af92f67c965ef.jpg",
  "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/43/43fb8ff8f455eb2e795e9aef1139225a621c7b45c5972a4cbf0c1e306ca1e009.jpg",
  "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/86/86427453173e9918e8a7b499c422b40525e27daf5cc90e795a7c0582c4806677.jpg",
  "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/9b/9b35edf7e5b8baa4046702a0956423af111346b92734311e1810f74b2b0c8ce2.jpg"
];
const styleUrl = "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/79/7950ce98fb9cc0085e0979a1038bea743ec22a4b83deb4051bcb2a62389fea82.png";
const facts = {
  product_title_zh: "吉利 EX5 EM-i 中控屏幕后方收纳盒",
  description_zh: "安装于吉利 EX5 EM-i 中控屏幕后方的车内收纳盒，ABS 塑料主体，接触面为硅胶，可收纳手机、钥匙等车内杂物。",
  compatibility_zh: ["吉利 EX5 EM-i"],
  selling_points_zh: ["ABS 塑料主体", "硅胶接触面", "适合收纳手机、钥匙等车内杂物", "利用中控屏幕后方空间"],
  package_contents_zh: ["收纳盒 1 个"],
  forbidden_facts_zh: [],
  confirmed_by_operator: true
};

let token = "";
async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body == null || typeof options.body === "string" ? options.body : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${data?.error || text}`);
  return data;
}

function generatedImageUrl(output = {}) {
  return output.generatedImages?.[0]?.url || output.croppedImages?.[0]?.url || output.images?.[0]?.url || output.url || "";
}

try {
  const [person] = await mysqlQuery("SELECT id, name, role, username FROM people WHERE active = 1 ORDER BY id LIMIT 1");
  if (!person) throw new Error("没有可用的本地测试用户");
  token = await createSession(person.id, person.name, person.role, person.username);

  console.log("[e2e] 1/5 generating Russian copy");
  const copy = await generateCommerceCopy({
    productName: facts.product_title_zh,
    title: facts.product_title_zh,
    summary: facts.description_zh,
    sellingPoints: facts.selling_points_zh.join("；"),
    exactProductIdentity: JSON.stringify(facts),
    rules: ["Generate precise Russian title, search tags and description.", "Never invent product facts or output Chinese."],
    sourceContext: { operatorFacts: facts, conversation: [facts.description_zh], categoryTemplate: category },
    aiTimeoutMs: 180000
  });
  const title = copy.titles?.[0] || copy.title;
  const tags = Array.isArray(copy.tags) ? copy.tags : [];
  const description = copy.description || "";
  if (!title || !tags.length || !description) throw new Error("俄语文案结果不完整");

  console.log("[e2e] 2/5 generating one 3:4 main image");
  const imageOutput = await generateImages({
    sourceImageUrl: productUrls[0],
    sourceImageUrls: [...productUrls, styleUrl],
    productImageCount: productUrls.length,
    fallbackSourceImageUrl: productUrls[0],
    ratio: "3:4",
    imageCount: 1,
    autoCrop: false,
    finalPrompt: [
      "Create one 3:4 premium Russian ecommerce main image.",
      "The first four references are authoritative product photos of the same Geely EX5 EM-i rear-screen storage box.",
      "The fifth reference is style-only: borrow its black-blue premium hierarchy, lighting and typography mood.",
      `OPERATOR-CONFIRMED FACTS: ${JSON.stringify(facts)}.`,
      `REQUIRED RUSSIAN HEADLINE: ${copy.imageHeadline || title}.`,
      `REQUIRED RUSSIAN SELLING POINTS: ${JSON.stringify((copy.imageSellingPoints || []).slice(0, 3))}.`,
      "Remove all Chinese source captions. Never render Chinese, random letters, watermarks, marketplace logos or unsupported claims.",
      "Keep the exact product shape. Use readable Russian text and do not cover the product."
    ].join("\n\n")
  });
  const mainImage = generatedImageUrl(imageOutput);
  if (!mainImage) throw new Error("主图生成未返回可用图片");

  console.log("[e2e] 3/6 generating three AI detail images");
  const detailOutput = await generateImages({
    sourceImageUrl: productUrls[0],
    sourceImageUrls: [...productUrls, styleUrl],
    productImageCount: productUrls.length,
    fallbackSourceImageUrl: productUrls[0],
    ratio: "3:4",
    imageCount: 3,
    autoCrop: false,
    finalPrompt: [
      "Create three distinct 3:4 Russian ecommerce detail images for the exact referenced product.",
      "Image 1: storage capacity and usage; image 2: ABS body and silicone insert; image 3: installation behind the central screen.",
      `OPERATOR-CONFIRMED FACTS: ${JSON.stringify(facts)}.`,
      "The returned images must be newly AI-generated. Never reuse or return the uploaded source images.",
      "Russian text only. No Chinese, random letters, watermark, marketplace logo or unsupported claim."
    ].join("\n\n")
  });
  const detailImages = (detailOutput.generatedImages || detailOutput.croppedImages || detailOutput.images || [])
    .map((item) => typeof item === "string" ? item : item?.url)
    .filter(Boolean);
  if (detailImages.length < 3) throw new Error(`详情图生成数量不足：期望 3，实际 ${detailImages.length}`);
  if (detailImages.some((url) => productUrls.includes(url))) throw new Error("详情图生成结果错误地复用了上传原图");

  console.log("[e2e] 4/6 resolving category template");
  const templates = await api("/api/listing/templates");
  const templateSummary = templates.find((item) => String(item.ozon_category_id || item.editable_payload?.ozon_category_id || "") === category.ozonCategoryId);
  if (!templateSummary?.id) throw new Error("指定三级类目没有可用模板");
  const template = await api(`/api/listing/templates/${templateSummary.id}`);

  console.log("[e2e] 5/6 creating listing draft");
  const images = [mainImage, ...detailImages];
  const imageObjects = images.map((url, index) => ({ url, role: index === 0 ? "main" : "detail", sort_order: index + 1 }));
  const offer = await api("/api/listing/generate-offer-id", { method: "POST", body: { prefix: "SUITE", existingIds: [] } });
  const offerId = offer.offerId || offer.offer_id;
  const editable = template.editable_payload || {};
  const templatePayload = {
    ...template,
    title,
    description,
    images: imageObjects,
    editable_payload: {
      ...editable,
      title,
      name: title,
      description,
      tags,
      hashtags: tags,
      images: imageObjects,
      variants: (Array.isArray(editable.variants) && editable.variants.length ? editable.variants : [{}]).map((variant, index) => ({
        ...variant,
        ...(index === 0 ? { primary_image: mainImage } : {}),
        images: imageObjects,
        images_manually_edited: true,
        image_edit_intent: "manual"
      }))
    }
  };
  const draft = await api("/api/listing/drafts/ai-variant-lightweight", {
    method: "POST",
    body: {
      template_id: Number(templateSummary.id),
      template_payload: templatePayload,
      clone_source_draft: false,
      development_type: "new",
      product_name: title,
      offer_id: offerId,
      internal_code: offerId,
      source_images: images,
      patch: { offer_id: offerId, title, description, tags, images },
      manual_facts: { operator_product_facts: facts, style_reference_urls: [styleUrl], image_edit_intent: "manual" },
      ai_optimization: { source: "ai_ecommerce_suite_workbench", storyboard: [], reference_board_url: productUrls[0] },
      changed_fields: ["offer_id", "title", "description", "tags", "images"]
    }
  });
  const draftId = draft.id || draft.draft_id;
  if (!draftId) throw new Error("草稿创建成功但未返回 ID");

  console.log("[e2e] 6/6 verifying saved draft");
  const saved = await api(`/api/listing/drafts/${draftId}`);
  const savedEditable = saved?.template_payload?.editable_payload || saved?.editable_payload || {};
  const savedImages = saved?.effective_images || savedEditable.images || saved?.images || [];
  if (!saved?.product_name && !saved?.template_payload?.title && !savedEditable.title) throw new Error("草稿验证失败：标题为空");
  if (!Array.isArray(savedImages) || savedImages.length < 2) throw new Error("草稿验证失败：图片未保存");
  console.log(JSON.stringify({ ok: true, draftId, offerId, templateId: templateSummary.id, category: category.name, title, tagCount: tags.length, imageCount: savedImages.length, mainImage }, null, 2));
} finally {
  if (token) await destroySession(token).catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
