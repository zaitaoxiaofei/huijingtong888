<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, MoreFilled, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const detailLoading = ref(false);
const creatingSku = ref("");
const creatingTemplateSku = ref("");
const deletingSku = ref("");
const batchDeleting = ref(false);
const detailVisible = ref(false);
const detail = ref(null);

const state = reactive({
  rows: [],
  selectedRows: [],
  total: 0,
  summary: {},
  filters: {
    query: "",
    status: "all",
    page: 1,
    pageSize: 20
  }
});

const statusOptions = [
  { label: "全部", value: "all" },
  { label: "今日采集", value: "today" },
  { label: "待处理", value: "collected" },
  { label: "已编辑", value: "edited" },
  { label: "已建上架模板", value: "listing_template_created" },
  { label: "已入选品池", value: "selection_created" }
];

const detailPayload = computed(() => detail.value?.payload || {});
const rawPayload = computed(() => detail.value?.rawPayload || detail.value?.raw_payload || {});
const detailImages = computed(() => {
  const values = [
    ...(Array.isArray(rawPayload.value.images) ? rawPayload.value.images : []),
    ...(Array.isArray(detailPayload.value.images) ? detailPayload.value.images : []),
    detail.value?.image_url,
    rawPayload.value.productImage,
    rawPayload.value.mainImage
  ];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 12);
});
const detailDimensions = computed(() => {
  const dimensions = detailPayload.value.dimensions || rawPayload.value.dimensions || {};
  return {
    length: firstFilled([dimensions.length, dimensions.length_cm, rawPayload.value.length, rawPayload.value.length_cm]),
    width: firstFilled([dimensions.width, dimensions.width_cm, rawPayload.value.width, rawPayload.value.width_cm]),
    height: firstFilled([dimensions.height, dimensions.height_cm, rawPayload.value.height, rawPayload.value.height_cm]),
    weight: firstFilled([dimensions.weight, dimensions.weight_g, rawPayload.value.weight, rawPayload.value.weight_g])
  };
});
const listingPreviewFields = computed(() => [
  { label: "商品标题", value: detail.value?.title || detailPayload.value.productTitle || rawPayload.value.title },
  { label: "Ozon SKU", value: detail.value?.sku },
  { label: "产品类目", value: detail.value?.category_name || detailPayload.value.category || rawPayload.value.categoryName || rawPayload.value.category },
  { label: "来源链接", value: detail.value?.product_url || detailPayload.value.productUrl, type: "link" },
  { label: "采集日期", value: detail.value?.collect_date },
  { label: "当前状态", value: statusText(detail.value || {}) }
]);
const footerSummary = computed(() => `第 ${state.filters.page} 页`);

function firstFilled(values) {
  return values.find((value) => value !== null && value !== undefined && value !== "") ?? "";
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${(number * 100).toFixed(2)}%`;
}

function formatDimension(value, unit) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${formatNumber(number)} ${unit}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const text = String(value);
  return text.length > 16 ? text.slice(0, 16) : text;
}

function skuCount(row) {
  return Number(row?.sku_count || row?.skuCount || row?.variant_count || row?.variantCount || 1);
}

const selectedSkus = computed(() => state.selectedRows.map((row) => String(row?.sku || "").trim()).filter(Boolean));

function productTitle(row) {
  return String(row?.title || (row?.sku ? `Ozon ${row.sku}` : "")).trim();
}

function productBuyerLink(row) {
  return row?.product_url || (row?.sku ? `https://www.ozon.ru/product/${encodeURIComponent(row.sku)}/` : "");
}

function statusText(row) {
  const map = {
    collected: "待处理",
    edited: "已编辑",
    listing_template_created: "已建上架模板",
    selection_created: "已入选品池"
  };
  return map[row?.status] || "待处理";
}

function statusType(row) {
  if (row?.status === "selection_created" || row?.status === "listing_template_created") return "success";
  if (row?.status === "edited") return "primary";
  return "warning";
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set("page", String(state.filters.page));
  params.set("pageSize", String(state.filters.pageSize));
  if (state.filters.query.trim()) params.set("query", state.filters.query.trim());
  if (state.filters.status !== "all") params.set("status", state.filters.status);
  return params;
}

