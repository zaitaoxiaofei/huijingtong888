<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ExceptionModuleTabs from "../../components/exceptions/ExceptionModuleTabs.vue";
import { formatInteger } from "../profit/profit-utils.js";

const props = defineProps({ view: { type: String, default: "profit" } });
const router = useRouter();

const loading = ref(false);
const actionLoading = ref(false);
const rowActionKey = ref("");

const state = reactive({
  selectedIds: [],
  filters: {
    keyword: "",
    from: "",
    to: "",
    page: 1,
    pageSize: 20,
    sortField: "priority",
    sortDirection: "desc"
  }
});

const payload = reactive({
  rows: [],
  total: 0,
  resolvedTotal: 0,
  counts: {},
  generatedAt: ""
});

const configs = {
  profit: { label: "利润异常", tag: "danger", countKey: "profit", description: "优先处理利润为负的订单。" },
  deadline: { label: "订单超时异常", tag: "warning", countKey: "delivery_timeout", description: "优先处理已经超时的订单。" },
  deadline_warning: { label: "超时预警", tag: "warning", countKey: "delivery_warning", description: "提前处理临近超时的订单。" },
  stock: { label: "库存异常", tag: "danger", countKey: "stock", description: "处理库存不足和库存预警问题。" },
  binding: { label: "未绑定库存", tag: "info", countKey: "binding", description: "处理缺少库存绑定的订单。" }
};

const pageConfig = computed(() => configs[props.view] || configs.profit);
const summaryCards = computed(() => {
  const counts = payload.counts || {};
  return [
    { label: pageConfig.value.label, value: Number(counts[pageConfig.value.countKey] || payload.total || 0) },
    { label: "待处理", value: Number(payload.total || 0) },
    { label: "高优先级", value: Number(counts.danger || 0) },
    { label: "已处理", value: Number(payload.resolvedTotal || 0) }
  ];
});
const toolbarSummary = computed(() => [
  `${pageConfig.value.label} ${formatInteger(Number(payload.counts?.[pageConfig.value.countKey] || 0))} 条`,
  `待处理 ${formatInteger(payload.total)} 条`,
  `已处理 ${formatInteger(payload.resolvedTotal)} 条`
]);

function dt(value) {
  return value ? String(value).slice(0, 19).replace("T", " ") : "-";
}

function levelType(value) {
  if (value === "danger") return "danger";
  if (value === "warning") return "warning";
  return "info";
}

function taskStateType(value) {
  if (value === "handled") return "success";
  if (value === "ignored") return "info";
  return "";
}

function typeLabel(row = {}) {
  const map = {
    profit: "利润异常",
    deadline: row.level === "danger" ? "订单超时异常" : "超时预警",
    order_stock_shortage: "订单库存不足",
    order_binding: "未绑定库存",
    stock_local: "本地库存预警",
    stock_fbp: "FBP 库存预警",
    stock_fbs: "FBS 库存预警",
    stock_mapping: "SKU 映射异常",
    cancelled_order: "已取消订单"
  };
  return map[row.type] || row.title || "异常";
}

function metaLines(row = {}) {
  return [
    row.shop_name ? `店铺 ${row.shop_name}` : "",
    row.order_ref ? `订单 ${row.order_ref}` : "",
    row.sku_text ? `SKU ${row.sku_text}` : "",
    row.inventory_id ? `库存 ${row.inventory_id}` : ""
  ].filter(Boolean);
}

function contextLines(row = {}) {
  if (props.view === "profit") {
    return [
      row.profit_context_text || "",
      row.shipping_method_mismatch ? `运输方式不一致：${row.shipping_method_text || ""}` : "",
      ...(Array.isArray(row.profit_formula_lines) ? row.profit_formula_lines : []),
      ...(Array.isArray(row.profit_cost_lines) ? row.profit_cost_lines : [])
    ].filter(Boolean);
  }
  if (props.view === "deadline" || props.view === "deadline_warning") {
    return [
      row.detail || "",
      row.deadline_due_at ? `截止时间 ${dt(row.deadline_due_at)}` : "",
      row.deadline_elapsed_days ? `已流转 ${row.deadline_elapsed_days} 天` : "",
      row.shipping_method_text ? `运输方式 ${row.shipping_method_text}` : ""
    ].filter(Boolean);
  }
  return [row.detail || "", row.profit_context_text || "", row.dimensions_text || ""].filter(Boolean);
}

