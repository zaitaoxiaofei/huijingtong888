<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Check, Lock, Plus, Refresh } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const saving = ref(false);
const activeTab = ref("statements");
const currentMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date());
const month = ref(currentMonth);
const companyId = ref("");
const setup = reactive({ people: [], companies: [], schemes: [], policies: [], profiles: [] });
const payroll = reactive({ period: null, rows: [], summary: {} });
const schemeDialog = ref(false);
const policyDialog = ref(false);
const profileDialog = ref(false);

const emptyRates = () => ({ pension: 0, medical: 0, supplementary_medical: 0, unemployment: 0, injury: 0, maternity: 0, housing_fund: 0 });
const SHANGHAI_CONTRIBUTION_PRESET = {
  name: "2026 上海（当前核算口径）", city_code: "shanghai", city_name: "上海",
  social_base_min: 7460, housing_base_min: 2690, effective_from: "2026-03-01",
  source_note: "按现有上海工资核算表配置；社保基数 7460，公积金下限 2690。政策调整后请新建版本，不覆盖历史。",
  employer_rates: { pension: 0.16, medical: 0.085, supplementary_medical: 0.005, unemployment: 0.005, injury: 0.004, maternity: 0, housing_fund: 0.05 },
  employee_rates: { pension: 0.08, medical: 0.02, supplementary_medical: 0, unemployment: 0.005, injury: 0, maternity: 0, housing_fund: 0.05 }
};
const schemeForm = reactive({ id: null, name: "", city_code: "shanghai", city_name: "上海", social_base_min: 0, housing_base_min: 0, effective_from: `${currentMonth}-01`, source_note: "", employer_rates: emptyRates(), employee_rates: emptyRates() });
const policyForm = reactive({ id: null, name: "", version_no: 1, effective_from: `${currentMonth}-01`, components: { position_allowance: 0, fixed_allowance: 0, attendance_bonus: 0, performance_bonus: 0, revenue_commission_rate: 0, profit_threshold: 0, profit_commission_rate: 0, quarterly_bonus: 0, annual_bonus: 0, other_earnings: 0 } });
const profileForm = reactive({ id: null, person_id: "", company_id: "", department: "", employment_city_code: "shanghai", contribution_scheme_id: "", policy_id: "", base_salary: 0, effective_from: `${currentMonth}-01` });

