<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, Delete, Refresh, Search, View } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { archiveMaterialAsset, deleteMaterialAsset } from "../../api/materialAssets";
import { withImageToken } from "../../api/tools/imageCropper";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const archiving = ref(false);
const deleting = ref(false);


const materialAssets = ref([]);

const aiMainImageAssets = ref([]);
const selectedMaterialRows = ref([]);

const previewDialog = reactive({ visible: false, title: "素材预览", url: "", type: "image", text: "" });
let aiMainImageRequestSeq = 0;
let materialLoadSeq = 0;
let requestController = null, viewActive = false;
let viewScope = currentApiCacheScope();
const filters = reactive({
  keyword: "",
  role: "",
  status: "",
  mediaType: ""
});
const pager = reactive({

  main: { page: 1, pageSize: 20, total: 0 }
});

const roleOptions = [
  { label: "主图", value: "main" },
  { label: "详情图", value: "detail" },
  { label: "尾图", value: "tail" },
  { label: "视频", value: "video" },
  { label: "AI 主图", value: "main_image" },

];

const statusOptions = [
  { label: "可用", value: "active" },
  { label: "已保存", value: "ready" },
  { label: "待审核", value: "pending_review" },
  { label: "已使用", value: "used" },
  { label: "已归档", value: "archived" }
];

const filteredMaterialAssets = computed(() => materialAssets.value);

const summary = computed(() => ({
  main: materialAssets.value.length,
  image: materialAssets.value.filter(item => mediaType(item) === "image").length,
  video: materialAssets.value.filter(item => mediaType(item) === "video").length,
  text: materialAssets.value.filter(item => mediaType(item) === "text").length
}));
const returnTo = computed(() => String(route.query.returnTo || ""));
const returnLabel = computed(() => String(route.query.returnLabel || "返回上一页"));

function requestCurrent(seq, context) {
  return seq === materialLoadSeq && context.scope === currentApiCacheScope() && !context.signal.aborted;
}
async function loadAssets() {
  viewScope = currentApiCacheScope();
  requestController?.abort();
  requestController = new AbortController();
  const context = { scope: viewScope, signal: requestController.signal };
  const seq = ++materialLoadSeq;
  selectedMaterialRows.value = [];
  loading.value = true;
  try {
    await loadMainAssets({ paged: "1", source_type: "ai_generated", recent_days: "7", keyword: filters.keyword.trim(), role: filters.role, status: filters.status }, seq, context);
  } catch (error) {
    if (requestCurrent(seq, context) && error?.name !== "AbortError") ElMessage.error(error.message || "AI 素材加载失败");
  } finally { if (requestCurrent(seq, context)) loading.value = false; }
}
async function loadMainAssets(common = {}, seq = materialLoadSeq, context) {
  const params = new URLSearchParams({ ...common, asset_type: filters.mediaType || "", page: String(pager.main.page), pageSize: String(pager.main.pageSize) });
  const materialRows = await apiClient.get(`/api/material-assets?${params}`, { noCache: true, signal: context.signal });
  if (!requestCurrent(seq, context)) return;
  const baseRows = Array.isArray(materialRows?.rows) ? materialRows.rows : [];
  aiMainImageAssets.value = [];
  materialAssets.value = mergeMaterialRows(baseRows, []);
  pager.main.total = Number(materialRows?.total || 0);
  pager.main.page = Number(materialRows?.page || pager.main.page);
  pager.main.pageSize = Number(materialRows?.pageSize || pager.main.pageSize);
  void refreshAiMainImageAssets(common, seq, context);
}
async function refreshAiMainImageAssets(common = {}, materialSeq, context) {
  const seq = ++aiMainImageRequestSeq;
  try {
    const rows = await loadAiMainImageAssets(common, context);
    if (seq !== aiMainImageRequestSeq || !requestCurrent(materialSeq, context)) return;
    aiMainImageAssets.value = rows;
    materialAssets.value = mergeMaterialRows(materialAssets.value.filter(row => !isAiVariantAssetRow(row)), rows);
    pager.main.total += rows.length;
  } catch (error) {
    if (error?.name !== "AbortError" && requestCurrent(materialSeq, context)) console.warn("AI 素材补充记录暂不可用", error.message);
  }
}
async function loadAiMainImageAssets(common = {}, context) {
  if (pager.main.page !== 1 || (filters.mediaType && filters.mediaType !== "image") || (filters.role && filters.role !== "main_image")) return [];
  const params = new URLSearchParams({ field_key: "main_image", repair_temp_ai: "1", recent_days: "7", compact: "1", limit: String(Math.min(Math.max(Number(pager.main.pageSize || 20), 1), 50)) });
  const keyword = String(common.keyword || "").trim();
  if (keyword) params.set("sourceProductId", keyword);
  const rows = await apiClient.get(`/api/listing/ai-variant-assets?${params.toString()}`, { noCache: true, signal: context.signal });
  return normalizeAiMainImageAssetRows(Array.isArray(rows) ? rows : []);
}