function timeLines(row = {}) {
  return [
    row.ordered_at ? `下单时间 ${dt(row.ordered_at)}` : "",
    row.task_state_updated_at ? `状态更新 ${dt(row.task_state_updated_at)}` : ""
  ].filter(Boolean);
}

function actionKey(rowId, action) {
  return `${rowId}:${action}`;
}

function actionErrorMessage(error, fallback) {
  return error?.payload?.error || error?.payload?.message || error?.message || fallback;
}

async function loadRows(refresh = false) {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      view: props.view,
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      search: state.filters.keyword || "",
      dateFrom: state.filters.from || "",
      dateTo: state.filters.to || "",
      sortField: state.filters.sortField,
      sortDirection: state.filters.sortDirection
    });
    if (refresh) params.set("refresh", "1");
    const data = await apiClient.get(`/api/exception-workbench?${params.toString()}`);
    payload.rows = Array.isArray(data?.rows) ? data.rows : [];
    payload.total = Number(data?.total || 0);
    payload.resolvedTotal = Number(data?.resolved_total || 0);
    payload.counts = data?.counts || {};
    payload.generatedAt = data?.generated_at || "";
    state.filters.page = Number(data?.page || state.filters.page);
    state.filters.pageSize = Number(data?.pageSize || state.filters.pageSize);
    state.selectedIds = [];
  } catch (error) {
    ElMessage.error(actionErrorMessage(error, "异常工作台加载失败"));
  } finally {
    loading.value = false;
  }
}

async function saveStates(ids, status) {
  if (!ids.length) return ElMessage.warning("请先选择异常明细");
  const label = status === "ignored" ? "忽略" : status === "open" ? "待处理" : "已处理";
  const confirmed = await ElMessageBox.confirm(`确认将 ${ids.length} 条异常标记为${label}？`, "异常处理", {
    type: "warning",
    confirmButtonText: "确认",
    cancelButtonText: "取消"
  }).catch(() => false);
  if (!confirmed) return;

  actionLoading.value = true;
  try {
    for (const id of ids) {
      await apiClient.post("/api/exception-workbench/tasks/state", { task_id: id, status });
    }
    ElMessage.success("状态已更新");
    await loadRows(true);
  } catch (error) {
    ElMessage.error(error.message || "状态更新失败");
  } finally {
    actionLoading.value = false;
  }
}

async function runOnlineAction(row, action, confirmText) {
  if (!row.onlineProductId) return ElMessage.warning("当前异常未关联在线商品");
  const confirmed = await ElMessageBox.confirm(confirmText, "在线商品处理", {
    type: "warning",
    confirmButtonText: action === "archive" ? "确认归档" : "确认",
    cancelButtonText: "取消"
  }).catch(() => false);
  if (!confirmed) return;

  rowActionKey.value = actionKey(row.id, action);
  try {
    const result = await apiClient.post("/api/online-products/action", {
      online_product_id: Number(row.onlineProductId),
      action
    });
    if (action === "archive") {
      const handledCount = Number(result?.handled_exception_count || 0);
      const handledText = handledCount > 1 ? `，并自动处理 ${handledCount} 条关联异常` : "，并标记异常为已处理";
      ElMessage.success(result?.already_archived ? `商品此前已归档${handledText}` : `已归档商品${handledText}`);
    } else {
      ElMessage.success("操作完成");
    }
    await loadRows(true);
  } catch (error) {
    ElMessage.error(actionErrorMessage(error, action === "archive" ? "归档商品失败" : "在线商品操作失败"));
  } finally {
    rowActionKey.value = "";
  }
}

async function recalculateOrder(row) {
  if (!row.orderId) return ElMessage.warning("当前异常未关联订单");
  rowActionKey.value = actionKey(row.id, "recalculate");
  try {
    await apiClient.post(`/api/orders/${row.orderId}/recalculate-profit`, {});
    ElMessage.success("已重算订单利润");
    await loadRows(true);
  } catch (error) {
    ElMessage.error(actionErrorMessage(error, "重算利润失败"));
  } finally {
    rowActionKey.value = "";
  }
}

function openInventory(row) {
  if (!row.productId) return ElMessage.warning("当前异常未关联库存商品");
  router.push({ path: "/inventory/products", query: { productId: String(row.productId) } });
}

function openBinding(row) {
  if (!row.onlineProductId) return ElMessage.warning("当前异常未关联在线商品");
  router.push({ path: "/online-products", query: { onlineProductId: String(row.onlineProductId), action: "bind" } });
}

