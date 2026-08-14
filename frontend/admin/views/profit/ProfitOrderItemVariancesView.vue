<script setup>
import { onBeforeUnmount, onMounted, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Edit, RefreshRight, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { formatInteger, formatMoney } from "./profit-utils.js";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const route = useRoute();
const router = useRouter();
let abortController = null;
const state = reactive({
  loading: false,
  rows: [],
  shops: [],
  total: 0,
  totalPages: 1,
  filters: {
    dates: [String(route.query.from || shanghaiDateDaysAgo(89)), String(route.query.to || shanghaiDateKey())],
    shopId: "all",
    keyword: String(route.query.keyword || ""),
    productId: String(route.query.productId || ""),
    minVariance: 20,
    minRatePercent: 30,
    riskOnly: true,
    page: 1,
    pageSize: 50
  }
});

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function varianceClass(value) {
  return Number(value || 0) < 0 ? "danger" : Number(value || 0) > 0 ? "positive" : "";
}

const comparisonDefinitions = [
  { key: "purchase", label: "采购成本", estimated: "estimated_purchase_cost", actual: "actual_purchase_cost", action: "核对库存采购成本和 SKU 绑定", editable: true },
  { key: "domestic", label: "国内运费", estimated: "estimated_domestic_shipping", actual: "actual_domestic_shipping", action: "核对库存国内运费", editable: true },
  { key: "international", label: "国际运费", estimated: "estimated_international_shipping", actual: "actual_international_shipping", action: "核对克重、物流方式和运费规则", editable: true },
  { key: "packaging", label: "包装处理费", estimated: "estimated_packaging_cost", actual: "actual_packaging_cost", action: "核对库存包装处理费", editable: true },
  { key: "commission", label: "Ozon 佣金", estimated: "estimated_commission", actual: "actual_commission", action: "查看 Ozon 佣金账单，不修改库存", editable: false },
  { key: "service", label: "Ozon 服务费", estimated: "estimated_ozon_service_fee", actual: "actual_ozon_service_fee", action: "查看 Ozon 服务费账单，不修改库存", editable: false },
  { key: "returnLoss", label: "售后/退货损失", estimated: "estimated_return_loss", actual: "actual_return_loss", action: "查看订单售后记录和 Ozon 退款账单", editable: false },
  { key: "advertising", label: "广告费", estimated: "estimated_advertising_cost", actual: "actual_advertising_cost", action: "广告费预估与真实使用相同归集口径", editable: false },
  { key: "other", label: "其他费用", estimated: "estimated_other_fees", actual: "actual_other_fees", action: "查看 Ozon 其他费用明细，不修改库存", editable: false }
];

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function comparisonRows(row) {
  const rows = comparisonDefinitions.map((definition) => {
    const estimated = roundMoney(row[definition.estimated]);
    const actual = roundMoney(row[definition.actual]);
    return { ...definition, estimated, actual, diff: roundMoney(actual - estimated) };
  });
  rows.push({
    key: "profit",
    label: "利润",
    estimated: roundMoney(row.estimated_profit),
    actual: roundMoney(row.actual_profit),
    diff: roundMoney(row.variance),
    action: "以上费用差异共同形成最终利润差异",
    editable: false,
    strong: true
  });
  return rows;
}

function mainDrivers(row) {
  return comparisonRows(row)
    .filter((item) => item.key !== "profit" && Math.abs(item.diff) >= 0.01)
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff))
    .slice(0, 2);
}

function suggestedAction(row) {
  const drivers = mainDrivers(row);
  return drivers.find((item) => item.editable)?.action || drivers[0]?.action || "展开查看逐项费用对比";
}

function params() {
  const value = new URLSearchParams({
    from: state.filters.dates?.[0] || shanghaiDateDaysAgo(89),
    to: state.filters.dates?.[1] || shanghaiDateKey(),
    shopId: state.filters.shopId,
    minVariance: String(state.filters.minVariance || 0),
    minRate: String(Number(state.filters.minRatePercent || 0) / 100),
    riskOnly: state.filters.riskOnly ? "1" : "0",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize)
  });
  if (state.filters.productId) value.set("productId", state.filters.productId);
  if (state.filters.keyword.trim()) value.set("keyword", state.filters.keyword.trim());
  return value;
}

