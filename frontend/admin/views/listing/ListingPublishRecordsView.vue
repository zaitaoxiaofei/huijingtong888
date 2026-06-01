<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Edit, Refresh, Search, VideoCamera, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { withImageToken } from "../../api/tools/imageCropper";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import { ozonBuyerProductLinkFromRow } from "../../utils/product-links";

const loading = ref(false);
const refreshingId = ref(null);
const detailLoadingId = ref(null);
const retrying = ref(false);
const deletingId = ref(null);
const batchRefreshing = ref(false);
const batchDeleting = ref(false);
const selectedRows = ref([]);
const router = useRouter();
const recordImagePlaceholder = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='8' fill='%23f3f6fb'/%3E%3Cpath d='M18 42l10-12 7 8 5-6 8 10H18z' fill='%23c7d0dd'/%3E%3Ccircle cx='24' cy='23' r='5' fill='%23c7d0dd'/%3E%3C/svg%3E";

const state = reactive({
  rows: [],
  query: "",
  nameQuery: "",
  shopQuery: "",
  status: "all",
  quality: "all",
  page: 1,
  pageSize: 20,
  total: 0
});

const drawer = reactive({
  visible: false,
  row: null,
  payloadText: "",
  form: {
    name: "",
    offer_id: "",
    price: "",
    old_price: "",
    primary_image: "",
    imagesText: "",
    videoUrlsText: ""
  }
});

const filteredRows = computed(() => state.rows);

function matchesStatusFilter(status, filter) {
  if (!filter || filter === "all") return true;
  if (filter === "success") return isSuccessStatus(status);
  if (filter === "processing") return ["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(status);
  if (filter === "failed") return ["failed", "ozon_status_error"].includes(status);
  return status === filter;
}

const summary = computed(() => {
  const rows = state.rows;
  return {
    total: rows.length,
    success: rows.filter((row) => isSuccessStatus(row.status)).length,
    processing: rows.filter((row) => ["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(row.status)).length,
    failed: rows.filter((row) => row.status === "failed").length,
    quality90: rows.filter((row) => Number(row.quality_score || 0) >= 90).length
  };
});

async function loadRecords() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(state.page),
      pageSize: String(state.pageSize),
      status: state.status,
      quality: state.quality,
      includePayload: "0"
    });
    if (state.query.trim()) params.set("query", state.query.trim());
    if (state.nameQuery.trim()) params.set("nameQuery", state.nameQuery.trim());
    if (state.shopQuery.trim()) params.set("shopQuery", state.shopQuery.trim());
    const result = await apiClient.get(`/api/listing/publish-records?${params.toString()}`, { noCache: true });
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
    state.page = Number(result?.page || state.page);
    state.pageSize = Number(result?.pageSize || state.pageSize);
    selectedRows.value = [];
  } finally {
    loading.value = false;
  }
}

function handleSelectionChange(rows) {
  selectedRows.value = rows;
}

function resetFilters() {
  state.query = "";
  state.nameQuery = "";
  state.shopQuery = "";
  state.status = "all";
  state.quality = "all";
  state.page = 1;
  loadRecords();
}

function searchRecords() {
  state.page = 1;
  loadRecords();
}

function handlePageChange(page) {
  state.page = page;
  loadRecords();
}

function handlePageSizeChange(size) {
  state.pageSize = Number(size || 20);
  state.page = 1;
  loadRecords();
}