function onSelect(rows) {
  state.selectedIds = rows.map((row) => String(row.id || "")).filter(Boolean);
}

async function search() {
  state.filters.page = 1;
  await loadRows();
}

async function reset() {
  state.filters.keyword = "";
  state.filters.from = "";
  state.filters.to = "";
  state.filters.page = 1;
  state.filters.pageSize = 20;
  state.filters.sortField = "priority";
  state.filters.sortDirection = "desc";
  await loadRows();
}

function pageChange(page) {
  state.filters.page = Number(page || 1);
  loadRows();
}

function sizeChange(size) {
  state.filters.page = 1;
  state.filters.pageSize = Number(size || 20);
  loadRows();
}

watch(() => props.view, () => loadRows());
onMounted(() => loadRows());
</script>

<template>
  <div class="page-stack exception-workbench-page erp-paged-page">
    <el-card shadow="never" class="page-card exception-overview-card">
      <div class="exception-overview">
        <div class="exception-overview__main">
          <el-tag effect="light" :type="pageConfig.tag">异常中心</el-tag>
          <h2>{{ pageConfig.label }}</h2>
          <p>{{ pageConfig.description }}</p>
          <div class="exception-summary-inline">
            <span v-for="card in summaryCards" :key="card.label" class="exception-summary-chip">
              <strong>{{ card.value }}</strong>
              <small>{{ card.label }}</small>
            </span>
          </div>
        </div>

        <div class="exception-overview__aside">
          <ExceptionModuleTabs compact class="exception-module-tabs" />
          <div class="exception-toolbar__summary">
            <span v-for="item in toolbarSummary" :key="item">{{ item }}</span>
            <small v-if="payload.generatedAt">生成时间 {{ dt(payload.generatedAt) }}</small>
          </div>
          <el-button size="small" :loading="loading" @click="loadRows(true)">刷新数据</el-button>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="page-card exception-table-card erp-paged-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>{{ pageConfig.label }}</strong>
            <span>处理后会从待处理列表中移除。</span>
          </div>
          <div class="page-card-actions">
            <div class="exception-filter-inline">
              <el-date-picker v-model="state.filters.from" value-format="YYYY-MM-DD" type="date" placeholder="开始日期" size="small" />
              <el-date-picker v-model="state.filters.to" value-format="YYYY-MM-DD" type="date" placeholder="结束日期" size="small" />
              <el-input
                v-model="state.filters.keyword"
                placeholder="订单号 / SKU / 库存编号 / 店铺"
                clearable
                size="small"
                style="width: 240px"
                @keyup.enter="search"
              />
              <el-button type="primary" size="small" :loading="loading" @click="search">查询</el-button>
              <el-button size="small" @click="reset">重置</el-button>
            </div>
            <el-button :loading="actionLoading" :disabled="!state.selectedIds.length" @click="saveStates(state.selectedIds, 'handled')">批量已处理</el-button>
            <el-button type="warning" plain :loading="actionLoading" :disabled="!state.selectedIds.length" @click="saveStates(state.selectedIds, 'ignored')">批量忽略</el-button>
            <el-button plain :loading="actionLoading" :disabled="!state.selectedIds.length" @click="saveStates(state.selectedIds, 'open')">恢复待处理</el-button>
          </div>
        </div>
      </template>

      <div class="exception-table-wrap erp-table-scroll">
        <el-table
          :data="payload.rows"
          row-key="id"
          stripe
          class="erp-data-table exception-table"
          table-layout="fixed"
          v-loading="loading"
          @selection-change="onSelect"
        >
        <el-table-column type="selection" width="48" />

        <el-table-column label="异常对象" min-width="330">
          <template #default="{ row }">
            <div class="exception-object-cell">
              <ProductImagePreview :src="row.image_url" size="square" />
              <div class="exception-object-copy">
                <div class="exception-object-copy__top">
                  <el-tag size="small" effect="light" :type="levelType(row.level)">{{ typeLabel(row) }}</el-tag>
                  <el-tag v-if="row.task_state && row.task_state !== 'open'" size="small" effect="plain" :type="taskStateType(row.task_state)">
                    {{ row.task_state_label || row.task_state }}
                  </el-tag>
                </div>
                <strong>{{ row.subject || row.title }}</strong>
                <p>{{ row.product_name || row.title }}</p>
                <div class="exception-meta-line">
                  <span v-for="item in metaLines(row)" :key="item">{{ item }}</span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="业务上下文" min-width="380">
          <template #default="{ row }">
            <div class="exception-context-cell">
              <p v-for="line in contextLines(row)" :key="line">{{ line }}</p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="时间与状态" min-width="220">
          <template #default="{ row }">
            <div class="exception-time-cell">
              <p v-for="line in timeLines(row)" :key="line">{{ line }}</p>
              <p v-if="!timeLines(row).length">暂无时间信息</p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <div class="exception-actions-cell">
              <el-button class="exception-action-button" size="small" plain @click="saveStates([row.id], 'handled')">已处理</el-button>
              <el-button class="exception-action-button" size="small" plain type="warning" @click="saveStates([row.id], 'ignored')">忽略</el-button>

              <el-button
                v-if="props.view === 'profit' && row.orderId"
                class="exception-action-button"
                size="small"
                plain
                :loading="rowActionKey === actionKey(row.id, 'recalculate')"
                @click="recalculateOrder(row)"
              >
                重算利润
              </el-button>

              <el-button v-if="props.view === 'profit' && row.productId" class="exception-action-button" size="small" plain @click="openInventory(row)">查看库存</el-button>
              <el-button v-if="props.view === 'binding'" class="exception-action-button" size="small" plain type="primary" @click="openBinding(row)">去绑定</el-button>

              <el-button
                v-if="props.view === 'profit' && row.onlineProductId"
                class="exception-action-button"
                size="small"
                plain
                type="danger"
                :loading="rowActionKey === actionKey(row.id, 'archive')"
                @click="runOnlineAction(row, 'archive', `确认归档「${row.product_name || row.subject || '当前商品'}」吗？归档成功后，这条利润异常会自动标记为已处理。`)"
              >
                归档商品
              </el-button>
            </div>
          </template>
        </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="exception-footer"
        :total="payload.total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100, 200]"
        @update:page="pageChange"
        @update:page-size="sizeChange"
      />
    </el-card>
  </div>