async function loadData() {
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  state.loading = true;
  try {
    const payload = await apiClient.get(`/api/profit-reconciliation/items?${params()}`, { signal, noCache: true });
    if (signal.aborted) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.shops = Array.isArray(payload?.shops) ? payload.shops : [];
    state.total = Number(payload?.total || 0);
    state.totalPages = Number(payload?.totalPages || 1);
  } catch (error) {
    if (error?.name !== "AbortError") ElMessage.error(error.message || "订单商品行差异加载失败");
  } finally {
    if (abortController?.signal === signal) {
      abortController = null;
      state.loading = false;
    }
  }
}

function search() {
  state.filters.page = 1;
  loadData();
}

function reset() {
  Object.assign(state.filters, {
    dates: [shanghaiDateDaysAgo(89), shanghaiDateKey()],
    shopId: "all",
    keyword: "",
    productId: "",
    minVariance: 20,
    minRatePercent: 30,
    riskOnly: true,
    page: 1,
    pageSize: 50
  });
  loadData();
}

function editInventory(row) {
  if (!row.product_id) {
    router.push({ path: "/inventory/mappings", query: { keyword: row.ozon_sku || "", returnTo: route.fullPath } });
    return;
  }
  router.push({
    path: "/inventory/products",
    query: { productId: String(row.product_id), openEdit: "1", recalculateAfterSave: "1", source: "profit-order-item-variances" }
  });
}

onMounted(loadData);
onBeforeUnmount(() => abortController?.abort());
</script>

<template>
  <div class="page-stack variance-page">
    <ErpPageHeader title="订单商品行差异" description="利润差异 = 真实利润 - 预估利润；定位原因后可直接修改库存资料。">
      <template #actions><el-button class="erp-btn erp-btn-secondary" @click="router.push('/profit/inventory-risks')">库存利润风险</el-button></template>
    </ErpPageHeader>
    <ErpFilterBar class="filter-band">
      <el-form inline>
        <el-form-item label="日期"><el-date-picker v-model="state.filters.dates" type="daterange" value-format="YYYY-MM-DD" range-separator="至" /></el-form-item>
        <el-form-item label="店铺"><el-select v-model="state.filters.shopId" filterable style="width:175px"><el-option label="全部店铺" value="all" /><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select></el-form-item>
        <el-form-item label="搜索"><el-input v-model="state.filters.keyword" clearable placeholder="订单、SKU、库存编码或名称" style="width:240px" @keyup.enter="search" /></el-form-item>
        <el-form-item><el-checkbox v-model="state.filters.riskOnly">只看库存问题</el-checkbox></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="RefreshRight" @click="reset">重置</el-button></el-form-item>
      </el-form>
    </ErpFilterBar>
    <section class="table-section" v-loading="state.loading">
      <div class="section-heading"><div><h2>差异明细</h2><p v-if="state.filters.productId">已定位库存产品 ID {{ state.filters.productId }}</p></div><span>共 {{ formatInteger(state.total) }} 行</span></div>
      <el-table :data="state.rows" stripe border height="650" table-layout="fixed">
        <el-table-column type="expand" width="48" fixed="left">
          <template #default="{ row }">
            <div class="comparison-panel">
              <div class="comparison-head">
                <div><strong>逐项利润对比</strong><span>复用订单利润口径；费用差异 = 真实金额 - 预估金额。</span></div>
                <el-button size="small" type="primary" :icon="Edit" @click="editInventory(row)">{{ row.product_id ? "修改库存资料" : "绑定库存" }}</el-button>
              </div>
              <el-table :data="comparisonRows(row)" border size="small" class="comparison-table" :row-class-name="({ row: item }) => item.strong ? 'comparison-total-row' : ''">
                <el-table-column prop="label" label="对比项目" min-width="150" />
                <el-table-column label="预估金额" width="135" align="right"><template #default="{ row: item }">{{ formatMoney(item.estimated) }}</template></el-table-column>
                <el-table-column label="真实金额" width="135" align="right"><template #default="{ row: item }">{{ formatMoney(item.actual) }}</template></el-table-column>
                <el-table-column label="费用差异" width="125" align="right"><template #default="{ row: item }"><strong :class="varianceClass(item.diff)">{{ item.diff > 0 ? "+" : "" }}{{ formatMoney(item.diff) }}</strong></template></el-table-column>
                <el-table-column label="判断与下一步" min-width="330"><template #default="{ row: item }">{{ Math.abs(item.diff) < 0.01 ? "基本一致，无需处理" : item.action }}</template></el-table-column>
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="订单 / 商品" min-width="280" fixed="left"><template #default="{ row }"><button class="order-link" @click="router.push({ path: '/orders', query: { orderId: String(row.order_id) } })"><strong>{{ row.posting_number || row.order_number }}</strong><span>{{ row.ozon_name || row.product_name }}</span><small>SKU {{ row.ozon_sku }} · {{ row.shop_name }}</small></button></template></el-table-column>
        <el-table-column label="库存产品" min-width="190"><template #default="{ row }"><strong>{{ row.product_name || "未绑定" }}</strong><br><small>{{ row.product_code || "-" }}</small></template></el-table-column>
        <el-table-column label="签收时间" width="165"><template #default="{ row }">{{ shanghaiDateTimeText(row.delivered_at) }}</template></el-table-column>
        <el-table-column label="预估利润" width="110" align="right"><template #default="{ row }">{{ formatMoney(row.estimated_profit) }}</template></el-table-column>
        <el-table-column label="真实利润" width="110" align="right"><template #default="{ row }">{{ formatMoney(row.actual_profit) }}</template></el-table-column>
        <el-table-column label="利润差异" width="115" align="right"><template #default="{ row }"><strong :class="varianceClass(row.variance)">{{ formatMoney(row.variance) }}</strong></template></el-table-column>
        <el-table-column label="差异率" width="95" align="right"><template #default="{ row }">{{ percent(row.variance_rate) }}</template></el-table-column>
        <el-table-column label="主要差异项" min-width="220"><template #default="{ row }"><div class="driver-list"><el-tag v-for="item in mainDrivers(row)" :key="item.key" size="small" :type="item.editable ? 'danger' : 'warning'" effect="plain">{{ item.label }} {{ item.diff > 0 ? "+" : "" }}{{ formatMoney(item.diff) }}</el-tag><span v-if="!mainDrivers(row).length">展开查看明细</span></div></template></el-table-column>
        <el-table-column label="建议修改" min-width="245"><template #default="{ row }"><span class="action-hint">{{ suggestedAction(row) }}</span></template></el-table-column>
        <el-table-column label="下一步动作" width="130" fixed="right"><template #default="{ row }"><el-button size="small" type="primary" :icon="Edit" @click="editInventory(row)">{{ row.product_id ? "编辑库存" : "绑定库存" }}</el-button></template></el-table-column>
      </el-table>
      <PageFooterPagination :total="state.total" :page="state.filters.page" :page-size="state.filters.pageSize" :total-pages="state.totalPages" @update:page="value => { state.filters.page = value; loadData(); }" @update:page-size="value => { state.filters.pageSize = value; state.filters.page = 1; loadData(); }" />
    </section>
  </div>
