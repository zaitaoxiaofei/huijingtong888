<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import { PAYROLL_EMPLOYER_FIELDS, PAYROLL_EMPLOYEE_FIELDS } from "../../../../src/shared/payroll-entry.js";
import { canAccessPage } from "../../../../src/shared/permissions.js";
import { shanghaiDateKey } from "../../utils/shanghai-date.js";

const PayrollItemEditor = defineAsyncComponent(() => import("../../components/finance/PayrollItemEditor.vue"));
const FinanceImportPanel = defineAsyncComponent(() => import("../../components/finance/FinanceImportPanel.vue"));
const auth = useAuthStore(), route = useRoute(), router = useRouter(), today = shanghaiDateKey();
const routeMonth = () => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(route.query.month || "")) ? String(route.query.month) : today.slice(0,7);
const allowed = computed(() => canAccessPage(auth.user, "/finance/payroll"));
const year = ref(routeMonth().slice(0, 4)), companyId = ref(String(route.query.companyId || "all")), companies = ref([]), rows = ref([]), selectedMonth = ref(routeMonth());
const loading = ref(false), errorText = ref(""), importOpen = ref(false), contributionDetails = ref(false);
const reviewSubmissionId=ref(null);
const detailsOpen = ref(false), editorOpen = ref(false), editingRow = ref(null), copyingRow = ref(false), selectedRows = ref([]), batchSaving = ref(false);
const paymentRow = ref(null), paidAmount = ref(0), paymentOpen = ref(false), saving = ref(false);
let generation = 0, controller;
const money = value => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = value => Math.round(Number(value || 0) * 100);
const sum = (list, key) => list.reduce((total, row) => total + cents(row[key]), 0) / 100;
const companyCost = row => (cents(row.base) + cents(row.employer)) / 100;
const totalCost = list => list.reduce((total, row) => total + cents(companyCost(row)), 0) / 100;
const months = computed(() => Array.from({ length: 12 }, (_, index) => {
  const month = `${year.value}-${String(index + 1).padStart(2, "0")}`, records = rows.value.filter(row => row.month === month);
  const unpaid = records.reduce((total, row) => total + Math.max(cents(row.remaining_amount), 0), 0) / 100;
  const paid = sum(records, "paid_amount");
  return { month, label: `${index + 1}月`, count: records.length, net: sum(records, "net"), cost: totalCost(records), employer: sum(records, "employer"), paid, remaining: sum(records, "remaining_amount"),
    state: !records.length ? "未录入" : records.some(row => cents(row.remaining_amount) < 0) ? "超发待核对" : unpaid === 0 ? "已发完" : paid > 0 ? "部分发放" : "未发放" };
}));
const details = computed(() => rows.value.filter(row => row.month === selectedMonth.value));
const annual = computed(() => ({ net: sum(rows.value, "net"), cost: totalCost(rows.value), employer: sum(rows.value, "employer"), paid: sum(rows.value, "paid_amount"), remaining: sum(rows.value, "remaining_amount") }));
const employerFields = PAYROLL_EMPLOYER_FIELDS;
const employeeFields = PAYROLL_EMPLOYEE_FIELDS;
function openFinance(path) {
  const query=path==='/finance/company-statements'?{company_id:companyId.value,month:selectedMonth.value}:{companyId:companyId.value,from:selectedMonth.value+'-01',to:selectedMonth.value+'-'+String(new Date(Date.UTC(Number(selectedMonth.value.slice(0,4)),Number(selectedMonth.value.slice(5)),0)).getUTCDate())};
  router.push({path,query});
}
async function deleteItem(row) {
  const token=generation;
  try {
    const {value}=await ElMessageBox.prompt(`删除${row.person_name}的工资明细，并同步移除对应已入账费用。修改历史会保留。已有发放金额、凭证或已关账的记录需先核对。`, '删除工资明细', {inputPlaceholder:'填写删除原因',inputValidator:v=>Boolean(String(v||'').trim())&&String(v).length<=500||'请填写原因，最多500字',confirmButtonText:'确认删除',cancelButtonText:'取消',type:'warning'});
    if(token!==generation)return;
    batchSaving.value=true;
    await apiClient.post('/api/finance-submissions/payroll-delete',{item_id:row.id,expected_revision:row.revision,reason:value});
    if(token!==generation)return;
    batchSaving.value=false;ElMessage.success('工资及对应费用已同步删除');await load();
  }catch(error){if(token===generation&&!['cancel','close'].includes(error))ElMessage.error(error.message||'删除失败');}
  finally{if(token===generation)batchSaving.value=false;}
}
const selectable = row => Number(row.remaining_amount) > 0;
function openDetails(month) { if(loading.value || batchSaving.value)return; selectedMonth.value = month; selectedRows.value = []; detailsOpen.value = true; }
function openEditor(row = null, copy = false) { editingRow.value = row ? JSON.parse(JSON.stringify(row)) : null; copyingRow.value = copy; editorOpen.value = true; }
async function saveBatchPayment() {
  const chosen = selectedRows.value.map(row => ({ ...row }));
  if (!chosen.length || loading.value || batchSaving.value) return;
  const token = generation;
  try {
    await ElMessageBox.confirm(`将 ${chosen.length} 条工资的累计已发金额登记为各自的实发工资，本次补记 ¥${money(chosen.reduce((n,row)=>n+Math.max(cents(row.remaining_amount),0),0)/100)}。只登记记录，不执行转账。`, "批量登记发放", { confirmButtonText: "确认登记", cancelButtonText: "取消", type: "warning" });
    if (token !== generation) return;
    batchSaving.value = true;
    const result = await apiClient.post('/api/finance-submissions/payroll-paid-batch', { items: chosen.map(row => ({ item_id: row.id, expected_paid_amount: row.paid_amount, expected_revision: row.revision })) });
    if (token !== generation) return;
    ElMessage.success(`已登记 ${result.changed} 条，已发完的 ${result.skipped} 条未重复登记`); selectedRows.value = []; batchSaving.value = false; await load();
  } catch(error) { if (token === generation && !['cancel','close'].includes(error)) ElMessage.error(error.message || '批量登记失败'); }
  finally { if (token === generation) batchSaving.value = false; }
}
async function load() {
  selectedRows.value = [];
  const token = ++generation;
  controller?.abort(); controller = new AbortController();
  if (!allowed.value) return;
  loading.value = true; errorText.value = "";
  try {
    const response = await apiClient.get(`/api/finance-submissions/payroll-ledger?year=${year.value}&company_id=${encodeURIComponent(companyId.value)}`, { noCache: true, signal: controller.signal });
    if (token !== generation || !allowed.value) return;
    selectedRows.value = []; rows.value = response.rows || []; companies.value = response.companies || [];
    if (!selectedMonth.value.startsWith(`${year.value}-`)) selectedMonth.value = `${year.value}-${today.slice(5,7)}`;
    if (!route.query.month && !rows.value.some(row => row.month === selectedMonth.value) && rows.value.length) selectedMonth.value = rows.value.map(row => row.month).sort().at(-1);
  } catch (error) { if (token === generation && error.name !== "AbortError") { errorText.value = error.message || "工资明细加载失败"; rows.value = []; } }
  finally { if (token === generation) loading.value = false; }
}
function openPayment(row) { paymentRow.value = { ...row }; paidAmount.value = Number(row.paid_amount || 0); paymentOpen.value = true; }
async function savePayment() {
  const token = generation;
  saving.value = true;
  try {
    await apiClient.post("/api/finance-submissions/payroll-paid", { item_id: paymentRow.value.id, paid_amount: paidAmount.value, expected_paid_amount: paymentRow.value.paid_amount, expected_revision: paymentRow.value.revision });
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
  generation++; controller?.abort(); rows.value = []; companies.value = []; companyId.value = String(route.query.companyId || "all");
  detailsOpen.value = allowed.value && Boolean(route.query.month) && route.query.action !== "import"; editorOpen.value = false; editingRow.value = null; selectedRows.value = []; batchSaving.value = false; paymentOpen.value = false; paymentRow.value = null; importOpen.value = allowed.value && route.query.action === "import"; saving.value = false; load();
}, { immediate: true });
watch(() => [route.query.month,route.query.companyId,route.query.action], () => {
  if(route.path!=="/finance/payroll")return;
  selectedMonth.value=routeMonth(); year.value=selectedMonth.value.slice(0,4); companyId.value=String(route.query.companyId||"all");
  importOpen.value=allowed.value&&route.query.action==='import'; detailsOpen.value=allowed.value&&Boolean(route.query.month)&&route.query.action!=='import'; if(allowed.value)load();
});
function handleItemSaved(result) {
  selectedMonth.value = result.month; year.value = result.month.slice(0,4);
  if(companyId.value !== 'all') companyId.value = String(result.company_id);
  detailsOpen.value = true; load();
}
watch(selectedMonth, () => { selectedRows.value = []; });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>

