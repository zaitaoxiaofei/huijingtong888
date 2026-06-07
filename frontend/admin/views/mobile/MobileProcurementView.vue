<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { Link, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { money, shortText } from "./mobile-orders-utils.js";

const loading = ref(false);
const loadingMore = ref(false);
const confirmingPurchase = ref(false);
const confirmingInbound = ref(false);
const rows = ref([]);
const inboundRows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const filters = reactive({
  query: "",
  tab: "purchase"
});

const pendingPurchaseRows = computed(() => rows.value.map((row) => ({
  ...row,
  row_type: "purchase",
  row_key: `purchase-${row.product_id}`
})));

const pendingInboundRows = computed(() => inboundRows.value.map((row) => ({
  ...row,
  row_type: "inbound",
  row_key: `inbound-${row.inbound_record_id}`,
  total_quantity: Number(row.expected_quantity || row.remaining_quantity || row.actual_quantity || 0),
  total_amount: Number(row.amount || 0),
  total_shipping: Number(row.shipping_amount || 0),
  request_count: 1,
  earliest_created_at: row.order_created_at || row.inbound_created_at || row.purchased_at || "",
  requests: []
})));

const visibleRows = computed(() => filters.tab === "inbound" ? pendingInboundRows.value : pendingPurchaseRows.value);
const hasMore = computed(() => filters.tab === "purchase" && rows.value.length < total.value);
const activeTotal = computed(() => filters.tab === "inbound" ? pendingInboundRows.value.length : Number(total.value || rows.value.length));

function dateText(value) {
  return value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "-";
}

function productImage(row = {}) {
  return row.product_image_url || row.image_url || "";
}

function splitText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" / ");
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean).join(" / ");
}

function sourceText(row = {}) {
  if (row.row_type === "inbound") return row.order_no || row.purchase_order_no || "采购单";
  const requests = Array.isArray(row.requests) ? row.requests : [];
  const sources = requests.map((item) => item.source_type || item.product_source_platform).filter(Boolean);
  return [...new Set(sources)].join(" / ") || splitText(row.supplier_names) || "采购";
}

function primaryPurchaseUrl(row = {}) {
  if (row.link_1688) return row.link_1688;
  if (row.link_pdd) return row.link_pdd;
  if (row.purchase_url) return row.purchase_url;
  const requests = Array.isArray(row.requests) ? row.requests : [];
  return requests.map((item) => item.purchase_url || item.product_purchase_url).find(Boolean) || "";
}

function averageUnitCost(row = {}) {
  const quantity = Number(row.total_quantity || 0);
  if (!quantity) return money(0);
  return money((Number(row.total_amount || 0) + Number(row.total_shipping || 0)) / quantity);
}

function requestIds(row = {}) {
  return (Array.isArray(row.requests) ? row.requests : []).map((item) => Number(item.id)).filter(Boolean);
}

function inboundPayload(row = {}) {
  return {
    product_id: Number(row.product_id || 0) || null,
    quantity: Number(row.expected_quantity || row.remaining_quantity || row.actual_quantity || 0),
    amount: Number(row.amount || 0),
    shipping_amount: Number(row.shipping_amount || 0),
    purchase_url: row.purchase_url || "",
    status: "approved",
    note: row.inbound_note || "",
    qc_status: row.qc_status || "approved"
  };
}

function buildPurchaseParams(nextPage = 1) {
  const params = new URLSearchParams({
    grouped: "1",
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize)
  });
  const query = filters.query.trim();
  if (query) params.set("query", query);
  return params;
}