</template>

<style scoped>
.variance-page{gap:18px;padding-bottom:24px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.section-heading p{margin:0;color:#64748b}.filter-band{padding:14px 16px 2px;border:1px solid #dfe3e8;border-radius:6px;background:#fff}.filter-band :deep(.el-form-item){margin-bottom:12px}.section-heading{margin-bottom:12px}.section-heading h2{margin:0 0 4px;font-size:17px}.section-heading>span{color:#64748b}.order-link{display:flex;width:100%;flex-direction:column;border:0;padding:0;background:transparent;text-align:left;cursor:pointer}.order-link strong{color:#175cd3}.order-link span,.order-link small{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.order-link small{color:#64748b}.driver-list{display:flex;gap:5px;flex-wrap:wrap}.action-hint{color:#475467;line-height:1.5}.comparison-panel{padding:14px 18px 20px;background:#f8fafc}.comparison-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.comparison-head>div{display:flex;flex-direction:column;gap:4px}.comparison-head span{color:#64748b}.comparison-table{max-width:1050px}.danger{color:#b42318}.positive{color:#067647}:deep(.comparison-total-row td){background:#eef4ff!important}:deep(.comparison-total-row .cell){font-weight:700}:deep(.el-table th.el-table__cell){background:#f8fafc;color:#475467}:deep(.el-pagination){margin-top:14px;justify-content:flex-end}@media(max-width:900px){.section-heading,.comparison-head{align-items:flex-start;flex-direction:column}}
</style>