</template>

<style scoped>
.exception-workbench-page { min-height: 0; gap: 12px; }
.exception-overview-card { padding-bottom: 10px; }
.exception-overview { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.exception-overview__main { display: grid; gap: 8px; min-width: 0; }
.exception-overview h2 { margin: 8px 0 2px; }
.exception-overview p { margin: 0; color: #64748b; }
.exception-summary-inline { display: flex; flex-wrap: wrap; gap: 8px; }
.exception-summary-chip { display: grid; gap: 2px; min-width: 110px; padding: 8px 10px; border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 12px; background: #f8fafc; }
.exception-summary-chip strong { font-size: 16px; color: #0f172a; line-height: 1; }
.exception-summary-chip small { color: #64748b; font-size: 12px; }
.exception-overview__aside { display: grid; gap: 8px; min-width: 300px; justify-items: end; }
.exception-module-tabs { width: 100%; }
.exception-toolbar__summary { display: flex; flex-wrap: wrap; gap: 8px 16px; color: #64748b; font-size: 13px; justify-content: flex-end; }
.exception-table-card { min-height: 0; }
.exception-table-wrap { flex: 1 1 auto; }
.exception-filter-inline { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.exception-object-cell { display: flex; gap: 12px; align-items: flex-start; }
.exception-thumb { width: 56px; height: 56px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.25); background: #f8fafc; overflow: hidden; flex: none; }
.exception-object-copy { min-width: 0; display: grid; gap: 6px; }
.exception-object-copy__top { display: flex; flex-wrap: wrap; gap: 6px; }
.exception-object-copy strong { color: #0f172a; line-height: 1.4; }
.exception-object-copy p { margin: 0; color: #475569; line-height: 1.45; }
.exception-meta-line { display: flex; flex-wrap: wrap; gap: 6px 10px; color: #64748b; font-size: 12px; }
.exception-context-cell, .exception-time-cell { display: grid; gap: 6px; }
.exception-context-cell p, .exception-time-cell p { margin: 0; color: #475569; line-height: 1.5; }
.exception-actions-cell { display: grid; grid-template-columns: repeat(2, minmax(92px, 1fr)); gap: 6px; align-items: center; }
.exception-action-button { width: 100%; margin-left: 0 !important; justify-content: center; }
.exception-action-button.el-button--danger { grid-column: 1 / -1; }
.exception-footer { margin-top: auto; }
@media (max-width: 900px) {
  .exception-overview { flex-direction: column; }
  .exception-overview__aside { min-width: 0; width: 100%; justify-items: stretch; }
  .exception-filter-inline { justify-content: flex-start; }
}
</style>

