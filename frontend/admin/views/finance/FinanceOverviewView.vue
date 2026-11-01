<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import { canAccessPage } from "../../../../src/shared/permissions.js";
import { shanghaiDateKey } from "../../utils/shanghai-date.js";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import FinanceImportPanel from "../../components/finance/FinanceImportPanel.vue";

const FinanceSettings = defineAsyncComponent(() => import("./FinanceCenterView.vue"));
const auth = useAuthStore(), router = useRouter();
const today = shanghaiDateKey();
const year = ref(today.slice(0, 4)), shopId = ref("all"), shops = ref([]), months = ref([]), loading = ref(false);
const payrollOpen = ref(false), settingsOpen = ref(false), loadError = ref("");
const allowed = computed(() => canAccessPage(auth.user, "/finance-center"));
let generation = 0, controller;
const money = value => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratio = value => `${(Number(value || 0) * 100).toFixed(1)}%`;
const totals = computed(() => {
  const total = {};
  for (const row of months.value) for (const key of ["order_count", "revenue", "net_profit", "manual_expense", "salary_expense"]) total[key] = (total[key] || 0) + Number(row.summary?.[key] || 0);
  total.margin = total.revenue ? total.net_profit / total.revenue : 0;
  return total;
});
const calendar = computed(() => Array.from({ length: 12 }, (_, index) => {
  const key = `${year.value}-${String(index + 1).padStart(2, "0")}`;
  const row = months.value.find(item => item.month_key === key);
  return { ...row, month_key: key, label: `${index + 1}月`, future: key > today.slice(0, 7), summary: row?.summary || {} };
}));
async function load() {
  const token = ++generation;
  controller?.abort(); controller = new AbortController();
  months.value = [];
  loadError.value = "";
  if (!allowed.value || !year.value) return;
  loading.value = true;
  try {
    const end = year.value === today.slice(0, 4) ? Number(today.slice(5, 7)) : 12;
    const response = await apiClient.get(`/api/monthly-billing-details?year=${year.value}&fromMonth=1&toMonth=${end}&shopId=${encodeURIComponent(shopId.value)}&overviewOnly=1`, { noCache: true, signal: controller.signal });
    if (token !== generation || !allowed.value) return;
    months.value = response.months || []; shops.value = response.shops || [];
  } catch (error) { if (token === generation && error.name !== "AbortError") { loadError.value = error.message || "经营总览加载失败"; ElMessage.error(loadError.value); } }
  finally { if (token === generation) loading.value = false; }
}
function bill(row) {
  if (row.future) return;
  router.push({ path: "/profit/monthly-billing", query: { year: year.value, month: row.month_key.slice(5), shopId: shopId.value } });
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, allowed.value, currentApiCacheScope()], () => {
  shops.value = []; months.value = []; payrollOpen.value = false; settingsOpen.value = false; shopId.value = "all"; load();
}, { immediate: true });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>
<template>
  <div v-if="allowed" class="page-stack finance-overview">
    <el-card shadow="never"><ErpPageHeader title="经营总览" description="查看全年经营结果，点击月份进入一张完整账单，再按需查看明细。"><template #actions><el-button @click="payrollOpen=true">工资表导入与汇总</el-button><el-button @click="settingsOpen=true">财务设置</el-button></template></ErpPageHeader>
      <div class="overview-toolbar"><el-date-picker v-model="year" type="year" value-format="YYYY" format="YYYY年" :clearable="false" :disabled-date="date => date.getFullYear() > Number(today.slice(0,4)) || date.getFullYear()<2020" @change="load" /><el-select v-model="shopId" aria-label="店铺筛选" style="width:220px" @change="load"><el-option label="全部店铺（含公司共用费用）" value="all" /><el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select><el-button :loading="loading" @click="load">刷新</el-button><el-button type="primary" @click="router.push('/profit/monthly-billing')">查看经营账单 / 自选日期</el-button></div>
    </el-card>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" />
    <section v-else v-loading="loading" class="overview-metrics"><article><span>年度累计收入</span><strong>¥{{ money(totals.revenue) }}</strong></article><article><span>年度累计净利润</span><strong>¥{{ money(totals.net_profit) }}</strong></article><article><span>累计净利润率</span><strong>{{ ratio(totals.margin) }}</strong></article><article><span>费用与人工成本</span><strong>¥{{ money((totals.manual_expense||0)+(totals.salary_expense||0)) }}</strong></article></section>
    <el-card v-if="!loadError" shadow="never"><div class="month-heading"><h2>{{ year }}年月度账单</h2><p>当月截至北京时间 {{ today }}；历史月份仍可能有待结算订单，未视为最终关账结果。</p></div>
      <el-table v-loading="loading" :data="calendar" stripe @row-click="bill">
        <el-table-column label="月份" width="105"><template #default="{row}"><el-button link type="primary" :disabled="row.future">{{ row.label }}</el-button></template></el-table-column>
        <el-table-column label="状态" min-width="150"><template #default="{row}"><el-tag :type="row.future?'info':row.month_key===today.slice(0,7)?'warning':'info'">{{ row.future ? '尚未开始' : row.month_key===today.slice(0,7) ? '进行中 · 截至今日' : '历史月份 · 可核对' }}</el-tag></template></el-table-column>
        <el-table-column label="订单数" align="right"><template #default="{row}">{{ row.future ? '—' : row.summary.order_count || 0 }}</template></el-table-column>
        <el-table-column label="收入（元）" align="right" min-width="140"><template #default="{row}">{{ row.future ? '—' : money(row.summary.revenue) }}</template></el-table-column>
        <el-table-column label="净利润（元）" align="right" min-width="140"><template #default="{row}">{{ row.future ? '—' : money(row.summary.net_profit) }}</template></el-table-column>
        <el-table-column label="净利润率" align="right"><template #default="{row}">{{ row.future ? '—' : ratio(row.summary.net_profit_margin) }}</template></el-table-column>
        <el-table-column label="查看" width="100"><template #default="{row}"><el-button link :disabled="row.future" type="primary">查看账单</el-button></template></el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="payrollOpen" title="工资表导入与汇总" width="min(96vw, 1250px)" destroy-on-close><FinanceImportPanel v-if="payrollOpen" kind="payroll" @changed="load" /></el-dialog>
    <el-dialog v-model="settingsOpen" title="公司、店铺与历史财务资料" width="96vw" destroy-on-close><FinanceSettings v-if="settingsOpen" /></el-dialog>
  </div>
</template>
<style scoped>
.overview-toolbar{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}.overview-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.overview-metrics article{padding:24px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px;display:grid;gap:14px}.overview-metrics span,.month-heading p{color:var(--el-text-color-secondary)}.overview-metrics strong{font-size:26px}.month-heading h2{font-size:18px;margin:0}.month-heading{margin-bottom:20px}@media(max-width:900px){.overview-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-metrics strong{font-size:20px}}
</style>
