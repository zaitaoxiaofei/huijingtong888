<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { formatInteger, formatMoney, formatShortDate } from "./profit-utils.js";
import { shanghaiDateKey, shanghaiMonthStart, shanghaiDateText } from "../../utils/shanghai-date";

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const shops = ref([]);
const detailActionLoading = ref(false);
const detailRowActionKey = ref("");
const detailRouteRestoreDone = ref(false);

function todayText() {
  return shanghaiDateKey();
}

function monthStartText() {
  return shanghaiMonthStart();
}

function defaultFilters() {
  return {
    from: monthStartText(),
    to: todayText(),
    shopId: "all",
    bucket: "all"
  };
}

const state = reactive({
  buckets: [],
  totals: {},
  missingAlert: {},
  filters: defaultFilters()
});

const detail = reactive({
  row: null,
  rows: [],
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1
});

const bucketOptions = [
  { label: "全部", value: "all" },
  { label: "履约前取消", value: "pre_fulfillment_cancel" },
  { label: "拒收/未取", value: "rejected_unclaimed" },
  { label: "不合适/发错货/破损", value: "unsuitable_wrong_damaged" },
  { label: "质量问题", value: "quality_issue" },
  { label: "平台质检/证件问题", value: "platform_document_issue" }
];

const currentShopName = computed(() => {
  if (state.filters.shopId === "all") return "全部店铺";
  return shops.value.find((item) => String(item.id) === String(state.filters.shopId))?.name || "未知店铺";
});

const rangeSummary = computed(() => `${state.filters.from || "--"} 至 ${state.filters.to || "--"}`);

function formatDate(value) {
  return shanghaiDateText(value, { assumeUtcWhenNaive: true });
}

function bucketLabel(key) {
  return bucketOptions.find((item) => item.value === key)?.label || key || "-";
}

function bucketHint(key) {
  return {
    pre_fulfillment_cancel: "履约前取消，默认损失 0。",
    rejected_unclaimed: "至少核对商品成本、国际运费和收单费。",
    unsuitable_wrong_damaged: "至少核对商品成本、国内/国际运费和平台费。",
    quality_issue: "重点核对佣金、平台售后费和完整履约成本。",
    platform_document_issue: "单独列示，先看财务流水再定损失口径。"
  }[key] || "";
}

function detailOrderStatus(row = {}) {
  return [row.status, row.tracking_stage, row.logistics_status]
    .map((item) => String(item || "").trim())
    .find(Boolean) || "-";
}

function detailItemImageUrl(row = {}) {
  const value = row.image_url || row.ozon_image_url || row.online_image_url || row.primary_image || row.product_image_url || "";
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return String(parsed[0] || "").trim();
      return String(parsed.url || parsed.image_url || parsed.src || "").trim();
    } catch {
      return text;
    }
  }
  return text.split("||").map((item) => item.trim()).find(Boolean) || "";
}

function hasMissingCost(row = {}) {
  return Number(row.missing_cost_count || 0) > 0;
}

function hasMissingShipping(row = {}) {
  return Number(row.missing_shipping_count || 0) > 0;
}

function hasNeedsReview(row = {}) {
  return Number(row.needs_review || 0) > 0;
}

function detailIssueTags(row = {}) {
  const tags = [];
  if (hasMissingCost(row)) tags.push({ key: "cost", label: "成本缺失", type: "warning" });
  if (hasMissingShipping(row)) tags.push({ key: "shipping", label: "运费缺失", type: "danger" });
  if (hasNeedsReview(row)) tags.push({ key: "review", label: "待核实", type: "info" });
  return tags;
}

function aftersalesBucketCellClassName({ row, column }) {
  if (column.property === "missing_cost_count" && Number(row.missing_cost_count || 0) > 0) return "aftersales-summary-cell-is-cost-missing";
  if (column.property === "missing_shipping_count" && Number(row.missing_shipping_count || 0) > 0) return "aftersales-summary-cell-is-shipping-missing";
  if (column.property === "needs_review_count" && Number(row.needs_review_count || 0) > 0) return "aftersales-summary-cell-is-review";
  return "";
}

