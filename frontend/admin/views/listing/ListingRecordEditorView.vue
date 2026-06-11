<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowLeft, Check, Delete, MagicStick, Refresh, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import OzonRichContentEditor from "../../components/listing/OzonRichContentEditor.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const submitting = ref(false);
const deleting = ref(false);
const aiAction = ref("");
const translating = ref(false);
const technicalJsonLoaded = ref(false);
const richEditorVisible = ref(false);
let rawPayloadCache = null;
let rawResponseCache = null;

const state = reactive({
  recordId: null,
  updated_at: "",
  shopId: null,
  shopName: "",
  status: "",
  payloadText: "",
  responseText: "",
  translation: {
    title: "",
    tags: "",
    description: "",
    richJson: ""
  },
  form: {
    name: "",
    offer_id: "",
    price: "",
    old_price: "",
    currency_code: "RUB",
    primary_image: "",
    imagesText: "",
    videoUrlsText: "",
    description_category_id: "",
    type_id: "",
    weight: "",
    depth: "",
    width: "",
    height: "",
    tagsText: "",
    description: "",
    richJson: ""
  }
});

const imagePreview = computed(() => [state.form.primary_image, ...splitLines(state.form.imagesText)].filter(Boolean).slice(0, 8));
const richPreview = computed(() => parseRichContentPreview(state.form.richJson));

function listingRecordReturnTarget() {
  const returnTo = String(route.query.returnTo || "").trim();
  if (!returnTo) return null;
  const query = {
    listingRecordId: String(state.recordId || route.query.recordId || "").trim()
  };
  return { path: returnTo, query };
}

function backToRecordListOrReturn() {
  const target = listingRecordReturnTarget();
  if (target) {
    router.push(target);
    return;
  }
  router.push({ name: "listing-publish-records" });
}

onMounted(loadDraft);

async function loadDraft() {
  const key = String(route.query.recordDraft || "").trim();
  const recordId = Number(route.query.recordId || 0) || null;
  if (!key && !recordId) return;
  loading.value = true;
  try {
    let draft = null;
    if (key) {
      const raw = sessionStorage.getItem(key);
      if (raw) draft = JSON.parse(raw);
    }
    if (!draft && recordId) {
      const row = await apiClient.get(`/api/listing/publish-records/${recordId}`, { noCache: true });
      if (row?.id) draft = buildDraftFromRow(row);
    }
    if (!draft) {
      ElMessage.warning("没有找到这条上架记录，请从上架记录列表重新打开");
      return;
    }
    applyDraft(draft);
  } catch (error) {
    ElMessage.error(error.message || "载入上架记录失败");
  } finally {
    loading.value = false;
  }
}

function buildDraftFromRow(row) {
  const template = buildTemplateFromDetailRow(row);
  return {
    record_id: row.id,
    updated_at: row.updated_at || "",
    shop_id: row.shop_id,
    shop_name: row.shop_name,
    status: row.status,
    template,
    response: {
      response: row.response,
      error: row.error
    }
  };
}

function buildTemplateFromDetailRow(row) {
  const snapshot = plainClone(row.template_snapshot, null);
  if (snapshot?.editable_payload) {
    const editable = snapshot.editable_payload || {};
    const sourceRaw = plainClone(snapshot.source_raw || editable.source_raw || row.request || {}, {});
    sourceRaw.record_id = row.id;
    sourceRaw.shop_id = row.shop_id;
    sourceRaw.from_publish_record = true;
    if (!sourceRaw.offer_id) sourceRaw.offer_id = row.offer_id || editable.sku || "";
    return {
      ...snapshot,
      source_raw: sourceRaw,
      editable_payload: {
        ...editable,
        source_raw: sourceRaw
      }
    };
  }
  return {
    source_raw: row.request || {},
    editable_payload: {
      source_raw: row.request || {}
    }
  };
}