async function loadRows() {
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/listing/collector-box?${buildQuery().toString()}`, { noCache: true });
    state.rows = result.rows || [];
    state.selectedRows = [];
    state.total = Number(result.total || 0);
    state.summary = result.summary || {};
  } catch (error) {
    ElMessage.error(error.message || "采集箱加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  state.filters.page = 1;
  loadRows();
}

function resetFilters() {
  state.filters.query = "";
  state.filters.status = "all";
  state.filters.page = 1;
  loadRows();
}

async function openDetail(row) {
  detailVisible.value = true;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`, { noCache: true });
  } catch (error) {
    ElMessage.error(error.message || "详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function ensureDetail(row) {
  if (detail.value?.sku === row?.sku) return detail.value;
  return await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`, { noCache: true });
}

async function openEdit(row) {
  await createListingTemplate(row);
}

function handleRowCommand(command, row) {
  if (command === "detail") return openDetail(row);
  if (command === "ozon") return openOzon(row);
  if (command === "selection") return createSelection(row);
  if (command === "delete") return deleteRow(row);
  return null;
}

function handleSelectionChange(rows) {
  state.selectedRows = rows || [];
}

function openOzon(row) {
  const url = productBuyerLink(row);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

async function createListingTemplate(row) {
  if (!row?.sku) return;
  creatingTemplateSku.value = row.sku;
  try {
    if (row.listing_template_id) {
      router.push({ path: "/listing-automation", query: { templateId: row.listing_template_id, collectorSku: row.sku } });
      return;
    }
    const result = await apiClient.post(`/api/listing/collector-box/${encodeURIComponent(row.sku)}/create-listing-template`, {
      openMode: "listing_editor",
      compact: true
    });
    ElMessage.success(result?.reused ? "已载入已有上架模板" : "已生成上架编辑模板");
    const templateId = result?.template?.id;
    if (templateId) router.push({ path: "/listing-automation", query: { templateId, collectorSku: row.sku } });
    loadRows().catch(() => {});
  } catch (error) {
    ElMessage.error(error.message || "创建上架模板失败");
  } finally {
    creatingTemplateSku.value = "";
  }
}

async function createSelection(row) {
  if (!row?.sku) return;
  await ElMessageBox.confirm("将该采集商品生成选品池草稿，后续可继续完善成本、物流和上架资料。", "加入选品池", {
    confirmButtonText: "生成草稿",
    cancelButtonText: "取消",
    type: "info"
  });
  creatingSku.value = row.sku;
  try {
    const result = await apiClient.post(`/api/listing/collector-box/${encodeURIComponent(row.sku)}/create-selection`, {});
    ElMessage.success("已生成选品池草稿");
    await loadRows();
    if (result?.product?.id || result?.id) {
      router.push({ path: "/selection", query: { productId: result.product?.id || result.id } });
    }
  } catch (error) {
    ElMessage.error(error.message || "加入选品池失败");
  } finally {
    creatingSku.value = "";
  }
}

async function deleteRow(row) {
  if (!row?.sku) return;
  await ElMessageBox.confirm(`确认删除采集商品 ${row.sku}？删除后列表不再显示。`, "删除采集商品", {
    confirmButtonText: "删除",
    cancelButtonText: "取消",
    type: "warning"
  });
  deletingSku.value = row.sku;
  try {
    await apiClient.delete(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`);
    ElMessage.success("已删除采集商品");
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "删除失败");
  } finally {
    deletingSku.value = "";
  }
}

async function batchDeleteRows() {
  const skus = selectedSkus.value;
  if (!skus.length) return;
  await ElMessageBox.confirm(`确认删除选中的 ${skus.length} 个采集商品？`, "批量删除", {
    confirmButtonText: "批量删除",
    cancelButtonText: "取消",
    type: "warning"
  });
  batchDeleting.value = true;
  try {
    await apiClient.delete("/api/listing/collector-box", {
      body: JSON.stringify({ skus })
    });
    ElMessage.success(`已删除 ${skus.length} 个采集商品`);
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "批量删除失败");
  } finally {
    batchDeleting.value = false;
  }
}

watch(() => [state.filters.page, state.filters.pageSize], loadRows);

onMounted(() => {
  if (route.query.sku) state.filters.query = String(route.query.sku);
  loadRows();
});
</script>

