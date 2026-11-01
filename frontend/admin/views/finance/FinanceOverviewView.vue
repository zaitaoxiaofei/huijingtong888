<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowRight, Refresh } from "@element-plus/icons-vue";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import { canAccessPage } from "../../../../src/shared/permissions.js";
import { shanghaiDateKey, shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const FinanceCompanySettings = defineAsyncComponent(() => import("../../components/finance/FinanceCompanySettings.vue"));
const auth = useAuthStore(), router = useRouter();
const today = shanghaiDateKey();
const year = ref(today.slice(0, 4)), shopId = ref("all"), shops = ref([]), months = ref([]);
const companyId = ref("all"), companies = ref([]);
const loading = ref(false), loaded = ref(false), loadError = ref("");
const inventory = ref(null), inventoryLoading = ref(false), inventoryError = ref("");
const companyOpen = ref(false);
const allowed = computed(() => canAccessPage(auth.user, "/finance-center"));
let generation = 0, controller, inventoryGeneration = 0, inventoryController;
const money = value => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = value => Number(value || 0).toLocaleString("zh-CN");
const ratio = value => `${(Number(value || 0) * 100).toFixed(1)}%`;
const totals = computed(() => {
  const total = {};
  for (const row of months.value) for (const key of ["order_count", "revenue", "net_profit", "manual_expense", "salary_expense"]) total[key] = (total[key] || 0) + Number(row.summary?.[key] || 0);
  total.margin = total.revenue ? total.net_profit / total.revenue : 0;
  return total;
});
const calendar = computed(() => Array.from({ length: 12 }, (_, index) => {
  const key = `${year.value}-${String(index + 1).padStart(2, "0")}`;
  return { ...months.value.find(item => item.month_key === key), month_key: key, label: `${index + 1}月`, future: key > today.slice(0, 7) };
}));
const inventoryParts = [
  { label: "国内仓", value: "local_inventory_value", quantity: "local_inventory_quantity" },
  { label: "FBP仓", value: "fbp_inventory_value", quantity: "fbp_inventory_quantity" },
  { label: "采购在途", value: "in_transit_value", quantity: "in_transit_quantity" }
];
async function load() {
  const token = ++generation;
  controller?.abort(); controller = new AbortController();
  loadError.value = "";
  if (!allowed.value || !year.value) return;
  loading.value = true; loaded.value = false;
  try {
    const end = year.value === today.slice(0, 4) ? Number(today.slice(5, 7)) : 12;
    const response = await apiClient.get(`/api/monthly-billing-details?year=${year.value}&fromMonth=1&toMonth=${end}&companyId=${encodeURIComponent(companyId.value)}&shopId=${encodeURIComponent(shopId.value)}&overviewOnly=1`, { noCache: true, signal: controller.signal });
    if (token !== generation || !allowed.value) return;
    months.value = response.months || []; shops.value = response.shops || []; companies.value = response.companies || []; loaded.value = true;
  } catch (error) { if (token === generation && error.name !== "AbortError") loadError.value = error.message || "经营账单加载失败"; }
  finally { if (token === generation) loading.value = false; }
}
async function loadInventory() {
  const token = ++inventoryGeneration;
  inventoryController?.abort(); inventoryController = new AbortController();
  if (!allowed.value) return;
  inventoryLoading.value = true; inventoryError.value = "";
  try {
    const response = await apiClient.get("/api/finance-center/inventory-capital", { noCache: true, signal: inventoryController.signal });
    if (token === inventoryGeneration && allowed.value) inventory.value = response;
  } catch (error) { if (token === inventoryGeneration && error.name !== "AbortError") inventoryError.value = error.message || "库存占用加载失败"; }
  finally { if (token === inventoryGeneration) inventoryLoading.value = false; }
}
function refresh() { load(); loadInventory(); }
function bill(row) {
  if (row.future || !loaded.value) return;
  router.push({ path: "/profit/monthly-billing", query: { year: year.value, month: row.month_key.slice(5), shopId: shopId.value, companyId: companyId.value } });
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, allowed.value, currentApiCacheScope()], () => {
  generation++; inventoryGeneration++; controller?.abort(); inventoryController?.abort();
  shops.value = []; months.value = []; inventory.value = null; loaded.value = false;
  companyOpen.value = false; shopId.value = "all"; companyId.value = "all"; companies.value = [];
  refresh();
}, { immediate: true });
onBeforeUnmount(() => { generation++; inventoryGeneration++; controller?.abort(); inventoryController?.abort(); });
</script>