function applyDraft(draft) {
  const template = draft.template || {};
  const editable = template.editable_payload || {};
  const sourceRaw = draft.template?.editable_payload?.source_raw || draft.template?.source_raw || draft.request || {};
  const item = sourceRaw.items?.[0] || {};
  const fallbackDescriptionCategoryId = String(
    item.description_category_id
    || editable.description_category_id
    || sourceRaw.description_category_id
    || sourceRaw.descriptionCategoryId
    || template.description_category_id
    || ""
  ).trim();
  const fallbackTypeId = String(
    item.type_id
    || editable.type_id
    || sourceRaw.type_id
    || sourceRaw.typeId
    || template.type_id
    || ""
  ).trim();
  state.recordId = Number(draft.record_id || draft.recordId || route.query.recordId || 0) || null;
  state.updated_at = draft.updated_at || draft.updatedAt || "";
  state.shopId = Number(draft.shop_id || draft.shopId || sourceRaw.shop_id || 0) || null;
  state.shopName = draft.shop_name || "";
  state.status = draft.status || "";
  rawPayloadCache = sourceRaw.items ? sourceRaw : { items: [item] };
  rawResponseCache = draft.response || {};
  state.payloadText = "";
  state.responseText = "";
  technicalJsonLoaded.value = false;
  state.translation = { title: "", tags: "", description: "", richJson: "" };
  state.form = {
    name: item.name || template.title || "",
    offer_id: item.offer_id || editable.sku || "",
    price: item.price || editable.price?.value || "",
    old_price: item.old_price || editable.price?.old_price || "",
    currency_code: item.currency_code || editable.price?.currency_code || "RUB",
    primary_image: item.primary_image || "",
    imagesText: (item.images || []).join("\n"),
    videoUrlsText: extractVideoUrls(item).join("\n"),
    description_category_id: fallbackDescriptionCategoryId,
    type_id: fallbackTypeId,
    weight: item.weight || "",
    depth: item.depth || "",
    width: item.width || "",
    height: item.height || "",
    tagsText: extractTags(item).join("\n"),
    description: item.description || findAttributeText(item, [4191], ["简介", "Аннотация", "Описание"]) || "",
    richJson: item.rich_content_json || extractRichContent(item) || ""
  };
}

function applyFormToPayload() {
  const payload = technicalJsonLoaded.value
    ? JSON.parse(state.payloadText || "{}")
    : plainClone(rawPayloadCache || {}, {});
  if (!Array.isArray(payload.items) || !payload.items[0]) payload.items = [{}];
  const item = payload.items[0];
  item.name = state.form.name;
  item.offer_id = state.form.offer_id;
  item.price = String(state.form.price || "");
  item.old_price = String(state.form.old_price || state.form.price || "");
  item.currency_code = state.form.currency_code || "RUB";
  item.primary_image = state.form.primary_image;
  item.images = splitLines(state.form.imagesText);
  item.description_category_id = state.form.description_category_id;
  item.type_id = state.form.type_id;
  item.weight = Number(state.form.weight || 0);
  item.depth = Number(state.form.depth || 0);
  item.width = Number(state.form.width || 0);
  item.height = Number(state.form.height || 0);
  item.description = state.form.description;
  item.tags = splitLines(state.form.tagsText);
  item.rich_content_json = state.form.richJson;
  setAttributeValues(item, 23171, "产品标签", item.tags);
  setAttributeValues(item, 4191, "简介", [state.form.description].filter(Boolean));
  setRichContent(item, state.form.richJson);
  setVideoUrls(item, splitLines(state.form.videoUrlsText));
  state.payloadText = JSON.stringify(payload, null, 2);
  rawPayloadCache = payload;
  technicalJsonLoaded.value = true;
  return payload;
}

