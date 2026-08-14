<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { formatInteger, formatMoney } from "./profit-utils.js";
import { shanghaiDateKey, shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const route = useRoute();
const router = useRouter();
let abortController = null;
const detailDrawerVisible = ref(false);
const detailRow = ref(null);
const today = shanghaiDateKey();
const legacyMonth = `${route.query.year || today.slice(0, 4)}-${String(route.query.month || today.slice(5, 7)).padStart(2, "0")}`;
const legacyLastDay = new Date(Number(legacyMonth.slice(0, 4)), Number(legacyMonth.slice(5, 7)), 0).getDate();
const legacyTo = legacyMonth === today.slice(0, 7) ? today : `${legacyMonth}-${String(legacyLastDay).padStart(2, "0")}`;

const state = reactive({
  loading: false,
  rows: [],
  shops: [],
  total: 0,
  totalPages: 1,
  filters: {
    dateRange: [String(route.query.from || `${legacyMonth}-01`), String(route.query.to || legacyTo)],
    shopId: String(route.query.shopId || "all"),
    keyword: String(route.query.keyword || ""),
    outcomeType: String(route.query.outcomeType || ""),
    settlementState: String(route.query.settlementState || ""),
    page: Math.max(Number(route.query.page || 1), 1),
    pageSize: Math.max(Number(route.query.pageSize || 50), 1)
  }
});

const outcomeOptions = [
  { label: "全部结果", value: "" },
  { label: "进行中", value: "active" },
  { label: "已签收", value: "delivered_signed" },
  { label: "拒收/未取", value: "rejected_unclaimed" },
  { label: "签收后退货", value: "after_delivery_return" },
  { label: "取消", value: "cancelled_pre_fulfillment" }
];

const settlementOptions = [
  { label: "全部口径", value: "" },
  { label: "真实账单", value: "finance_accrued" },
  { label: "待结算预估", value: "pending_estimate" },
  { label: "终态损失", value: "terminal_estimate" }
];

const outcomeLabels = {
  active: "进行中",
  delivered_signed: "已签收",
  rejected_unclaimed: "拒收/未取",
  after_delivery_return: "签收后退货",
  cancelled_pre_fulfillment: "取消"
};

const settlementLabels = {
  finance_accrued: "真实账单",
  pending_estimate: "待结算预估",
  terminal_estimate: "终态损失"
};

const selectedPeriodTitle = computed(() => `${state.filters.dateRange?.[0] || "-"} 至 ${state.filters.dateRange?.[1] || "-"}`);

function formatRatio(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0.0%";
  return `${(number * 100).toFixed(1)}%`;
}

function formatDateTime(value) {
  return shanghaiDateTimeText(value);
}

function outcomeLabel(value) {
  return outcomeLabels[String(value || "")] || String(value || "-");
}

function settlementLabel(value) {
  return settlementLabels[String(value || "")] || String(value || "-");
}

function outcomeTone(value) {
  const normalized = String(value || "");
  if (normalized === "delivered_signed") return "success";
  if (normalized === "active") return "info";
  if (normalized === "cancelled_pre_fulfillment") return "warning";
  return "danger";
}

function settlementTone(value) {
  const normalized = String(value || "");
  if (normalized === "finance_accrued") return "success";
  if (normalized === "terminal_estimate") return "warning";
  return "info";
}

function profitClass(value) {
  const number = Number(value || 0);
  if (number > 0) return "is-profit-positive";
  if (number < 0) return "is-profit-negative";
  return "";
}

function openCostDetail(row) {
  detailRow.value = row;
  detailDrawerVisible.value = true;
}

function syncRouteQuery() {
  router.replace({
    path: route.path,
    query: {
      tab: "orders",
      from: state.filters.dateRange[0],
      to: state.filters.dateRange[1],
      shopId: String(state.filters.shopId || "all"),
      keyword: state.filters.keyword || undefined,
      outcomeType: state.filters.outcomeType || undefined,
      settlementState: state.filters.settlementState || undefined,
      page: state.filters.page > 1 ? String(state.filters.page) : undefined,
      pageSize: state.filters.pageSize !== 50 ? String(state.filters.pageSize) : undefined
    }
  });
}

async function loadRows() {
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  state.loading = true;
  try {
    const params = new URLSearchParams({
      from: state.filters.dateRange[0],
      to: state.filters.dateRange[1],
      shopId: String(state.filters.shopId || "all"),
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize)
    });
    if (state.filters.keyword.trim()) params.set("keyword", state.filters.keyword.trim());
    if (state.filters.outcomeType) params.set("outcomeType", state.filters.outcomeType);
    if (state.filters.settlementState) params.set("settlementState", state.filters.settlementState);
    const payload = await apiClient.get(`/api/monthly-billing-orders?${params.toString()}`, { signal });
    if (signal.aborted) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.shops = Array.isArray(payload?.shops) ? payload.shops : [];
    state.total = Number(payload?.total || 0);
    state.totalPages = Number(payload?.totalPages || Math.max(1, Math.ceil(state.total / state.filters.pageSize)));
    state.filters.page = Number(payload?.page || state.filters.page);
    state.filters.pageSize = Number(payload?.pageSize || state.filters.pageSize);
    syncRouteQuery();
  } catch (error) {
    if (error?.name === "AbortError") return;
    ElMessage.error(error.message || "订单明细加载失败");
  } finally {
    if (abortController?.signal === signal) {
      abortController = null;
      state.loading = false;
    }
  }
}