function statusType(status) {
  if (isSuccessStatus(status)) return "success";
  if (["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(status)) return "warning";
  if (status === "ozon_status_error") return "danger";
  if (status === "failed") return "danger";
  return "info";
}

function statusText(status) {
  const map = {
    imported: "上架成功",
    published: "上架成功",
    success: "上架成功",
    submitted: "已提交 Ozon",
    processing: "Ozon处理中",
    resubmitting: "重新提交中",
    ozon_status_pending: "待同步Ozon状态",
    ozon_status_error: "Ozon状态同步失败",
    failed: "上架失败"
  };
  return map[status] || status || "未知";
}

function isSuccessStatus(status) {
  return ["imported", "published", "success"].includes(status);
}

function publishRecordProductTitle(row) {
  return row?.product_name || row?.offer_id || "-";
}

function publishRecordBuyerLink(row) {
  return ozonBuyerProductLinkFromRow(row);
}

function qualityType(score) {
  const value = Number(score || 0);
  if (value >= 90) return "success";
  if (value >= 75) return "warning";
  if (value > 0) return "danger";
  return "info";
}

function qualitySourceText(source) {
  const value = String(source || "");
  if (value.includes("ozon_rating_by_sku")) return "Ozon真实评分";
  if (value.includes("ozon_rating_waiting_sku")) return "等待Ozon返回SKU";
  if (value.includes("ozon_rating_pending")) return "等待Ozon评分";
  if (value.includes("ozon_rating_error")) return "Ozon评分同步失败";
  if (value.includes("local_estimate")) return "未返回";
  return value || "未返回";
}

async function loadPublishRecordDetail(row) {
  if (row?.request?.items) return row;
  detailLoadingId.value = row.id;
  try {
    const detail = await apiClient.get(`/api/listing/publish-records/${row.id}`, { noCache: true });
    const index = state.rows.findIndex((item) => Number(item.id) === Number(detail.id));
    if (index >= 0) state.rows[index] = { ...state.rows[index], ...detail };
    return index >= 0 ? state.rows[index] : detail;
  } finally {
    detailLoadingId.value = null;
  }
}

async function editInListingAutomation(row) {
  const detail = await loadPublishRecordDetail(row);
  const key = `listing-record-draft-${detail.id}-${Date.now()}`;
  sessionStorage.setItem(key, JSON.stringify({
    record_id: detail.id,
    shop_id: detail.shop_id,
    template: buildTemplateFromRecord(detail)
  }));
  router.push({ name: "listing-automation", query: { recordDraft: key, recordId: detail.id } });
}

function buildTemplateFromRecord(row) {
  const payload = plainClone(row.request, { items: [] });
  const item = payload.items?.[0] || {};
  const images = [item.primary_image, ...(item.images || [])].filter(Boolean).map((url, index) => ({ url, sort_order: index + 1 }));
  const videoUrls = extractVideoUrls(item);
  const modelName = generatedModelName(row, item);
  const productTags = extractProductTags(item);
  const richJson = extractRichContentJson(item);
  const material = extractAttributeValue(item, ["材料", "材质", "material", "материал"]) || item.material || "";
  const categoryName = row.category_name || row.category_name_zh || row.path_zh || item.category_name || item.description_category_name || "";
  const variant = {
    id: `record-${row.id}`,
    sku: item.offer_id || row.offer_id || "",
    offer_id: item.offer_id || row.offer_id || "",
    name: item.name || row.product_name || "",
    title: item.name || row.product_name || "",
    images,
    video_urls: videoUrls,
    video_cover_urls: videoUrls,
    price: Number(item.price || row.price || 0),
    old_price: Number(item.old_price || row.old_price || 0),
    color: item.color || "",
    material,
    quantity: item.quantity || "",
    weight_g: Number(item.weight || 0),
    length_mm: Number(item.depth || 0),
    width_mm: Number(item.width || 0),
    height_mm: Number(item.height || 0),
    stock: Number(item.stock || 0)
  };
  return {
    id: "",
    ozon_category_id: item.description_category_id && item.type_id ? `${item.description_category_id}:${item.type_id}` : "",
    category_name: categoryName,
    template_name: `上架记录 ${row.id} / ${item.offer_id || row.offer_id || ""}`,
    title: item.name || row.product_name || "",
    description: item.description || "",
    attributes: enrichRecordAttributes(item.attributes || [], { modelName, productTags, material, richJson }),
    images,
    source_raw: { ...payload, record_id: row.id, shop_id: row.shop_id, offer_id: item.offer_id || row.offer_id || "", from_publish_record: true },
    editable_payload: {
      sku: item.offer_id || row.offer_id || "",
      title: item.name || row.product_name || "",
      description: item.description || "",
      description_category_id: item.description_category_id || "",
      type_id: item.type_id || "",
      legacy_category_id: item.description_category_id && item.type_id ? `${item.description_category_id}:${item.type_id}` : "",
      price: { value: Number(item.price || row.price || 0), old_price: Number(item.old_price || row.old_price || 0), currency_code: item.currency_code || row.currency_code || "CNY", vat: item.vat || "0" },
      dimensions: { length_cm: Number(item.depth || 0) / 10, width_cm: Number(item.width || 0) / 10, height_cm: Number(item.height || 0) / 10, weight_g: Number(item.weight || 0) },
      logistics: { color: item.color || "", spec: item.material || "", quantity: item.quantity || "" },
      rich_content_json: richJson,
      category_name: categoryName,
      attributes: enrichRecordAttributes(item.attributes || [], { modelName, productTags, material, richJson }),
      images,
      variants: [variant],
      source_raw: { ...payload, record_id: row.id, shop_id: row.shop_id, from_publish_record: true }
    }
  };
}

function enrichRecordAttributes(attributes = [], { modelName = "", productTags = [], material = "", richJson = "" } = {}) {
  const next = plainClone(attributes, []);
  upsertRecordAttribute(next, ["型号名称", "型号", "Модель"], { name: "型号名称", value: modelName, required: true, source: "publish_record" });
  if (productTags.length) upsertRecordAttribute(next, ["产品标签", "主题标签", "主图标签", "tag", "тег", "ключ"], { name: "产品标签", value: productTags.join(","), values: productTags, source: "publish_record" });
  if (material) upsertRecordAttribute(next, ["材料", "材质", "material", "материал"], { name: "材料", value: material, source: "publish_record" });
  if (richJson) upsertRecordAttribute(next, ["JSON富内容", "Rich", "rich"], { name: "JSON富内容", attribute_id: 11254, value: richJson, type: "rich_json", source: "publish_record" });
  return next;
}

function upsertRecordAttribute(attributes, names, payload) {
  const existing = attributes.find((item) => names.some((name) => String(item?.name || "").toLowerCase().includes(String(name).toLowerCase())));
  if (existing) Object.assign(existing, payload);
  else attributes.push(payload);
}

function generatedModelName(row, item = {}) {
  const seed = String(item.offer_id || row.offer_id || row.id || Date.now()).replace(/[^a-zA-Z0-9]+/g, "").slice(-10).toUpperCase();
  return `M-${seed || Date.now().toString(36).toUpperCase()}`;
}

function extractProductTags(item = {}) {
  const raw = extractAttributeValue(item, ["产品标签", "主题标签", "主图标签", "tag", "тег", "ключ"]);
  return String(raw || "").split(/[\s,，;；]+/).map((value) => value.trim()).filter((value) => value.startsWith("#") || /[a-zа-яё0-9_]/i.test(value)).slice(0, 20);
}

function extractAttributeValue(item = {}, names = []) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  for (const attr of attrs) {
    const name = String(attr?.name || attr?.attribute_name || "").toLowerCase();
    if (!names.some((needle) => name.includes(String(needle).toLowerCase()))) continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const first = values.map((value) => value?.value || value?.name || value?.text || value).filter(Boolean)[0];
    return String(attr.value || first || "").trim();
  }
  return "";
}

function extractRichContentJson(item = {}) {
  const direct = extractAttributeValue(item, ["JSON富内容", "Rich", "rich"]);
  if (direct) return direct;
  const complexGroups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  for (const group of complexGroups) {
    const attrs = Array.isArray(group.attributes) ? group.attributes : [];
    const richAttr = attrs.find((attr) => String(attr?.id || "").toLowerCase() === "rich_content_json" || Number(attr?.id || 0) === 11254);
    const value = richAttr?.values?.[0]?.value;
    if (value) return String(value);
  }
  return "";
}

async function openDrawer(row) {
  const detail = await loadPublishRecordDetail(row);
  const payload = plainClone(detail.request, { items: [] });
  const item = payload.items?.[0] || {};
  drawer.row = detail;
  drawer.form = {
    name: item.name || "",
    offer_id: item.offer_id || "",
    price: item.price || "",
    old_price: item.old_price || "",
    primary_image: item.primary_image || "",
    imagesText: (item.images || []).join("\n"),
    videoUrlsText: extractVideoUrls(item).join("\n")
  };
  drawer.payloadText = JSON.stringify(payload, null, 2);
  drawer.visible = true;
}

function plainClone(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function applyFormToPayload() {
  const payload = JSON.parse(drawer.payloadText || "{}");
  if (!Array.isArray(payload.items) || !payload.items[0]) payload.items = [{}];
  const item = payload.items[0];
  item.name = drawer.form.name;
  item.offer_id = drawer.form.offer_id;
  item.price = String(drawer.form.price || "");
  item.old_price = String(drawer.form.old_price || drawer.form.price || "");
  item.primary_image = drawer.form.primary_image;
  item.images = splitLines(drawer.form.imagesText);
  setVideoUrls(item, splitLines(drawer.form.videoUrlsText));
  drawer.payloadText = JSON.stringify(payload, null, 2);
  return payload;
}

async function retryRecord() {
  if (!drawer.row?.id) return;
  let payload;
  try {
    payload = applyFormToPayload();
  } catch {
    ElMessage.error("技术 JSON 格式不正确");
    return;
  }
  retrying.value = true;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${drawer.row.id}/retry`, { payload });
    const index = state.rows.findIndex((row) => Number(row.id) === Number(updated.id));
    if (index >= 0) state.rows[index] = updated;
    drawer.visible = false;
    ElMessage.success("已重新提交 Ozon，可稍后刷新状态");
  } finally {
    retrying.value = false;
  }
}

async function refreshRecord(row) {
  refreshingId.value = row.id;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${row.id}/refresh`, {});
    const index = state.rows.findIndex((item) => Number(item.id) === Number(updated.id));
    if (index >= 0) state.rows[index] = updated;
    ElMessage.success("状态已刷新");
  } finally {
    refreshingId.value = null;
  }
}