<template>
  <div v-if="allowed" class="finance-overview">
    <header class="overview-header"><div><h1>经营总览</h1><p>经营结果与库存资金，一页看清。</p></div><div class="page-actions"><el-button text @click="companyOpen=true">公司设置</el-button></div></header>
    <section class="inventory-summary" aria-label="当前库存占用">
      <div class="inventory-total"><div class="section-label">当前库存占用 <span>全部公司</span></div><strong v-if="inventory && !inventoryError">¥{{ money(inventory.inventory_total_value) }}</strong><span v-else class="metric-placeholder">{{ inventoryError ? '暂不可用' : '加载中' }}</span><p>国内仓 + FBP仓 + 采购在途</p></div>
      <div v-for="part in inventoryParts" :key="part.value" class="inventory-part"><span>{{ part.label }}</span><b>{{ inventory && !inventoryError ? `¥${money(inventory[part.value])}` : '—' }}</b><small>{{ inventory && !inventoryError ? `${integer(inventory[part.quantity])} 件` : '当前库存' }}</small></div>
      <div class="inventory-status"><el-button text :icon="Refresh" :loading="inventoryLoading" aria-label="刷新库存占用" @click="loadInventory" /><small v-if="inventory && !inventoryError">{{ shanghaiDateTimeText(inventory.snapshot_at) }} 更新</small><small v-else-if="inventoryError" class="error-text">{{ inventoryError }}</small></div>
    </section>
    <section class="annual-statement">
      <div class="statement-header"><div><h2>年度经营账单</h2><p>{{ year === today.slice(0,4) ? `截至 ${today}` : `${year}年全年` }} · 人民币</p></div><div class="statement-filters">
        <el-date-picker v-model="year" type="year" value-format="YYYY" format="YYYY年" aria-label="经营年份" :clearable="false" :disabled-date="date => date.getFullYear() > Number(today.slice(0,4)) || date.getFullYear()<2020" @change="load" />
        <el-select v-model="companyId" aria-label="公司筛选" class="company-filter" @change="shopId='all'; load()"><el-option label="全部公司" value="all" /><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="String(company.id)" /></el-select>
        <el-select v-model="shopId" aria-label="店铺筛选" @change="load"><el-option label="全部店铺" value="all" /><el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select>
        <el-button text :icon="Refresh" :loading="loading" aria-label="刷新经营账单" @click="load" /><el-button type="primary" @click="router.push('/profit/monthly-billing')">自选日期查账</el-button>
      </div></div>
      <div v-if="loadError" class="statement-error"><span>{{ loadError }}</span><el-button link type="primary" @click="load">重新加载</el-button></div>
      <template v-else>
        <div class="annual-totals"><div><span>累计收入</span><strong>{{ loaded ? `¥${money(totals.revenue)}` : '—' }}</strong></div><div><span>累计净利润</span><strong :class="{negative: loaded && totals.net_profit < 0}">{{ loaded ? `¥${money(totals.net_profit)}` : '—' }}</strong></div><div><span>净利润率</span><strong>{{ loaded ? ratio(totals.margin) : '—' }}</strong></div><div><span>费用与人工</span><strong>{{ loaded ? `¥${money((totals.manual_expense||0)+(totals.salary_expense||0))}` : '—' }}</strong></div></div>
        <el-skeleton v-if="!loaded" class="statement-skeleton" :rows="8" animated />
        <el-table v-else :data="calendar" class="month-table" @row-click="bill">
          <el-table-column label="月份" min-width="145"><template #default="{row}"><div class="month-cell"><b>{{ row.label }}</b><span v-if="row.future">尚未开始</span><span v-else-if="row.month_key===today.slice(0,7)" class="current-month">进行中</span></div></template></el-table-column>
          <el-table-column label="订单数" align="right" min-width="100"><template #default="{row}">{{ row.future ? '—' : integer(row.summary?.order_count) }}</template></el-table-column>
          <el-table-column label="收入" align="right" min-width="145"><template #default="{row}">{{ row.future ? '—' : money(row.summary?.revenue) }}</template></el-table-column>
          <el-table-column label="净利润" align="right" min-width="145"><template #default="{row}"><span :class="{negative:Number(row.summary?.net_profit)<0}">{{ row.future ? '—' : money(row.summary?.net_profit) }}</span></template></el-table-column>
          <el-table-column label="净利润率" align="right" min-width="120"><template #default="{row}">{{ row.future ? '—' : ratio(row.summary?.net_profit_margin) }}</template></el-table-column>
          <el-table-column label="" width="66"><template #default="{row}"><el-button v-if="!row.future" text :icon="ArrowRight" :aria-label="`查看${row.label}账单`" @click.stop="bill(row)" /></template></el-table-column>
        </el-table>
      </template>
      <footer class="statement-note">点击月份查看账单明细。库存占用按当前库存计算，不重复计入经营成本。</footer>
    </section>
    <el-dialog v-model="companyOpen" title="公司设置" width="min(92vw, 720px)" destroy-on-close><FinanceCompanySettings v-if="companyOpen" @saved="ElMessage.success('公司信息已保存'); load()" /></el-dialog>
  </div>