async function submitRecord() {
  if (!state.recordId) {
    ElMessage.warning("缺少上架记录 ID");
    return;
  }
  let payload;
  try {
    payload = applyFormToPayload();
  } catch {
    ElMessage.error("技术 JSON 格式不正确");
    return;
  }
  await ElMessageBox.confirm("确认按当前修改内容重新提交 Ozon？", "重新提交", {
    type: "warning",
    confirmButtonText: "重新提交",
    cancelButtonText: "取消"
  });
  submitting.value = true;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${state.recordId}/retry`, {
      payload,
      updated_at: state.updated_at || ""
    });
    state.updated_at = updated.updated_at || "";
    state.status = updated.status;
    rawResponseCache = { response: updated.response, error: updated.error };
    if (technicalJsonLoaded.value) state.responseText = JSON.stringify(rawResponseCache, null, 2);
    ElMessage.success("已重新提交 Ozon，可回到上架记录稍后刷新状态");
    if (listingRecordReturnTarget()) {
      backToRecordListOrReturn();
    }
  } finally {
    submitting.value = false;
  }
}

function loadTechnicalJson() {
  if (!technicalJsonLoaded.value) {
    state.payloadText = JSON.stringify(rawPayloadCache || {}, null, 2);
    state.responseText = JSON.stringify(rawResponseCache || {}, null, 2);
    technicalJsonLoaded.value = true;
  }
}

async function deleteRecord() {
  if (!state.recordId) return;
  await ElMessageBox.confirm("删除后记录不再显示，不会下架 Ozon 已上架商品。", "删除上架记录", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  deleting.value = true;
  try {
    await apiClient.delete(`/api/listing/publish-records/${state.recordId}`);
    ElMessage.success("上架记录已删除");
    backToRecordListOrReturn();
  } finally {
    deleting.value = false;
  }
}

async function runAi(type) {
  aiAction.value = type;
  try {
    const result = await apiClient.post("/api/ai/deepseek/generate", {
      type,
      context: buildAiContext(type)
    });
    const fields = result?.data?.fields || {};
    const content = String(result?.data?.content || "").trim();
    if (type === "title") state.form.name = String(fields.title || fields.name || content || state.form.name).trim();
    if (type === "tags" || type === "keywords") {
      const tags = normalizeAiTags(fields.tags || fields.keywords || content);
      if (tags.length) state.form.tagsText = tags.join("\n");
    }
    if (type === "shortDescription") {
      state.form.description = String(fields.summary || fields.description || content || state.form.description).trim();
    }
    if (type === "description") {
      const richValue = fields.richJson || fields.rich_json || fields.richContent || "";
      if (richValue) state.form.richJson = typeof richValue === "string" ? richValue : JSON.stringify(richValue, null, 2);
      const summary = String(fields.summary || fields.description || "").trim();
      if (summary) state.form.description = summary;
    }
    applyFormToPayload();
    ElMessage.success("AI 已生成并回填当前字段");
  } catch (error) {
    ElMessage.error(error.message || "AI 生成失败，请检查 AI 配置");
  } finally {
    aiAction.value = "";
  }
}

async function translateCurrentCopy() {
  translating.value = true;
  try {
    const result = await apiClient.post("/api/ai/deepseek/generate", {
      type: "translateZh",
      context: {
        marketplace: "Ozon Russia",
        instruction: "Translate Russian listing text into concise Chinese meaning for an operator. Do not rewrite source fields.",
        fields: {
          title: state.form.name,
          tags: splitLines(state.form.tagsText),
          description: state.form.description,
          richJsonText: richPreview.value.text
        }
      }
    });
    const fields = result?.data?.fields || {};
    state.translation.title = String(fields.titleZh || fields.title_zh || fields.title || "").trim();
    state.translation.tags = normalizeTranslationText(fields.tagsZh || fields.tags_zh || fields.tags);
    state.translation.description = String(fields.descriptionZh || fields.description_zh || fields.description || result?.data?.content || "").trim();
    state.translation.richJson = String(fields.richJsonZh || fields.rich_zh || fields.richJson || "").trim();
    ElMessage.success("中文释义已生成，原俄语内容未覆盖");
  } catch (error) {
    ElMessage.error(error.message || "翻译失败，请检查 AI 配置");
  } finally {
    translating.value = false;
  }
}

function buildAiContext(type) {
  return {
    target: {
      type,
      outputContract: aiOutputContract(type)
    },
    marketplace: "Ozon Russia",
    language: "Russian",
    form: {
      title: state.form.name,
      offer_id: state.form.offer_id,
      price: state.form.price,
      tags: splitLines(state.form.tagsText),
      summary: state.form.description,
      richJson: state.form.richJson,
      description_category_id: state.form.description_category_id,
      type_id: state.form.type_id,
      dimensionsMm: {
        depth: state.form.depth,
        width: state.form.width,
        height: state.form.height,
        weight: state.form.weight
      }
    },
    media: {
      images: imagePreview.value
    },
    sourcePayload: technicalJsonLoaded.value ? safeJson(state.payloadText) : plainClone(rawPayloadCache || {}, {}),
    aiRules: [
      "Return valid JSON only. No markdown, no explanation.",
      "Use fluent, natural Russian for Ozon buyers.",
      "Do not invent unsupported compatibility, material grade, certification, or brand.",
      "Tags must start with # and be deduplicated.",
      "Summary must be 150-250 Russian words in coherent buyer-facing prose.",
      "The summary must read like a real product description with smooth sentence flow, not a stitched mix of title words and tags.",
      "Use only a few relevant search phrases when they fit naturally. Do not force every tag into the summary and do not write a keyword block."
    ]
  };
}

function aiOutputContract(type) {
  if (type === "title") return { content: "Russian title", fields: { title: "Russian Ozon title" } };
  if (type === "tags" || type === "keywords") return { content: "tags", fields: { tags: ["#tag"] } };
  if (type === "shortDescription") return { content: "Russian description", fields: { summary: "150-250 fluent Russian words, coherent product description, not keyword stuffing" } };
  if (type === "description") return { content: "rich content", fields: { summary: "150-250 fluent Russian words, coherent product description", richJson: "Ozon rich-content JSON string" } };
  return { content: "result", fields: {} };
}

function extractVideoUrls(item = {}) {
  return (item.complex_attributes || [])
    .flatMap((group) => group.attributes || [])
    .filter((attr) => Number(attr.id || 0) === 21841)
    .flatMap((attr) => attr.values || [])
    .map((value) => String(value.value || "").trim())
    .filter(Boolean);
}

function setVideoUrls(item, urls = []) {
  const others = (item.complex_attributes || []).filter((group) => {
    const attrs = group.attributes || [];
    return !attrs.some((attr) => [21841, 21837].includes(Number(attr.id || 0)));
  });
  if (urls.length) {
    others.push({
      attributes: [
        { complex_id: 100001, id: 21841, values: urls.map((url) => ({ value: url })) },
        { complex_id: 100001, id: 21837, values: urls.map((url, index) => ({ value: videoName(url, index) })) }
      ]
    });
  }
  item.complex_attributes = others;
}

function videoName(url, index) {
  try {
    return new URL(url).pathname.split("/").pop()?.replace(/\.[^.]+$/, "") || `video_${index + 1}`;
  } catch {
    return `video_${index + 1}`;
  }
}

function extractTags(item = {}) {
  const direct = splitLines(item.tags || item.hashtags || item.main_tags || "");
  if (direct.length) return direct;
  return splitLines(findAttributeText(item, [23171, 10096], ["产品标签", "标签", "tag", "ключевые слова", "тег"]));
}

function findAttributeText(item = {}, ids = [], names = []) {
  const idSet = new Set(ids.map((id) => String(id)));
  const attr = (item.attributes || []).find((field) => {
    const id = String(field.id || field.attribute_id || "");
    const name = String(field.name || field.attribute_name || "").toLowerCase();
    return idSet.has(id) || names.some((candidate) => name.includes(String(candidate).toLowerCase()));
  });
  return (attr?.values || []).map((value) => value.value || value.name || value).join(",");
}

function setAttributeValues(item, id, name, values = []) {
  const list = splitLines(values);
  item.attributes = Array.isArray(item.attributes) ? item.attributes : [];
  const existing = item.attributes.find((attr) => Number(attr.id || attr.attribute_id || 0) === Number(id));
  if (!list.length) {
    item.attributes = item.attributes.filter((attr) => Number(attr.id || attr.attribute_id || 0) !== Number(id));
    return;
  }
  const next = {
    id,
    attribute_id: id,
    name,
    values: list.map((value) => ({ value }))
  };
  if (existing) Object.assign(existing, next);
  else item.attributes.push(next);
}

function extractRichContent(item = {}) {
  const direct = findAttributeText(item, [11254], ["rich", "JSON富内容"]);
  if (direct) return direct;
  return (item.complex_attributes || [])
    .flatMap((group) => group.attributes || [])
    .find((attr) => Number(attr.id || attr.attribute_id || 0) === 11254 || String(attr.id || "").toLowerCase() === "rich_content_json")
    ?.values?.[0]?.value || "";
}

function setRichContent(item, richJson = "") {
  const text = String(richJson || "").trim();
  setAttributeValues(item, 11254, "JSON富内容", text ? [text] : []);
  const groups = (item.complex_attributes || []).filter((group) => {
    const attrs = group.attributes || [];
    return !attrs.some((attr) => Number(attr.id || attr.attribute_id || 0) === 11254 || String(attr.id || "").toLowerCase() === "rich_content_json");
  });
  if (text) groups.push({ attributes: [{ id: "rich_content_json", values: [{ value: text }] }] });
  item.complex_attributes = groups;
}

function parseRichContentPreview(value) {
  const text = String(value || "").trim();
  if (!text) return { blocks: [], images: [], text: "" };
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object") return { blocks: [{ title: "原始文本", text }], images: [], text };
  const blocks = [];
  const images = [];
  visitRichNode(parsed, blocks, images);
  return {
    blocks: blocks.length ? blocks : [{ title: "JSON 内容", text: JSON.stringify(parsed, null, 2) }],
    images: [...new Set(images)].slice(0, 8),
    text: blocks.map((block) => [block.title, block.text].filter(Boolean).join("\n")).join("\n\n")
  };
}

function handleRichEditorSave(value) {
  state.form.richJson = value;
  applyFormToPayload();
  ElMessage.success("Ozon 图文富内容已更新");
}

function visitRichNode(node, blocks, images) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => visitRichNode(item, blocks, images));
    return;
  }
  if (typeof node !== "object") return;
  const image = node.url || node.src || node.image || node.imageUrl || node.image_url;
  if (typeof image === "string" && image.trim()) images.push(image.trim());
  const title = node.title || node.heading || node.header;
  const text = node.text || node.content || node.description;
  if (typeof title === "string" || typeof text === "string") {
    blocks.push({ title: String(title || "").trim(), text: String(text || "").trim() });
  }
  Object.values(node).forEach((value) => visitRichNode(value, blocks, images));
}

function normalizeAiTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,，;\s]+/);
  return [...new Set(raw.map((item) => String(item || "").trim()).filter(Boolean).map((item) => item.startsWith("#") ? item : `#${item}`))].slice(0, 20);
}