async function batchRefreshRecords() {
  const rows = selectedRows.value.filter((row) => row?.id);
  if (!rows.length) {
    ElMessage.warning("请先选择要刷新的上架记录");
    return;
  }
  batchRefreshing.value = true;
  try {
    let success = 0;
    for (const row of rows) {
      const updated = await apiClient.post(`/api/listing/publish-records/${row.id}/refresh`, {});
      const index = state.rows.findIndex((item) => Number(item.id) === Number(updated.id));
      if (index >= 0) state.rows[index] = updated;
      success += 1;
    }
    ElMessage.success(`已刷新 ${success} 条上架记录`);
  } finally {
    batchRefreshing.value = false;
  }
}

async function deleteRecord(row) {
  await ElMessageBox.confirm(
    "删除后这条上架记录不会再显示在列表里，已经在 Ozon 上架的商品不会被下架。",
    "确认删除上架记录",
    { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
  );
  deletingId.value = row.id;
  try {
    await apiClient.delete(`/api/listing/publish-records/${row.id}`);
    state.rows = state.rows.filter((item) => Number(item.id) !== Number(row.id));
    ElMessage.success("上架记录已删除");
  } finally {
    deletingId.value = null;
  }
}

async function batchDeleteRecords() {
  const rows = selectedRows.value.filter((row) => row?.id);
  if (!rows.length) {
    ElMessage.warning("请先选择要删除的上架记录");
    return;
  }
  await ElMessageBox.confirm(
    `确认删除选中的 ${rows.length} 条上架记录？已经在 Ozon 上架的商品不会被下架。`,
    "批量删除上架记录",
    { type: "warning", confirmButtonText: "批量删除", cancelButtonText: "取消" }
  );
  batchDeleting.value = true;
  try {
    const ids = new Set(rows.map((row) => Number(row.id)));
    for (const row of rows) {
      await apiClient.delete(`/api/listing/publish-records/${row.id}`);
    }
    state.rows = state.rows.filter((row) => !ids.has(Number(row.id)));
    selectedRows.value = [];
    ElMessage.success(`已删除 ${ids.size} 条上架记录`);
  } finally {
    batchDeleting.value = false;
  }
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

function splitLines(value) {
  return String(value || "").split(/\r?\n|,|，/).map((item) => item.trim()).filter(Boolean);
}

function prettyJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function previewImageUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.pathname.startsWith("/uploads/")) return withImageToken(`${parsed.pathname}${parsed.search}`);
    } catch {
      return value;
    }
  }
  if (value.startsWith("/")) return withImageToken(value);
  return value;
}