async function loadPage({ append = false } = {}) {
  loading.value = !append;
  loadingMore.value = append;
  try {
    const nextPage = append ? page.value + 1 : 1;
    const [purchaseResult, inboundResult] = await Promise.all([
      apiClient.get(`/api/procurement/requests?${buildPurchaseParams(nextPage).toString()}`, { noCache: true }),
      apiClient.get("/api/procurement/pending-inbound", { noCache: true })
    ]);
    page.value = nextPage;
    total.value = Number(purchaseResult?.total || 0);
    const nextRows = Array.isArray(purchaseResult?.rows) ? purchaseResult.rows : [];
    rows.value = append ? [...rows.value, ...nextRows] : nextRows;
    inboundRows.value = Array.isArray(inboundResult) ? inboundResult : [];
  } catch (error) {
    ElMessage.error(error.message || "采购页面加载失败");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function submitSearch() {
  loadPage();
}

function setTab(tab) {
  filters.tab = tab;
}

async function confirmPurchase(row) {
  const ids = requestIds(row);
  if (!ids.length) {
    ElMessage.info("这条记录没有可确认的采购请求");
    return;
  }
  try {
    await ElMessageBox.confirm("确认这个商品已经采购？确认后会生成采购单并进入待入库。", "确认采购", {
      type: "warning",
      confirmButtonText: "确认采购",
      cancelButtonText: "取消"
    });
    confirmingPurchase.value = true;
    await apiClient.post("/api/procurement/purchase-orders/confirm-from-requests-async", { request_ids: ids });
    rows.value = rows.value.filter((item) => Number(item.product_id) !== Number(row.product_id));
    total.value = Math.max(0, Number(total.value || 0) - 1);
    ElMessage.success("已提交采购确认，后台正在生成采购单");
    window.setTimeout(() => loadPage(), 1500);
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认采购失败");
  } finally {
    confirmingPurchase.value = false;
  }
}

async function confirmInbound(row) {
  const inboundId = Number(row.inbound_record_id || 0);
  if (!inboundId) return;
  try {
    await ElMessageBox.confirm("确认这个商品已经入库？确认后会增加库存。", "确认入库", {
      type: "warning",
      confirmButtonText: "确认入库",
      cancelButtonText: "取消"
    });
    confirmingInbound.value = true;
    await apiClient.post("/api/inbound-records/batch-update-async", {
      records: [{ id: inboundId, payload: inboundPayload(row) }]
    });
    inboundRows.value = inboundRows.value.filter((item) => Number(item.inbound_record_id) !== inboundId);
    ElMessage.success("已提交入库处理，后台正在更新库存");
    window.setTimeout(() => loadPage(), 1500);
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认入库失败");
  } finally {
    confirmingInbound.value = false;
  }
}

function openPurchaseUrl(row) {
  const url = primaryPurchaseUrl(row);
  if (!url) {
    ElMessage.info("暂无采购链接");
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    ElMessage.warning("浏览器拦截了新窗口，请复制链接后打开");
  }
}

onMounted(() => loadPage());
</script>

<template>
  <div class="mobile-procurement-page" v-loading="loading">
    <section class="mobile-procurement-summary">
      <button type="button" :class="{ active: filters.tab === 'purchase' }" @click="setTab('purchase')">
        <span>待采购</span>
        <strong>{{ total }}</strong>
      </button>
      <button type="button" :class="{ active: filters.tab === 'inbound' }" @click="setTab('inbound')">
        <span>待入库</span>
        <strong>{{ pendingInboundRows.length }}</strong>
      </button>
    </section>

    <section class="mobile-procurement-search">
      <el-input
        v-model="filters.query"
        clearable
        placeholder="商品 / 编码 / SKU / 采购链接"
        @keyup.enter="submitSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" @click="submitSearch">搜索</el-button>
    </section>

    <el-button class="mobile-refresh-action" :loading="loading" @click="loadPage()">
      刷新采购数据
    </el-button>

    <section class="mobile-procurement-list">
      <article v-for="row in visibleRows" :key="row.row_key" class="mobile-procurement-card">
        <div class="mobile-procurement-card__head">
          <span>{{ row.row_type === "inbound" ? "待入库" : "待采购" }}</span>
          <strong>{{ sourceText(row) }}</strong>
        </div>

        <div class="mobile-procurement-card__body">
          <img v-if="productImage(row)" :src="productImage(row)" alt="">
          <div v-else class="mobile-procurement-card__fallback">SKU</div>
          <div class="mobile-procurement-card__main">
            <h2>{{ shortText(row.product_name, "采购商品") }}</h2>
            <p>编码：{{ shortText(row.product_code) }}</p>
            <p>SKU：{{ shortText(row.mapped_skus, "未绑定 SKU") }}</p>
            <div class="mobile-procurement-card__chips">
              <span>数量 {{ Number(row.total_quantity || 0) }}</span>
              <span>货款 {{ money(row.total_amount) }}</span>
              <span>均价 {{ averageUnitCost(row) }}</span>
            </div>
          </div>
        </div>

        <div class="mobile-procurement-card__meta">
          <span>供应商：{{ splitText(row.supplier_names) || "-" }}</span>
          <span>创建：{{ dateText(row.earliest_created_at) }}</span>
          <span v-if="row.row_type === 'inbound'">采购：{{ dateText(row.purchased_at) }}</span>
        </div>

        <div v-if="Array.isArray(row.requests) && row.requests.length" class="mobile-procurement-card__requests">
          <details>
            <summary>采购明细 {{ row.requests.length }} 条</summary>
            <div v-for="request in row.requests" :key="request.id" class="mobile-request-line">
              <span>{{ request.person_name || "申请人" }} / 数量 {{ Number(request.quantity || 0) }}</span>
              <small>{{ request.note || request.purchase_url || "无备注" }}</small>
            </div>
          </details>
        </div>

        <div class="mobile-procurement-card__actions">
          <button type="button" class="secondary" @click="openPurchaseUrl(row)">
            <el-icon><Link /></el-icon>
            <span>采购链接</span>
          </button>
          <button
            v-if="row.row_type === 'purchase'"
            type="button"
            :disabled="confirmingPurchase"
            @click="confirmPurchase(row)"
          >
            确认采购
          </button>
          <button
            v-else
            type="button"
            :disabled="confirmingInbound"
            @click="confirmInbound(row)"
          >
            确认入库
          </button>
        </div>
      </article>
    </section>

    <section v-if="!visibleRows.length && !loading" class="mobile-empty">
      <strong>暂无{{ filters.tab === "inbound" ? "待入库" : "待采购" }}商品</strong>
      <span>当前筛选下没有需要处理的采购事项。</span>
    </section>

    <el-button
      v-if="hasMore"
      class="mobile-load-more"
      :loading="loadingMore"
      @click="loadPage({ append: true })"
    >
      加载更多，当前 {{ rows.length }} / {{ activeTotal }}
    </el-button>
  </div>
</template>

<style scoped>
.mobile-procurement-page {
  display: grid;
  gap: 12px;
}

.mobile-procurement-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mobile-procurement-summary button {
  display: grid;
  gap: 4px;
  padding: 13px 12px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #fff;
  text-align: left;
}

.mobile-procurement-summary button.active {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.mobile-procurement-summary span {
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
}

.mobile-procurement-summary strong {
  color: #172033;
  font-size: 24px;
  line-height: 1;
}

.mobile-procurement-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px;
  gap: 8px;
}

.mobile-procurement-search :deep(.el-input__wrapper),
.mobile-procurement-search :deep(.el-button) {
  min-height: 42px;
  border-radius: 12px;
}

.mobile-procurement-list {
  display: grid;
  gap: 10px;
}

.mobile-procurement-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
}

.mobile-procurement-card__head,
.mobile-procurement-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-procurement-card__head span {
  padding: 4px 8px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-size: 12px;
  font-weight: 800;
}

.mobile-procurement-card__head strong {
  min-width: 0;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-procurement-card__body {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
}

.mobile-procurement-card__body img,
.mobile-procurement-card__fallback {
  width: 76px;
  height: 76px;
  border-radius: 12px;
  object-fit: cover;
  background: #eef2f7;
}

.mobile-procurement-card__fallback {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 800;
}

.mobile-procurement-card__main {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.mobile-procurement-card__main h2 {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: #172033;
  font-size: 14px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.mobile-procurement-card__main p,
.mobile-procurement-card__meta span {
  margin: 0;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-procurement-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mobile-procurement-card__chips span {
  padding: 3px 7px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 11px;
  font-weight: 800;
}

.mobile-procurement-card__meta {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border-radius: 12px;
  background: #f8fafc;
}

.mobile-procurement-card__requests details {
  padding: 9px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fbfdff;
}

.mobile-procurement-card__requests summary {
  color: #334155;
  font-size: 12px;
  font-weight: 800;
}

.mobile-request-line {
  display: grid;
  gap: 3px;
  padding-top: 8px;
}

.mobile-request-line span {
  color: #172033;
  font-size: 12px;
  font-weight: 700;
}

.mobile-request-line small {
  overflow-wrap: anywhere;
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
}

.mobile-procurement-card__actions button {
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 12px;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  font-weight: 900;
}

.mobile-procurement-card__actions button.secondary {
  background: #eef2ff;
  color: #3730a3;
}

.mobile-procurement-card__actions button:disabled {
  opacity: 0.62;
}

.mobile-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 36px 12px;
  color: #64748b;
}

.mobile-empty strong {
  color: #334155;
  font-size: 15px;
}

.mobile-refresh-action,
.mobile-load-more {
  min-height: 42px;
  border-radius: 12px;
}
</style>