function normalizeTranslationText(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value || "").trim();
}

function splitLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/\r?\n|,|，/).map((item) => item.trim()).filter(Boolean);
}

function safeJson(value) {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return null;
  }
}

function plainClone(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}
</script>

<template>
  <div class="page-stack record-editor" v-loading="loading">
    <OzonRichContentEditor
      v-model="state.form.richJson"
      v-model:visible="richEditorVisible"
      :title="state.form.name"
      @save="handleRichEditorSave"
    />

    <section class="workspace-header">
      <div>
        <h1>编辑上架</h1>
        <p>从上架记录带入原始请求，修改标题、文案、素材和技术参数后重新提交。</p>
      </div>
      <div class="header-actions">
        <el-button
          v-if="listingRecordReturnTarget()"
          class="erp-btn erp-btn-secondary"
          :icon="ArrowLeft"
          @click="backToRecordListOrReturn"
        >
          返回AI工作台
        </el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="ArrowLeft" @click="router.push({ name: 'listing-publish-records' })">返回记录</el-button>
        <el-button class="erp-btn erp-btn-danger" type="danger" plain :icon="Delete" :loading="deleting" @click="deleteRecord">删除记录</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Check" :loading="submitting" @click="submitRecord">重新提交 Ozon</el-button>
      </div>
    </section>

    <el-alert v-if="state.recordId" type="warning" :closable="false" show-icon :title="`正在编辑记录 #${state.recordId}`" />

    <section class="editor-grid">
      <div class="editor-panel">
        <div class="panel-title">
          <h2>基础信息</h2>
          <el-button size="small" :icon="MagicStick" :loading="aiAction === 'title'" @click="runAi('title')">AI 标题</el-button>
        </div>
        <el-form label-width="110px">
          <el-form-item label="标题"><el-input v-model="state.form.name" /></el-form-item>
          <el-form-item label="Offer ID"><el-input v-model="state.form.offer_id" /></el-form-item>
          <div class="form-row">
            <el-form-item label="售价"><el-input v-model="state.form.price" /></el-form-item>
            <el-form-item label="划线价"><el-input v-model="state.form.old_price" /></el-form-item>
            <el-form-item label="币种"><el-input v-model="state.form.currency_code" /></el-form-item>
          </div>
          <div class="form-row">
            <el-form-item label="类目 ID"><el-input v-model="state.form.description_category_id" /></el-form-item>
            <el-form-item label="类型 ID"><el-input v-model="state.form.type_id" /></el-form-item>
          </div>
          <div class="form-row">
            <el-form-item label="重量 g"><el-input v-model="state.form.weight" /></el-form-item>
            <el-form-item label="长 mm"><el-input v-model="state.form.depth" /></el-form-item>
            <el-form-item label="宽 mm"><el-input v-model="state.form.width" /></el-form-item>
            <el-form-item label="高 mm"><el-input v-model="state.form.height" /></el-form-item>
          </div>
        </el-form>
      </div>

      <div class="editor-panel">
        <h2>素材</h2>
        <el-form label-width="110px">
          <el-form-item label="主图 URL"><el-input v-model="state.form.primary_image" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="附图 URL"><el-input v-model="state.form.imagesText" type="textarea" :rows="7" placeholder="每行一个图片 URL" /></el-form-item>
          <el-form-item label="视频 URL"><el-input v-model="state.form.videoUrlsText" type="textarea" :rows="5" placeholder="每行一个视频公网 URL" /></el-form-item>
        </el-form>
        <div class="image-strip" v-if="imagePreview.length">
          <ProductImagePreview
            v-for="(url, index) in imagePreview"
            :key="`${index}-${url}`"
            :src="url"
            :preview-list="imagePreview"
            :initial-index="index"
            fit="contain"
            size="default"
          />
        </div>
      </div>
    </section>

    <section class="editor-grid">
      <div class="editor-panel">
        <div class="panel-title">
          <h2>标题 / 标签 / 简介</h2>
          <div class="panel-actions">
            <el-button size="small" :icon="MagicStick" :loading="aiAction === 'tags'" @click="runAi('tags')">AI 标签</el-button>
            <el-button size="small" :icon="MagicStick" :loading="aiAction === 'shortDescription'" @click="runAi('shortDescription')">AI 简介</el-button>
            <el-button size="small" :icon="View" :loading="translating" @click="translateCurrentCopy">翻译释义</el-button>
          </div>
        </div>
        <el-form label-width="110px">
          <el-form-item label="产品标签">
            <el-input v-model="state.form.tagsText" type="textarea" :rows="5" placeholder="每行一个俄语标签，例如 #коврик" />
          </el-form-item>
          <el-form-item label="简介">
            <el-input v-model="state.form.description" type="textarea" :rows="7" placeholder="俄语简介，不懂时先点翻译释义查看中文意思" />
          </el-form-item>
        </el-form>
        <div v-if="state.translation.title || state.translation.tags || state.translation.description" class="translation-card">
          <strong>中文释义预览</strong>
          <p v-if="state.translation.title">标题：{{ state.translation.title }}</p>
          <p v-if="state.translation.tags">标签：{{ state.translation.tags }}</p>
          <p v-if="state.translation.description">简介：{{ state.translation.description }}</p>
          <p v-if="state.translation.richJson">富内容：{{ state.translation.richJson }}</p>
        </div>
      </div>

      <div class="editor-panel">
        <div class="panel-title">
          <h2>富内容预览</h2>
          <div class="panel-actions">
            <el-button size="small" type="primary" :icon="View" @click="richEditorVisible = true">图文编辑</el-button>
            <el-button size="small" :icon="MagicStick" :loading="aiAction === 'description'" @click="runAi('description')">AI 富内容</el-button>
          </div>
        </div>
        <el-input v-model="state.form.richJson" type="textarea" :rows="8" placeholder="Ozon rich content JSON。下方会自动解析成人能看的图文预览。" />
        <div class="rich-preview">
          <div v-if="richPreview.images.length" class="image-strip rich-images">
            <ProductImagePreview
              v-for="(url, index) in richPreview.images"
              :key="`${index}-${url}`"
              :src="url"
              :preview-list="richPreview.images"
              :initial-index="index"
              fit="contain"
              size="default"
            />
          </div>
          <article v-for="(block, index) in richPreview.blocks" :key="index" class="rich-block">
            <h3 v-if="block.title">{{ block.title }}</h3>
            <p v-if="block.text">{{ block.text }}</p>
          </article>
          <el-empty v-if="!richPreview.blocks.length && !richPreview.images.length" description="暂无可预览的富内容" />
        </div>
      </div>
    </section>

    <section class="editor-panel">
      <div class="panel-title">
        <h2>技术 JSON</h2>
        <el-button v-if="!technicalJsonLoaded" class="erp-btn erp-btn-secondary" :icon="View" @click="loadTechnicalJson">加载技术 JSON</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="applyFormToPayload">同步表单到 JSON</el-button>
      </div>
      <el-input v-if="technicalJsonLoaded" v-model="state.payloadText" type="textarea" :rows="16" />
      <el-empty v-else description="技术 JSON 较大，默认不渲染；需要查看或手改时再加载。" />
    </section>

    <section class="editor-panel">
      <h2>Ozon 返回 / 错误</h2>
      <el-input v-if="technicalJsonLoaded" v-model="state.responseText" type="textarea" :rows="10" readonly />
      <el-empty v-else description="返回明细按需加载，避免大 JSON 卡住页面。" />
    </section>
  </div>