function recordPreviewCandidates(row = {}) {
  return [
    row.primary_image,
    ...(Array.isArray(row.images) ? row.images : []),
    row.fallback_image
  ].map(previewImageUrl).filter(Boolean);
}

function recordPreviewImage(row = {}) {
  return recordPreviewCandidates(row)[0] || "";
}

function handleRecordImageError(event, row = {}) {
  const image = event?.currentTarget;
  if (!image) return;
  const candidates = recordPreviewCandidates(row);
  const currentIndex = Number(image.dataset.previewIndex || 0);
  const next = candidates[currentIndex + 1];
  if (next) {
    image.dataset.previewIndex = String(currentIndex + 1);
    image.src = next;
    return;
  }
  image.dataset.previewIndex = String(candidates.length);
  image.src = recordImagePlaceholder;
}

onMounted(loadRecords);
</script>

<template>
  <div class="page-stack publish-records-page erp-paged-page">
    <section class="toolbar-panel">
      <div class="toolbar-filters">
        <el-input v-model="state.nameQuery" :prefix-icon="Search" clearable placeholder="名称 / offer_id" @keyup.enter="searchRecords" @clear="searchRecords" />
        <el-input v-model="state.shopQuery" clearable placeholder="店铺" @keyup.enter="searchRecords" @clear="searchRecords" />
        <el-input v-model="state.query" clearable placeholder="基础信息：task / 类目 / product id" @keyup.enter="searchRecords" @clear="searchRecords" />
        <el-select v-model="state.status" placeholder="状态" @change="searchRecords">
          <el-option label="全部状态" value="all" />
          <el-option label="上架成功" value="success" />
          <el-option label="等待处理" value="processing" />
          <el-option label="上架失败" value="failed" />
        </el-select>
        <el-select v-model="state.quality" placeholder="评分" @change="searchRecords">
          <el-option label="全部评分" value="all" />
          <el-option label="85分以下" value="lt85" />
          <el-option label="85分以上" value="gte85" />
          <el-option label="90分以上" value="gte90" />
        </el-select>
      </div>
      <div class="toolbar-actions">
        <span class="selection-count">已选 {{ selectedRows.length }} / 当前 {{ filteredRows.length }}</span>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchRecords">查询</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading" @click="loadRecords">刷新</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="batchRefreshing" :disabled="!selectedRows.length" @click="batchRefreshRecords">批量刷新</el-button>
        <el-button class="erp-btn erp-btn-danger" type="danger" plain :icon="Delete" :loading="batchDeleting" :disabled="!selectedRows.length" @click="batchDeleteRecords">批量删除</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="resetFilters">重置</el-button>
      </div>
    </section>

    <div class="publish-table-wrap erp-table-scroll">
      <el-table
        v-loading="loading"
        :data="filteredRows"
        border
        stripe
        class="erp-data-table publish-table"
        row-key="id"
        @selection-change="handleSelectionChange"
      >
      <el-table-column type="selection" width="44" fixed="left" />
      <el-table-column label="商品" min-width="360">
        <template #default="{ row }">
          <div class="record-product">
            <img
              :src="recordPreviewImage(row) || recordImagePlaceholder"
              alt=""
              loading="lazy"
              data-preview-index="0"
              @error="handleRecordImageError($event, row)"
            />
            <div>
              <ProductTitleLink :title="publishRecordProductTitle(row)" :href="publishRecordBuyerLink(row)" :lines="2" />
              <span>{{ row.offer_id }}</span>
              <em>{{ row.image_count || 0 }} 图 / {{ row.video_urls?.length || 0 }} 视频</em>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="店铺" min-width="130" prop="shop_name" />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" effect="plain">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="内容评分" width="150">
        <template #default="{ row }">
          <div class="quality-cell">
            <el-tag :type="qualityType(row.quality_score)" effect="plain">{{ row.quality_score ? `${row.quality_score} 分` : "未返回" }}</el-tag>
            <span>{{ qualitySourceText(row.quality_source) }}</span>
            <el-tooltip v-if="row.quality_issues?.length" placement="top" :content="row.quality_issues.join('；')">
              <em>缺项 {{ row.quality_issues.length }}</em>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="价格" width="130">
        <template #default="{ row }">{{ row.price }} {{ row.currency_code }}</template>
      </el-table-column>
      <el-table-column label="技术信息" min-width="220">
        <template #default="{ row }">
          <div class="tech-stack">
          <span>task: {{ row.task_id || "-" }}</span>
          <span>product: {{ row.ozon_product_id || "-" }}</span>
          <span>cat: {{ row.description_category_id || "-" }} / {{ row.type_id || "-" }}</span>
          <span v-if="row.quality_checked_at">score checked: {{ row.quality_checked_at }}</span>
        </div>
      </template>
    </el-table-column>
      <el-table-column label="更新时间" width="175">
        <template #default="{ row }">{{ row.updated_at || row.created_at }}</template>
      </el-table-column>
      <el-table-column label="操作" width="132" fixed="right" class-name="record-actions-column">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button class="erp-btn erp-btn-secondary" size="small" type="primary" plain :icon="Edit" :loading="detailLoadingId === row.id" @click="editInListingAutomation(row)">编辑</el-button>
            <el-button class="erp-btn erp-btn-secondary" size="small" plain :icon="View" :loading="detailLoadingId === row.id" @click="openDrawer(row)">档案</el-button>
            <el-button class="erp-btn erp-btn-secondary" size="small" type="success" plain :icon="Refresh" :loading="refreshingId === row.id" @click="refreshRecord(row)">刷新</el-button>
            <el-button class="erp-btn erp-btn-danger" size="small" type="danger" plain :icon="Delete" :loading="deletingId === row.id" @click="deleteRecord(row)">删除</el-button>
          </div>
        </template>
      </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.page"
      :page-size="state.pageSize"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />

    <el-drawer v-model="drawer.visible" title="上架记录详情" size="760px">
      <div v-if="drawer.row" class="record-drawer">
        <section class="drawer-hero">
          <img
            :src="recordPreviewImage(drawer.row) || recordImagePlaceholder"
            alt=""
            @error="handleRecordImageError($event, drawer.row)"
          />
          <div>
            <el-tag :type="statusType(drawer.row.status)" effect="plain">{{ statusText(drawer.row.status) }}</el-tag>
            <strong>{{ drawer.form.name }}</strong>
            <span>{{ drawer.row.shop_name }} / {{ drawer.row.offer_id }}</span>
          </div>
        </section>

        <el-form label-width="96px">
          <el-form-item label="标题">
            <el-input v-model="drawer.form.name" />
          </el-form-item>
          <el-form-item label="Offer ID">
            <el-input v-model="drawer.form.offer_id" />
          </el-form-item>
          <el-form-item label="售价">
            <el-input v-model="drawer.form.price" />
          </el-form-item>
          <el-form-item label="划线价">
            <el-input v-model="drawer.form.old_price" />
          </el-form-item>
          <el-form-item label="主图 URL">
            <el-input v-model="drawer.form.primary_image" type="textarea" :rows="2" />
          </el-form-item>
          <el-form-item label="附图 URL">
            <el-input v-model="drawer.form.imagesText" type="textarea" :rows="5" placeholder="每行一个图片 URL" />
          </el-form-item>
          <el-form-item label="视频 URL">
            <el-input v-model="drawer.form.videoUrlsText" type="textarea" :rows="4" placeholder="每行一个视频公网 URL，重试时会替换原视频" />
          </el-form-item>
        </el-form>

        <el-collapse>
          <el-collapse-item title="技术 JSON">
            <el-input v-model="drawer.payloadText" type="textarea" :rows="18" />
          </el-collapse-item>
          <el-collapse-item title="Ozon 返回 / 错误">
            <el-input :model-value="prettyJson({ response: drawer.row.response, error: drawer.row.error })" type="textarea" :rows="14" readonly />
          </el-collapse-item>
        </el-collapse>

        <div class="drawer-actions">
          <el-button class="erp-btn erp-btn-secondary" :icon="VideoCamera" @click="applyFormToPayload">同步到技术 JSON</el-button>
          <el-button class="erp-btn erp-btn-danger" type="danger" :icon="Edit" :loading="retrying" @click="retryRecord">保存并重新提交</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.publish-records-page { gap: 12px; min-height: 0; }