function handleSearch() {
  state.filters.page = 1;
  loadRows();
}

function handleReset() {
  state.filters.dateRange = [`${today.slice(0, 7)}-01`, today];
  state.filters.shopId = "all";
  state.filters.keyword = "";
  state.filters.outcomeType = "";
  state.filters.settlementState = "";
  state.filters.page = 1;
  state.filters.pageSize = 50;
  loadRows();
}

function handlePageChange(page) {
  state.filters.page = Number(page || 1);
  loadRows();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = Number(size || 50);
  state.filters.page = 1;
  loadRows();
}

watch(
  () => [route.query.from, route.query.to, route.query.shopId],
  () => {
    state.filters.dateRange = [String(route.query.from || state.filters.dateRange[0]), String(route.query.to || state.filters.dateRange[1])];
    state.filters.shopId = String(route.query.shopId || state.filters.shopId || "all");
  }
);

onMounted(() => {
  loadRows();
});

onBeforeUnmount(() => {
  abortController?.abort();
});
</script>

<template>
  <div class="page-stack monthly-orders-page">
    <el-card shadow="never" class="page-card monthly-orders-card">
      <div class="monthly-orders-head">
        <div>
          <h2>{{ selectedPeriodTitle }} 订单明细</h2>
          <p>共 {{ formatInteger(state.total) }} 单</p>
        </div>
      </div>

      <el-form inline class="monthly-orders-filters">
        <el-form-item label="统计时间">
          <el-date-picker
            v-model="state.filters.dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            :clearable="false"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="state.filters.shopId" filterable style="width: 220px">
            <el-option label="全部店铺" value="all" />
            <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="结果">
          <el-select v-model="state.filters.outcomeType" style="width: 150px">
            <el-option v-for="item in outcomeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="结算口径">
          <el-select v-model="state.filters.settlementState" style="width: 150px">
            <el-option v-for="item in settlementOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="搜索">
          <el-input
            v-model="state.filters.keyword"
            clearable
            style="width: 260px"
            placeholder="订单号、店铺或状态"
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="state.loading" @click="handleSearch">查询</el-button>
          <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <div class="monthly-orders-table-wrap" v-loading="state.loading">
        <el-table
          :data="state.rows"
          height="100%"
          stripe
          border
          class="erp-data-table monthly-orders-table"
          table-layout="fixed"
        >
          <el-table-column label="订单" min-width="190" fixed="left">
            <template #default="{ row }">
              <div class="order-cell">
                <strong>{{ row.posting_number || row.order_number || "-" }}</strong>
                <span>{{ row.order_number && row.order_number !== row.posting_number ? row.order_number : row.shop_name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="shop_name" label="店铺" min-width="140" />
          <el-table-column prop="ordered_at" label="下单时间" min-width="164">
            <template #default="{ row }">{{ formatDateTime(row.ordered_at) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="terminal_at" label="签收/拒收/取消时间" min-width="178">
            <template #default="{ row }">{{ formatDateTime(row.terminal_at) }}</template>
          </el-table-column>
          <el-table-column prop="outcome_type" label="结果" width="112">
            <template #default="{ row }">
              <el-tag size="small" :type="outcomeTone(row.outcome_type)">{{ outcomeLabel(row.outcome_type) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="settlement_state" label="结算口径" width="116">
            <template #default="{ row }">
              <el-tag size="small" :type="settlementTone(row.settlement_state)" effect="plain">{{ settlementLabel(row.settlement_state) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="item_quantity" label="件数" width="76" align="right">
            <template #default="{ row }">{{ formatInteger(row.item_quantity) }}</template>
          </el-table-column>
          <el-table-column prop="order_amount" label="订单金额" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.order_amount) }}</template>
          </el-table-column>
          <el-table-column prop="revenue" label="账单收益" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="purchase_cost" label="采购成本" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.purchase_cost) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="domestic_shipping_cost" label="国内物流" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.domestic_shipping_cost) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="international_shipping_cost" label="国际运费" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.international_shipping_cost) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="packaging_cost" label="包装/处理" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.packaging_cost) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="commission_fee" label="Ozon佣金" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.commission_fee) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="ozon_service_fee" label="Ozon服务费" min-width="112" align="right">
            <template #default="{ row }">{{ formatMoney(row.ozon_service_fee) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="other_fee" label="其他费用" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.other_fee) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="advertising_cost" label="广告费" min-width="104" align="right">
            <template #default="{ row }">{{ formatMoney(row.advertising_cost) }}</template>
          </el-table-column>
          <el-table-column v-if="false" prop="return_loss" label="退货/拒收损失" min-width="128" align="right">
            <template #default="{ row }">{{ formatMoney(row.return_loss) }}</template>
          </el-table-column>
          <el-table-column prop="total_cost" label="成本合计" min-width="112" align="right">
            <template #default="{ row }">{{ formatMoney(row.total_cost) }}</template>
          </el-table-column>
          <el-table-column prop="profit" label="利润" min-width="112" align="right" fixed="right">
            <template #default="{ row }">
              <strong :class="profitClass(row.profit)">{{ formatMoney(row.profit) }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="profit_margin" label="利润率" width="92" align="right" fixed="right">
            <template #default="{ row }">{{ row.revenue ? formatRatio(row.profit_margin) : "-" }}</template>
          </el-table-column>
          <el-table-column label="费用明细" width="92" align="center" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openCostDetail(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="monthly-orders-footer"
        :total="state.total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :total-pages="state.totalPages"
        :page-sizes="[50, 100, 150, 200]"
        summary=" "
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
      />
    </el-card>

    <el-drawer v-model="detailDrawerVisible" title="订单费用明细" size="620px" destroy-on-close>
      <div v-if="detailRow" class="page-stack">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单号" :span="2">{{ detailRow.posting_number || detailRow.order_number || "-" }}</el-descriptions-item>
          <el-descriptions-item label="店铺">{{ detailRow.shop_name || "-" }}</el-descriptions-item>
          <el-descriptions-item label="下单时间">{{ formatDateTime(detailRow.ordered_at) }}</el-descriptions-item>
          <el-descriptions-item label="订单金额">{{ formatMoney(detailRow.order_amount) }}</el-descriptions-item>
          <el-descriptions-item label="账单收益">{{ formatMoney(detailRow.revenue) }}</el-descriptions-item>
          <el-descriptions-item label="采购成本">{{ formatMoney(detailRow.purchase_cost) }}</el-descriptions-item>
          <el-descriptions-item label="国内物流">{{ formatMoney(detailRow.domestic_shipping_cost) }}</el-descriptions-item>
          <el-descriptions-item label="国际运费">{{ formatMoney(detailRow.international_shipping_cost) }}</el-descriptions-item>
          <el-descriptions-item label="包装/处理">{{ formatMoney(detailRow.packaging_cost) }}</el-descriptions-item>
          <el-descriptions-item label="Ozon 佣金">{{ formatMoney(detailRow.commission_fee) }}</el-descriptions-item>
          <el-descriptions-item label="Ozon 服务费">{{ formatMoney(detailRow.ozon_service_fee) }}</el-descriptions-item>
          <el-descriptions-item label="广告费">{{ formatMoney(detailRow.advertising_cost) }}</el-descriptions-item>
          <el-descriptions-item label="退货/拒收损失">{{ formatMoney(detailRow.return_loss) }}</el-descriptions-item>
          <el-descriptions-item label="其他费用">{{ formatMoney(detailRow.other_fee) }}</el-descriptions-item>
          <el-descriptions-item label="成本合计">{{ formatMoney(detailRow.total_cost) }}</el-descriptions-item>
          <el-descriptions-item label="利润"><strong :class="profitClass(detailRow.profit)">{{ formatMoney(detailRow.profit) }}</strong></el-descriptions-item>
          <el-descriptions-item label="利润率">{{ detailRow.revenue ? formatRatio(detailRow.profit_margin) : "-" }}</el-descriptions-item>
          <el-descriptions-item label="结果">{{ outcomeLabel(detailRow.outcome_type) }}</el-descriptions-item>
          <el-descriptions-item label="结算口径">{{ settlementLabel(detailRow.settlement_state) }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.monthly-orders-page {
  height: calc(100vh - 192px);
  min-height: 640px;
  overflow: hidden;
}

.monthly-orders-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.monthly-orders-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 16px 18px;
}

.monthly-orders-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.monthly-orders-head h2 {
  margin: 0;
  color: #0f172a;
  font-size: 20px;
}

.monthly-orders-head p {
  margin: 6px 0 0;
  color: #64748b;
  font-size: 13px;
}

.monthly-orders-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 0;
  margin-top: 16px;
}

.monthly-orders-table-wrap {
  flex: 1;
  min-height: 0;
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 8px;
  overflow: hidden;
}

.monthly-orders-table {
  height: 100%;
}

.monthly-orders-table :deep(.el-table__cell) {
  font-size: 12px;
}

.monthly-orders-footer {
  flex-shrink: 0;
  padding-top: 12px;
}

.order-cell {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.order-cell strong,
.order-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-cell strong {
  color: #0f172a;
  font-size: 12px;
}

.order-cell span {
  color: #64748b;
  font-size: 11px;
}

.is-profit-positive {
  color: #0f766e;
}

.is-profit-negative {
  color: #b45309;
}

:global(:root[data-theme="dark"] .monthly-orders-head h2),
:global(:root[data-theme="dark"] .order-cell strong) {
  color: #e5e7eb;
}

@media (max-width: 900px) {
  .monthly-orders-page {
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .monthly-orders-card,
  .monthly-orders-card :deep(.el-card__body) {
    height: auto;
  }

  .monthly-orders-table-wrap {
    height: 620px;
    flex: none;
  }
}
</style>