const money = (value) => `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (value) => `${(Number(value || 0) * 100).toFixed(2)}%`;
const statusText = (status) => ({ draft: "草稿", calculated: "已试算", approved: "已审核", locked: "已锁定" }[status] || "未生成");
const selectedCompany = computed(() => setup.companies.find((item) => Number(item.id) === Number(companyId.value)));
const canApprove = computed(() => payroll.period?.status === "calculated");
const canLock = computed(() => payroll.period?.status === "approved");

function replace(target, source) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);
}

async function loadSetup() {
  loading.value = true;
  try {
    const payload = await apiClient.get("/api/payroll/setup", { noCache: true });
    Object.assign(setup, payload || {});
    if (!companyId.value && setup.companies.length) companyId.value = String(setup.companies[0].id);
    await loadPeriod();
  } catch (error) {
    ElMessage.error(error.message || "工资模块数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadPeriod() {
  if (!companyId.value || !month.value) return;
  try {
    const payload = await apiClient.get(`/api/payroll/period?company_id=${companyId.value}&month=${month.value}`, { noCache: true });
    Object.assign(payroll, payload || { period: null, rows: [], summary: {} });
  } catch (error) {
    ElMessage.error(error.message || "工资单加载失败");
  }
}

function openScheme(row = null) {
  replace(schemeForm, row ? {
    id: row.id, name: row.name, city_code: row.city_code, city_name: row.city_name,
    social_base_min: Number(row.social_base_min), housing_base_min: Number(row.housing_base_min),
    effective_from: String(row.effective_from).slice(0, 10), source_note: row.source_note || "",
    employer_rates: { ...emptyRates(), ...(row.employer_rates || {}) }, employee_rates: { ...emptyRates(), ...(row.employee_rates || {}) }
  } : { id: null, name: "", city_code: "shanghai", city_name: "上海", social_base_min: 0, housing_base_min: 0, effective_from: `${month.value}-01`, source_note: "", employer_rates: emptyRates(), employee_rates: emptyRates() });
  schemeDialog.value = true;
}

function openPolicy(row = null) {
  replace(policyForm, row ? { id: row.id, name: row.name, version_no: Number(row.version_no), effective_from: String(row.effective_from).slice(0, 10), components: { ...policyForm.components, ...(row.components || {}) } } : {
    id: null, name: "", version_no: 1, effective_from: `${month.value}-01`, components: { position_allowance: 0, fixed_allowance: 0, attendance_bonus: 0, performance_bonus: 0, revenue_commission_rate: 0, profit_threshold: 0, profit_commission_rate: 0, quarterly_bonus: 0, annual_bonus: 0, other_earnings: 0 }
  });
  policyDialog.value = true;
}

function applyPolicyPreset(type) {
  const shared = { position_allowance: 0, fixed_allowance: 0, attendance_bonus: 0, performance_bonus: 0, revenue_commission_rate: 0, profit_threshold: 0, profit_commission_rate: 0, quarterly_bonus: 0, annual_bonus: 0, other_earnings: 0 };
  const preset = type === "store_operator"
    ? { name: "店铺运营", components: { ...shared, attendance_bonus: 200, profit_commission_rate: 0.01 } }
    : { name: "固定工资", components: shared };
  policyForm.name = preset.name;
  policyForm.components = preset.components;
}

function applyShanghaiContributionPreset() {
  replace(schemeForm, {
    id: schemeForm.id || null,
    ...SHANGHAI_CONTRIBUTION_PRESET,
    employer_rates: { ...SHANGHAI_CONTRIBUTION_PRESET.employer_rates },
    employee_rates: { ...SHANGHAI_CONTRIBUTION_PRESET.employee_rates }
  });
}

function openStoreOperatorPreset() {
  openPolicy();
  applyPolicyPreset("store_operator");
}

function openShanghaiSchemePreset() {
  openScheme();
  applyShanghaiContributionPreset();
}

function openProfile(row = null) {
  replace(profileForm, row ? {
    id: row.id, person_id: String(row.person_id), company_id: String(row.company_id), department: row.department || "",
    employment_city_code: row.employment_city_code, contribution_scheme_id: String(row.contribution_scheme_id), policy_id: String(row.policy_id),
    base_salary: Number(row.base_salary), effective_from: String(row.effective_from).slice(0, 10)
  } : { id: null, person_id: "", company_id: companyId.value, department: "", employment_city_code: "shanghai", contribution_scheme_id: "", policy_id: "", base_salary: 0, effective_from: `${month.value}-01` });
  profileDialog.value = true;
}

function closeSavedDialog(url) {
  if (url.endsWith("/profiles")) profileDialog.value = false;
  if (url.endsWith("/policies")) policyDialog.value = false;
  if (url.endsWith("/contribution-schemes")) schemeDialog.value = false;
}

async function save(url, form) {
  saving.value = true;
  try {
    await apiClient.post(url, form);
    closeSavedDialog(url);
    ElMessage.success("保存成功");
    await loadSetup();
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function calculate() {
  if (!companyId.value) return ElMessage.warning("请选择公司");
  try {
    await ElMessageBox.confirm(`确认重新试算 ${selectedCompany.value?.name || "当前公司"} ${month.value} 工资？`, "工资试算", { type: "warning" });
    loading.value = true;
    await apiClient.post("/api/payroll/calculate", { company_id: companyId.value, month: month.value });
    ElMessage.success("工资试算完成");
    await loadPeriod();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || "工资试算失败");
  } finally { loading.value = false; }
}

async function changeStatus(action) {
  const label = action === "approve" ? "审核" : "锁定";
  try {
    await ElMessageBox.confirm(`确认${label}本月工资？${action === "lock" ? "锁定后不能重新试算。" : ""}`, `${label}工资`, { type: "warning" });
    await apiClient.post("/api/payroll/period-status", { period_id: payroll.period.id, action });
    ElMessage.success(`${label}成功`);
    await loadPeriod();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || `${label}失败`);
  }
}

onMounted(loadSetup);
</script>

<template>
  <section class="payroll-page" v-loading="loading">
    <header class="page-header">
      <div><span class="eyebrow">PAYROLL</span><h1>员工工资</h1><p>内部完整核算，按用工公司匹配上海或合肥五险一金方案。</p></div>
      <div class="scope-actions">
        <el-select v-model="companyId" class="company-select" @change="loadPeriod"><el-option v-for="item in setup.companies" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select>
        <el-date-picker v-model="month" type="month" value-format="YYYY-MM" @change="loadPeriod" />
        <el-button :icon="Refresh" @click="loadSetup">刷新</el-button>
      </div>
    </header>

    <el-tabs v-model="activeTab" class="payroll-tabs">
      <el-tab-pane label="工资单" name="statements">
        <div class="metric-grid">
          <article><span>应发工资</span><strong>{{ money(payroll.summary.gross_salary) }}</strong></article>
          <article><span>个人五险一金</span><strong>{{ money(payroll.summary.employee_contribution) }}</strong></article>
          <article><span>实发工资</span><strong>{{ money(payroll.summary.net_salary) }}</strong></article>
          <article><span>公司用工成本</span><strong>{{ money(payroll.summary.employer_total_cost) }}</strong></article>
        </div>
        <div class="toolbar"><div><h2>{{ month }} 工资单</h2><p>状态：{{ statusText(payroll.period?.status) }}</p></div><div class="toolbar-actions"><el-button type="primary" @click="calculate">生成试算</el-button><el-button :icon="Check" :disabled="!canApprove" @click="changeStatus('approve')">审核</el-button><el-button :icon="Lock" :disabled="!canLock" @click="changeStatus('lock')">锁定</el-button></div></div>
        <el-alert v-if="!setup.schemes.length" title="请先配置城市最低缴费方案" description="没有上海或合肥有效最低基数时，系统不会按 0 元社保生成工资。" type="warning" show-icon :closable="false" />
        <el-table :data="payroll.rows" class="data-table" empty-text="本月尚未生成工资单">
          <el-table-column prop="person_name" label="员工" min-width="110" fixed />
          <el-table-column prop="department" label="部门/岗位" min-width="120" />
          <el-table-column prop="city_name" label="参保城市" width="96" />
          <el-table-column prop="policy_name" label="工资策略" min-width="130" />
          <el-table-column prop="base_salary" label="底薪" min-width="110" align="right"><template #default="{ row }">{{ money(row.base_salary) }}</template></el-table-column>
          <el-table-column prop="fixed_earnings" label="固定加项" min-width="110" align="right"><template #default="{ row }">{{ money(row.fixed_earnings) }}</template></el-table-column>
          <el-table-column prop="variable_earnings" label="提成/绩效" min-width="116" align="right"><template #default="{ row }">{{ money(row.variable_earnings) }}</template></el-table-column>
          <el-table-column prop="gross_salary" label="应发" min-width="116" align="right"><template #default="{ row }"><b>{{ money(row.gross_salary) }}</b></template></el-table-column>
          <el-table-column prop="employee_contribution" label="个人五险一金" min-width="130" align="right"><template #default="{ row }">{{ money(row.employee_contribution) }}</template></el-table-column>
          <el-table-column prop="income_tax" label="个税" min-width="100" align="right"><template #default="{ row }">{{ money(row.income_tax) }}</template></el-table-column>
          <el-table-column prop="net_salary" label="实发" min-width="120" align="right" fixed="right"><template #default="{ row }"><strong class="net">{{ money(row.net_salary) }}</strong></template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="员工薪酬档案" name="profiles">
        <div class="toolbar"><div><h2>员工薪酬档案</h2><p>用工公司决定参保城市；负责店铺只影响提成和费用分摊。</p></div><el-button type="primary" :icon="Plus" @click="openProfile()">新增档案</el-button></div>
        <el-table :data="setup.profiles" class="data-table"><el-table-column prop="person_name" label="员工" /><el-table-column prop="company_name" label="用工公司" min-width="210" /><el-table-column prop="department" label="部门/岗位" /><el-table-column prop="employment_city_code" label="参保城市"><template #default="{ row }">{{ row.employment_city_code === 'shanghai' ? '上海' : row.employment_city_code === 'hefei' ? '合肥' : row.employment_city_code }}</template></el-table-column><el-table-column prop="scheme_name" label="五险一金方案" min-width="160" /><el-table-column prop="policy_name" label="工资策略" min-width="140" /><el-table-column prop="base_salary" label="底薪"><template #default="{ row }">{{ money(row.base_salary) }}</template></el-table-column><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openProfile(row)">编辑</el-button></template></el-table-column></el-table>
      </el-tab-pane>

      <el-tab-pane label="工资策略" name="policies">
        <div class="toolbar"><div><h2>DIY 工资策略</h2><p>底薪在员工档案维护；策略负责津贴、满勤、提成、绩效和奖金。</p></div><div class="toolbar-actions"><el-button type="primary" plain @click="openStoreOperatorPreset">快速创建店铺运营策略</el-button><el-button type="primary" :icon="Plus" @click="openPolicy()">自定义策略</el-button></div></div>
        <el-table :data="setup.policies" class="data-table"><el-table-column prop="name" label="策略名称" /><el-table-column prop="version_no" label="版本" width="80" /><el-table-column prop="effective_from" label="生效日期" width="120" /><el-table-column label="营业额提成" width="120"><template #default="{ row }">{{ percent(row.components?.revenue_commission_rate) }}</template></el-table-column><el-table-column label="利润提成" width="120"><template #default="{ row }">{{ percent(row.components?.profit_commission_rate) }}</template></el-table-column><el-table-column label="满勤奖" width="110"><template #default="{ row }">{{ money(row.components?.attendance_bonus) }}</template></el-table-column><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openPolicy(row)">编辑</el-button></template></el-table-column></el-table>
      </el-tab-pane>

      <el-tab-pane label="五险一金方案" name="schemes">
        <div class="toolbar"><div><h2>城市最低缴费方案</h2><p>最低基数和比例按生效日期版本化，政策调整不能覆盖历史方案。</p></div><div class="toolbar-actions"><el-button type="primary" plain @click="openShanghaiSchemePreset">一键填写上海方案</el-button><el-button type="primary" :icon="Plus" @click="openScheme()">自定义方案</el-button></div></div>
        <el-table :data="setup.schemes" class="data-table"><el-table-column prop="name" label="方案名称" min-width="160" /><el-table-column prop="city_name" label="城市" width="90" /><el-table-column prop="social_base_min" label="社保最低基数"><template #default="{ row }">{{ money(row.social_base_min) }}</template></el-table-column><el-table-column prop="housing_base_min" label="公积金最低基数"><template #default="{ row }">{{ money(row.housing_base_min) }}</template></el-table-column><el-table-column prop="effective_from" label="生效日期" width="120" /><el-table-column prop="source_note" label="政策来源/备注" min-width="220" show-overflow-tooltip /><el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openScheme(row)">编辑</el-button></template></el-table-column></el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="profileDialog" :title="profileForm.id ? '编辑员工薪酬档案' : '新增员工薪酬档案'" width="680px"><el-form label-position="top"><div class="form-grid"><el-form-item label="员工" required><el-select v-model="profileForm.person_id" filterable><el-option v-for="item in setup.people" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select></el-form-item><el-form-item label="用工/发薪公司" required><el-select v-model="profileForm.company_id"><el-option v-for="item in setup.companies" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select></el-form-item><el-form-item label="部门/岗位"><el-input v-model="profileForm.department" /></el-form-item><el-form-item label="参保城市" required><el-select v-model="profileForm.employment_city_code"><el-option label="上海" value="shanghai" /><el-option label="合肥" value="hefei" /></el-select></el-form-item><el-form-item label="五险一金方案" required><el-select v-model="profileForm.contribution_scheme_id"><el-option v-for="item in setup.schemes.filter(s => s.city_code === profileForm.employment_city_code)" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select></el-form-item><el-form-item label="工资策略" required><el-select v-model="profileForm.policy_id"><el-option v-for="item in setup.policies" :key="item.id" :label="`${item.name} v${item.version_no}`" :value="String(item.id)" /></el-select></el-form-item><el-form-item label="月度底薪"><el-input-number v-model="profileForm.base_salary" :min="0" :precision="2" /></el-form-item><el-form-item label="生效日期" required><el-date-picker v-model="profileForm.effective_from" value-format="YYYY-MM-DD" /></el-form-item></div></el-form><template #footer><el-button @click="profileDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save('/api/payroll/profiles', profileForm, profileDialog)">保存</el-button></template></el-dialog>

    <el-dialog v-model="policyDialog" :title="policyForm.id ? '编辑工资策略' : '新增工资策略'" width="760px"><el-form label-position="top"><div class="form-grid"><el-form-item label="策略名称" required><el-input v-model="policyForm.name" placeholder="例如：店铺运营策略" /></el-form-item><el-form-item label="版本"><el-input-number v-model="policyForm.version_no" :min="1" /></el-form-item><el-form-item label="生效日期" required><el-date-picker v-model="policyForm.effective_from" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="岗位津贴"><el-input-number v-model="policyForm.components.position_allowance" :min="0" :precision="2" /></el-form-item><el-form-item label="固定补贴"><el-input-number v-model="policyForm.components.fixed_allowance" :min="0" :precision="2" /></el-form-item><el-form-item label="满勤奖"><el-input-number v-model="policyForm.components.attendance_bonus" :min="0" :precision="2" /></el-form-item><el-form-item label="绩效奖金"><el-input-number v-model="policyForm.components.performance_bonus" :min="0" :precision="2" /></el-form-item><el-form-item label="营业额提成比例"><el-input-number v-model="policyForm.components.revenue_commission_rate" :min="0" :max="1" :step="0.001" :precision="4" /></el-form-item><el-form-item label="利润提成门槛"><el-input-number v-model="policyForm.components.profit_threshold" :min="0" :precision="2" /></el-form-item><el-form-item label="利润提成比例"><el-input-number v-model="policyForm.components.profit_commission_rate" :min="0" :max="1" :step="0.01" :precision="4" /></el-form-item><el-form-item label="季度奖"><el-input-number v-model="policyForm.components.quarterly_bonus" :min="0" :precision="2" /></el-form-item><el-form-item label="年终奖"><el-input-number v-model="policyForm.components.annual_bonus" :min="0" :precision="2" /></el-form-item></div><el-alert title="利润提成按扣工资前可分配利润计算，利润为负时提成为 0。" type="info" :closable="false" /></el-form><template #footer><el-button @click="policyDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save('/api/payroll/policies', policyForm, policyDialog)">保存</el-button></template></el-dialog>

    <el-dialog v-model="schemeDialog" :title="schemeForm.id ? '编辑五险一金方案' : '新增五险一金方案'" width="920px"><el-form label-position="top"><div class="form-grid"><el-form-item label="方案名称" required><el-input v-model="schemeForm.name" placeholder="例如：上海最低基数 2026" /></el-form-item><el-form-item label="城市" required><el-select v-model="schemeForm.city_code" @change="schemeForm.city_name = schemeForm.city_code === 'shanghai' ? '上海' : '合肥'"><el-option label="上海" value="shanghai" /><el-option label="合肥" value="hefei" /></el-select></el-form-item><el-form-item label="社保最低缴费基数" required><el-input-number v-model="schemeForm.social_base_min" :min="0" :precision="2" /></el-form-item><el-form-item label="公积金最低缴费基数" required><el-input-number v-model="schemeForm.housing_base_min" :min="0" :precision="2" /></el-form-item><el-form-item label="生效日期" required><el-date-picker v-model="schemeForm.effective_from" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="政策来源/核验说明"><el-input v-model="schemeForm.source_note" /></el-form-item></div><h3 class="rate-title">缴费比例（填写小数，例如 16% 填 0.16）</h3><div class="rate-grid"><div class="rate-head">险种</div><div class="rate-head">单位比例</div><div class="rate-head">个人比例</div><template v-for="item in [['pension','养老'],['medical','医疗'],['supplementary_medical','附加医疗'],['unemployment','失业'],['injury','工伤'],['maternity','生育'],['housing_fund','公积金']]" :key="item[0]"><span>{{ item[1] }}</span><el-input-number v-model="schemeForm.employer_rates[item[0]]" :min="0" :max="1" :step="0.001" :precision="4" /><el-input-number v-model="schemeForm.employee_rates[item[0]]" :min="0" :max="1" :step="0.001" :precision="4" /></template></div></el-form><template #footer><el-button @click="schemeDialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save('/api/payroll/contribution-schemes', schemeForm, schemeDialog)">保存</el-button></template></el-dialog>
  </section>
</template>

<style scoped>
.payroll-page{padding:20px 24px 36px;color:#1f2937}.page-header,.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px}.page-header h1,.toolbar h2{margin:3px 0 5px}.page-header h1{font-size:26px}.page-header p,.toolbar p{margin:0;color:#64748b;font-size:13px}.eyebrow{color:#2563eb;font-size:11px;font-weight:800;letter-spacing:.12em}.scope-actions,.toolbar-actions{display:flex;align-items:center;gap:10px}.company-select{width:300px}.payroll-tabs{margin-top:18px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric-grid article{padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}.metric-grid span{display:block;color:#64748b;font-size:13px}.metric-grid strong{display:block;margin-top:8px;color:#0f172a;font-size:23px}.toolbar{margin:22px 0 14px}.data-table{width:100%;border-top:1px solid #e5e7eb}.net{color:#047857}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.form-grid :deep(.el-select),.form-grid :deep(.el-date-editor),.form-grid :deep(.el-input-number){width:100%}.rate-title{margin:8px 0 12px;font-size:15px}.rate-grid{display:grid;grid-template-columns:140px 1fr 1fr;align-items:center;gap:10px 16px}.rate-head{color:#64748b;font-size:12px;font-weight:700}.rate-grid :deep(.el-input-number){width:100%}@media(max-width:900px){.page-header,.toolbar{align-items:flex-start;flex-direction:column}.scope-actions{width:100%;flex-wrap:wrap}.company-select{width:100%}.metric-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.payroll-page{padding:14px}.metric-grid,.form-grid{grid-template-columns:1fr}.rate-grid{grid-template-columns:90px 1fr 1fr}}
</style>