function aftersalesDetailRowClassName({ row }) {
  if (hasMissingCost(row)) return "aftersales-row-is-cost-missing";
  if (hasMissingShipping(row)) return "aftersales-row-is-shipping-missing";
  if (hasNeedsReview(row)) return "aftersales-row-is-review";
  return "";
}

function aftersalesDetailCellClassName({ row, column }) {
  if (column.property === "purchase_cost_cny" && hasMissingCost(row)) return "aftersales-cell-is-cost-missing";
  if (column.property === "international_shipping_cny" && hasMissingShipping(row)) return "aftersales-cell-is-shipping-missing";
  if ((column.property === "estimated_loss_cny" || column.property === "sale_amount_cny") && hasNeedsReview(row)) return "aftersales-cell-is-review";
  return "";
}

function detailActionKey(row, action) {
  return `${row.order_id || row.order_number || "row"}:${action}`;
}

function openInventory(row) {
  if (!row.product_id) return ElMessage.warning("当前售后明细未关联库存商品");
  router.push({ path: "/inventory/products", query: { productId: String(row.product_id) } });
}

function openBinding(row) {
  if (!row.online_product_id) return ElMessage.warning("当前售后明细未关联在线商品");
  router.push({ path: "/online-products", query: { onlineProductId: String(row.online_product_id), action: "bind" } });
}

function openOrder(row) {
  if (!row.order_id) return ElMessage.warning("当前售后明细未关联订单");
  router.push({
    path: "/orders",
    query: {
      orderId: String(row.order_id),
      from: "profit-aftersales",
      returnBucket: String(detail.row?.key || row.bucket || ""),
      returnFilterBucket: String(state.filters.bucket || "all"),
      returnDetailBucket: String(detail.row?.key || row.bucket || ""),
      returnFrom: String(state.filters.from || ""),
      returnTo: String(state.filters.to || ""),
      returnShopId: String(state.filters.shopId || "all"),
      returnDetailPage: String(detail.page || 1),
      returnDetailPageSize: String(detail.pageSize || 10)
    }
  });
}

async function recalculateOrder(row) {
  if (!row.order_id) return ElMessage.warning("当前售后明细未关联订单");
  detailRowActionKey.value = detailActionKey(row, "recalculate");
  try {
    await apiClient.post(`/api/orders/${row.order_id}/recalculate-profit`, {});
    ElMessage.success("已重算订单利润");
    await refreshDetail();
    await loadAftersales();
  } catch (error) {
    ElMessage.error(error.message || "重算利润失败");
  } finally {
    detailRowActionKey.value = "";
  }
}

async function batchRecalculateDetailRows() {
  const rows = (detail.rows || []).filter((row) => row.order_id);
  if (!rows.length) return ElMessage.warning("当前页没有可重算的订单");
  const confirmed = await ElMessageBox.confirm(`确认重算当前页 ${rows.length} 个售后订单利润？`, "批量重算", {
    type: "warning",
    confirmButtonText: "确认重算",
    cancelButtonText: "取消"
  }).catch(() => false);
  if (!confirmed) return;

  detailActionLoading.value = true;
  try {
    for (const row of rows) {
      await apiClient.post(`/api/orders/${row.order_id}/recalculate-profit`, {});
    }
    ElMessage.success(`已重算 ${rows.length} 个订单`);
    await refreshDetail();
    await loadAftersales();
  } catch (error) {
    ElMessage.error(error.message || "批量重算失败");
  } finally {
    detailActionLoading.value = false;
  }
}

async function loadShops() {
  if (shops.value.length) return;
  const payload = await apiClient.get("/api/shops");
  shops.value = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
}

function validateFilters() {
  if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) {
    ElMessage.warning("开始日期不能晚于结束日期");
    return false;
  }
  return true;
}

