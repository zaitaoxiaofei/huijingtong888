<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Check, Download, DocumentAdd, Link, Lock, Plus, Refresh, Upload, Warning } from "@element-plus/icons-vue";
import { apiClient, getAuthToken } from "../../utils/api";
import { shanghaiDateKey, shanghaiDateText, shanghaiDateTimeText } from "../../utils/shanghai-date";
import ErpPageHeader from "../../components/ErpPageHeader.vue";

const loading = ref(false);
const saving = ref(false);
const activeTab = ref("report");
const companiesData = ref({ companies: [], assignments: [], shops: [] });
const report = ref({ metrics: {}, rows: [], shops: [], quality: {}, period: {} });
const expenses = ref([]);
const vouchers = ref([]);
const platformItems = ref([]);
const uploadingVoucher = ref(false);
const companyId = ref("");
const month = ref(beijingMonth());
const expenseDialog = ref(false);
const voucherDialog = ref(false);
const companyDialog = ref(false);
const assignmentDialog = ref(false);

const expenseForm = reactive({ company_id: "", shop_id: "", expense_date: beijingDate(), category: "office", counterparty: "", description: "", currency_code: "CNY", original_amount: 0, exchange_rate: 1, amount_cny: 0, payment_reference: "", voucher_status: "missing" });
const voucherForm = reactive({ company_id: "", expense_id: "", finance_item_id: "", voucher_type: "invoice", voucher_number: "", issue_date: beijingDate(), seller_name: "", buyer_name: "", seller_tax_number: "", buyer_tax_number: "", currency_code: "CNY", total_amount: 0, tax_amount: 0, attachment_url: "", attachment_name: "", deduction_candidate: "review", review_status: "pending", review_note: "" });
const companyForm = reactive({ id: "", name: "", tax_number: "", taxpayer_type: "unknown", bank_name: "", bank_account: "" });
const assignmentForm = reactive({ shop_id: "", company_id: "", effective_from: beijingDate() });

const selectedCompany = computed(() => companiesData.value.companies.find((item) => String(item.id) === String(companyId.value)) || null);
const scopedShops = computed(() => report.value.shops || []);
const periodClosed = computed(() => report.value.period?.status === "closed");
const checklist = computed(() => [
  { label: "公司已有归属店铺", ok: scopedShops.value.length > 0 },
  { label: "Ozon 财务流水已归集", ok: Number(report.value.quality?.finance_rows || 0) > 0 },
  { label: "所有费用凭证已处理", ok: Number(report.value.quality?.missing_vouchers || 0) === 0 },
  { label: "财务期间尚未关账", ok: !periodClosed.value }
]);

const headlineMetrics = computed(() => [
  { label: "确认收入", value: money(report.value.metrics?.revenue), note: "优先采用 Ozon 销售计提", tone: "neutral" },
  { label: "经营利润", value: money(report.value.metrics?.operating_profit), note: `利润率 ${percent(report.value.metrics?.operating_margin)}`, tone: Number(report.value.metrics?.operating_profit || 0) >= 0 ? "positive" : "negative" },
  { label: "结算净流入", value: money(report.value.metrics?.net_settlement_cashflow), note: "本月平台流水净额，不等于利润", tone: "neutral" },
  { label: "待处理事项", value: `${actionItems.value.length} 项`, note: actionItems.value.length ? "会影响报表可信度或关账" : "本月数据检查已通过", tone: actionItems.value.length ? "warning" : "positive" }
]);
const costItems = computed(() => (report.value.rows || []).filter((item) => item.key !== "revenue"));
const maxCost = computed(() => Math.max(1, ...costItems.value.map((item) => Number(item.amount || 0))));
const actionItems = computed(() => {
  const items = [];
  if (!scopedShops.value.length) items.push({ title: "公司尚未绑定店铺", detail: "当前报表无法归集业务数据", tab: "companies", action: "去绑定" });
  if (!Number(report.value.quality?.finance_rows || 0)) items.push({ title: "缺少 Ozon 财务流水", detail: "收入暂可能回退为订单销售额", action: "检查同步" });
  if (Number(report.value.quality?.missing_cost_items || 0) > 0) items.push({ title: `${report.value.quality.missing_cost_items} 个订单商品缺成本`, detail: "经营利润会被高估", action: "补成本" });
  if (Number(report.value.quality?.missing_vouchers || 0) > 0) items.push({ title: `${report.value.quality.missing_vouchers} 项凭证待处理`, detail: "凭证不完整，暂不能关账", tab: "vouchers", action: "去处理" });
  return items;
});