function normalizeAiMainImageAssetRows(rows = []) {
  return rows
    .map((row) => {
      const asset = row.asset || {};
      const url = firstDisplayableAiAssetUrl(asset);
      if (!url) return null;
      const snapshot = row.row_snapshot || row.rowSnapshot || {};
      return {
        id: `ai-main-${row.id}`,
        sourceAiAssetId: row.id,
        asset_type: "image",
        role: "main_image",
        title: row.product_name || snapshot.title || `AI主图 ${row.result_id || row.id}`,
        url,
        thumbnail_url: url,
        local_url: displayableAiAssetUrl(asset.localUrl) || "",
        publish_url: displayableAiAssetUrl(asset.publishUrl || asset.url) || "",
        source_type: row.source_module || "ai_variant_lab",
        source_id: row.source_product_id || "",
        source_batch_id: row.source_batch_id || "",
        variant_task_id: row.workbench_id || row.source_batch_id || "",
        variant_result_id: row.result_id || "",
        target_model: row.variant_target || snapshot.target_variant_value || "",
        product_name: row.product_name || snapshot.title || "",
        status: row.field_status || row.status || "generated",
        metadata: {
          aiVariantAsset: true,
          sourceAiAssetId: row.id,
          listingDraftId: row.listing_draft_id || row.listingDraftId || null,
          sourceImageUrl: asset.sourceImageUrl || "",
          downloadUrl: asset.downloadUrl || ""
        },
        updated_at: row.updated_at || row.updatedAt,
        updatedAt: row.updatedAt || row.updated_at
      };
    })
    .filter((row) => row && matchesKeyword(row, [
      row.title,
      row.product_name,
      row.source_id,
      row.variant_task_id,
      row.variant_result_id,
      row.target_model
    ]));
}

function firstDisplayableAiAssetUrl(asset = {}) {
  return [
    asset.publishUrl,
    asset.localUrl,
    asset.url,
    asset.downloadUrl
  ].map(displayableAiAssetUrl).find(Boolean) || "";
}