<template>
  <div v-if="allowed" class="payroll-ledger">
    <header class="ledger-header"><div><h1>工资管理</h1><p>按公司查看全年1—12月工资汇总，点击明细查看或编辑记录。</p></div><div class="detail-actions"><el-button type="primary" @click="openEditor()">新增工资明细</el-button><el-button type="primary" @click="importOpen=true">导入工资表</el-button></div></header>
    <div class="detail-actions"><el-button :disabled="companyId==='all'" title="先选择归属公司，再查看公司账单" @click="openFinance('/finance/company-statements')">公司账单</el-button><el-button @click="openFinance('/profit/monthly-billing')">月度账单</el-button><el-button @click="router.push({path:'/finance-center',query:{companyId,year}})">经营总览</el-button></div>
    <el-alert type="info" :closable="false" title="可直接新增工资明细，也可导入工资表。点击月份查看明细、批量登记发放或逐条编辑；点击明细中的“核对并入账”确认成本；发放登记单独保留，不重复扣费。" />
    <div class="ledger-filters"><el-date-picker v-model="year" type="year" value-format="YYYY" format="YYYY年" aria-label="工资年份" :clearable="false" @change="load" /><el-select v-model="companyId" aria-label="工资归属公司" @change="load"><el-option label="全部公司" value="all" /><el-option v-for="company in companies" :key="company.id" :label="company.name" :value="String(company.id)" /></el-select><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="errorText" :title="errorText" type="error" :closable="false" />
    <section v-else v-loading="loading" class="ledger-section">
      <div class="ledger-totals">
        <div><span>{{ year }}年员工实发工资</span><strong>¥{{ money(annual.net) }}</strong></div>
        <div><span>公司承担社保公积金</span><strong>¥{{ money(annual.employer) }}</strong></div>
        <div><span>公司人工总支出</span><strong>¥{{ money(annual.cost) }}</strong></div>
        <div><span>工资已发金额</span><strong>¥{{ money(annual.paid) }}</strong></div>
        <div><span>工资未发差额</span><strong>¥{{ money(annual.remaining) }}</strong></div>
      </div>
      <p class="ledger-note cost-note">公司人工总支出 = 基本工资 + 公司承担社保公积金；个人扣款已包含在基本工资中，不重复相加。含已确认与待确认工资；已发放工资按归属月计成本，可在同一行核对确认，审批归档不重复扣费。</p>
      <el-table :data="months" class="month-ledger" :row-class-name="({row}) => row.month===selectedMonth ? 'selected-month' : ''" @row-click="row => openDetails(row.month)">
        <el-table-column prop="label" label="月份" width="64" fixed />
        <el-table-column prop="count" label="人数" width="60" align="right" />
        <el-table-column label="员工实发工资" align="right" min-width="125"><template #default="{row}">{{ row.count ? money(row.net) : '—' }}</template></el-table-column>
        <el-table-column label="公司承担缴费" align="right" min-width="125"><template #default="{row}">{{ row.count ? money(row.employer) : '—' }}</template></el-table-column>
        <el-table-column label="公司人工总支出" align="right" min-width="135"><template #default="{row}"><strong>{{ row.count ? money(row.cost) : '—' }}</strong></template></el-table-column>
        <el-table-column label="工资已发" align="right" min-width="110"><template #default="{row}">{{ row.count ? money(row.paid) : '—' }}</template></el-table-column>
        <el-table-column label="工资未发" align="right" min-width="110"><template #default="{row}">{{ row.count ? money(row.remaining) : '—' }}</template></el-table-column>
        <el-table-column prop="state" label="发放状态" width="90" />
        <el-table-column width="100" fixed="right"><template #default="{row}"><el-button link type="primary" @click.stop="openDetails(row.month)">{{row.count?'查看明细':'录入工资'}}</el-button></template></el-table-column>
      </el-table>
    </section>
    <el-dialog v-model="detailsOpen" :title="selectedMonth + ' 工资明细'" width="min(96vw, 1540px)" :close-on-click-modal="!batchSaving" :close-on-press-escape="!batchSaving" :show-close="!batchSaving" destroy-on-close>
    <section class="details-section">
      <div class="details-header"><div><h2>{{ selectedMonth }} 工资明细 · {{ details.length }}人</h2><p>勾选未发完的记录可批量登记；登记后仍可逐条编辑工资或修正已发金额。</p></div><div class="detail-actions"><el-button type="primary" :disabled="batchSaving || loading" @click="openEditor()">新增工资明细</el-button><el-button :disabled="batchSaving" @click="importOpen=true">导入与审核</el-button><el-button type="primary" :disabled="!selectedRows.length || batchSaving || loading" :loading="batchSaving" @click="saveBatchPayment">批量登记发放{{ selectedRows.length ? `（${selectedRows.length}条）` : '' }}</el-button><el-select v-model="selectedMonth" :disabled="batchSaving" aria-label="明细月份" style="width:130px"><el-option v-for="month in months" :key="month.month" :value="month.month" :label="`${month.label}（${month.count}人）`" /></el-select><el-switch v-model="contributionDetails" active-text="工资与缴费明细" /><el-button :disabled="!details.length" @click="exportMonth">导出本月</el-button></div></div>
      <el-table v-loading="loading" :data="details" empty-text="本月暂无记录，可点击新增一条，或导入工资表。" class="salary-details" max-height="60vh" @selection-change="value => selectedRows=value">
        <el-table-column type="selection" width="44" fixed :selectable="selectable" />
        <el-table-column prop="person_name" label="姓名" width="90" fixed /><el-table-column prop="company_name" label="公司" width="180" show-overflow-tooltip /><el-table-column v-if="contributionDetails" prop="department" label="部门" min-width="90" />
        <el-table-column label="基本工资" width="105" align="right"><template #default="{row}">{{ money(row.base) }}</template></el-table-column>
        <el-table-column v-if="contributionDetails" label="单位缴费"><el-table-column v-for="field in employerFields" :key="field[0]" :label="field[1]" width="105" align="right"><template #default="{row}">{{ row.employer_items?.[field[0]] == null ? '—' : money(row.employer_items[field[0]]) }}</template></el-table-column></el-table-column>
        <el-table-column v-if="contributionDetails" label="单位缴费合计" width="115" align="right"><template #default="{row}">{{ money(row.employer) }}</template></el-table-column>
        <el-table-column v-if="contributionDetails" label="个人缴费"><el-table-column v-for="field in employeeFields" :key="field[0]" :label="field[1]" width="105" align="right"><template #default="{row}">{{ row.employee_items?.[field[0]] == null ? '—' : money(row.employee_items[field[0]]) }}</template></el-table-column></el-table-column>
        <el-table-column v-if="contributionDetails" label="个人缴费合计" width="115" align="right"><template #default="{row}">{{ money(row.employee) }}</template></el-table-column><el-table-column v-if="contributionDetails" label="个税" width="95" align="right"><template #default="{row}">{{ money(row.tax) }}</template></el-table-column>
        <el-table-column label="员工实发工资" width="120" align="right"><template #default="{row}">{{ money(row.net) }}</template></el-table-column>
        <el-table-column label="公司人工总支出" width="130" align="right"><template #default="{row}"><strong>{{ money(companyCost(row)) }}</strong></template></el-table-column>
        <el-table-column label="已发金额" width="110" align="right"><template #default="{row}">{{ money(row.paid_amount) }}</template></el-table-column>
        <el-table-column label="未发差额" width="110" align="right"><template #default="{row}">{{ money(row.remaining_amount) }}</template></el-table-column>
        <el-table-column label="入账状态" width="100"><template #default="{row}">{{ row.approval_status==='approved'?'已入账':Number(row.paid_amount||0)>0?'已发待归档':row.cost_confirmed?'已确认待归档':'待确认入账' }}</template></el-table-column>
        <el-table-column label="操作" width="370" fixed="right"><template #default="{row}"><el-button v-if="row.approval_status==='pending'" type="primary" link :disabled="batchSaving" @click="reviewSubmissionId=row.submission_id">核对并入账</el-button><el-button type="primary" link :disabled="batchSaving" :aria-label="`编辑${row.person_name}工资明细`" @click="openEditor(row)">编辑</el-button><el-button type="primary" link :disabled="batchSaving" @click="openEditor(row,true)">复制新增</el-button><el-button type="primary" link :disabled="batchSaving" :aria-label="`登记${row.person_name}已发金额`" @click="openPayment(row)">登记发放</el-button><el-button type="danger" link :disabled="batchSaving" @click="deleteItem(row)">删除</el-button></template></el-table-column>
      </el-table>
      <p v-if="contributionDetails && details.some(row => !row.employer_items)" class="ledger-note">部分旧导入记录未保存缴费分项，以“—”显示，合计金额仍保留。</p>
    </section>
    </el-dialog>
    <FinanceImportPanel v-if="reviewSubmissionId" kind="payroll" :submission-id="reviewSubmissionId" @closed="reviewSubmissionId=null" @changed="load"/>
    <PayrollItemEditor v-model="editorOpen" :row="editingRow" :copy="copyingRow" :companies="companies" :company-id="companyId" :month="selectedMonth" @saved="handleItemSaved" />
    <el-dialog v-model="paymentOpen" title="登记已发金额" width="min(94vw, 440px)" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" destroy-on-close><template v-if="paymentRow"><p>{{ paymentRow.company_name }} · {{ paymentRow.person_name }}</p><p>{{ paymentRow.month }} · 表内实发工资 ¥{{ money(paymentRow.net) }}</p><el-form label-position="top" @submit.prevent="savePayment"><el-form-item label="累计已发金额（元）"><el-input-number v-model="paidAmount" :min="0" :precision="2" :max="100000000" :disabled="saving" /><el-button :disabled="saving" @click="paidAmount=Number(paymentRow.net)">填入全部工资</el-button></el-form-item><p class="ledger-note">保存只登记发放记录，不会执行银行转账。</p><p>未发差额：¥{{ money((cents(paymentRow.net)-cents(paidAmount))/100) }}</p></el-form></template><template #footer><el-button :disabled="saving" @click="paymentOpen=false">取消</el-button><el-button type="primary" :loading="saving" :disabled="paidAmount==null" @click="savePayment">保存</el-button></template></el-dialog>
    <el-dialog v-model="importOpen" title="工资表导入与审核" width="min(94vw, 1200px)" destroy-on-close><FinanceImportPanel v-if="importOpen" kind="payroll" :month="selectedMonth" :company-id="companyId" @changed="load" /></el-dialog>
  </div>
