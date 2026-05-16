<script setup>
import { computed, defineExpose, onMounted, reactive } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import OrdersStatusTabs from "./components/OrdersStatusTabs.vue";
import OrdersTable from "./components/OrdersTable.vue";
import OrdersToolbar from "./components/OrdersToolbar.vue";
import PageFooterPagination from "../admin/components/PageFooterPagination.vue";
import ProcurementRequestCreateDialog from "../admin/components/procurement/ProcurementRequestCreateDialog.vue";
import { useOrdersPage } from "./composables/useOrdersPage.js";
import "./orders-view.css";

const SEARCH_TYPE_OPTIONS = [
  { value: "order", label: "订单号" },
  { value: "sku", label: "SKU" },
  { value: "offer", label: "货号" },
  { value: "tracking", label: "跟踪号" },
  { value: "purchaseTracking", label: "采购快递单号" },
  { value: "product", label: "库存产品" }
];

const STATE_META = {
  all: { label: "全部订单", color: "slate" },
  awaiting_packaging: { label: "等待备货", color: "amber" },
  awaiting_deliver: { label: "等待发货", color: "blue" },
  delivering: { label: "运输中", color: "green" },
  dispute: { label: "有争议", color: "red" },
  delivered: { label: "已签收", color: "green" },
  cancelled: { label: "已取消", color: "slate" },
  unbound: { label: "待绑定库存", color: "amber" },
  stock_issue: { label: "库存异常", color: "red" }
};

const {
  vm,
  loading,
  totalPages,
  totalLabel,
  activeStatusLabel,
  selectedOrderIds,
  loadOrders,
  submitFilters,
  changeStatus,
  changePrintView,
  changeMarkFilter,
  changePage,
  changePageSize,
  syncRecent,
  syncAll,
  cancelSync,
  bulkPrint,
  bulkPrepare,
  openQualityRules,
  saveQualityRules,
  resetRecentDates,
  handleMoreAction,
  fetchOrderDetail,
  prepareSingleOrder,
  printSingleOrder,
  recalculateOrderProfit,
  saveOrderMark,
  openBindProduct,
  openBindProductFromOrder,
  openCreateProduct,
  openCreateProductFromOrder,
  jumpToStockProduct,
  openProcurement
} = useOrdersPage();

const selectedCount = computed(() => selectedOrderIds.value.size);
const selectedOrderIdList = computed(() => [...selectedOrderIds.value]);
const allRowsSelected = computed(() => {
  const rows = Array.isArray(vm.rows) ? vm.rows : [];
  return rows.length > 0 && rows.every((row) => selectedOrderIds.value.has(Number(row.id)));
});
const someRowsSelected = computed(() => {
  const rows = Array.isArray(vm.rows) ? vm.rows : [];
  return rows.some((row) => selectedOrderIds.value.has(Number(row.id))) && !allRowsSelected.value;
});

const detailDialog = reactive({
  visible: false,
  loading: false,
  mode: "detail",
  orderId: null,
  data: null
});

const qualityDialog = reactive({
  visible: false,
  loading: false,
  saving: false,
  prefixesText: "",
  note: ""
});

const procurementDialog = reactive({
  visible: false,
  productId: null
});

const detailOrder = computed(() => detailDialog.data?.order || {});
const detailItems = computed(() => detailDialog.data?.items || []);
const detailFinance = computed(() => detailDialog.data?.finance || []);