function displayableAiAssetUrl(value = "") {
  const url = String(value || "").trim();
  if (!url || /^\/api\/ai\/file\//i.test(url) || /\/api\/ai\/file\//i.test(url)) return "";
  return url;
}

function mergeMaterialRows(baseRows = [], aiRows = []) {
  const seen = new Set();
  return [...aiRows, ...baseRows].filter((row) => {
    const key = row.sourceAiAssetId ? `ai:${row.sourceAiAssetId}` : `material:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clearFilters() {
  filters.keyword = "";
  filters.role = "";
  filters.status = "";
  filters.mediaType = "";
  resetMaterialPages();
  loadAssets();
}

function resetMaterialPages() {
  pager.main.page = 1;
}

function searchAssets() {
  resetMaterialPages();
  loadAssets();
}

function handleMaterialPageChange(kind, page) {
  pager[kind].page = page;
  loadAssets();
}

function handleMaterialPageSizeChange(kind, size) {
  pager[kind].pageSize = Number(size || 20);
  pager[kind].page = 1;
  loadAssets();
}

function handleSelectionChange(kind, rows = []) {
  selectedMaterialRows.value = rows;
}

function goBackToSource() {
  if (returnTo.value) {
    router.push(returnTo.value);
    return;
  }
  router.back();
}

function matchesKeyword(item, values = []) {
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  if (!keyword) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(keyword));
}

function mediaType(item = {}) {
  const raw = String(item.mediaType || item.media_type || item.asset_type || item.assetType || "").toLowerCase();
  const role = roleValue(item);
  const mime = String(item.mimeType || item.mime_type || "").toLowerCase();
  if (raw === "video" || role === "video" || mime.startsWith("video/")) return "video";
  if (raw === "text") return "text";
  return raw || "image";
}

function roleValue(item = {}) {
  return String(item.role || "").toLowerCase();
}

function statusValue(item = {}) {
  return String(item.status || "").toLowerCase();
}

function isAiVariantAssetRow(item = {}) {
  return Boolean(item.sourceAiAssetId || item.metadata?.aiVariantAsset);
}

function previewUrl(item = {}) {
  const url = mediaType(item) === "video"
    ? item.previewUrl || item.preview_url || item.localUrl || item.local_url || item.publishUrl || item.publish_url || item.url || ""
    : item.thumbnail_url || item.thumbnailUrl || item.previewUrl || item.preview_url || item.localUrl || item.local_url || item.url || item.publishUrl || item.publish_url || "";
  if (!url || /^blob:|^data:/i.test(url)) return url;
  return withImageToken(normalizeLocalPreviewUrl(url));
}

function normalizeLocalPreviewUrl(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    const isKnownAppHost = ["localhost", "127.0.0.1", "erp.hjt888.xyz"].includes(parsed.hostname);
    if (isKnownAppHost && /^(\/api\/|\/uploads\/)/i.test(parsed.pathname)) {
      return `${parsed.pathname}${parsed.search || ""}`;
    }
  } catch {
    return value;
  }
  return value;
}

function openPreview(item) {
  const url = previewUrl(item);
  if (mediaType(item) === "text") {
    previewDialog.text = String(item.content_text || item.contentText || item.text || "暂无文本内容");
    previewDialog.type = "text"; previewDialog.title = item.title || "AI 文本预览"; previewDialog.visible = true; return;
  }
  if (!url) {
    ElMessage.warning("这条素材没有可预览地址");
    return;
  }
  previewDialog.url = url;
  previewDialog.type = mediaType(item) === "video" ? "video" : "image";
  previewDialog.title = item.title || item.originalName || item.original_name || item.storageName || item.storage_name || "素材预览";
  previewDialog.visible = true;
}

function sourceLabel(item = {}) {
  const source = String(item.source_type || item.sourceType || item.sourceModule || item.source_module || "").toLowerCase();
  if (source.includes("asset_variant")) return "店铺矩阵";
  if (source.includes("shop_matrix")) return "店铺矩阵";
  if (source.includes("ai")) return "AI 生成";
  if (source.includes("upload")) return "手动上传";
  return source || "-";
}

function productName(item = {}) {
  return item.assetVariantSourceTitle || item.product_name || item.productName || item.title || item.metadata?.productTitle || item.metadata?.sourceTitle || "-";
}

function assetTitle(item = {}) {
  return item.assetVariantTitle || item.assetVariantTitleZh || item.title || item.originalName || item.original_name || item.storageName || item.storage_name || "-";
}

function formatTime(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }

async function archiveAsset(row) {
  const scope = currentApiCacheScope();
  await ElMessageBox.confirm(`确定归档「${row.title || row.product_name || row.id}」吗？`, "归档素材", { type: "warning" });
  if (scope !== currentApiCacheScope()) return;
  archiving.value = true;
  try {
    await archiveMaterialAsset(row.id);
    ElMessage.success("素材已归档");
    await loadAssets();
  } finally {
    archiving.value = false;
  }
}

async function deleteAsset(row) {
  const scope = currentApiCacheScope();
  if (!row?.id) return;
  if (isAiVariantAssetRow(row)) {
    await deleteAiVariantAssetRows([row]);
    return;
  }
  await ElMessageBox.confirm(`确定删除「${row.title || row.product_name || row.id}」吗？素材记录会从素材库移除，已注册的底层图片文件会保留。`, "删除素材记录", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  if (scope !== currentApiCacheScope()) return;
  deleting.value = true;
  try {
    await deleteMaterialAsset(row.id);
    ElMessage.success("素材记录已删除");
    await loadAssets();
  } finally {
    deleting.value = false;
  }
}

async function deleteAiVariantAssetRows(rows = []) {
  const scope = currentApiCacheScope();
  const ids = rows.map((row) => Number(row.sourceAiAssetId || 0)).filter(Boolean);
  if (!ids.length) return;
  await ElMessageBox.confirm(`确定删除 ${ids.length} 个 AI 素材记录吗？已注册的底层图片文件会保留。`, "删除 AI 素材记录", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  if (scope !== currentApiCacheScope()) return;
  deleting.value = true;
  try {
    const result = await apiClient.post("/api/listing/ai-variant-assets/batch-delete", { ids });
    ElMessage.success(`已删除 ${result.deleted || ids.length} 个 AI 素材记录`);
    selectedMaterialRows.value = [];
    aiMainImageAssets.value = aiMainImageAssets.value.filter((row) => !ids.includes(Number(row.sourceAiAssetId || 0)));
    await loadAssets();
  } finally {
    deleting.value = false;
  }
}

async function deleteSelectedMaterialAssets() {
  const scope = currentApiCacheScope();
  const rows = selectedMaterialRows.value;
  if (!rows.length) return;
  const aiRows = rows.filter(isAiVariantAssetRow);
  const materialRows = rows.filter((row) => !isAiVariantAssetRow(row));
  await ElMessageBox.confirm(`确定删除选中的 ${rows.length} 个主图 / AI 素材记录吗？已注册的底层图片文件会保留。`, "批量删除素材", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  if (scope !== currentApiCacheScope()) return;
  deleting.value = true;
  try {
    let deleted = 0;
    const aiIds = aiRows.map((row) => Number(row.sourceAiAssetId || 0)).filter(Boolean);
    if (aiIds.length) {
      const result = await apiClient.post("/api/listing/ai-variant-assets/batch-delete", { ids: aiIds });
      deleted += Number(result.deleted || aiIds.length);
    }
    for (const row of materialRows) {
      if (scope !== currentApiCacheScope()) return;
      await deleteMaterialAsset(row.id);
      deleted += 1;
    }
    ElMessage.success(`已删除 ${deleted} 个素材记录`);
    selectedMaterialRows.value = [];
    await loadAssets();
  } finally {
    deleting.value = false;
  }
}

function stopReads() { materialLoadSeq++; aiMainImageRequestSeq++; requestController?.abort(); loading.value = false; }
function resetScope() {
  stopReads(); viewScope = currentApiCacheScope();
  Object.assign(filters, { keyword: "", role: "", status: "", mediaType: "" });
  materialAssets.value = []; aiMainImageAssets.value = []; selectedMaterialRows.value = [];
  previewDialog.visible = false; previewDialog.url = ""; previewDialog.text = "";
  pager.main.page = 1; pager.main.total = 0;
  if (viewActive) loadAssets();
}
onMounted(() => { viewActive = true; window.addEventListener("erp:auth-scope-changed", resetScope); loadAssets(); });
onActivated(() => { viewActive = true; if (!loading.value && !materialAssets.value.length) loadAssets(); });
onDeactivated(() => { viewActive = false; stopReads(); });
onBeforeUnmount(() => { viewActive = false; stopReads(); window.removeEventListener("erp:auth-scope-changed", resetScope); });
</script>

<template>
  <div v-loading="loading" class="material-center-page erp-paged-page">
    <header class="material-center-header">
      <div>
        <h1>AI素材</h1>
        <p>仅展示近 7 天创建的 AI 图片、视频与文本。已采用素材可继续在草稿和案例中使用。</p>
      </div>
      <div class="header-actions">
        <el-button class="erp-btn erp-btn-secondary" v-if="returnTo" :icon="ArrowLeft" @click="goBackToSource">{{ returnLabel }}</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadAssets">刷新</el-button>
      </div>
    </header>

    <section class="summary-strip">
      <div><span>本页素材</span><strong>{{ summary.main }}</strong></div>
      <div><span>图片</span><strong>{{ summary.image }}</strong></div>
      <div><span>视频</span><strong>{{ summary.video }}</strong></div>
      <div><span>文本</span><strong>{{ summary.text }}</strong></div>
    </section>

    <section class="filter-bar">
      <el-input v-model="filters.keyword" :prefix-icon="Search" clearable placeholder="搜索名称、批次、车型、类目、文件名" @keyup.enter="searchAssets" @clear="searchAssets" />
      <el-select v-model="filters.mediaType" clearable placeholder="素材类型" @change="searchAssets">
        <el-option label="图片" value="image" />
        <el-option label="视频" value="video" />
        <el-option label="文本" value="text" />
      </el-select>
      <el-select v-model="filters.role" clearable placeholder="图片用途" @change="searchAssets">
        <el-option v-for="item in roleOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="素材状态" @change="searchAssets">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchAssets">查询</el-button>
      <el-button class="erp-btn erp-btn-secondary" @click="clearFilters">清空</el-button>
    </section>

    <section class="material-tabs">
        <div class="material-tab-panel">
          <div class="material-batch-bar">
            <span>已选 {{ selectedMaterialRows.length }} 个</span>
            <el-button class="erp-btn erp-btn-danger" :icon="Delete" :disabled="!selectedMaterialRows.length" :loading="deleting" @click="deleteSelectedMaterialAssets">删除选中</el-button>
          </div>
          <div class="material-table-wrap erp-table-scroll">
        <el-table :data="filteredMaterialAssets" border stripe class="material-table erp-data-table" @selection-change="handleSelectionChange('main', $event)">
          <el-table-column type="selection" width="44" fixed="left" />
          <el-table-column label="预览" width="92" align="center">
            <template #default="{ row }">
              <button type="button" class="thumb-button" @click="openPreview(row)">
                <video v-if="mediaType(row) === 'video' && previewUrl(row)" :src="previewUrl(row)" muted preload="metadata" playsinline /><span v-else-if="mediaType(row) === 'text'" class="empty-thumb">文本</span>
                <ProductImagePreview v-else-if="previewUrl(row)" :src="previewUrl(row)" alt="asset preview" size="compact" :preview="false" :lazy="false" />
                <span v-else class="empty-thumb">-</span>
              </button>
            </template>
          </el-table-column>
          <el-table-column label="素材名称" min-width="260">
            <template #default="{ row }">
              <div class="title-cell">
                <strong>{{ row.title || row.product_name || `素材 #${row.id}` }}</strong>
                <span>{{ row.product_name || row.target_model || row.source_id || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">{{ sourceLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="角色" width="125">
            <template #default="{ row }"><el-tag effect="plain">{{ row.role || "-" }}</el-tag></template>
          </el-table-column>
          <el-table-column label="车型 / 品牌" min-width="170">
            <template #default="{ row }">{{ [row.target_brand, row.target_model].filter(Boolean).join(" ") || "-" }}</template>
          </el-table-column>
          <el-table-column label="任务 / 结果" min-width="180">
            <template #default="{ row }">{{ row.variant_task_id || "-" }} / {{ row.variant_result_id || "-" }}</template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }"><el-tag>{{ row.status || "-" }}</el-tag></template>
          </el-table-column>
          <el-table-column label="更新时间" width="180">
            <template #default="{ row }">{{ formatTime(row.updated_at || row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="190" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn-link" size="small" link type="primary" :icon="View" @click="openPreview(row)">预览</el-button>
              <el-button v-if="!isAiVariantAssetRow(row)" class="erp-btn-link-danger" size="small" link type="danger" :icon="Delete" :loading="archiving" :disabled="row.status === 'archived'" @click="archiveAsset(row)">归档</el-button>
              <el-button class="erp-btn-link-danger" size="small" link type="danger" :icon="Delete" :loading="deleting" @click="deleteAsset(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
          </div>
          <PageFooterPagination
            :total="pager.main.total"
            :page="pager.main.page"
            :page-size="pager.main.pageSize"
            @update:page="handleMaterialPageChange('main', $event)"
            @update:pageSize="handleMaterialPageSizeChange('main', $event)"
          />
        </div>
    </section>

    <el-dialog v-if="previewDialog.visible" v-model="previewDialog.visible" :title="previewDialog.title" width="880px">
      <video v-if="previewDialog.type === 'video'" class="dialog-video" :src="previewDialog.url" controls autoplay playsinline />
      <pre v-else-if="previewDialog.type === 'text'" class="dialog-text">{{ previewDialog.text }}</pre>
      <img v-else class="dialog-image" :src="previewDialog.url" alt="素材预览">
    </el-dialog>
  </div>
</template>

<style scoped>
.material-center-page {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  gap: 14px;
  padding: 16px;
  color: var(--erp-detail-text-main, #172033);
  min-height: 0;
}

.material-center-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid var(--erp-detail-border, #dbe5ef);
  border-radius: 8px;
  background: var(--erp-detail-surface-alt, rgba(248, 250, 252, 0.96));
  backdrop-filter: blur(12px);
}

.material-center-header h1 {
  margin: 0;
  font-size: 22px;
  color: var(--erp-detail-text-main, #0f172a);
}

.material-center-header p {
  margin: 5px 0 0;
  color: var(--erp-text-regular, #64748b);
}

.header-actions,
.filter-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
}

.summary-strip div {
  min-height: 72px;
  display: grid;
  gap: 4px;
  align-content: center;
  padding: 12px;
  border: 1px solid var(--erp-detail-border, #dbe5ef);
  border-radius: 8px;
  background: var(--erp-detail-surface, #ffffff);
}

.summary-strip span {
  color: var(--erp-text-regular, #64748b);
  font-size: 12px;
}

.summary-strip strong {
  color: var(--erp-detail-text-main, #0f172a);
  font-size: 22px;
}

.filter-bar {
  padding: 12px;
  border: 1px solid var(--erp-detail-border, #dbe5ef);
  border-radius: 8px;
  background: var(--erp-detail-surface, #ffffff);
}

.filter-bar .el-input {
  width: min(420px, 100%);
}

.filter-bar .el-select {
  width: 150px;
}

.material-tabs {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 12px 12px;
  border: 1px solid var(--erp-detail-border, #dbe5ef);
  border-radius: 8px;
  background: var(--erp-detail-surface, #ffffff);
}

.material-tab-panel {
  min-width: 0;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.material-batch-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 8px;
  color: var(--erp-text-regular, #64748b);
  font-size: 13px;
}

.material-table-wrap {
  min-width: 0;
  overflow: auto;
  flex: 1 1 auto;
}

.material-table {
  width: 100%;
  min-width: 1120px;
}

.thumb-button {
  width: 64px;
  height: 84px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--erp-detail-border, #dbe5ef);
  border-radius: 8px;
  background: var(--erp-detail-surface-alt, #f8fafc);
  cursor: pointer;
  overflow: hidden;
}

.thumb-button img,
.thumb-button video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.portrait-thumb {
  aspect-ratio: 3 / 4;
}

.video-thumb,
.empty-thumb {
  color: var(--erp-text-regular, #64748b);
  font-size: 12px;
  font-weight: 700;
}

.title-cell {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.title-cell strong,
.title-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title-cell strong {
  color: var(--erp-detail-text-main, #0f172a);
}

.title-cell span {
  color: var(--erp-text-regular, #64748b);
  font-size: 12px;
}

.dialog-text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 72vh; overflow-y: auto; color: var(--erp-text-main); font: inherit; line-height: 1.8; }

.dialog-image,
.dialog-video {
  width: 100%;
  max-height: 72vh;
  object-fit: contain;
  background: #0f172a;
}

@media (max-width: 900px) {
  .material-center-header,
  .summary-strip {
    grid-template-columns: 1fr;
  }

  .material-center-header {
    display: grid;
  }

  .filter-bar .el-input,
  .filter-bar .el-select {
    width: 100%;
  }
}

@media (max-width: 767px) {
  .summary-strip,
  .asset-type-tabs,
  .material-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .material-center-actions { width: 100%; flex-wrap: wrap; }
  .material-center-actions .el-button { margin-left: 0; }
}

@media (max-width: 420px) {
  .summary-strip,
  .asset-type-tabs,
  .material-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
