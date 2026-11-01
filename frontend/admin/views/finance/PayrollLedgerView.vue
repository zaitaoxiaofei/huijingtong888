<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import { canAccessPage } from "../../../../src/shared/permissions.js";
import { shanghaiDateKey } from "../../utils/shanghai-date.js";

const FinanceImportPanel = defineAsyncComponent(() => import("../../components/finance/FinanceImportPanel.vue"));
const auth = useAuthStore(), today = shanghaiDateKey();
const allowed = computed(() => canAccessPage(auth.user, "/finance/payroll"));
const year = ref(today.slice(0, 4)), companyId = ref("all"), companies = ref([]), rows = ref([]), selectedMonth = ref(today.slice(0, 7));
const loading = ref(false), errorText = ref(""), importOpen = ref(false), contributionDetails = ref(false);
const paymentRow = ref(null), paidAmount = ref(0), paymentOpen = ref(false), saving = ref(false);
let generation = 0, controller;
const money = value => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = value => Math.round(Number(value || 0) * 100);
const sum = (list, key) => list.reduce((total, row) => total + cents(row[key]), 0) / 100;
const months = computed(() => Array.from({ length: 12 }, (_, index) => {
  const month = `${year.value}-${String(index + 1).padStart(2, "0")}`, records = rows.value.filter(row => row.month === month);
  const unpaid = records.reduce((total, row) => total + Math.max(cents(row.remaining_amount), 0), 0) / 100;
  const paid = sum(records, "paid_amount");
  return { month, label: `${index + 1}月`, count: records.length, net: sum(records, "net"), paid, remaining: sum(records, "remaining_amount"),
    state: !records.length ? "未导入" : unpaid === 0 ? "已发完" : paid > 0 ? "部分发放" : "未发放" };
}));
const details = computed(() => rows.value.filter(row => row.month === selectedMonth.value));
const annual = computed(() => ({ net: sum(rows.value, "net"), paid: sum(rows.value, "paid_amount"), remaining: sum(rows.value, "remaining_amount") }));
const employerFields = [["pension", "养老"], ["medical", "医疗"], ["supplementary_medical", "附加医疗"], ["unemployment", "失业"], ["injury", "工伤"], ["housing_fund", "公积金"]];
const employeeFields = [["pension", "养老"], ["medical", "医疗"], ["unemployment", "失业"], ["housing_fund", "公积金"]];
async function load() {
  const token = ++generation;
  controller?.abort(); controller = new AbortController();
  if (!allowed.value) return;
  loading.value = true; errorText.value = "";
  try {
    const response = await apiClient.get(`/api/finance-submissions/payroll-ledger?year=${year.value}&company_id=${encodeURIComponent(companyId.value)}`, { noCache: true, signal: controller.signal });
    if (token !== generation || !allowed.value) return;
    rows.value = response.rows || []; companies.value = response.companies || [];
    if (!rows.value.some(row => row.month === selectedMonth.value)) selectedMonth.value = rows.value.at(-1)?.month || `${year.value}-${today.slice(5,7)}`;
  } catch (error) { if (token === generation && error.name !== "AbortError") { errorText.value = error.message || "工资明细加载失败"; rows.value = []; } }
  finally { if (token === generation) loading.value = false; }
}
function openPayment(row) { paymentRow.value = { ...row }; paidAmount.value = Number(row.paid_amount || 0); paymentOpen.value = true; }
async function savePayment() {
  const token = generation;
  saving.value = true;
  try {
    await apiClient.post("/api/finance-submissions/payroll-paid", { item_id: paymentRow.value.id, paid_amount: paidAmount.value, expected_paid_amount: paymentRow.value.paid_amount });
    if (token !== generation) return;
    saving.value = false; paymentOpen.value = false; paymentRow.value = null; ElMessage.success("已发金额已保存"); await load();
  } catch (error) { if (token === generation) ElMessage.error(error.message || "保存失败"); }
  finally { if (token === generation) saving.value = false; }
}
async function exportMonth() {
  const token = generation;
  try {
    const response = await apiClient.blobResponse(`/api/finance-submissions/payroll-export?year=${year.value}&company_id=${encodeURIComponent(companyId.value)}&month=${selectedMonth.value}`);
    if (token !== generation || !allowed.value) return;
    const url = URL.createObjectURL(response.blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `工资明细-${selectedMonth.value}.xlsx`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { if (token === generation) ElMessage.error(error.message || "导出失败"); }
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, allowed.value, currentApiCacheScope()], () => {
  generation++; controller?.abort(); rows.value = []; companies.value = []; companyId.value = "all";
  paymentOpen.value = false; paymentRow.value = null; importOpen.value = false; saving.value = false; load();
}, { immediate: true });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>

<template>
  <div v-if="allowed" class="payroll-ledger">
    <header class="ledger-header"><div><h1>工资管理</h1><p>按公司、月份查看工资表，登记已发金额和未发差额。</p></div><el-button type="primary" @click="importOpen=true">导入工资表</el-button></header>
    <div class="ledger-filters"><el-date-picker v-model="year" type="year" value-format="YYYY" format="YYYY年" aria-label="工资年份" :clearable="false" @change="load" /><el-select v-model="companyId" aria-label="工资归属公司" @change="load"><el-option label="全部公司" value="all" /><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="String(company.id)" /></el-select><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" />
    <section v-else v-loading="loading" class="ledger-section">
      <div class="ledger-totals"><div><span>{{ year }}年工资表金额</span><strong>¥{{ money(annual.net) }}</strong></div><div><span>已发金额</span><strong>¥{{ money(annual.paid) }}</strong></div><div><span>未发差额</span><strong>¥{{ money(annual.remaining) }}</strong></div></div>
      <el-table :data="months" class="month-ledger" :row-class-name="({row}) => row.month===selectedMonth ? 'selected-month' : ''" @row-click="row => selectedMonth=row.month"><el-table-column prop="label" label="月份" min-width="100" /><el-table-column prop="count" label="员工数" align="right" min-width="90" /><el-table-column label="工资表金额" align="right" min-width="140"><template #default="{row}">{{ row.count ? money(row.net) : '—' }}</template></el-table-column><el-table-column label="已发金额" align="right" min-width="140"><template #default="{row}">{{ row.count ? money(row.paid) : '—' }}</template></el-table-column><el-table-column label="未发差额" align="right" min-width="140"><template #default="{row}">{{ row.count ? money(row.remaining) : '—' }}</template></el-table-column><el-table-column prop="state" label="发放状态" min-width="115" /><el-table-column width="90"><template #default="{row}"><el-button link type="primary" @click.stop="selectedMonth=row.month">查看明细</el-button></template></el-table-column></el-table>
    </section>
    <section class="ledger-section details-section">
      <div class="details-header"><div><h2>{{ selectedMonth }} 工资明细</h2><p>差额 = 表内实发工资 − 已发金额；社保、公积金缴纳不代表工资已发。</p></div><div class="detail-actions"><el-switch v-model="contributionDetails" active-text="缴费分项" /><el-button :disabled="!details.length" @click="exportMonth">导出本月</el-button></div></div>
      <el-table v-loading="loading" :data="details" empty-text="本月暂无工资表，可通过导入工资表添加。" class="salary-details">
        <el-table-column prop="person_name" label="姓名" width="105" fixed /><el-table-column prop="company_name" label="公司" min-width="205" /><el-table-column prop="department" label="部门" min-width="90" />
        <el-table-column label="基本工资" width="115" align="right"><template #default="{row}">{{ money(row.base) }}</template></el-table-column>
        <el-table-column v-if="contributionDetails" label="单位缴费"><el-table-column v-for="field in employerFields" :key="field[0]" :label="field[1]" width="105" align="right"><template #default="{row}">{{ row.employer_items?.[field[0]] == null ? '—' : money(row.employer_items[field[0]]) }}</template></el-table-column></el-table-column>
        <el-table-column label="单位缴费合计" width="125" align="right"><template #default="{row}">{{ money(row.employer) }}</template></el-table-column>
        <el-table-column v-if="contributionDetails" label="个人缴费"><el-table-column v-for="field in employeeFields" :key="field[0]" :label="field[1]" width="105" align="right"><template #default="{row}">{{ row.employee_items?.[field[0]] == null ? '—' : money(row.employee_items[field[0]]) }}</template></el-table-column></el-table-column>
        <el-table-column label="个人缴费合计" width="125" align="right"><template #default="{row}">{{ money(row.employee) }}</template></el-table-column><el-table-column label="个税" width="95" align="right"><template #default="{row}">{{ money(row.tax) }}</template></el-table-column>
        <el-table-column label="实发工资（表内）" width="145" align="right"><template #default="{row}">{{ money(row.net) }}</template></el-table-column><el-table-column label="已发金额" width="125" align="right" fixed="right"><template #default="{row}"><el-button link type="primary" :aria-label="`登记${row.person_name}已发金额`" @click="openPayment(row)">{{ money(row.paid_amount) }}</el-button></template></el-table-column><el-table-column label="未发差额" width="125" align="right" fixed="right"><template #default="{row}">{{ money(row.remaining_amount) }}</template></el-table-column>
      </el-table>
      <p v-if="contributionDetails && details.some(row => !row.employer_items)" class="ledger-note">部分旧导入记录未保存缴费分项，以“—”显示，合计金额仍保留。</p>
    </section>
    <el-dialog v-model="paymentOpen" title="登记已发金额" width="420px" destroy-on-close><template v-if="paymentRow"><p>{{ paymentRow.company_name }} · {{ paymentRow.person_name }}</p><p>{{ paymentRow.month }} · 表内实发工资 ¥{{ money(paymentRow.net) }}</p><el-form label-position="top" @submit.prevent="savePayment"><el-form-item label="累计已发金额"><el-input-number v-model="paidAmount" :min="0" :precision="2" :max="100000000" /></el-form-item><p>未发差额：¥{{ money((cents(paymentRow.net)-cents(paidAmount))/100) }}</p></el-form></template><template #footer><el-button :disabled="saving" @click="paymentOpen=false">取消</el-button><el-button type="primary" :loading="saving" :disabled="paidAmount==null" @click="savePayment">保存</el-button></template></el-dialog>
    <el-dialog v-model="importOpen" title="工资表导入与审核" width="min(94vw, 1200px)" destroy-on-close><FinanceImportPanel v-if="importOpen" kind="payroll" @changed="load" /></el-dialog>
  </div>
</template>

<style scoped>
.payroll-ledger{display:grid;gap:22px;max-width:1560px;margin:0 auto}.ledger-header,.ledger-filters,.details-header,.detail-actions{display:flex;align-items:center;justify-content:space-between;gap:14px}.ledger-header h1{font-size:22px;margin:0;font-weight:650}.ledger-header p,.details-header p{color:var(--el-text-color-secondary);font-size:13px;margin:6px 0 0}.ledger-filters{justify-content:flex-start}.ledger-filters :deep(.el-date-editor){width:130px}.ledger-filters :deep(.el-select){width:300px}.ledger-section{padding:24px 28px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px}.ledger-totals{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:4px 0 24px}.ledger-totals>div{display:grid;gap:10px}.ledger-totals span{font-size:12px;color:var(--el-text-color-secondary)}.ledger-totals strong{font-size:25px;font-weight:600;font-variant-numeric:tabular-nums}.month-ledger :deep(.el-table__row){cursor:pointer}.month-ledger :deep(.selected-month){--el-table-tr-bg-color:var(--el-color-primary-light-9)}.month-ledger :deep(.el-table__cell){padding:12px 0}.details-header{margin-bottom:22px;flex-wrap:wrap}.details-header h2{font-size:17px;margin:0;font-weight:600}.salary-details :deep(.el-table__cell){padding:14px 0;font-variant-numeric:tabular-nums}.ledger-note{font-size:12px;color:var(--el-text-color-secondary);margin:16px 0 0}.detail-actions{justify-content:flex-end}
@media(max-width:720px){.ledger-header,.ledger-filters{flex-wrap:wrap}.ledger-section{padding:20px 14px}.ledger-totals{grid-template-columns:1fr;gap:18px}.ledger-totals strong{font-size:22px}.ledger-filters :deep(.el-select){width:230px}}
</style>