function beijingDate() { return shanghaiDateKey(); }
function beijingMonth() { return beijingDate().slice(0, 7); }
function money(value) { return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
function signedMoney(value) { const amount = Number(value || 0); return `${amount > 0 ? "+" : ""}${money(amount)}`; }
function goAction(item) { if (item.tab) activeTab.value = item.tab; else ElMessage.info("请先在数据同步中心更新 Ozon 财务流水"); }
function dateText(value) { return shanghaiDateText(value); }
function dateTimeText(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }
function statusLabel(value) { return ({ preparing: "数据准备中", pending_vouchers: "待补凭证", reviewing: "待复核", ready: "可关账", closed: "已关账", missing: "缺凭证", matched: "已匹配", pending: "待审核", approved: "已通过", supplement: "需补充", rejected: "不合格" })[value] || value || "-"; }
function statusType(value) { return ["closed", "matched", "approved"].includes(value) ? "success" : ["rejected"].includes(value) ? "danger" : ["supplement", "missing"].includes(value) ? "warning" : "info"; }

async function loadCompanies() {
  companiesData.value = await apiClient.get("/api/finance-center/companies", { noCache: true });
  if (!companyId.value && companiesData.value.companies.length) companyId.value = String(companiesData.value.companies[0].id);
}
async function loadAll() {
  if (!companyId.value) return;
  loading.value = true;
  try {
    const query = `company_id=${encodeURIComponent(companyId.value)}&month=${encodeURIComponent(month.value)}`;
    const [nextReport, nextExpenses, nextVouchers, nextPlatformItems] = await Promise.all([
      apiClient.get(`/api/finance-center/report?${query}`, { noCache: true }),
      apiClient.get(`/api/finance-center/expenses?${query}`, { noCache: true }),
      apiClient.get(`/api/finance-center/vouchers?${query}`, { noCache: true }),
      apiClient.get(`/api/finance-center/platform-items?${query}`, { noCache: true })
    ]);
    report.value = nextReport;
    expenses.value = nextExpenses;
    vouchers.value = nextVouchers;
    platformItems.value = nextPlatformItems;
  } catch (error) { ElMessage.error(error.message || "财务数据加载失败"); }
  finally { loading.value = false; }
}
function openExpense(row = null) {
  Object.assign(expenseForm, { id: row?.id || "", company_id: companyId.value, shop_id: row?.shop_id || "", expense_date: row?.expense_date?.slice?.(0, 10) || beijingDate(), category: row?.category || "office", counterparty: row?.counterparty || "", description: row?.description || "", currency_code: row?.currency_code || "CNY", original_amount: Number(row?.original_amount || 0), exchange_rate: Number(row?.exchange_rate || 1), amount_cny: Number(row?.amount_cny || 0), payment_reference: row?.payment_reference || "", voucher_status: row?.voucher_status || "missing" });
  expenseDialog.value = true;
}
function openVoucher(row = null) {
  Object.assign(voucherForm, { id: row?.id || "", company_id: companyId.value, expense_id: row?.expense_id || "", finance_item_id: row?.finance_item_id || "", voucher_type: row?.voucher_type || "invoice", voucher_number: row?.voucher_number || "", issue_date: row?.issue_date?.slice?.(0, 10) || beijingDate(), seller_name: row?.seller_name || "", buyer_name: row?.buyer_name || selectedCompany.value?.name || "", seller_tax_number: row?.seller_tax_number || "", buyer_tax_number: row?.buyer_tax_number || selectedCompany.value?.tax_number || "", currency_code: row?.currency_code || "CNY", total_amount: Number(row?.total_amount || 0), tax_amount: Number(row?.tax_amount || 0), attachment_url: row?.attachment_url || "", attachment_name: row?.attachment_url ? row.attachment_url.split('/').pop() : "", deduction_candidate: row?.deduction_candidate || "review", review_status: row?.review_status || "pending", review_note: row?.review_note || "" });
  voucherDialog.value = true;
}
async function saveExpense() { saving.value = true; try { await apiClient.post("/api/finance-center/expenses", expenseForm); expenseDialog.value = false; ElMessage.success("费用已保存"); await loadAll(); } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; } }
async function removeExpense(row) { await ElMessageBox.confirm(`确认删除费用“${row.description || row.category}”？`, "删除费用", { type: "warning" }); await apiClient.delete(`/api/finance-center/expenses/${row.id}`); ElMessage.success("费用已删除"); await loadAll(); }
async function saveVoucher() { saving.value = true; try { await apiClient.post("/api/finance-center/vouchers", voucherForm); voucherDialog.value = false; ElMessage.success("凭证已保存"); await loadAll(); } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; } }
async function uploadVoucherFile(options) {
  uploadingVoucher.value = true;
  try {
    const form = new FormData(); form.append("file", options.file);
    const token = getAuthToken();
    const response = await fetch("/api/finance-center/voucher-attachments", { method: "POST", body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || "凭证附件上传失败");
    voucherForm.attachment_url = data.url; voucherForm.attachment_name = data.name || options.file.name;
    options.onSuccess?.(data); ElMessage.success("凭证文件已上传");
  } catch (error) { options.onError?.(error); ElMessage.error(error.message); }
  finally { uploadingVoucher.value = false; }
}
function openAttachment(url) { if (url) window.open(url, "_blank", "noopener,noreferrer"); }
async function exportReport() {
  try {
    const query = `company_id=${encodeURIComponent(companyId.value)}&month=${encodeURIComponent(month.value)}`;
    const response = await apiClient.blobResponse(`/api/finance-center/export?${query}`);
    const href = URL.createObjectURL(response.blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = `财务报账-${selectedCompany.value?.name || companyId.value}-${month.value}.xls`; anchor.click(); URL.revokeObjectURL(href);
    ElMessage.success("月度报账包已导出");
  } catch (error) { ElMessage.error(error.message || "导出失败"); }
}
function openCompany(row = null) { Object.assign(companyForm, { id: row?.id || "", name: row?.name || "", tax_number: row?.tax_number || "", taxpayer_type: row?.taxpayer_type || "unknown", bank_name: row?.bank_name || "", bank_account: row?.bank_account || "" }); companyDialog.value = true; }
async function saveCompany() { await apiClient.post("/api/finance-center/companies", companyForm); companyDialog.value = false; await loadCompanies(); ElMessage.success("公司档案已保存"); }
function openAssignment() { Object.assign(assignmentForm, { shop_id: "", company_id: companyId.value, effective_from: beijingDate() }); assignmentDialog.value = true; }
async function saveAssignment() { await apiClient.post("/api/finance-center/shop-assignments", assignmentForm); assignmentDialog.value = false; await loadCompanies(); await loadAll(); ElMessage.success("店铺归属已更新"); }
async function closePeriod() { await ElMessageBox.confirm(`确认关账 ${selectedCompany.value?.name} ${month.value}？关账后本期数据应停止日常调整。`, "月度关账", { type: "warning", confirmButtonText: "确认关账" }); try { await apiClient.post("/api/finance-center/close", { company_id: companyId.value, month: month.value }); ElMessage.success("本月已关账"); await loadAll(); } catch (e) { ElMessage.error(e.message); } }

watch([companyId, month], loadAll);
onMounted(async () => { await loadCompanies(); await loadAll(); });
</script>

<template>
  <section class="finance-center" v-loading="loading">
    <ErpPageHeader title="财务中心" description="公司经营数据、费用凭证与月度关账">
      <template #actions>
        <div class="finance-scope">
        <el-select v-model="companyId" aria-label="公司主体" class="company-select"><el-option v-for="item in companiesData.companies" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select>
        <el-date-picker v-model="month" type="month" value-format="YYYY-MM" format="YYYY年MM月" aria-label="会计月份" />
        <el-button :icon="Refresh" circle title="刷新财务数据" @click="loadAll" />
        <el-tag :type="periodClosed ? 'success' : 'warning'" effect="plain">{{ statusLabel(report.period?.status) }}</el-tag>
        </div>
      </template>
    </ErpPageHeader>

    <el-tabs v-model="activeTab" class="finance-tabs">
      <el-tab-pane label="经营总览" name="report">
        <div class="overview-intro">
          <div><span class="eyebrow">{{ selectedCompany?.name || '请选择公司' }}</span><h2>{{ month }} 经营结果</h2><p>按公司历史店铺归属汇总；利润采用权责口径，结算净流入采用平台流水口径。</p></div>
          <div class="overview-actions"><el-button :icon="Download" @click="exportReport">导出报账包</el-button><el-button type="primary" :icon="DocumentAdd" @click="openVoucher()">登记凭证</el-button></div>
        </div>
        <div class="headline-grid">
          <article v-for="item in headlineMetrics" :key="item.label" :class="['headline-card', item.tone]"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article>
        </div>
        <div class="overview-grid">
          <section class="panel profit-panel">
            <div class="panel-heading"><div><h3>利润构成</h3><p>从确认收入到经营利润，点击费用与凭证页可追溯明细</p></div><el-tag effect="plain">权责口径</el-tag></div>
            <div class="profit-equation"><span>确认收入 <b>{{ money(report.metrics?.revenue) }}</b></span><i>−</i><span>全部成本 <b>{{ money(report.metrics?.total_costs) }}</b></span><i>=</i><span class="profit-result">经营利润 <b>{{ money(report.metrics?.operating_profit) }}</b></span></div>
            <div class="cost-list"><div v-for="item in costItems" :key="item.key" class="cost-row"><span>{{ item.label }}</span><div class="cost-track"><i :style="{ width: `${Math.max(2, Number(item.amount || 0) / maxCost * 100)}%` }" /></div><b>{{ money(item.amount) }}</b></div></div>
          </section>
          <section class="panel reconciliation-panel">
            <div class="panel-heading"><div><h3>收入对账</h3><p>订单发生与平台结算存在时间差，差异不直接等于异常</p></div><el-tag :type="Math.abs(Number(report.metrics?.revenue_variance_rate || 0)) > 0.05 ? 'warning' : 'success'" effect="plain">差异 {{ percent(report.metrics?.revenue_variance_rate) }}</el-tag></div>
            <dl class="reconciliation-list"><div><dt>订单销售额</dt><dd>{{ money(report.metrics?.order_revenue) }}</dd></div><div><dt>平台销售计提</dt><dd>{{ money(report.metrics?.settlement_revenue) }}</dd></div><div class="variance"><dt>计提与订单差异</dt><dd>{{ signedMoney(report.metrics?.revenue_variance) }}</dd></div><div><dt>平台结算净流入</dt><dd>{{ money(report.metrics?.net_settlement_cashflow) }}</dd></div></dl>
            <p class="definition-note">确认收入优先使用平台销售计提；无平台流水时才回退至订单销售额。结算净流入包含平台扣款，不作为利润替代值。</p>
          </section>
          <section class="panel quality-panel">
            <div class="panel-heading"><div><h3>数据可信度</h3><p>先看完整性，再看利润</p></div><span class="sync-time">最近财务同步：{{ dateTimeText(report.quality?.last_finance_sync_at) }}</span></div>
            <div class="quality-list"><div><span>订单成本覆盖</span><el-progress :percentage="Math.round(Number(report.metrics?.cost_coverage || 0) * 100)" :stroke-width="8" /></div><div><span>凭证金额覆盖</span><el-progress :percentage="Math.round(Number(report.metrics?.voucher_coverage || 0) * 100)" :stroke-width="8" /></div></div>
            <div class="fact-strip"><span>有效订单 <b>{{ report.metrics?.effective_orders || 0 }}</b></span><span>取消订单 <b>{{ report.metrics?.cancelled_orders || 0 }}</b></span><span>退货/拒收 <b>{{ report.metrics?.return_orders || 0 }}</b></span><span>财务流水 <b>{{ report.quality?.finance_rows || 0 }}</b></span></div>
          </section>
          <section class="panel action-panel">
            <div class="panel-heading"><div><h3>本月待办</h3><p>影响真实性与关账的事项</p></div><el-tag :type="actionItems.length ? 'warning' : 'success'">{{ actionItems.length ? `${actionItems.length} 项` : '已完成' }}</el-tag></div>
            <el-empty v-if="!actionItems.length" description="暂无待处理事项" :image-size="64" />
            <div v-else class="action-list"><button v-for="item in actionItems" :key="item.title" type="button" @click="goAction(item)"><el-icon><Warning /></el-icon><span><b>{{ item.title }}</b><small>{{ item.detail }}</small></span><em>{{ item.action }} →</em></button></div>
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="费用管理" name="expenses">
        <div class="section-toolbar"><div><h2>人工费用</h2><p>录入房租、工资、软件、办公、差旅及银行手续费等非平台费用</p></div><el-button type="primary" :icon="Plus" @click="openExpense()">新增费用</el-button></div>
        <el-table :data="expenses" stripe class="finance-table">
          <el-table-column prop="expense_date" label="发生日期" width="120"><template #default="{ row }">{{ dateText(row.expense_date) }}</template></el-table-column><el-table-column prop="category" label="类别" width="130" /><el-table-column prop="shop_name" label="店铺" width="100"><template #default="{ row }">{{ row.shop_name || '公司共用' }}</template></el-table-column><el-table-column prop="counterparty" label="对方单位" min-width="160" /><el-table-column prop="description" label="说明" min-width="200" /><el-table-column label="人民币金额" width="140" align="right"><template #default="{ row }">{{ money(row.amount_cny) }}</template></el-table-column><el-table-column label="凭证" width="110"><template #default="{ row }"><el-tag :type="statusType(row.voucher_status)">{{ statusLabel(row.voucher_status) }}</el-tag></template></el-table-column><el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openExpense(row)">编辑</el-button><el-button link type="danger" @click="removeExpense(row)">删除</el-button></template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="凭证中心" name="vouchers">
        <div class="section-toolbar"><div><h2>凭证台账</h2><p>登记发票、平台账单、合同、付款记录及其他法律凭证</p></div><el-button type="primary" :icon="Plus" @click="openVoucher()">登记凭证</el-button></div>
        <el-alert title="系统仅提供凭证完整性与抵扣候选提示，最终税务处理应由财务人员审核确认。" type="info" :closable="false" show-icon />
        <el-table :data="vouchers" stripe class="finance-table voucher-table"><el-table-column prop="voucher_type" label="类型" width="120" /><el-table-column prop="voucher_number" label="凭证号码" min-width="150" /><el-table-column prop="seller_name" label="开具方" min-width="180" /><el-table-column label="关联业务" min-width="180"><template #default="{ row }">{{ row.expense_description || row.finance_item_name || '未关联' }}</template></el-table-column><el-table-column label="金额" width="140" align="right"><template #default="{ row }">{{ money(row.total_amount) }}</template></el-table-column><el-table-column label="税额" width="120" align="right"><template #default="{ row }">{{ money(row.tax_amount) }}</template></el-table-column><el-table-column label="税务提示" width="150"><template #default="{ row }">{{ row.deduction_candidate === 'vat' ? '进项抵扣候选' : row.deduction_candidate === 'expense' ? '费用凭证候选' : row.deduction_candidate === 'supporting' ? '仅辅助材料' : '待财务判断' }}</template></el-table-column><el-table-column label="审核状态" width="110"><template #default="{ row }"><el-tag :type="statusType(row.review_status)">{{ statusLabel(row.review_status) }}</el-tag></template></el-table-column><el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button v-if="row.attachment_url" link :icon="Link" @click="openAttachment(row.attachment_url)">附件</el-button><el-button link type="primary" @click="openVoucher(row)">审核</el-button></template></el-table-column></el-table>
      </el-tab-pane>

      <el-tab-pane label="公司与店铺" name="companies">
        <div class="section-toolbar"><div><h2>公司主体</h2><p>店铺采用历史归属，归属调整不会覆盖已发生月份</p></div><div><el-button @click="openAssignment">绑定店铺</el-button><el-button type="primary" :icon="Plus" @click="openCompany()">新增公司</el-button></div></div>
        <el-table :data="companiesData.companies" stripe class="finance-table"><el-table-column prop="name" label="公司名称" min-width="260" /><el-table-column prop="tax_number" label="统一社会信用代码" min-width="190" /><el-table-column prop="taxpayer_type" label="纳税人类型" width="140" /><el-table-column prop="bank_name" label="开户行" min-width="180" /><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openCompany(row)">编辑</el-button></template></el-table-column></el-table>
        <h3 class="subheading">店铺归属记录</h3>
        <el-table :data="companiesData.assignments" stripe class="finance-table"><el-table-column prop="shop_name" label="店铺" width="120" /><el-table-column prop="company_name" label="所属公司" min-width="260" /><el-table-column label="生效日期" width="140"><template #default="{ row }">{{ dateText(row.effective_from) }}</template></el-table-column><el-table-column label="结束日期" width="140"><template #default="{ row }">{{ row.effective_to ? dateText(row.effective_to) : '当前' }}</template></el-table-column></el-table>
      </el-tab-pane>

      <el-tab-pane label="月度关账" name="close">
        <div class="closing-layout"><div><h2>{{ selectedCompany?.name }} · {{ month }}</h2><p>完成全部检查后锁定本会计期间。</p><div class="check-list"><div v-for="item in checklist" :key="item.label" :class="['check-row', { ok: item.ok }]"><el-icon><Check v-if="item.ok" /><Lock v-else /></el-icon><span>{{ item.label }}</span><b>{{ item.ok ? '通过' : '待处理' }}</b></div></div></div><div class="close-action"><el-tag :type="periodClosed ? 'success' : 'warning'" size="large">{{ statusLabel(report.period?.status) }}</el-tag><p>关账操作会记录操作人及北京时间。存在待处理凭证时不能关账。</p><el-button type="primary" size="large" :icon="Lock" :disabled="periodClosed" @click="closePeriod">{{ periodClosed ? '本月已关账' : '确认月度关账' }}</el-button></div></div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="expenseDialog" :title="expenseForm.id ? '编辑费用' : '新增费用'" width="640px"><el-form label-position="top"><div class="form-grid"><el-form-item label="发生日期"><el-date-picker v-model="expenseForm.expense_date" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="费用类别"><el-select v-model="expenseForm.category"><el-option v-for="item in [['office','办公'],['salary','工资'],['rent','房租'],['software','软件'],['travel','差旅'],['bank','银行手续费'],['domestic_logistics','国内物流'],['other','其他']]" :key="item[0]" :value="item[0]" :label="item[1]" /></el-select></el-form-item><el-form-item label="归属店铺"><el-select v-model="expenseForm.shop_id" clearable placeholder="公司共用"><el-option v-for="item in scopedShops" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="对方单位"><el-input v-model="expenseForm.counterparty" /></el-form-item><el-form-item label="原币金额"><el-input-number v-model="expenseForm.original_amount" :precision="2" :min="0" /></el-form-item><el-form-item label="币种"><el-select v-model="expenseForm.currency_code"><el-option label="人民币 CNY" value="CNY" /><el-option label="俄罗斯卢布 RUB" value="RUB" /><el-option label="美元 USD" value="USD" /></el-select></el-form-item><el-form-item label="汇率"><el-input-number v-model="expenseForm.exchange_rate" :precision="6" :min="0" /></el-form-item><el-form-item label="人民币金额"><el-input-number v-model="expenseForm.amount_cny" :precision="2" :min="0" /></el-form-item></div><el-form-item label="费用说明"><el-input v-model="expenseForm.description" type="textarea" :rows="2" /></el-form-item><el-form-item label="付款流水/回单编号"><el-input v-model="expenseForm.payment_reference" /></el-form-item></el-form><template #footer><el-button @click="expenseDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveExpense">保存</el-button></template></el-dialog>

    <el-dialog v-model="voucherDialog" title="登记与审核凭证" width="760px"><el-form label-position="top"><div class="form-grid"><el-form-item label="凭证类型"><el-select v-model="voucherForm.voucher_type"><el-option label="发票" value="invoice" /><el-option label="平台账单" value="platform_statement" /><el-option label="合同" value="contract" /><el-option label="付款记录" value="payment" /><el-option label="其他" value="other" /></el-select></el-form-item><el-form-item label="关联人工费用"><el-select v-model="voucherForm.expense_id" clearable filterable><el-option v-for="item in expenses" :key="item.id" :label="`${item.description || item.category} · ${money(item.amount_cny)}`" :value="item.id" /></el-select></el-form-item><el-form-item class="wide-field" label="关联 Ozon 平台流水"><el-select v-model="voucherForm.finance_item_id" clearable filterable><el-option v-for="item in platformItems" :key="item.id" :label="`${item.shop_name} · ${item.item_name} · ${money(Math.abs(Number(item.amount_cny || 0)))}`" :value="item.id" /></el-select></el-form-item><el-form-item label="凭证号码"><el-input v-model="voucherForm.voucher_number" /></el-form-item><el-form-item label="开具日期"><el-date-picker v-model="voucherForm.issue_date" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="开具方"><el-input v-model="voucherForm.seller_name" /></el-form-item><el-form-item label="购买方"><el-input v-model="voucherForm.buyer_name" /></el-form-item><el-form-item label="开具方税号"><el-input v-model="voucherForm.seller_tax_number" /></el-form-item><el-form-item label="购买方税号"><el-input v-model="voucherForm.buyer_tax_number" /></el-form-item><el-form-item label="含税金额"><el-input-number v-model="voucherForm.total_amount" :precision="2" :min="0" /></el-form-item><el-form-item label="税额"><el-input-number v-model="voucherForm.tax_amount" :precision="2" :min="0" /></el-form-item><el-form-item label="税务提示"><el-select v-model="voucherForm.deduction_candidate"><el-option label="待财务判断" value="review" /><el-option label="进项抵扣候选" value="vat" /><el-option label="费用凭证候选" value="expense" /><el-option label="仅辅助材料" value="supporting" /></el-select></el-form-item><el-form-item label="审核状态"><el-select v-model="voucherForm.review_status"><el-option label="待审核" value="pending" /><el-option label="已通过" value="approved" /><el-option label="需补充" value="supplement" /><el-option label="不合格" value="rejected" /></el-select></el-form-item></div><el-form-item label="凭证文件"><div class="voucher-upload"><el-upload :show-file-list="false" :http-request="uploadVoucherFile" accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.zip,.ppt,.pptx,.jpg,.jpeg,.png"><el-button :icon="Upload" :loading="uploadingVoucher">上传凭证</el-button></el-upload><span v-if="voucherForm.attachment_name">{{ voucherForm.attachment_name }}</span><el-button v-if="voucherForm.attachment_url" link :icon="Link" @click="openAttachment(voucherForm.attachment_url)">查看</el-button></div></el-form-item><el-form-item label="外部归档地址"><el-input v-model="voucherForm.attachment_url" placeholder="也可以填写文件服务器、网盘或归档系统地址" /></el-form-item><el-form-item label="审核意见"><el-input v-model="voucherForm.review_note" type="textarea" :rows="2" /></el-form-item></el-form><template #footer><el-button @click="voucherDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveVoucher">保存凭证</el-button></template></el-dialog>

    <el-dialog v-model="companyDialog" title="公司档案" width="620px"><el-form label-position="top"><el-form-item label="公司全称"><el-input v-model="companyForm.name" /></el-form-item><div class="form-grid"><el-form-item label="统一社会信用代码"><el-input v-model="companyForm.tax_number" /></el-form-item><el-form-item label="纳税人类型"><el-select v-model="companyForm.taxpayer_type"><el-option label="待确认" value="unknown" /><el-option label="一般纳税人" value="general" /><el-option label="小规模纳税人" value="small" /></el-select></el-form-item><el-form-item label="开户行"><el-input v-model="companyForm.bank_name" /></el-form-item><el-form-item label="银行账号"><el-input v-model="companyForm.bank_account" /></el-form-item></div></el-form><template #footer><el-button @click="companyDialog=false">取消</el-button><el-button type="primary" @click="saveCompany">保存</el-button></template></el-dialog>
    <el-dialog v-model="assignmentDialog" title="绑定店铺归属" width="520px"><el-form label-position="top"><el-form-item label="店铺"><el-select v-model="assignmentForm.shop_id"><el-option v-for="item in companiesData.shops" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="所属公司"><el-select v-model="assignmentForm.company_id"><el-option v-for="item in companiesData.companies" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-form-item label="生效日期"><el-date-picker v-model="assignmentForm.effective_from" value-format="YYYY-MM-DD" /></el-form-item></el-form><template #footer><el-button @click="assignmentDialog=false">取消</el-button><el-button type="primary" @click="saveAssignment">确认绑定</el-button></template></el-dialog>
  </section>
</template>

<style scoped>
.finance-center{padding:20px 24px 32px;color:#1f2937}.finance-header,.section-toolbar,.report-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px}.finance-header h1,.section-toolbar h2,.report-toolbar h2,.closing-layout h2{margin:0;font-size:22px;letter-spacing:0}.finance-header p,.section-toolbar p,.report-toolbar p,.closing-layout p{margin:5px 0 0;color:#6b7280}.finance-scope{display:flex;align-items:center;gap:10px}.company-select{width:310px}.finance-tabs{margin-top:18px}.overview-intro{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:8px 0 18px}.overview-intro h2{margin:4px 0 5px;font-size:26px}.overview-intro p,.panel-heading p{margin:0;color:#6b7280;font-size:13px}.eyebrow{color:#64748b;font-size:12px;font-weight:700;letter-spacing:.05em}.overview-actions{display:flex;gap:10px}.headline-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.headline-card{padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.03)}.headline-card span,.headline-card small{display:block;color:#64748b}.headline-card strong{display:block;margin:8px 0 6px;color:#0f172a;font-size:24px}.headline-card small{font-size:12px}.headline-card.positive{border-top:3px solid #10b981}.headline-card.negative{border-top:3px solid #ef4444}.headline-card.warning{border-top:3px solid #f59e0b}.overview-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(340px,.8fr);gap:14px;margin-top:14px}.panel{min-width:0;padding:20px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.panel-heading h3{margin:0 0 5px;font-size:16px}.profit-equation{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:12px;margin:20px 0;padding:14px 16px;border-radius:8px;background:#f8fafc}.profit-equation span{display:flex;flex-direction:column;color:#64748b;font-size:12px}.profit-equation b{margin-top:5px;color:#0f172a;font-size:16px}.profit-equation i{color:#94a3b8;font-style:normal}.profit-equation .profit-result b{color:#047857}.cost-list{display:grid;gap:11px}.cost-row{display:grid;grid-template-columns:112px minmax(80px,1fr) 112px;align-items:center;gap:12px;font-size:13px}.cost-row b{text-align:right}.cost-track{height:7px;overflow:hidden;border-radius:999px;background:#f1f5f9}.cost-track i{display:block;height:100%;border-radius:999px;background:#64748b}.reconciliation-list{margin:16px 0 0}.reconciliation-list div{display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid #f1f5f9}.reconciliation-list dt{color:#64748b}.reconciliation-list dd{margin:0;font-weight:700}.reconciliation-list .variance dd{color:#b45309}.definition-note{margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.65}.sync-time{color:#64748b;font-size:12px}.quality-list{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0}.quality-list span{display:block;margin-bottom:9px;font-size:13px}.fact-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.fact-strip span{padding:10px;border-radius:7px;background:#f8fafc;color:#64748b;font-size:12px}.fact-strip b{display:block;margin-top:4px;color:#0f172a;font-size:17px}.action-list{display:grid;margin-top:12px}.action-list button{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:9px;padding:13px 0;border:0;border-bottom:1px solid #f1f5f9;background:transparent;text-align:left;cursor:pointer}.action-list button:last-child{border-bottom:0}.action-list .el-icon{color:#d97706}.action-list span{display:flex;min-width:0;flex-direction:column}.action-list b{font-size:13px}.action-list small{margin-top:3px;color:#64748b}.action-list em{color:#2563eb;font-size:12px;font-style:normal}.report-toolbar,.section-toolbar{margin:22px 0 14px}.finance-table{width:100%;border-top:1px solid #e5e7eb}.voucher-table{margin-top:14px}.subheading{margin:28px 0 12px;font-size:16px;letter-spacing:0}.closing-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:46px;max-width:980px;padding:20px 0}.check-list{margin-top:24px;border-top:1px solid #e5e7eb}.check-row{display:grid;grid-template-columns:30px 1fr auto;align-items:center;min-height:56px;border-bottom:1px solid #e5e7eb;color:#9a3412}.check-row.ok{color:#047857}.check-row span{color:#374151}.close-action{padding-left:32px;border-left:1px solid #e5e7eb}.close-action p{margin:18px 0;line-height:1.7}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.form-grid :deep(.el-select),.form-grid :deep(.el-date-editor),.form-grid :deep(.el-input-number){width:100%}.wide-field{grid-column:1/-1}.voucher-upload{display:flex;align-items:center;gap:12px;min-height:32px;color:#4b5563;overflow:hidden}.voucher-upload span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:1100px){.headline-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-grid{grid-template-columns:1fr}.closing-layout{grid-template-columns:1fr}.close-action{padding-left:0;border-left:0}}@media(max-width:640px){.finance-center{padding:14px}.finance-scope{width:100%;flex-wrap:wrap}.overview-intro,.section-toolbar,.report-toolbar{align-items:flex-start;flex-direction:column}.headline-grid,.form-grid,.quality-list{grid-template-columns:1fr}.wide-field{grid-column:auto}.company-select{width:100%}.profit-equation{grid-template-columns:1fr}.profit-equation i{display:none}.cost-row{grid-template-columns:90px 1fr}.cost-row b{grid-column:2}.fact-strip{grid-template-columns:repeat(2,1fr)}}
</style>