</template>

<style scoped>
.record-editor { gap: 16px; }
.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.workspace-header h1, .editor-panel h2 { margin: 0; }
.workspace-header p { margin: 6px 0 0; color: var(--el-text-color-secondary); }
.header-actions, .panel-title, .panel-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.panel-actions { justify-content: flex-end; flex-wrap: wrap; }
.editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.editor-panel { border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; padding: 16px; }
.editor-panel h2 { font-size: 16px; margin-bottom: 14px; }
.form-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.form-row:has(.el-form-item:nth-child(4)) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.image-strip { display: flex; gap: 8px; flex-wrap: wrap; margin-left: 110px; }
.image-strip :deep(.erp-image-preview) {
  width: 72px !important;
  min-width: 72px !important;
  max-width: 72px !important;
  height: 96px !important;
  min-height: 96px !important;
  max-height: 96px !important;
  flex-basis: 72px !important;
  aspect-ratio: 3 / 4;
  border: 1px solid #edf1f7;
  border-radius: 8px;
  background: #f8fafc;
}
.image-strip :deep(.erp-image-preview__image),
.image-strip :deep(.el-image__inner) {
  object-fit: contain !important;
  background: #f8fafc;
}
.translation-card { margin-left: 110px; padding: 12px 14px; border: 1px solid rgba(37, 99, 235, 0.16); border-radius: 8px; background: rgba(239, 246, 255, 0.76); color: #334155; }
.translation-card strong { display: block; margin-bottom: 6px; color: #2563eb; }
.translation-card p { margin: 4px 0; white-space: pre-wrap; line-height: 1.65; }
.rich-preview { margin-top: 12px; min-height: 140px; border: 1px dashed #d8e0ec; border-radius: 8px; padding: 12px; background: #fbfcff; }
.rich-images { margin-left: 0; margin-bottom: 10px; }
.rich-block { padding: 10px 0; border-top: 1px solid #edf1f7; }
.rich-block:first-of-type { border-top: 0; }
.rich-block h3 { margin: 0 0 6px; font-size: 14px; color: #1f2937; }
.rich-block p { margin: 0; color: #4b5563; line-height: 1.7; white-space: pre-wrap; }
@media (max-width: 1100px) {
  .workspace-header, .header-actions, .panel-title { flex-direction: column; align-items: stretch; }
  .editor-grid, .form-row { grid-template-columns: 1fr; }
  .image-strip, .translation-card { margin-left: 0; }
}
</style>