function formatDateTime(value) {
  return value ? String(value).slice(0, 19).replace("T", " ") : "-";
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function toggleAll(checked) {
  selectedOrderIds.value = checked
    ? new Set((vm.rows || []).map((row) => Number(row.id)).filter(Boolean))
    : new Set();
}

function toggleRow(orderId, checked) {
  const next = new Set(selectedOrderIds.value);
  const id = Number(orderId);
  if (checked) next.add(id);
  else next.delete(id);
  selectedOrderIds.value = next;
}

function rowStateLabel(row) {
  const key = String(row?.status || "").toLowerCase();
  return STATE_META[key]?.label || row?.tracking_stage || row?.status || "-";
}

function rowStateColor(row) {
  const key = String(row?.status || "").toLowerCase();
  return STATE_META[key]?.color || "slate";
}

function rowAvailableActions(row) {
  return row?.availableActions || {
    print: ["awaiting_deliver"].includes(String(row?.status || "")) || Boolean(row?.isPrinted),
    prepare: ["awaiting_packaging", "unbound"].includes(String(row?.status || "")),
    profit: true
  };
}

async function syncRecentOrdersAction() {
  await syncRecent();
}

async function syncAllOrdersAction() {
  await syncAll();
}

function bulkPrintSelected() {
  if (!selectedOrderIds.value.size) return ElMessage.warning("请先选择订单");
  ElMessageBox.confirm("确认批量打印所选订单？", "批量打印", { type: "warning" })
    .then(() => bulkPrint(selectedOrderIdList.value));
}

function bulkPrepareSelected() {
  if (!selectedOrderIds.value.size) return ElMessage.warning("请先选择订单");
  ElMessageBox.confirm("确认批量备货所选订单？", "批量备货", { type: "warning" })
    .then(() => bulkPrepare(selectedOrderIdList.value));
}

async function openDrawer(mode, orderId) {
  detailDialog.visible = true;
  detailDialog.loading = true;
  detailDialog.mode = mode;
  detailDialog.orderId = Number(orderId);
  try {
    detailDialog.data = await fetchOrderDetail(orderId);
  } finally {
    detailDialog.loading = false;
  }
}

function openOrderDetail(orderId) {
  return openDrawer("detail", orderId);
}

function openProfitDetail(orderId) {
  return openDrawer("profit", orderId);
}

async function handleRecalculate(orderId) {
  await recalculateOrderProfit(orderId);
  await loadOrders();
  if (detailDialog.visible && Number(detailDialog.orderId) === Number(orderId)) {
    await openDrawer(detailDialog.mode, orderId);
  }
}

async function showQualityRules() {
  qualityDialog.visible = true;
  qualityDialog.loading = true;
  try {
    const rules = await openQualityRules();
    const list = Array.isArray(rules) ? rules : [];
    qualityDialog.prefixesText = list.map((item) => item.prefix).filter(Boolean).join("\n");
    qualityDialog.note = list[0]?.note || "命中这些前缀的订单会标记为质检单。";
  } finally {
    qualityDialog.loading = false;
  }
}

async function submitQualityRules() {
  qualityDialog.saving = true;
  try {
    const prefixes = qualityDialog.prefixesText
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    await saveQualityRules({ prefixes, note: qualityDialog.note });
    ElMessage.success("质检规则已保存");
    qualityDialog.visible = false;
    await loadOrders();
  } finally {
    qualityDialog.saving = false;
  }
}

async function handleSaveMark(orderId, markType) {
  await saveOrderMark(orderId, markType);
  vm.rows = (vm.rows || []).map((row) => (
    Number(row.id) === Number(orderId)
      ? { ...row, mark_type: String(markType || "") }
      : row
  ));
  ElMessage.success("订单标记已更新");
}

function handleOpenProcurement(productId) {
  procurementDialog.productId = Number(productId || 0) || null;
  procurementDialog.visible = Boolean(procurementDialog.productId);
}

async function handleProcurementCreated() {
  procurementDialog.visible = false;
  procurementDialog.productId = null;
  await loadOrders();
}

defineExpose({ loadOrders });

onMounted(() => {
  loadOrders();
});
</script>

<template>
  <section v-loading="loading" class="vue-orders-shell">
    <header class="vue-orders-header">
      <div>
        <h2>{{ vm.title }}</h2>
      </div>
      <div class="vue-orders-header-meta">
        <span>{{ totalLabel }}</span>
        <strong>{{ activeStatusLabel }}</strong>
      </div>
    </header>

    <OrdersToolbar
      :filters="vm.filters"
      :shops="vm.shops"
      :search-type-options="SEARCH_TYPE_OPTIONS"
      :sync-status="vm.syncStatus"
      :sync-running="vm.syncRunning"
      :more-actions="vm.moreActions"
      @update:filters="vm.filters = $event"
      @submit="submitFilters"
      @sync-incremental="syncRecentOrdersAction"
      @sync-full="syncAllOrdersAction"
      @cancel-sync="cancelSync"
      @more-action="handleMoreAction"
      @open-quality-rules="showQualityRules"
      @reset-dates="resetRecentDates"
    />

    <OrdersStatusTabs
      :status-tabs="vm.statusTabs"
      :active-status="vm.filters.status"
      :print-views="vm.printViews"
      :active-print-view="vm.filters.printView"
      :mark-options="vm.markOptions"
      :active-mark-filter="vm.filters.markFilter"
      :selected-count="selectedCount"
      @change-status="changeStatus"
      @change-print-view="changePrintView"
      @change-mark-filter="changeMarkFilter"
      @bulk-print="bulkPrintSelected"
      @bulk-prepare="bulkPrepareSelected"
    />

    <el-space v-if="selectedCount > 0" class="vue-orders-selection-bar" wrap>
      <span>已选订单 {{ selectedCount }}</span>
      <el-button @click="bulkPrintSelected">批量打印</el-button>
      <el-button type="primary" @click="bulkPrepareSelected">批量备货</el-button>
    </el-space>

    <div class="orders-table-section">
      <OrdersTable
        :rows="vm.rows"
        :mark-options="vm.markOptions"
        :status-label-fn="rowStateLabel"
        :status-color-fn="rowStateColor"
        :available-actions-fn="rowAvailableActions"
        :selected-ids="selectedOrderIds"
        :all-selected="allRowsSelected"
        :some-selected="someRowsSelected"
        table-height="100%"
        @toggle-all="toggleAll"
        @toggle-row="toggleRow"
        @open-detail="openOrderDetail"
        @open-profit="openProfitDetail"
        @prepare-order="prepareSingleOrder"
        @print-order="printSingleOrder"
        @recalculate-profit="handleRecalculate"
        @save-mark="handleSaveMark"
        @open-bind-product="openBindProduct"
        @open-bind-product-from-order="openBindProductFromOrder"
        @open-create-product="openCreateProduct"
        @open-create-product-from-order="openCreateProductFromOrder"
        @jump-stock-product="jumpToStockProduct"
        @open-procurement="handleOpenProcurement"
      />

      <div class="orders-page-footer">
        <PageFooterPagination
          :page="vm.filters.page"
          :total-pages="totalPages"
          :page-size="vm.filters.pageSize"
          :total="vm.meta.total"
          @update:page="changePage"
          @update:pageSize="changePageSize"
        />
      </div>
    </div>

    <el-dialog
      v-model="detailDialog.visible"
      :title="detailDialog.mode === 'profit' ? '订单利润详情' : '订单详情'"
      width="1080px"
      destroy-on-close
    >
      <div v-loading="detailDialog.loading">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单号">{{ detailOrder.posting_number || detailDialog.orderId || "-" }}</el-descriptions-item>
          <el-descriptions-item label="店铺">{{ detailOrder.shop_name || "-" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ rowStateLabel(detailOrder) }}</el-descriptions-item>
          <el-descriptions-item label="下单时间">{{ formatDateTime(detailOrder.ordered_at) }}</el-descriptions-item>
          <el-descriptions-item label="跟踪号">{{ detailOrder.tracking_number || "-" }}</el-descriptions-item>
          <el-descriptions-item label="物流方式">{{ detailOrder.delivery_method || detailOrder.shipping_method || "-" }}</el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 16px">
          <el-button type="primary" @click="handleRecalculate(detailDialog.orderId)">重算利润</el-button>
        </div>

        <el-divider content-position="left">商品</el-divider>
        <el-table :data="detailItems" stripe border max-height="320">
          <el-table-column prop="ozon_sku" label="SKU" min-width="160" />
          <el-table-column prop="offer_id" label="货号" min-width="140" />
          <el-table-column prop="product_name" label="商品" min-width="280" />
          <el-table-column prop="quantity" label="数量" width="80" align="center" />
          <el-table-column label="销售额" width="120" align="right">
            <template #default="{ row }">CNY {{ formatMoney(row.sale_amount_cny || Number(row.sale_price || 0) * Number(row.quantity || 0)) }}</template>
          </el-table-column>
          <el-table-column v-if="detailDialog.mode === 'profit'" label="利润" width="120" align="right">
            <template #default="{ row }">CNY {{ formatMoney(row.net_profit_cny || row.gross_profit_cny) }}</template>
          </el-table-column>
        </el-table>

        <template v-if="detailDialog.mode === 'profit'">
          <el-divider content-position="left">财务</el-divider>
          <el-table :data="detailFinance" stripe border max-height="260">
            <el-table-column prop="service_type" label="费用类型" min-width="160" />
            <el-table-column prop="service_name" label="费用名称" min-width="220" />
            <el-table-column prop="currency_code" label="币种" width="90" align="center" />
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">{{ formatMoney(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="人民币金额" width="130" align="right">
              <template #default="{ row }">CNY {{ formatMoney(row.amount_cny) }}</template>
            </el-table-column>
            <el-table-column prop="operation_date" label="业务时间" min-width="180">
              <template #default="{ row }">{{ formatDateTime(row.operation_date) }}</template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-dialog>

    <el-dialog v-model="qualityDialog.visible" title="质检规则" width="720px" destroy-on-close>
      <div v-loading="qualityDialog.loading">
        <el-form label-width="100px">
          <el-form-item label="前缀列表">
            <el-input
              v-model="qualityDialog.prefixesText"
              type="textarea"
              :rows="8"
              placeholder="每行一个前缀，也可以用空格或逗号分隔"
            />
          </el-form-item>
          <el-form-item label="规则说明">
            <el-input
              v-model="qualityDialog.note"
              type="textarea"
              :rows="4"
              placeholder="请输入质检规则说明"
            />
          </el-form-item>
        </el-form>
        <el-alert
          type="info"
          :closable="false"
          title="命中这些前缀的订单会按质检单识别，用于过滤和人工处理提醒。"
        />
      </div>
      <template #footer>
        <el-button @click="qualityDialog.visible = false">关闭</el-button>
        <el-button type="primary" :loading="qualityDialog.saving" @click="submitQualityRules">保存规则</el-button>
      </template>
    </el-dialog>

    <ProcurementRequestCreateDialog
      v-model="procurementDialog.visible"
      :initial-product-id="procurementDialog.productId"
      lock-product
      @created="handleProcurementCreated"
    />
  </section>
</template>
