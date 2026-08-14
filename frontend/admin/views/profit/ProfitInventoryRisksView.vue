<script setup>
import { computed, onBeforeUnmount, onMounted, reactive } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Edit, RefreshRight, Search, Tickets } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { formatInteger, formatMoney } from "./profit-utils.js";
import { shanghaiDateDaysAgo, shanghaiDateKey } from "../../utils/shanghai-date.js";

const router = useRouter();
let abortController = null;
const defaults = () => ({
  dates: [shanghaiDateDaysAgo(89), shanghaiDateKey()],
  shopId: "all",
  keyword: "",
  minVariance: 20,
  minRatePercent: 30,
  page: 1,
  pageSize: 50
});
const state = reactive({
  loading: false,
  recalculatingId: 0,
  rows: [],
  shops: [],
  summary: {},
  total: 0,
  totalPages: 1,
  filters: defaults()
});

const summaryItems = computed(() => [
  { label: "疑似库存问题", value: formatInteger(state.summary.inventory_risk_item_count) },
  { label: "受影响库存产品", value: formatInteger(state.summary.affected_product_count) },
  { label: "大差异商品行", value: formatInteger(state.summary.variance_item_count) },
  { label: "累计利润差异", value: formatMoney(state.summary.variance_total), danger: Number(state.summary.variance_total || 0) < 0 }
]);

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function flagLabel(code) {
  return {
    missing_mapping: "未绑定库存",
    missing_weight: "缺少克重",
    missing_shipping_method: "缺少物流方式",
    shipping_method_mismatch: "物流方式不一致",
    logistics_variance: "物流费偏差",
    purchase_variance: "成本/SKU 异常",
    commission_variance: "佣金偏差",
    unclassified_variance: "其他差异"
  }[code] || code;
}

function topFlags(row) {
  return Object.entries(row.flag_counts || {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 3);
}

function params() {
  const value = new URLSearchParams({
    from: state.filters.dates?.[0] || shanghaiDateDaysAgo(89),
    to: state.filters.dates?.[1] || shanghaiDateKey(),
    shopId: state.filters.shopId,
    minVariance: String(state.filters.minVariance || 0),
    minRate: String(Number(state.filters.minRatePercent || 0) / 100),
    riskOnly: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize)
  });
  if (state.filters.keyword.trim()) value.set("keyword", state.filters.keyword.trim());
  return value;
}

async function loadData() {
  abortController?.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  state.loading = true;
  try {
    const payload = await apiClient.get(`/api/profit-reconciliation/products?${params()}`, { signal, noCache: true });
    if (signal.aborted) return;
    state.rows = Array.isArray(payload?.products) ? payload.products : [];
    state.shops = Array.isArray(payload?.shops) ? payload.shops : [];
    state.summary = payload?.summary || {};
    state.total = Number(payload?.total || 0);
    state.totalPages = Number(payload?.totalPages || 1);
  } catch (error) {
    if (error?.name !== "AbortError") ElMessage.error(error.message || "库存利润风险加载失败");
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
  Object.assign(state.filters, defaults());
  loadData();
}

function editInventory(row) {
  if (!row.product_id) return;
  router.push({
    path: "/inventory/products",
    query: {
      productId: String(row.product_id),
      openEdit: "1",
      recalculateAfterSave: "1",
      source: "profit-inventory-risks"
    }
  });
}

function bindInventory(row) {
  router.push({
    path: "/inventory/mappings",
    query: {
      keyword: row.product_code || row.product_name || "",
      source: "profit-inventory-risks",
      returnTo: "/profit/inventory-risks"
    }
  });
}

function viewItems(row) {
  const query = {
    productId: row.product_id ? String(row.product_id) : "",
    keyword: row.product_code || row.product_name || "",
    from: state.filters.dates?.[0] || "",
    to: state.filters.dates?.[1] || ""
  };
  router.push({ path: "/profit/order-item-variances", query });
}

async function recalculate(row) {
  if (!row.product_id) return;
  state.recalculatingId = Number(row.product_id);
  try {
    const result = await apiClient.post(`/api/products/${row.product_id}/recalculate-profits`, {});
    ElMessage.success(`预估利润已重算：${formatInteger(result?.updated)} 行`);
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "重算预估利润失败");
  } finally {
    state.recalculatingId = 0;
  }
}

onMounted(loadData);
onBeforeUnmount(() => abortController?.abort());
</script>

