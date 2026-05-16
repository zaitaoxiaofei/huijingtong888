<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProfitModuleTabs from "../../components/profit/ProfitModuleTabs.vue";
import { formatInteger, formatMoney } from "./profit-utils.js";

const props = defineProps({
  dimension: { type: String, default: "sku" }
});

const loading = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const state = reactive({
  rows: [],
  total: 0,
  totalPages: 0,
  page: 1,
  pageSize: 30,
  filters: { from: "", to: "", keyword: "" }
});
const detail = reactive({
  row: null,
  totals: {},
  rows: []
});

const pageTitle = computed(() => (props.dimension === "shop" ? "店铺排行榜" : "SKU 排行榜"));
const pageDescription = computed(() => (
  props.dimension === "shop"
    ? "只看店铺维度，按利润倒序分页展示。"
    : "只看 SKU 维度，支持关键词筛选和分页。"
));

const toolbarSummary = computed(() => {
  const first = state.rows[0] || {};
  return [
    `结果 ${formatInteger(state.total)} 条`,
    `第 ${state.page} / ${state.totalPages || 1} 页`,
    `榜首利润 ${formatMoney(first.profit)} CNY`,
    props.dimension === "shop"
      ? `榜首营业额 ${formatMoney(first.revenue)} CNY`
      : `榜首订单 ${formatInteger(first.order_count)} 单`
  ];
});

function modelCancelledRevenue(row) {
  return Number(row?.cancelled_revenue ?? row?.cancel_amount ?? 0) - Number(row?.event_cancelled_revenue || 0);
}

async function loadRows() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      dimension: props.dimension,
      page: String(state.page),
      pageSize: String(state.pageSize)
    });
    if (state.filters.from) params.set("from", state.filters.from);
    if (state.filters.to) params.set("to", state.filters.to);
    if (state.filters.keyword) params.set("keyword", state.filters.keyword);
    const payload = await apiClient.get(`/api/profit-ranking?${params.toString()}`);
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || 0);
    state.totalPages = Number(payload?.totalPages || 1);
    state.page = Number(payload?.page || 1);
    state.pageSize = Number(payload?.pageSize || state.pageSize);
    if (!state.filters.from) state.filters.from = payload?.from || "";
    if (!state.filters.to) state.filters.to = payload?.to || "";
  } catch (error) {
    ElMessage.error(error.message || `${pageTitle.value}加载失败`);
  } finally {
    loading.value = false;
  }
}

async function openDetail(row) {
  detailLoading.value = true;
  detailVisible.value = true;
  detail.row = row;
  detail.rows = [];
  detail.totals = {};
  try {
    const params = new URLSearchParams({
      dimension: props.dimension,
      shop_id: String(row.shop_id || ""),
      from: state.filters.from || "",
      to: state.filters.to || "",
      limit: "120"
    });
    if (props.dimension === "sku") {
      params.set("shop_id", String(row.shop_id || ""));
      params.set("ozon_sku", String(row.ozon_sku || ""));
    }
    const payload = await apiClient.get(`/api/profit-ranking/details?${params.toString()}`);
    detail.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    detail.totals = payload?.totals || {};
  } catch (error) {
    detailVisible.value = false;
    ElMessage.error(error.message || "明细加载失败");
  } finally {
    detailLoading.value = false;
  }
}

function handleSearch() {
  state.page = 1;
  loadRows();
}

function handleReset() {
  state.page = 1;
  state.pageSize = 30;
  state.filters.from = "";
  state.filters.to = "";
  state.filters.keyword = "";
  loadRows();
}

function handlePageChange(page) {
  state.page = Number(page || 1);
  loadRows();
}

function handlePageSizeChange(size) {
  state.page = 1;
  state.pageSize = Number(size || 30);
  loadRows();
}

watch(() => props.dimension, () => {
  state.page = 1;
  state.filters.keyword = "";
  detailVisible.value = false;
  loadRows();
});

onMounted(loadRows);
</script>