.record-product span, .record-product em, .tech-stack span, .drawer-hero span { color: #697386; font-size: 12px; }
.toolbar-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}
.toolbar-filters {
  display: grid;
  grid-template-columns: 220px 150px minmax(240px, 1fr) 140px 130px;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.selection-count {
  color: #697386;
  font-size: 12px;
  white-space: nowrap;
}
.publish-table-wrap {
  flex: 1 1 auto;
}
.record-product { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; align-items: center; }
.record-product img, .drawer-hero img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid #edf1f7; background: #f8fafc; }
.record-product div, .tech-stack, .drawer-hero div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.record-product strong { overflow-wrap: anywhere; }
.quality-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.quality-cell span, .quality-cell em { color: #697386; font-size: 12px; font-style: normal; }
.row-actions {
  display: grid;
  grid-template-columns: repeat(2, 54px);
  gap: 6px;
  justify-content: center;
}
.row-actions .el-button {
  width: 54px;
  margin-left: 0;
}
.record-drawer { display: flex; flex-direction: column; gap: 16px; }
.drawer-hero { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px; border: 1px solid #e5eaf3; border-radius: 8px; background: #f8fafc; }
.drawer-hero strong { font-size: 16px; overflow-wrap: anywhere; }
.drawer-actions { display: flex; justify-content: flex-end; gap: 10px; position: sticky; bottom: 0; background: #fff; padding-top: 12px; }
@media (max-width: 1280px) {
  .toolbar-panel {
    align-items: stretch;
    flex-direction: column;
  }
  .toolbar-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