<template>
  <div class="page-stack risk-page">
    <ErpPageHeader title="库存利润风险" description="从库存资料问题开始处理，修改后立即重算利润并回看差异。">
      <template #actions><el-button class="erp-btn erp-btn-secondary" :icon="Tickets" @click="router.push('/profit/order-item-variances')">订单商品行差异</el-button></template>
    </ErpPageHeader>

    <ErpFilterBar class="filter-band">
      <el-form inline>
        <el-form-item label="日期"><el-date-picker v-model="state.filters.dates" type="daterange" value-format="YYYY-MM-DD" range-separator="至" /></el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="state.filters.shopId" filterable style="width:180px">
            <el-option label="全部店铺" value="all" />
            <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="最小差额"><el-input-number v-model="state.filters.minVariance" :min="0" :step="10" style="width:125px" /></el-form-item>
        <el-form-item label="最小差异率"><el-input-number v-model="state.filters.minRatePercent" :min="0" :max="500" :step="10" style="width:125px" /></el-form-item>
        <el-form-item label="搜索"><el-input v-model="state.filters.keyword" clearable placeholder="SKU、库存编码或名称" @keyup.enter="search" /></el-form-item>
        <el-form-item><el-button type="primary" :icon="Search" @click="search">查询</el-button><el-button :icon="RefreshRight" @click="reset">重置</el-button></el-form-item>
      </el-form>
    </ErpFilterBar>

    <section class="summary-strip">
      <div v-for="item in summaryItems" :key="item.label"><span>{{ item.label }}</span><strong :class="{ danger: item.danger }">{{ item.value }}</strong></div>
    </section>

    <section class="table-section" v-loading="state.loading">
      <div class="section-heading"><div><h2>待处理产品</h2><p>优先处理影响订单多、累计差异大的库存产品。</p></div><span>共 {{ formatInteger(state.total) }} 个</span></div>
      <el-table :data="state.rows" stripe border height="610" table-layout="fixed">
        <el-table-column label="库存产品" min-width="260" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image :src="row.image_url" fit="cover" lazy class="thumb" preview-teleported :preview-src-list="row.image_url ? [row.image_url] : []"><template #error><span>无图</span></template></el-image>
              <div><strong>{{ row.product_name }}</strong><small>{{ row.product_code || "未绑定库存编码" }}</small></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="当前库存资料" min-width="190"><template #default="{ row }"><div>克重：{{ row.package_weight_g ? `${formatInteger(row.package_weight_g)} g` : "未填写" }}</div><small>物流：{{ row.shipping_method || "未设置" }}</small></template></el-table-column>
        <el-table-column prop="inventory_risk_count" label="风险行" width="90" align="right" />
        <el-table-column prop="risk_rate" label="风险占比" width="100" align="right"><template #default="{ row }">{{ percent(row.risk_rate) }}</template></el-table-column>
        <el-table-column prop="variance_total" label="累计利润差异" width="135" align="right"><template #default="{ row }"><strong :class="{ danger: Number(row.variance_total) < 0 }">{{ formatMoney(row.variance_total) }}</strong></template></el-table-column>
        <el-table-column label="主要证据" min-width="270"><template #default="{ row }"><div class="flags"><el-tag v-for="flag in topFlags(row)" :key="flag[0]" size="small" type="danger" effect="plain">{{ flagLabel(flag[0]) }} {{ flag[1] }}</el-tag></div></template></el-table-column>
        <el-table-column label="下一步动作" width="290" fixed="right">
          <template #default="{ row }">
            <div class="actions">
              <el-button v-if="row.product_id" size="small" type="primary" :icon="Edit" @click="editInventory(row)">编辑库存</el-button>
              <el-button v-else size="small" type="warning" @click="bindInventory(row)">绑定库存</el-button>
              <el-button size="small" :icon="RefreshRight" :disabled="!row.product_id" :loading="state.recalculatingId === Number(row.product_id)" @click="recalculate(row)">重算预估</el-button>
              <el-button size="small" link type="primary" @click="viewItems(row)">查看差异</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <PageFooterPagination :total="state.total" :page="state.filters.page" :page-size="state.filters.pageSize" :total-pages="state.totalPages" @update:page="value => { state.filters.page = value; loadData(); }" @update:page-size="value => { state.filters.pageSize = value; state.filters.page = 1; loadData(); }" />
    </section>
  </div>
</template>

<style scoped>
.risk-page{gap:18px;padding-bottom:24px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.section-heading p{margin:0;color:#64748b}.filter-band{padding:14px 16px 2px;border:1px solid #dfe3e8;border-radius:6px;background:#fff}.filter-band :deep(.el-form-item){margin-bottom:12px}.summary-strip{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #dfe3e8;border-radius:6px;background:#fff}.summary-strip>div{padding:15px 18px;border-right:1px solid #e5e7eb}.summary-strip>div:last-child{border:0}.summary-strip span,.product-cell small{display:block;color:#64748b}.summary-strip strong{display:block;margin-top:7px;font-size:21px}.danger{color:#b42318}.section-heading{margin-bottom:12px}.section-heading h2{margin:0 0 4px;font-size:17px}.section-heading>span{color:#64748b}.product-cell{display:flex;align-items:center;gap:10px}.product-cell>div{min-width:0}.product-cell strong,.product-cell small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.thumb{width:48px;height:62px;flex:0 0 auto;border:1px solid #e5e7eb;border-radius:4px}.thumb span{display:grid;height:100%;place-items:center;color:#94a3b8}.flags,.actions{display:flex;gap:6px;flex-wrap:wrap}:deep(.el-table th.el-table__cell){background:#f8fafc;color:#475467}:deep(.el-pagination){margin-top:14px;justify-content:flex-end}@media(max-width:900px){.summary-strip{grid-template-columns:repeat(2,1fr)}.section-heading{align-items:flex-start;flex-direction:column}}
</style>