<template>
  <div class="page-stack">
    <el-card shadow="never" class="page-card ranking-overview-card">
      <div class="ranking-overview">
        <div class="ranking-overview__main">
          <el-tag effect="light" type="warning">经营排行</el-tag>
          <h2>{{ pageTitle }}</h2>
          <p>{{ pageDescription }}</p>
        </div>

        <div class="ranking-overview__aside">
          <ProfitModuleTabs class="ranking-tabs" />
          <el-button :loading="loading" @click="loadRows">刷新数据</el-button>
        </div>
      </div>

      <div class="ranking-controls">
        <el-form inline class="ranking-controls__form">
          <el-form-item label="开始日期">
            <el-date-picker v-model="state.filters.from" value-format="YYYY-MM-DD" type="date" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="state.filters.to" value-format="YYYY-MM-DD" type="date" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.keyword"
              :placeholder="props.dimension === 'shop' ? '店铺名称' : 'SKU / 产品 / 店铺'"
              clearable
              style="width: 260px"
              @keyup.enter="handleSearch"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="loading" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>

        <div class="ranking-toolbar-summary">
          <span v-for="item in toolbarSummary" :key="item">{{ item }}</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="page-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>{{ pageTitle }}</strong>
            <span>默认每页 30 条，可切换 50 / 100 条，支持逐行查看订单明细。</span>
          </div>
        </div>
      </template>

      <el-table :data="state.rows" stripe class="erp-data-table" table-layout="fixed" v-loading="loading">
        <el-table-column prop="rank" label="排名" width="76" />

        <template v-if="props.dimension === 'shop'">
          <el-table-column prop="shop_name" label="店铺" min-width="180" />
          <el-table-column prop="order_count" label="订单数" width="110" />
          <el-table-column prop="item_quantity" label="销量" width="100" />
          <el-table-column prop="revenue" label="营业额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
          </el-table-column>
          <el-table-column prop="profit" label="利润" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
          </el-table-column>
          <el-table-column label="利润口径取消" min-width="130">
            <template #default="{ row }">{{ formatMoney(modelCancelledRevenue(row)) }}</template>
          </el-table-column>
          <el-table-column prop="event_cancelled_revenue" label="状态取消金额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.event_cancelled_revenue) }}</template>
          </el-table-column>
          <el-table-column prop="event_return_revenue" label="状态退货金额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.event_return_revenue) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">查看明细</el-button>
            </template>
          </el-table-column>
        </template>

        <template v-else>
          <el-table-column prop="shop_name" label="店铺" min-width="120" />
          <el-table-column prop="sku_name" label="SKU" min-width="220" />
          <el-table-column prop="product_name" label="产品" min-width="220" />
          <el-table-column prop="owner_name" label="负责人" min-width="100" />
          <el-table-column prop="order_count" label="订单数" width="100" />
          <el-table-column prop="revenue" label="营业额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
          </el-table-column>
          <el-table-column prop="profit" label="利润" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
          </el-table-column>
          <el-table-column label="利润口径取消" min-width="130">
            <template #default="{ row }">{{ formatMoney(modelCancelledRevenue(row)) }}</template>
          </el-table-column>
          <el-table-column prop="event_cancelled_revenue" label="状态取消金额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.event_cancelled_revenue) }}</template>
          </el-table-column>
          <el-table-column prop="event_return_revenue" label="状态退货金额" min-width="130">
            <template #default="{ row }">{{ formatMoney(row.event_return_revenue) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">查看明细</el-button>
            </template>
          </el-table-column>
        </template>
      </el-table>

      <PageFooterPagination
        :total="state.total"
        :page="state.page"
        :page-size="state.pageSize"
        :total-pages="state.totalPages"
        :page-sizes="[30, 50, 100]"
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
      />
    </el-card>

    <el-dialog v-model="detailVisible" :title="detail.row ? `${pageTitle}明细` : '排行明细'" width="1080px" destroy-on-close>
      <div v-loading="detailLoading" class="ranking-detail">
        <div v-if="detail.row" class="ranking-detail__summary">
          <el-tag effect="plain">{{ detail.row.shop_name }}</el-tag>
          <el-tag v-if="props.dimension === 'sku'" effect="plain" type="success">{{ detail.row.ozon_sku }}</el-tag>
          <span>订单 {{ formatInteger(detail.totals.order_count) }}</span>
          <span>营业额 {{ formatMoney(detail.totals.revenue) }}</span>
          <span>利润 {{ formatMoney(detail.totals.profit) }}</span>
        </div>
        <el-table :data="detail.rows" stripe class="erp-data-table" table-layout="fixed">
          <el-table-column prop="ordered_at" label="下单时间" min-width="150" />
          <el-table-column prop="posting_number" label="包裹号" min-width="160" />
          <el-table-column prop="item_names" label="商品" min-width="260" />
          <el-table-column prop="order_status" label="订单状态" min-width="120" />
          <el-table-column prop="revenue" label="营业额" min-width="120">
            <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
          </el-table-column>
          <el-table-column prop="profit" label="利润" min-width="120">
            <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
          </el-table-column>
          <el-table-column label="取消/退货说明" min-width="220">
            <template #default="{ row }">
              {{ row.reason_label || row.loss_profile_label || "-" }}
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.ranking-overview-card { padding-bottom: 8px; }
.ranking-overview {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
}
.ranking-overview__main h2 {
  margin: 10px 0 6px;
}
.ranking-overview__main p {
  margin: 0;
  color: #64748b;
}
.ranking-overview__aside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  min-width: 320px;
}
.ranking-tabs {
  width: 100%;
}
.ranking-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}
.ranking-controls__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
}
.ranking-toolbar-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ranking-toolbar-summary span {
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(241, 245, 249, 0.95);
  border: 1px solid rgba(148, 163, 184, 0.16);
  color: #475569;
  font-size: 12px;
}
.ranking-detail { min-height: 120px; }
.ranking-detail__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
  color: #475569;
}

@media (max-width: 980px) {
  .ranking-overview {
    flex-direction: column;
  }
  .ranking-overview__aside {
    width: 100%;
    min-width: 0;
    align-items: stretch;
  }
}
</style>