<template>
  <div class="page-stack collector-box-page">
    <el-card shadow="never" class="page-card erp-paged-card collector-list-card">
      <div class="collector-toolbar">
        <div class="collector-filter-row">
          <el-input v-model="state.filters.query" clearable placeholder="搜索 SKU、标题、类目" class="collector-search" @keyup.enter="search" />
          <el-select v-model="state.filters.status" class="collector-status-filter" @change="search">
            <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-button type="primary" :icon="Search" :loading="loading" @click="search">搜索</el-button>
          <el-button :icon="Refresh" @click="resetFilters">重置</el-button>
        </div>
        <div class="collector-toolbar-actions">
          <el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="!selectedSkus.length"
            :loading="batchDeleting"
            @click="batchDeleteRows"
          >
            批量删除
          </el-button>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="state.rows"
        stripe
        border
        class="erp-data-table collector-table"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" align="center" fixed="left" />
        <el-table-column label="图片" width="92" align="center" fixed="left">
          <template #default="{ row }">
            <ProductImagePreview :src="row.image_url" />
          </template>
        </el-table-column>
        <el-table-column label="产品名称" min-width="360" fixed="left">
          <template #default="{ row }">
            <div class="product-main table-title-cell">
              <ProductTitleLink :title="productTitle(row)" :href="productBuyerLink(row)" :lines="2" />
              <span>{{ row.category_name || "未识别类目" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="采集价格" width="130" align="center">
          <template #default="{ row }">{{ formatNumber(row.price, 2) }} {{ row.currency }}</template>
        </el-table-column>
        <el-table-column label="SKU数量" width="100" align="center">
          <template #default="{ row }">{{ skuCount(row) }}</template>
        </el-table-column>
        <el-table-column label="采集来源" width="120" align="center">
          <template #default>ozon</template>
        </el-table-column>
        <el-table-column label="运营数据" width="150" align="center">
          <template #default="{ row }">
            <span>{{ formatNumber(row.sold_count) }} / {{ formatNumber(row.view_count) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row)" effect="plain">{{ statusText(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.created_at || row.collect_date) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.updated_at || row.edited_at || row.collected_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="creatingTemplateSku === row.sku"
                @click="openEdit(row)"
              >
                编辑上架
              </el-button>
              <el-dropdown trigger="click" @command="(command) => handleRowCommand(command, row)">
                <el-button size="small" circle :icon="MoreFilled" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="detail">查看详情</el-dropdown-item>
                    <el-dropdown-item command="ozon">打开 Ozon</el-dropdown-item>
                    <el-dropdown-item command="selection" :disabled="row.status === 'selection_created'">加入选品池</el-dropdown-item>
                    <el-dropdown-item command="delete" divided :disabled="deletingSku === row.sku">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <PageFooterPagination
        v-model:page="state.filters.page"
        v-model:page-size="state.filters.pageSize"
        :total="state.total"
        :summary="footerSummary"
      />
    </el-card>

    <el-drawer v-model="detailVisible" title="采集商品详情" size="860px" class="collector-detail-drawer">
      <div v-loading="detailLoading" class="detail-drawer">
        <template v-if="detail">
          <section class="listing-preview-hero">
            <ProductImagePreview :src="detailImages[0] || detail.image_url" size="square" />
            <div class="listing-preview-hero__main">
              <div class="listing-preview-title">
                <h3>{{ detail.title || `Ozon ${detail.sku}` }}</h3>
                <el-tag :type="statusType(detail)" effect="plain">{{ statusText(detail) }}</el-tag>
              </div>
              <p>{{ detail.category_name || "未识别类目" }}</p>
              <div class="listing-preview-actions">
                <el-button @click="openOzon(detail)">打开 Ozon</el-button>
                <el-button
                  type="primary"
                  plain
                  :loading="creatingTemplateSku === detail.sku"
                  @click="openEdit(detail)"
                >
                  编辑上架
                </el-button>
                <el-button
                  type="warning"
                  :disabled="detail.status === 'selection_created'"
                  :loading="creatingSku === detail.sku"
                  @click="createSelection(detail)"
                >
                  加入选品池
                </el-button>
              </div>
            </div>
          </section>

          <section class="listing-panel">
          <div class="listing-panel__head">
            <h4>上架基础信息</h4>
              <span>点击编辑上架后会带入商品上架模板</span>
          </div>
            <div class="listing-field-grid">
              <div v-for="field in listingPreviewFields" :key="field.label" class="listing-field">
                <span>{{ field.label }}</span>
                <a v-if="field.type === 'link' && field.value" :href="field.value" target="_blank" rel="noopener noreferrer">{{ field.value }}</a>
                <strong v-else>{{ field.value || "-" }}</strong>
              </div>
            </div>
          </section>

          <section class="listing-panel">
            <div class="listing-panel__head">
              <h4>运营判断数据</h4>
              <span>按上架页常看的价格、销量、体积来排布</span>
            </div>
            <div class="metric-grid">
              <div class="metric-card">
                <span>前台价格</span>
                <strong>{{ formatNumber(detail.price, 2) }} {{ detail.currency || "RUB" }}</strong>
              </div>
              <div class="metric-card">
                <span>销量</span>
                <strong>{{ formatNumber(detail.sold_count) }}</strong>
              </div>
              <div class="metric-card">
                <span>浏览</span>
                <strong>{{ formatNumber(detail.view_count) }}</strong>
              </div>
              <div class="metric-card">
                <span>转化率</span>
                <strong>{{ formatPercent(detail.conversion_rate) }}</strong>
              </div>
            </div>
            <div class="listing-field-grid compact">
              <div class="listing-field">
                <span>长</span>
                <strong>{{ formatDimension(detailDimensions.length, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>宽</span>
                <strong>{{ formatDimension(detailDimensions.width, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>高</span>
                <strong>{{ formatDimension(detailDimensions.height, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>重量</span>
                <strong>{{ formatDimension(detailDimensions.weight, "g") }}</strong>
              </div>
            </div>
          </section>

          <section class="listing-panel">
            <div class="listing-panel__head">
              <h4>图片素材</h4>
              <span>{{ detailImages.length ? `${detailImages.length} 张可用图片` : "暂无图片" }}</span>
            </div>
            <div v-if="detailImages.length" class="image-strip">
              <ProductImagePreview v-for="image in detailImages" :key="image" :src="image" size="square" />
            </div>
            <el-empty v-else description="暂无图片素材" :image-size="72" />
          </section>

          <el-collapse class="raw-collapse">
            <el-collapse-item title="查看原始采集数据" name="raw">
              <pre class="payload-preview">{{ JSON.stringify(rawPayload || detail.payload || {}, null, 2) }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>
      </div>
    </el-drawer>

  </div>
</template>

<style scoped>
.collector-toolbar,
.collector-filter-row,
.collector-toolbar-actions,
.product-cell,
.listing-preview-hero,
.listing-preview-title,
.listing-preview-actions,
.row-actions {
  display: flex;
  align-items: center;
}

.collector-list-card {
  overflow: hidden;
}

.collector-toolbar {
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0 14px;
}

.collector-filter-row {
  flex: 1;
  gap: 10px;
  min-width: 0;
}

.collector-toolbar-actions {
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}

.collector-search {
  width: min(360px, 38vw);
}

.collector-status-filter {
  width: 150px;
}

.product-cell {
  gap: 12px;
  min-width: 0;
}

.product-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.table-title-cell {
  padding-right: 12px;
}

.listing-preview-title h3 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-main strong {
  display: -webkit-box;
  overflow: hidden;
  max-width: 100%;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.35;
}

.product-main span,
.product-main em,
.collector-table small {
  color: var(--el-text-color-secondary);
  font-style: normal;
}

.collector-table :deep(.el-table__cell) {
  padding: 8px 0;
}

.collector-table :deep(.el-table__header th) {
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-weight: 600;
}

.row-actions {
  justify-content: center;
  gap: 8px;
}

.detail-drawer {
  min-height: 320px;
}

.listing-preview-hero {
  align-items: flex-start;
  gap: 18px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.listing-preview-hero__main {
  display: grid;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.listing-preview-title {
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.listing-preview-title h3 {
  margin: 0;
  font-size: 18px;
}

.listing-preview-hero p {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.listing-preview-actions {
  gap: 10px;
  justify-content: flex-end;
}

.listing-panel {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
}

.listing-panel__head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.listing-panel__head h4 {
  margin: 0;
  font-size: 15px;
}

.listing-panel__head span,
.listing-field span,
.metric-card span {
  color: var(--el-text-color-secondary);
}

.listing-field-grid,
.metric-grid {
  display: grid;
  gap: 10px;
}

.listing-field-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.listing-field-grid.compact,
.metric-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.listing-field,
.metric-card {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.listing-field strong,
.listing-field a,
.metric-card strong {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.listing-field a {
  color: var(--el-color-primary);
}

.metric-card strong {
  font-size: 18px;
}

.image-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
}

.raw-collapse {
  margin-top: 16px;
}

.payload-preview {
  max-height: 320px;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 760px) {
  .collector-toolbar,
  .collector-filter-row,
  .collector-toolbar-actions,
  .listing-preview-hero,
  .listing-panel__head {
    align-items: stretch;
    flex-direction: column;
  }

  .collector-toolbar-actions {
    margin-left: 0;
  }

  .collector-search,
  .collector-status-filter {
    width: 100%;
  }

  .listing-field-grid,
  .listing-field-grid.compact,
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