</template>

<style scoped>
.finance-overview{display:grid;gap:22px;max-width:1560px;margin:0 auto;color:var(--el-text-color-primary)}
.overview-header,.page-actions,.statement-header,.statement-filters{display:flex;align-items:center;justify-content:space-between;gap:12px}.overview-header{padding:6px 2px}.overview-header h1{font-size:22px;line-height:1.4;margin:0;font-weight:650;letter-spacing:.3px}.overview-header p,.statement-header p{font-size:13px;color:var(--el-text-color-secondary);margin:5px 0 0}.page-actions{justify-content:flex-end}.page-actions :deep(.el-button)+:deep(.el-button){margin-left:0}
.inventory-summary{position:relative;display:grid;grid-template-columns:1.5fr repeat(3,1fr);align-items:center;gap:24px;padding:26px 30px 42px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px}.section-label{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600}.section-label span{font-weight:400;font-size:11px;color:var(--el-text-color-secondary);padding:2px 6px;background:var(--el-fill-color-light);border-radius:4px}.inventory-total strong{display:block;font-size:30px;font-weight:650;letter-spacing:-.7px;margin-top:10px;font-variant-numeric:tabular-nums}.inventory-total p{font-size:12px;color:var(--el-text-color-secondary);margin:7px 0 0}.inventory-part{display:grid;gap:10px;padding-left:26px;border-left:1px solid var(--el-border-color-lighter)}.inventory-part>span{font-size:13px;color:var(--el-text-color-secondary)}.inventory-part b{font-size:21px;font-weight:550;font-variant-numeric:tabular-nums}.inventory-part small,.inventory-status small{font-size:11px;color:var(--el-text-color-secondary)}.inventory-status{position:absolute;right:21px;bottom:11px;display:flex;align-items:center;gap:8px}.metric-placeholder{display:block;font-size:25px;color:var(--el-text-color-secondary);margin-top:12px}
.annual-statement{background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px;overflow:hidden}.statement-header{padding:24px 28px 20px;flex-wrap:wrap}.statement-header h2{font-size:17px;font-weight:600;margin:0}.statement-filters{justify-content:flex-end;flex-wrap:wrap}.statement-filters :deep(.el-date-editor){width:116px}.statement-filters :deep(.el-select){width:158px}.statement-filters :deep(.company-filter){width:240px}.statement-filters :deep(.el-button)+:deep(.el-button){margin-left:0}
.annual-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:22px 28px;margin:0 28px 12px;background:var(--el-fill-color-lighter);border-radius:8px;gap:16px}.annual-totals>div{display:grid;gap:10px}.annual-totals span{font-size:12px;color:var(--el-text-color-secondary)}.annual-totals strong{font-size:23px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.3px}.negative{color:var(--el-color-danger)}.month-table{width:calc(100% - 56px);margin:0 28px;--el-table-header-bg-color:transparent;--el-table-row-hover-bg-color:var(--el-fill-color-lighter)}.month-table :deep(.el-table__cell){padding:14px 0;font-size:13px;font-variant-numeric:tabular-nums}.month-table :deep(th.el-table__cell){padding:12px 0;color:var(--el-text-color-secondary);font-weight:400;font-size:12px}.month-table :deep(.el-table__row){cursor:pointer}.month-table :deep(.cell){padding-left:12px;padding-right:12px}.month-cell{display:flex;align-items:center;gap:12px}.month-cell b{font-weight:500;min-width:30px}.month-cell>span{color:var(--el-text-color-placeholder);font-size:11px}.month-cell .current-month{color:var(--el-color-primary)}.statement-note{padding:18px 40px;color:var(--el-text-color-secondary);font-size:11px}.statement-error{padding:24px 28px;display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--el-color-danger)}.statement-skeleton{padding:20px 40px}.error-text{color:var(--el-color-danger)!important}
@media(max-width:1100px){.inventory-summary{gap:16px;padding:24px 22px 42px}.inventory-total strong{font-size:26px}.inventory-part{padding-left:16px}.inventory-part b{font-size:18px}.annual-totals{margin:0 20px 10px;padding:20px}.annual-totals strong{font-size:20px}.statement-header{padding:22px 20px}.month-table{width:calc(100% - 40px);margin:0 20px}}
@media(max-width:720px){.finance-overview{gap:16px}.overview-header{flex-wrap:wrap}.overview-header h1{font-size:20px}.inventory-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:22px 18px 42px}.inventory-total{grid-column:1/-1}.inventory-part{padding-left:0;border-left:0}.inventory-part b{font-size:15px}.annual-totals{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.statement-filters{width:100%;justify-content:flex-start}.statement-note{padding:16px 22px}.month-table{width:calc(100% - 24px);margin:0 12px}.statement-header{padding:20px}.inventory-status{right:14px}}
</style>