</template>

<style scoped>
.payroll-ledger{display:grid;gap:14px;width:100%;min-width:0;margin:0;box-sizing:border-box}
.ledger-header,.ledger-filters,.details-header,.detail-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.ledger-header h1{font-size:22px;margin:0;font-weight:650}
.ledger-header p,.details-header p{color:var(--el-text-color-secondary);font-size:13px;margin:6px 0 0}
.ledger-filters{justify-content:flex-start;flex-wrap:wrap}.ledger-filters :deep(.el-date-editor){width:130px}.ledger-filters :deep(.el-select){width:280px}
.ledger-section{min-width:0;overflow:hidden;padding:16px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:10px}
.ledger-totals{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;padding:0 0 12px}
.ledger-totals>div{display:grid;gap:6px}.ledger-totals span{font-size:12px;color:var(--el-text-color-secondary)}.ledger-totals strong{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
.month-ledger,.salary-details{width:100%;min-width:0}.month-ledger :deep(.el-table__row){cursor:pointer}.month-ledger :deep(.selected-month){--el-table-tr-bg-color:var(--el-color-primary-light-9)}
.month-ledger :deep(.el-table__cell),.salary-details :deep(.el-table__cell){padding:7px 0;font-variant-numeric:tabular-nums}.month-ledger :deep(.cell),.salary-details :deep(.cell){padding:0 8px}
.details-header{margin-bottom:14px;flex-wrap:wrap}.details-header h2{font-size:17px;margin:0;font-weight:600}.ledger-note{font-size:12px;color:var(--el-text-color-secondary);margin:12px 0 0}.cost-note{margin:0 0 12px}.detail-actions{justify-content:flex-end;flex-wrap:wrap}
@media(max-width:1100px){.ledger-totals{grid-template-columns:repeat(3,minmax(0,1fr))}.ledger-totals strong{font-size:19px}}
@media(max-width:720px){.ledger-header,.ledger-filters{flex-wrap:wrap}.ledger-section{padding:12px}.ledger-totals{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ledger-totals strong{font-size:18px}.ledger-filters :deep(.el-select){width:230px}}
</style>