async function loadAftersales() {
  if (!validateFilters()) return;
  loading.value = true;
  try {
    const params = new URLSearchParams({
      from: state.filters.from || "",
      to: state.filters.to || "",
      shopId: state.filters.shopId || "all",
      bucket: state.filters.bucket || "all"
    });
    const payload = await apiClient.get(`/api/profit-aftersales?${params.toString()}`);
    state.buckets = Array.isArray(payload?.buckets) ? payload.buckets : [];
    state.totals = payload?.totals || {};
    state.missingAlert = payload?.missing_alert || {};
  } catch (error) {
    ElMessage.error(error.message || "售后损失加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadDetail(row, { resetPage = false } = {}) {
  if (!row) return;
  detailLoading.value = true;
  detailVisible.value = true;
  detail.row = row;
  detail.rows = [];
  if (resetPage) detail.page = 1;
  try {
    const params = new URLSearchParams({
      from: state.filters.from || "",
      to: state.filters.to || "",
      shopId: state.filters.shopId || "all",
      bucket: row.key,
      page: String(detail.page),
      pageSize: String(detail.pageSize)
    });
    const payload = await apiClient.get(`/api/profit-aftersales/details?${params.toString()}`);
    detail.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    detail.total = Number(payload?.total || 0);
    detail.totalPages = Number(payload?.total_pages || 1);
  } catch (error) {
    detailVisible.value = false;
    ElMessage.error(error.message || "售后明细加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function openDetail(row) {
  await loadDetail(row, { resetPage: true });
}

async function refreshDetail() {
  if (!detail.row) return;
  await loadDetail(detail.row);
}

function resetFilters() {
  Object.assign(state.filters, defaultFilters());
  loadAftersales();
}

function handleQuery() {
  loadAftersales();
}

function handleDetailPageChange(page) {
  detail.page = Number(page || 1);
  refreshDetail();
}

function handleDetailPageSizeChange(size) {
  detail.page = 1;
  detail.pageSize = Number(size || 10);
  refreshDetail();
}

function backToDashboard() {
  router.push("/profit");
}

function syncFiltersFromRoute() {
  state.filters.from = String(route.query.from || route.query.aftersalesFrom || state.filters.from || monthStartText());
  state.filters.to = String(route.query.to || route.query.aftersalesTo || state.filters.to || todayText());
  state.filters.shopId = String(route.query.shopId || route.query.aftersalesShopId || state.filters.shopId || "all");
  state.filters.bucket = String(route.query.bucket || state.filters.bucket || "all");
}

async function restoreDetailFromRoute() {
  if (detailRouteRestoreDone.value) return;
  const detailBucket = String(route.query.detailBucket || route.query.returnDetailBucket || route.query.bucket || "");
  if (!detailBucket || detailBucket === "all") return;
  const row = (state.buckets || []).find((item) => String(item.key) === detailBucket);
  if (!row) return;
  detailRouteRestoreDone.value = true;
  detail.page = Math.max(1, Number(route.query.detailPage || route.query.returnDetailPage || 1));
  detail.pageSize = Math.max(1, Number(route.query.detailPageSize || route.query.returnDetailPageSize || detail.pageSize || 10));
  await loadDetail(row);
}

watch(() => [state.filters.from, state.filters.to, state.filters.shopId, state.filters.bucket], () => {
  loadAftersales();
});

onMounted(async () => {
  try {
    syncFiltersFromRoute();
    await loadShops();
    await loadAftersales();
    await restoreDetailFromRoute();
  } catch (error) {
    ElMessage.error(error.message || "页面初始化失败");
  }
});
</script>

<template>
  <div class="page-stack profit-aftersales-page">
    <el-card shadow="never" class="page-card">
      <div class="page-hero">
        <div>
          <h2>售后损失</h2>
          <p>独立查看取消、拒收、错发破损、质量问题和平台/证件问题的数量、销售额和损失。</p>
        </div>
        <div class="page-card-actions">
          <el-button class="erp-btn erp-btn-secondary" @click="backToDashboard">返回利润看板</el-button>
          <el-button class="erp-btn erp-btn-secondary" type="primary" plain @click="loadAftersales">刷新</el-button>
        </div>
      </div>

      <div class="aftersales-toolbar">
        <el-form inline @submit.prevent>
          <el-form-item label="开始日期">
            <el-date-picker v-model="state.filters.from" value-format="YYYY-MM-DD" type="date" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="state.filters.to" value-format="YYYY-MM-DD" type="date" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="店铺">
            <el-select v-model="state.filters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="类型">
            <el-select v-model="state.filters.bucket" style="width: 220px">
              <el-option v-for="item in bucketOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" :loading="loading" @click="handleQuery">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <el-alert
        v-if="state.missingAlert?.message"
        type="warning"
        :closable="false"
        :title="state.missingAlert.message"
        class="aftersales-alert"
      />

      <div class="aftersales-summary">
        <div class="aftersales-summary__item">
          <span>时间段</span>
          <strong>{{ rangeSummary }}</strong>
        </div>
        <div class="aftersales-summary__item">
          <span>店铺</span>
          <strong>{{ currentShopName }}</strong>
        </div>
        <div class="aftersales-summary__item">
          <span>订单数</span>
          <strong>{{ formatInteger(state.totals?.order_count) }}</strong>
        </div>
        <div class="aftersales-summary__item">
          <span>涉及销售额</span>
          <strong>{{ formatMoney(state.totals?.sale_amount_cny) }}</strong>
        </div>
        <div class="aftersales-summary__item">
          <span>估算损失</span>
          <strong>{{ formatMoney(state.totals?.estimated_loss_cny) }}</strong>
        </div>
        <div class="aftersales-summary__item">
          <span>待核实</span>
          <strong>{{ formatInteger(state.totals?.needs_review_count) }}</strong>
        </div>
      </div>

      <div class="aftersales-table-wrap">
        <el-table
          :data="state.buckets"
          stripe
          class="erp-data-table"
          v-loading="loading"
          table-layout="fixed"
          :cell-class-name="aftersalesBucketCellClassName"
        >
          <el-table-column prop="label" label="类型" min-width="180">
            <template #default="{ row }">
              <strong>{{ row.label }}</strong>
              <div class="aftersales-cell-hint">{{ bucketHint(row.key) }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="order_count" label="订单数" width="90">
            <template #default="{ row }">{{ formatInteger(row.order_count) }}</template>
          </el-table-column>
          <el-table-column prop="item_quantity" label="件数" width="80">
            <template #default="{ row }">{{ formatInteger(row.item_quantity) }}</template>
          </el-table-column>
          <el-table-column prop="sale_amount_cny" label="涉及销售额" min-width="120">
            <template #default="{ row }">{{ formatMoney(row.sale_amount_cny) }}</template>
          </el-table-column>
          <el-table-column prop="estimated_loss_cny" label="估算损失" min-width="120">
            <template #default="{ row }">{{ formatMoney(row.estimated_loss_cny) }}</template>
          </el-table-column>
          <el-table-column prop="actual_loss_cny" label="已入账损失" min-width="120">
            <template #default="{ row }">{{ formatMoney(row.actual_loss_cny) }}</template>
          </el-table-column>
          <el-table-column prop="missing_cost_count" label="成本缺失" width="90">
            <template #default="{ row }">
              <span :class="{ warning: Number(row.missing_cost_count || 0) > 0 }">{{ formatInteger(row.missing_cost_count) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="missing_shipping_count" label="运费缺失" width="90">
            <template #default="{ row }">
              <span :class="{ warning: Number(row.missing_shipping_count || 0) > 0 }">{{ formatInteger(row.missing_shipping_count) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="needs_review_count" label="待核实" width="90">
            <template #default="{ row }">
              <span :class="{ warning: Number(row.needs_review_count || 0) > 0 }">{{ formatInteger(row.needs_review_count) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" @click="openDetail(row)">明细</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-dialog v-model="detailVisible" title="售后明细" width="1460px" destroy-on-close class="erp-centered-dialog">
      <div v-loading="detailLoading" class="aftersales-detail-dialog">
        <div class="aftersales-detail-header">
          <div>
            <strong>{{ bucketLabel(detail.row?.key) }}</strong>
            <span>{{ detail.row?.loss_policy || "-" }}</span>
          </div>
          <div class="aftersales-detail-meta">
            <span>{{ currentShopName }}</span>
            <span>{{ formatDate(state.filters.from) }} - {{ formatDate(state.filters.to) }}</span>
            <el-button class="erp-btn erp-btn-secondary" size="small" :loading="detailActionLoading" @click="batchRecalculateDetailRows">批量重算</el-button>
            <el-button class="erp-btn erp-btn-secondary" size="small" @click="refreshDetail">刷新</el-button>
          </div>
        </div>

        <div class="aftersales-detail-table-wrap">
          <el-table
            :data="detail.rows"
            stripe
            class="erp-data-table"
            table-layout="fixed"
            :row-class-name="aftersalesDetailRowClassName"
            :cell-class-name="aftersalesDetailCellClassName"
          >
            <el-table-column label="订单信息" min-width="220">
              <template #default="{ row }">
                <div class="aftersales-cell-stack">
                  <strong>{{ row.posting_number || row.order_number || "-" }}</strong>
                  <span>订单号：{{ row.order_number || "-" }}</span>
                  <span>下单：{{ formatDate(row.ordered_at) }}</span>
                  <span>状态：{{ detailOrderStatus(row) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="缩略图" width="96" align="center">
              <template #default="{ row }">
                <el-image
                  v-if="detailItemImageUrl(row)"
                  :src="detailItemImageUrl(row)"
                  fit="contain"
                  class="aftersales-item-thumb"
                  :preview-src-list="[detailItemImageUrl(row)]"
                  preview-teleported
                />
                <div v-else class="aftersales-item-thumb aftersales-item-thumb-empty">无图</div>
              </template>
            </el-table-column>
            <el-table-column label="商品信息" min-width="300">
              <template #default="{ row }">
                <div class="aftersales-cell-stack">
                  <strong>{{ row.item_names || "-" }}</strong>
                  <span>SKU：{{ row.skus || "-" }}</span>
                  <span>件数：{{ formatInteger(row.item_quantity) }}</span>
                  <span>店铺：{{ row.shop_name || currentShopName }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="原因" min-width="220">
              <template #default="{ row }">
                <div class="aftersales-cell-stack">
                  <strong>{{ row.reason_label || "-" }}</strong>
                  <span>{{ row.reason_group_label || "-" }}</span>
                  <span>{{ row.cancel_reason || "-" }}</span>
                  <div class="aftersales-tag-row">
                    <el-tag
                      v-for="tag in detailIssueTags(row)"
                      :key="tag.key"
                      size="small"
                      effect="dark"
                      :type="tag.type"
                    >
                      {{ tag.label }}
                    </el-tag>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="sale_amount_cny" label="销售额" width="110">
              <template #default="{ row }">{{ formatMoney(row.sale_amount_cny) }}</template>
            </el-table-column>
            <el-table-column prop="estimated_loss_cny" label="估算损失" width="110">
              <template #default="{ row }">{{ formatMoney(row.estimated_loss_cny) }}</template>
            </el-table-column>
            <el-table-column prop="purchase_cost_cny" label="成本" width="100">
              <template #default="{ row }">{{ formatMoney(row.purchase_cost_cny) }}</template>
            </el-table-column>
            <el-table-column prop="international_shipping_cny" label="国际运费" width="100">
              <template #default="{ row }">{{ formatMoney(row.international_shipping_cny) }}</template>
            </el-table-column>
            <el-table-column prop="commission_fee_cny" label="佣金" width="100">
              <template #default="{ row }">{{ formatMoney(row.commission_fee_cny) }}</template>
            </el-table-column>
            <el-table-column label="处理" width="250" fixed="right">
              <template #default="{ row }">
                <div class="aftersales-actions-cell">
                  <el-button class="erp-btn-link" link type="primary" @click="openOrder(row)">查看订单</el-button>
                  <el-button class="erp-btn-link" v-if="row.product_id" link @click="openInventory(row)">打开库存</el-button>
                  <el-button class="erp-btn-link" v-if="row.online_product_id" link type="warning" @click="openBinding(row)">去绑定</el-button>
                  <el-button
                    v-if="row.order_id"
                    link
                    type="success"
                    :loading="detailRowActionKey === detailActionKey(row, 'recalculate')"
                    @click="recalculateOrder(row)"
                  >
                    重算
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <PageFooterPagination
          :total="detail.total"
          :page="detail.page"
          :page-size="detail.pageSize"
          :total-pages="detail.totalPages"
          :page-sizes="[10, 20, 50]"
          summary=" "
          @update:page="handleDetailPageChange"
          @update:page-size="handleDetailPageSizeChange"
        />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.profit-aftersales-page .page-card {
  min-height: 0;
}

.aftersales-toolbar {
  margin: 12px 0 16px;
}

.aftersales-toolbar :deep(.el-form) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 0;
}

.aftersales-alert {
  margin-bottom: 12px;
}

.aftersales-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.aftersales-summary__item {
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.aftersales-summary__item span {
  display: block;
  color: #64748b;
  font-size: 12px;
}

.aftersales-summary__item strong {
  display: block;
  margin-top: 6px;
  font-size: 16px;
  color: #0f172a;
}

.aftersales-table-wrap {
  margin-bottom: 12px;
}

.aftersales-cell-hint {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
  white-space: normal;
}

.warning {
  color: #b45309;
  font-weight: 700;
}

.aftersales-detail-dialog {
  display: flex;
  flex-direction: column;
  min-height: 620px;
  max-height: calc(100vh - 180px);
}

.aftersales-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.aftersales-detail-header strong {
  display: block;
  font-size: 16px;
}

.aftersales-detail-header span,
.aftersales-detail-meta span {
  color: #64748b;
  font-size: 12px;
}

.aftersales-detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.aftersales-detail-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-bottom: 8px;
}

.aftersales-item-thumb {
  width: 64px;
  height: 84px;
  display: block;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  cursor: zoom-in;
}

.aftersales-item-thumb .el-image__wrapper,
.aftersales-item-thumb .el-image__inner {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
}

.aftersales-item-thumb-empty {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 12px;
}

.aftersales-cell-stack {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.aftersales-cell-stack strong {
  color: #0f172a;
  font-size: 13px;
  line-height: 1.35;
  word-break: break-word;
}

.aftersales-cell-stack span {
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
  word-break: break-word;
}

.aftersales-tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.aftersales-actions-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
}

:deep(.aftersales-summary-cell-is-cost-missing .cell) {
  color: #b45309;
  font-weight: 700;
}

:deep(.aftersales-summary-cell-is-shipping-missing .cell) {
  color: #b91c1c;
  font-weight: 700;
}

:deep(.aftersales-summary-cell-is-review .cell) {
  color: #1d4ed8;
  font-weight: 700;
}

:deep(.aftersales-row-is-cost-missing td) {
  background: #fff7ed !important;
}

:deep(.aftersales-row-is-shipping-missing td) {
  background: #fef2f2 !important;
}

:deep(.aftersales-row-is-review td) {
  background: #eff6ff !important;
}

:deep(.aftersales-cell-is-cost-missing .cell) {
  color: #9a3412;
  font-weight: 700;
}

:deep(.aftersales-cell-is-shipping-missing .cell) {
  color: #b91c1c;
  font-weight: 700;
}

:deep(.aftersales-cell-is-review .cell) {
  color: #1d4ed8;
  font-weight: 700;
}

@media (max-width: 1200px) {
  .aftersales-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 780px) {
  .aftersales-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
