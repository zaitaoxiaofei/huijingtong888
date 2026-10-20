<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const rows = ref([]);
const plans = ref([]);
const people = ref([]);
const members = ref([]);
const selected = ref(null);
const activeSection = ref("customers");
const detailVisible = ref(false);
const createVisible = ref(false);
const planVisible = ref(false);
const editingPlanId = ref(null);
const memberVisible = ref(false);
const accountVisible = ref(false);
const pluginTokenStatus = ref({ configured: false });
const pluginTokenDialog = ref(false);
const pluginTokenValue = ref("");
const pluginTokenImportDialog = ref(false);
const pluginTokenImportValue = ref("");
const activationCodeStatus = ref({ configured: false });
const activationCodeValue = ref("");
const activationCodeDialog = ref(false);
const activationCodeLoading = ref(false);
const selectedPlanCode = ref("");
const filters = reactive({ keyword: "", status: "all", plan: "all" });

const tenantForm = reactive({ name: "", slug: "", owner_person_id: null, plan_code: "trial_7d" });
const quotaForm = reactive({ member_limit: null, shop_limit: null });
const memberForm = reactive({ person_id: null, role: "member" });
const accountForm = reactive({ name: "", username: "", password: "", roles: ["operator"] });
const planForm = reactive({ name: "", duration_days: 30, subscription_status: "active", account_limit: 1, shop_limit: 2, unlimited_accounts: false, unlimited_shops: false });

const statusLabels = { active: "已开通", trial: "体验中", expired: "已到期", suspended: "已暂停" };
const title = computed(() => selected.value?.name || "客户空间");
const activePlans = computed(() => plans.value.filter(plan => Number(plan.active)));
const trialPlans = computed(() => plans.value.filter(plan => plan.subscription_status === "trial"));
const paidPlans = computed(() => plans.value.filter(plan => plan.subscription_status !== "trial"));
const summary = computed(() => ({
  total: rows.value.length,
  active: rows.value.filter(row => row.access_allowed && row.subscription_status === "active").length,
  trial: rows.value.filter(row => row.access_allowed && row.subscription_status === "trial").length,
  attention: rows.value.filter(row => !row.access_allowed || row.subscription_status === "expired").length
}));
const filteredRows = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase();
  return rows.value.filter(row => {
    const matchesKeyword = !keyword || [row.name, row.slug, row.plan_code].some(value => String(value || "").toLowerCase().includes(keyword));
    const matchesStatus = filters.status === "all"
      || (filters.status === "available" && row.access_allowed)
      || (filters.status === "expired" && row.subscription_status === "expired")
      || (filters.status === "suspended" && row.subscription_status === "suspended");
    const matchesPlan = filters.plan === "all" || row.plan_code === filters.plan;
    return matchesKeyword && matchesStatus && matchesPlan;
  });
});

function planName(code, tenant = null) {
  if (tenant?.slug === "default") return "默认企业（内部空间）";
  return plans.value.find(item => item.code === code)?.name || code || "未设置";
}

function quotaText(value, unit = "个") {
  return value == null ? "不限" : `${value} ${unit}`;
}

function formatDateTime(value) {
  return value ? `${shanghaiDateTimeText(value, { assumeUtcWhenNaive: true })}（北京时间）` : "长期有效";
}

function statusType(row) {
  if (!row.access_allowed || row.subscription_status === "expired") return "danger";
  if (row.subscription_status === "trial") return "warning";
  if (row.subscription_status === "suspended") return "info";
  return "success";
}

function statusText(row) {
  if (!row.access_allowed && row.subscription_status !== "suspended") return "已到期";
  return statusLabels[row.subscription_status] || row.subscription_status || "未知";
}

async function load() {
  loading.value = true;
  try {
    const [tenants, users, tenantPlans] = await Promise.all([
      apiClient.get("/api/tenants"),
      apiClient.get("/api/people"),
      apiClient.get("/api/tenants/plans")
    ]);
    rows.value = tenants;
    people.value = users || [];
    plans.value = tenantPlans || [];
    if (selected.value) {
      selected.value = rows.value.find(row => row.id === selected.value.id) || null;
      if (selected.value) {
        selectedPlanCode.value = selected.value.plan_code || "";
        await Promise.all([loadMembers(), loadPluginTokenStatus(), loadActivationCodeStatus()]);
      } else {
        detailVisible.value = false;
        members.value = [];
      }
    }
  } catch (error) {
    ElMessage.error(error.message || "客户空间数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadMembers() {
  if (!selected.value) return;
  members.value = await apiClient.get(`/api/tenants/members?tenant_id=${selected.value.id}`);
}

async function loadPluginTokenStatus() {
  if (!selected.value) return;
  pluginTokenStatus.value = await apiClient.get(`/api/tenants/plugin-token?tenant_id=${selected.value.id}`);
}

async function loadActivationCodeStatus() {
  if (!selected.value) return;
  activationCodeStatus.value = await apiClient.get(`/api/tenants/activation-code?tenant_id=${selected.value.id}`);
}

async function openTenant(row) {
  selected.value = row;
  selectedPlanCode.value = row.plan_code || "";
  Object.assign(quotaForm, { member_limit: row.member_limit, shop_limit: row.shop_limit });
  pluginTokenValue.value = "";
  activationCodeValue.value = "";
  detailVisible.value = true;
  try {
    await Promise.all([loadMembers(), loadPluginTokenStatus(), loadActivationCodeStatus()]);
  } catch (error) {
    ElMessage.error(error.message || "客户空间详情加载失败");
  }
}

function openCreateTenant() {
  Object.assign(tenantForm, { name: "", slug: "", owner_person_id: null, plan_code: activePlans.value.some(plan => plan.code === "trial_7d") ? "trial_7d" : activePlans.value[0]?.code || "" });
  createVisible.value = true;
}

async function createTenant() {
  try {
    const result = await apiClient.post("/api/tenants", tenantForm);
    ElMessage.success(`客户空间已创建并按「${planName(tenantForm.plan_code)}」开通`);
    createVisible.value = false;
    await load();
    const created = rows.value.find(row => Number(row.id) === Number(result.id));
    if (created) await openTenant(created);
    activationCodeValue.value = result.activation_code || "";
    activationCodeDialog.value = Boolean(result.activation_code);
  } catch (error) {
    ElMessage.error(error.message || "创建客户空间失败");
  }
}

async function saveQuotas() {
  try {
    await apiClient.post("/api/tenants/quotas", { tenant_id: selected.value.id, ...quotaForm });
    ElMessage.success("账号与店铺额度已保存");
    await load();
  } catch (error) {
    ElMessage.error(error.message || "保存额度失败");
  }
}

async function clearQuotas() {
  quotaForm.member_limit = null;
  quotaForm.shop_limit = null;
  await saveQuotas();
}

async function applyPlan() {
  const target = activePlans.value.find(item => item.code === selectedPlanCode.value);
  if (!target) return;
  try {
    await ElMessageBox.confirm(
      `将为「${selected.value.name}」开通「${target.name}」，有效期从现在重新计算，并按套餐覆盖账号和店铺额度。确认继续？`,
      "确认调整授权",
      { type: "warning", confirmButtonText: "确认开通", cancelButtonText: "再检查一下" }
    );
    await apiClient.post("/api/tenants/subscription", { tenant_id: selected.value.id, plan_code: target.code });
    ElMessage.success("套餐授权已更新");
    await load();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "套餐授权失败");
  }
}

function openPlanEditor(row = null) {
  editingPlanId.value = row?.id || null;
  Object.assign(planForm, row ? {
    name: row.name,
    duration_days: row.duration_days,
    subscription_status: row.subscription_status,
    account_limit: row.account_limit ?? 1,
    shop_limit: row.shop_limit ?? 0,
    unlimited_accounts: row.account_limit == null,
    unlimited_shops: row.shop_limit == null
  } : {
    name: "",
    duration_days: 30,
    subscription_status: "active",
    account_limit: 1,
    shop_limit: 2,
    unlimited_accounts: false,
    unlimited_shops: false
  });
  planVisible.value = true;
}

async function savePlan() {
  const payload = {
    name: planForm.name,
    duration_days: planForm.duration_days,
    subscription_status: planForm.subscription_status,
    account_limit: planForm.unlimited_accounts ? null : planForm.account_limit,
    shop_limit: planForm.unlimited_shops ? null : planForm.shop_limit
  };
  try {
    if (editingPlanId.value) {
      await apiClient.put("/api/tenants/plans", { id: editingPlanId.value, ...payload });
    } else {
      await apiClient.post("/api/tenants/plans", payload);
    }
    ElMessage.success(editingPlanId.value ? "套餐已更新" : "套餐已创建");
    planVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error.message || "保存套餐失败");
  }
}

async function togglePlan(row) {
  try {
    await apiClient.put("/api/tenants/plans", {
      id: row.id,
      name: row.name,
      duration_days: row.duration_days,
      subscription_status: row.subscription_status,
      account_limit: row.account_limit,
      shop_limit: row.shop_limit,
      active: Number(row.active) ? 0 : 1
    });
    ElMessage.success(Number(row.active) ? "套餐已停用；已有客户授权不受影响" : "套餐已重新上架");
    await load();
  } catch (error) {
    ElMessage.error(error.message || "更新套餐状态失败");
  }
}

async function suspend() {
  try {
    await ElMessageBox.confirm(`暂停后「${selected.value.name}」的成员将不能使用业务功能。`, "暂停客户空间", { type: "warning", confirmButtonText: "确认暂停" });
    await apiClient.post("/api/tenants/subscription", { tenant_id: selected.value.id, subscription_status: "suspended" });
    ElMessage.success("客户空间已暂停");
    await load();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "暂停失败");
  }
}

async function saveMember() {
  try {
    await apiClient.put("/api/tenants/members", { tenant_id: selected.value.id, ...memberForm, active: 1 });
    memberVisible.value = false;
    await loadMembers();
    await load();
  } catch (error) {
    ElMessage.error(error.message || "保存成员失败");
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确认将「${row.name}」移出此空间吗？登录账号和业务数据不会被删除。`, "移除成员", { type: "warning" });
    await apiClient.put("/api/tenants/members", { tenant_id: selected.value.id, person_id: row.person_id, role: row.role, active: 0 });
    await loadMembers();
    await load();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "移除成员失败");
  }
}

async function createAccount() {
  try {
    const person = await apiClient.post("/api/people", accountForm);
    memberForm.person_id = person.id || person.person_id;
    accountVisible.value = false;
    memberVisible.value = true;
    Object.assign(accountForm, { name: "", username: "", password: "", roles: ["operator"] });
    await load();
  } catch (error) {
    ElMessage.error(error.message || "创建子账号失败");
  }
}

async function archive() {
  try {
    await ElMessageBox.confirm(`将归档「${selected.value.name}」，成员会被移出，但业务数据不会删除。`, "归档客户空间", { type: "error", confirmButtonText: "确认归档" });
    await apiClient.post("/api/tenants/archive", { tenant_id: selected.value.id });
    selected.value = null;
    members.value = [];
    detailVisible.value = false;
    await load();
    ElMessage.success("客户空间已归档");
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "归档失败");
  }
}

async function issuePluginToken() {
  try {
    if (!pluginTokenStatus.value.encryption_configured) {
      throw new Error("服务器尚未配置稳定的企业插件令牌加密密钥，请先配置后再生成或重置令牌");
    }
    if (pluginTokenStatus.value.configured) {
      await ElMessageBox.confirm("生成新令牌会立即撤销旧令牌，已配置旧令牌的插件需要重新粘贴。", "重置插件接入令牌", { type: "warning" });
    }
    const result = await apiClient.post("/api/tenants/plugin-token", { tenant_id: selected.value.id });
    pluginTokenValue.value = result.token;
    pluginTokenDialog.value = true;
    await loadPluginTokenStatus().catch(() => {});
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "生成插件令牌失败");
  }
}

async function revealPluginToken() {
  try {
    const result = await apiClient.post("/api/tenants/plugin-token/reveal", { tenant_id: selected.value.id });
    pluginTokenValue.value = result.token;
    pluginTokenDialog.value = true;
  } catch (error) {
    ElMessage.error(error.message || "读取插件令牌失败");
  }
}

function openPluginTokenImport() {
  pluginTokenImportValue.value = "";
  pluginTokenImportDialog.value = true;
}

function clearPluginTokenImportValue() {
  pluginTokenImportValue.value = "";
}

async function saveExistingPluginToken() {
  const token = pluginTokenImportValue.value.trim();
  if (!token) {
    ElMessage.warning("请先粘贴已有的插件令牌");
    return;
  }
  try {
    await ElMessageBox.confirm("如果粘贴的是当前正在使用的令牌，只会补存加密副本，插件不会掉线；如果是另一枚令牌，当前令牌会立即失效。", "保存已有插件令牌", { type: "warning", confirmButtonText: "确认保存" });
    await apiClient.post("/api/tenants/plugin-token/import", { tenant_id: selected.value.id, token });
    pluginTokenValue.value = token;
    pluginTokenImportDialog.value = false;
    pluginTokenDialog.value = true;
    await loadPluginTokenStatus();
    ElMessage.success("已有令牌已安全保存，可随时查看和复制");
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "保存已有令牌失败");
  }
}

function clearPluginTokenValue() {
  pluginTokenValue.value = "";
}

async function revokePluginToken() {
  try {
    await ElMessageBox.confirm("撤销后，该空间已配置此令牌的浏览器插件将立即无法连接。", "撤销插件接入令牌", { type: "warning" });
    await apiClient.delete(`/api/tenants/plugin-token?tenant_id=${selected.value.id}`);
    pluginTokenStatus.value = { configured: false };
    ElMessage.success("插件令牌已撤销");
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "撤销插件令牌失败");
  }
}

async function issueActivationCode() {
  if (activationCodeLoading.value) return;
  activationCodeLoading.value = true;
  try {
    if (activationCodeStatus.value.configured && activationCodeStatus.value.status === "active") {
      await ElMessageBox.confirm("生成新激活码会立即作废旧码；已复制旧码但尚未注册的客户需要使用新码。", "重发客户激活码", { type: "warning", confirmButtonText: "作废旧码并重发" });
    }
    const result = await apiClient.post("/api/tenants/activation-code", { tenant_id: selected.value.id });
    activationCodeValue.value = result.activation_code;
    activationCodeDialog.value = true;
    await loadActivationCodeStatus();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "生成激活码失败");
  } finally {
    activationCodeLoading.value = false;
  }
}

async function revokeActivationCode() {
  try {
    await ElMessageBox.confirm("作废后，此激活码将不能再用于注册。", "作废客户激活码", { type: "warning", confirmButtonText: "确认作废" });
    await apiClient.delete(`/api/tenants/activation-code?tenant_id=${selected.value.id}`);
    await loadActivationCodeStatus();
    ElMessage.success("客户激活码已作废");
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "作废激活码失败");
  }
}

async function copyActivationCode() {
  try {
    await navigator.clipboard.writeText(activationCodeValue.value);
    ElMessage.success("客户激活码已复制，请妥善发送给客户");
  } catch {
    ElMessage.error("复制失败，请手动选择并复制激活码");
  }
}

async function copyPluginToken() {
  if (!pluginTokenValue.value) return;
  try {
    await navigator.clipboard.writeText(pluginTokenValue.value);
    ElMessage.success("插件接入令牌已复制");
  } catch {
    ElMessage.error("复制失败，请手动选择并复制令牌");
  }
}

onMounted(load);
</script>

<template>
  <main class="tenant-page" v-loading="loading">
    <header class="page-header">
      <div>
        <div class="eyebrow">订阅运营 / 客户管理</div>
        <h1>客户与套餐</h1>
        <p>管理客户空间、订阅套餐与客户激活码；客户自助注册兑换正在分步接入。</p>
      </div>
      <div class="header-actions">
        <el-button @click="load">刷新</el-button>
        <el-button v-if="activeSection === 'customers'" type="primary" @click="openCreateTenant">新增客户空间</el-button>
        <el-button v-else type="primary" @click="openPlanEditor()">新增套餐</el-button>
      </div>
    </header>

    <section v-if="activeSection === 'customers'" class="summary-grid" aria-label="客户空间概览">
      <article class="summary-card"><span>客户空间</span><strong>{{ summary.total }}</strong><small>含体验、正式与已暂停空间</small></article>
      <article class="summary-card"><span>正式服务中</span><strong>{{ summary.active }}</strong><small>当前可正常使用</small></article>
      <article class="summary-card"><span>体验中</span><strong>{{ summary.trial }}</strong><small>体验套餐有效空间</small></article>
      <article class="summary-card attention"><span>需要跟进</span><strong>{{ summary.attention }}</strong><small>已到期或不可使用</small></article>
    </section>

    <el-tabs v-model="activeSection" class="tenant-tabs">
      <el-tab-pane label="客户空间" name="customers">
        <section class="customer-panel">
          <div class="panel-heading">
            <div><h2>客户空间</h2><p>每一行代表一个彼此隔离的工作空间；点“管理”查看授权、用量和成员。</p></div>
            <span class="result-count">{{ filteredRows.length }} 个空间</span>
          </div>
          <div class="filters">
            <el-input v-model="filters.keyword" clearable placeholder="搜索空间名称、标识或套餐" class="search-input">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-select v-model="filters.status" aria-label="按服务状态筛选" class="filter-select">
              <el-option label="全部状态" value="all" />
              <el-option label="可使用" value="available" />
              <el-option label="已到期" value="expired" />
              <el-option label="已暂停" value="suspended" />
            </el-select>
            <el-select v-model="filters.plan" aria-label="按套餐筛选" class="filter-select">
              <el-option label="全部套餐" value="all" />
              <el-option v-for="plan in plans" :key="plan.id" :label="plan.name" :value="plan.code" />
            </el-select>
          </div>
          <el-table :data="filteredRows" row-key="id" class="customer-table" empty-text="没有符合条件的客户空间">
            <el-table-column label="客户空间" min-width="220">
              <template #default="{ row }"><div class="space-cell"><strong>{{ row.name }}</strong><span>{{ row.slug }}</span></div></template>
            </el-table-column>
            <el-table-column label="当前套餐" min-width="160"><template #default="{ row }"><span class="plan-cell">{{ planName(row.plan_code, row) }}</span></template></el-table-column>
            <el-table-column label="服务状态" width="120"><template #default="{ row }"><el-tag :type="statusType(row)" effect="light" round>{{ statusText(row) }}</el-tag></template></el-table-column>
            <el-table-column label="到期时间（北京时间）" min-width="210"><template #default="{ row }">{{ formatDateTime(row.subscription_expires_at) }}</template></el-table-column>
            <el-table-column label="账号用量" min-width="145"><template #default="{ row }"><span>{{ row.member_count }} 个总账号</span><small class="usage-sub">子账号用量：{{ row.sub_account_count }} / {{ quotaText(row.member_limit, '名额') }}</small></template></el-table-column>
            <el-table-column label="店铺用量" width="120"><template #default="{ row }">{{ row.shop_count }} / {{ quotaText(row.shop_limit) }}</template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button type="primary" link @click="openTenant(row)">管理<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button></template></el-table-column>
          </el-table>
          <el-alert class="activation-note" type="info" :closable="false" show-icon>
            <template #title>每个新客户空间会自动生成客户激活码</template>
            激活码由套餐期限约束，完整码仅在创建或重发时展示；客户自助注册和兑换流程将在下一步接入。浏览器插件令牌与客户激活码用途不同。
          </el-alert>
        </section>
      </el-tab-pane>

      <el-tab-pane label="套餐目录" name="plans">
        <section class="plan-panel">
          <div class="panel-heading">
            <div><h2>套餐目录</h2><p>套餐定义可售服务的期限和资源额度；修改套餐不会静默改变已开通客户的额度。</p></div>
            <span class="result-count">{{ plans.length }} 个套餐</span>
          </div>
          <div class="plan-group" v-if="trialPlans.length">
            <h3><span class="group-dot trial-dot" />体验套餐 <small>{{ trialPlans.length }}</small></h3>
            <div class="plan-grid">
              <article v-for="plan in trialPlans" :key="plan.id" class="plan-card" :class="{ inactive: !Number(plan.active) }">
                <div class="plan-card-top"><div><span class="plan-kind trial-kind">体验</span><h4>{{ plan.name }}</h4></div><el-tag :type="Number(plan.active) ? 'success' : 'info'" effect="light">{{ Number(plan.active) ? '可开通' : '已停用' }}</el-tag></div>
                <div class="plan-duration"><strong>{{ plan.duration_days }}</strong><span>天</span><el-tag v-if="Number(plan.is_builtin)" size="small" effect="plain">预置方案</el-tag></div>
                <div class="plan-quotas"><span><el-icon><User /></el-icon>{{ quotaText(plan.account_limit, '个账号') }}<small>含主账号</small></span><span><el-icon><Shop /></el-icon>{{ quotaText(plan.shop_limit, '个店铺') }}</span></div>
                <div class="plan-actions"><el-button link type="primary" @click="openPlanEditor(plan)">编辑套餐</el-button><el-button link :type="Number(plan.active) ? 'danger' : 'success'" @click="togglePlan(plan)">{{ Number(plan.active) ? '停用' : '重新上架' }}</el-button></div>
              </article>
            </div>
          </div>
          <div class="plan-group" v-if="paidPlans.length">
            <h3><span class="group-dot paid-dot" />正式套餐 <small>{{ paidPlans.length }}</small></h3>
            <div class="plan-grid">
              <article v-for="plan in paidPlans" :key="plan.id" class="plan-card" :class="{ inactive: !Number(plan.active) }">
                <div class="plan-card-top"><div><span class="plan-kind paid-kind">正式服务</span><h4>{{ plan.name }}</h4></div><el-tag :type="Number(plan.active) ? 'success' : 'info'" effect="light">{{ Number(plan.active) ? '可开通' : '已停用' }}</el-tag></div>
                <div class="plan-duration"><strong>{{ plan.duration_days }}</strong><span>天</span><el-tag v-if="Number(plan.is_builtin)" size="small" effect="plain">预置方案</el-tag></div>
                <div class="plan-quotas"><span><el-icon><User /></el-icon>{{ quotaText(plan.account_limit, '个账号') }}<small>含主账号</small></span><span><el-icon><Shop /></el-icon>{{ quotaText(plan.shop_limit, '个店铺') }}</span></div>
                <div class="plan-actions"><el-button link type="primary" @click="openPlanEditor(plan)">编辑套餐</el-button><el-button link :type="Number(plan.active) ? 'danger' : 'success'" @click="togglePlan(plan)">{{ Number(plan.active) ? '停用' : '重新上架' }}</el-button></div>
              </article>
            </div>
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-drawer v-model="detailVisible" :title="title" size="760px" class="tenant-drawer" destroy-on-close>
      <template v-if="selected">
        <div class="drawer-intro">
          <div><span class="drawer-slug">{{ selected.slug }}</span><p>客户空间 · 独立数据工作区</p></div>
          <el-tag :type="statusType(selected)" effect="light" round>{{ statusText(selected) }}</el-tag>
        </div>

        <section class="drawer-section subscription-card">
          <div class="section-heading"><div><h3>当前授权</h3><p>{{ planName(selected.plan_code, selected) }}</p></div><el-tag :type="statusType(selected)" effect="light">{{ statusText(selected) }}</el-tag></div>
          <div class="subscription-facts"><div><span>服务到期</span><strong>{{ formatDateTime(selected.subscription_expires_at) }}</strong></div><div><span>账号用量</span><strong>{{ selected.member_count }} / {{ selected.member_limit == null ? '不限' : Number(selected.member_limit) + 1 }} 个</strong></div><div><span>店铺用量</span><strong>{{ selected.shop_count }} / {{ selected.shop_limit == null ? '不限' : selected.shop_limit }} 个</strong></div></div>
          <div class="plan-assign"><el-select v-model="selectedPlanCode" placeholder="选择要开通的套餐" class="assign-select"><el-option v-for="plan in activePlans" :key="plan.id" :label="`${plan.name} · ${plan.duration_days} 天 · ${quotaText(plan.account_limit, '账号')} · ${quotaText(plan.shop_limit, '店铺')}`" :value="plan.code" /></el-select><el-button type="primary" :disabled="!selectedPlanCode" @click="applyPlan">重新开通 / 调整套餐</el-button></div>
          <p class="inline-hint">重新授权会从现在重新计算有效期，并按套餐更新额度；已有激活码不会自动重发，请在下方按需重发。</p>
        </section>

        <section class="drawer-section">
          <div class="section-heading"><div><h3>客户激活码</h3><p>客户注册认领用；完整激活码仅在创建或重发后显示一次。</p></div><div class="member-actions"><el-button type="primary" plain :loading="activationCodeLoading" @click="issueActivationCode">{{ activationCodeStatus.configured ? '作废并重发' : '生成激活码' }}</el-button><el-button type="danger" plain :disabled="activationCodeStatus.status !== 'active'" @click="revokeActivationCode">作废</el-button></div></div>
          <div v-if="activationCodeStatus.configured" class="activation-code-status"><span>••••••{{ activationCodeStatus.code_hint }}</span><el-tag size="small" :type="activationCodeStatus.status === 'active' ? 'success' : activationCodeStatus.status === 'expired' ? 'warning' : 'info'">{{ activationCodeStatus.status === 'active' ? '可用' : activationCodeStatus.status === 'expired' ? '已过期' : activationCodeStatus.status === 'unavailable' ? '空间不可用' : '已作废' }}</el-tag><span v-if="activationCodeStatus.expires_at">有效至 {{ formatDateTime(activationCodeStatus.expires_at) }}</span></div>
          <el-empty v-else description="尚未生成客户激活码" :image-size="54" />
          <p class="inline-hint">目前本版本已完成后台发码与作废；邮箱/手机号注册并兑换激活码尚未开放，不能把此码当成已可自助登录。</p>
        </section>

        <section class="drawer-section">
          <div class="section-heading"><div><h3>资源额度</h3><p>改低额度不会删除已有账号或店铺，只会阻止新增。</p></div></div>
          <el-form inline class="quota-form"><el-form-item label="子账号名额"><el-input-number v-model="quotaForm.member_limit" :min="0" :max="1000000" :step="1" controls-position="right" /></el-form-item><el-form-item label="店铺上限"><el-input-number v-model="quotaForm.shop_limit" :min="0" :max="1000000" :step="1" controls-position="right" /></el-form-item><el-button type="primary" plain @click="saveQuotas">保存额度</el-button><el-button @click="clearQuotas">不限</el-button></el-form>
        </section>

        <section class="drawer-section">
          <div class="section-heading"><div><h3>空间成员</h3><p>{{ members.length }} 位成员 · 主账号以外的成员占用子账号名额</p></div><div class="member-actions"><el-button @click="memberVisible = true">加入已有账号</el-button><el-button type="primary" plain @click="accountVisible = true">创建子账号</el-button></div></div>
          <el-table :data="members" size="small" class="member-table" empty-text="暂时没有成员账号">
            <el-table-column prop="name" label="姓名" min-width="130" />
            <el-table-column prop="username" label="登录账号" min-width="160" />
            <el-table-column label="空间角色" width="130"><template #default="{ row }"><el-tag size="small" :type="row.role === 'owner' ? 'warning' : row.role === 'admin' ? 'primary' : 'info'">{{ row.role === 'owner' ? '负责人' : row.role === 'admin' ? '空间管理员' : '成员' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="80" align="right"><template #default="{ row }"><el-button link type="danger" :disabled="row.role === 'owner'" @click="remove(row)">移除</el-button></template></el-table-column>
          </el-table>
        </section>

        <el-collapse class="advanced-section">
          <el-collapse-item name="plugin"><template #title><span class="advanced-title">高级接入：浏览器插件令牌</span></template>
            <div class="plugin-box">
              <div>
                <strong>{{ pluginTokenStatus.configured ? (pluginTokenStatus.can_reveal ? '已配置插件接入令牌' : pluginTokenStatus.recoverable ? '已配置插件令牌' : '已配置旧版令牌，暂不可查看') : '尚未配置插件接入令牌' }}</strong>
                <p>此令牌只供 Ozon 浏览器插件连接 ERP，和客户购买/注册用的激活码是两种不同凭证。新令牌会加密保存，授权管理员可随时查看和复制。</p>
                <p v-if="!pluginTokenStatus.encryption_configured" class="token-warning">服务器尚未配置稳定的令牌加密密钥，因此暂不能生成或查看可恢复的令牌。</p>
                <p v-else-if="pluginTokenStatus.configured && !pluginTokenStatus.recoverable" class="token-warning">当前令牌是在此功能上线前创建的，系统无法从旧哈希还原。如果你保存了原令牌，可录入以补存加密副本，不会更换令牌；如果原令牌已丢失，才需要重置并更新插件配置。</p>
                <p v-else-if="pluginTokenStatus.configured && !pluginTokenStatus.can_reveal" class="token-warning">令牌已加密保存，但当前服务未能使用对应密钥解密；请恢复原加密密钥后再查看，或确认插件可更新后重置。</p>
              </div>
              <div class="plugin-actions">
                <el-button v-if="pluginTokenStatus.can_reveal" type="primary" plain @click="revealPluginToken">查看/复制</el-button>
                <el-button type="primary" plain :disabled="!pluginTokenStatus.encryption_configured" @click="openPluginTokenImport">录入已有令牌</el-button>
                <el-button type="primary" plain :disabled="!pluginTokenStatus.encryption_configured" @click="issuePluginToken">{{ pluginTokenStatus.configured ? '重置令牌' : '生成令牌' }}</el-button>
                <el-button type="danger" plain :disabled="!pluginTokenStatus.configured" @click="revokePluginToken">撤销</el-button>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>

        <section class="archive-section"><div><strong>归档客户空间</strong><p>停用空间并移出成员，不直接删除业务数据。</p></div><el-button type="danger" plain @click="archive">归档空间</el-button></section>
      </template>
    </el-drawer>

    <el-dialog v-model="createVisible" title="创建客户空间" width="560px" destroy-on-close>
      <p class="dialog-lead">创建后会立即按所选套餐开通服务，并生成一枚与套餐期限一致的客户激活码。客户自助注册兑换将在下一步接入。</p>
      <el-form label-position="top" class="dialog-form">
        <div class="form-row"><el-form-item label="空间名称" required><el-input v-model="tenantForm.name" placeholder="例如：星河贸易团队" /></el-form-item><el-form-item label="空间标识" required><el-input v-model="tenantForm.slug" placeholder="例如 xinghe-team" /></el-form-item></div>
        <el-form-item label="开通套餐" required><el-select v-model="tenantForm.plan_code" class="full-width"><el-option v-for="plan in activePlans" :key="plan.id" :value="plan.code" :label="`${plan.name} · ${plan.duration_days} 天 · ${quotaText(plan.account_limit, '账号')} · ${quotaText(plan.shop_limit, '店铺')}`" /></el-select></el-form-item>
        <el-form-item label="绑定已有负责人账号（可选）"><el-select v-model="tenantForm.owner_person_id" clearable filterable class="full-width" placeholder="之后也可以从空间详情加入"><el-option v-for="person in people" :key="person.id" :label="`${person.name}（${person.username || '未设置登录账号'}）`" :value="person.id" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :disabled="!tenantForm.name || !tenantForm.slug || !tenantForm.plan_code" @click="createTenant">创建并开通</el-button></template>
    </el-dialog>

    <el-dialog v-model="planVisible" :title="editingPlanId ? '编辑套餐' : '新增套餐'" width="520px" destroy-on-close>
      <p class="dialog-lead">套餐账号总数包含主账号。修改套餐不会自动改写已有客户空间的授权。</p>
      <el-form label-position="top" class="dialog-form">
        <el-form-item label="套餐名称" required><el-input v-model="planForm.name" maxlength="80" placeholder="例如：季度团队版" /></el-form-item>
        <div class="form-row"><el-form-item label="服务期限（天）" required><el-input-number v-model="planForm.duration_days" :min="1" :max="3650" :step="1" controls-position="right" class="full-width" /></el-form-item><el-form-item label="服务类型"><el-select v-model="planForm.subscription_status" class="full-width"><el-option label="体验服务" value="trial" /><el-option label="正式服务" value="active" /></el-select></el-form-item></div>
        <div class="form-row"><el-form-item label="账号总数（含主账号）"><div class="quota-input"><el-input-number v-model="planForm.account_limit" :min="1" :max="1000000" :disabled="planForm.unlimited_accounts" controls-position="right" /><el-checkbox v-model="planForm.unlimited_accounts">不限</el-checkbox></div></el-form-item><el-form-item label="店铺上限"><div class="quota-input"><el-input-number v-model="planForm.shop_limit" :min="0" :max="1000000" :disabled="planForm.unlimited_shops" controls-position="right" /><el-checkbox v-model="planForm.unlimited_shops">不限</el-checkbox></div></el-form-item></div>
      </el-form>
      <template #footer><el-button @click="planVisible = false">取消</el-button><el-button type="primary" :disabled="!planForm.name.trim()" @click="savePlan">保存套餐</el-button></template>
    </el-dialog>

    <el-dialog v-model="memberVisible" title="加入空间成员" width="460px" destroy-on-close>
      <el-form label-position="top"><el-form-item label="用户账号"><el-select v-model="memberForm.person_id" filterable class="full-width"><el-option v-for="person in people" :key="person.id" :label="`${person.name}（${person.username || '未设置登录账号'}）`" :value="person.id" /></el-select></el-form-item><el-form-item label="空间角色"><el-select v-model="memberForm.role" class="full-width"><el-option label="成员" value="member" /><el-option label="空间管理员" value="admin" /><el-option label="负责人" value="owner" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="memberVisible = false">取消</el-button><el-button type="primary" :disabled="!memberForm.person_id" @click="saveMember">加入空间</el-button></template>
    </el-dialog>

    <el-dialog v-model="accountVisible" title="创建空间子账号" width="460px" destroy-on-close>
      <el-form label-position="top"><el-form-item label="姓名"><el-input v-model="accountForm.name" /></el-form-item><el-form-item label="登录账号"><el-input v-model="accountForm.username" /></el-form-item><el-form-item label="初始密码"><el-input v-model="accountForm.password" show-password /></el-form-item></el-form>
      <template #footer><el-button @click="accountVisible = false">取消</el-button><el-button type="primary" :disabled="!accountForm.name || !accountForm.username || !accountForm.password" @click="createAccount">创建账号并加入空间</el-button></template>
    </el-dialog>

    <el-dialog v-model="activationCodeDialog" title="客户激活码已生成" width="620px"><el-alert type="warning" :closable="false" title="请立即复制并安全发送给客户；完整码只显示这一次。" /><p class="dialog-lead">此码当前尚不能用于自助注册；兑换功能完成后客户才能用它创建主账号并认领此工作空间。</p><el-input v-model="activationCodeValue" readonly /><template #footer><el-button @click="activationCodeDialog = false">关闭</el-button><el-button type="primary" @click="copyActivationCode">复制激活码</el-button></template></el-dialog>
    <el-dialog v-model="pluginTokenDialog" title="浏览器插件接入令牌" width="620px" @closed="clearPluginTokenValue"><el-alert type="info" :closable="false" title="这是插件连接令牌，不是客户购买或注册用的激活码。" /><p class="dialog-lead">请仅复制到需要连接此企业空间的 Ozon 浏览器插件中；关闭窗口后可再次点击“查看/复制”。</p><el-input v-model="pluginTokenValue" readonly /><template #footer><el-button @click="pluginTokenDialog = false">关闭</el-button><el-button type="primary" :disabled="!pluginTokenValue" @click="copyPluginToken">复制令牌</el-button></template></el-dialog>
    <el-dialog v-model="pluginTokenImportDialog" title="录入已有插件令牌" width="620px" @closed="clearPluginTokenImportValue"><el-alert type="info" :closable="false" title="粘贴你此前保存的 Ozon 浏览器插件令牌，不要发送给客服或粘贴到聊天中。" /><p class="dialog-lead">若令牌与当前使用的一致，系统只会补存加密副本，原插件继续工作；若不同，保存后该空间会切换到这枚令牌。</p><el-input v-model="pluginTokenImportValue" type="password" show-password autocomplete="new-password" placeholder="粘贴 ozp_ 开头的完整令牌" /><template #footer><el-button @click="pluginTokenImportDialog = false">取消</el-button><el-button type="primary" :disabled="!pluginTokenImportValue.trim()" @click="saveExistingPluginToken">安全保存</el-button></template></el-dialog>
  </main>
</template>

<style scoped>
.tenant-page{max-width:1600px;margin:0 auto;padding:28px 32px 40px;color:#182230}.page-header,.panel-heading,.section-heading,.archive-section,.plan-card-top{display:flex;align-items:center;justify-content:space-between;gap:18px}.page-header{margin-bottom:22px}.eyebrow{margin-bottom:8px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:.04em}.page-header h1{margin:0;font-size:26px;line-height:1.25;font-weight:700}.page-header p,.panel-heading p,.section-heading p,.dialog-lead{margin:7px 0 0;color:#667085;font-size:13px;line-height:1.6}.header-actions{display:flex;gap:10px;flex:none}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.summary-card{display:grid;gap:7px;padding:17px 19px;border:1px solid #e7ebf0;border-radius:12px;background:#fff}.summary-card span{color:#667085;font-size:13px}.summary-card strong{font-size:27px;line-height:1.1;font-weight:700;color:#182230}.summary-card small{color:#98a2b3;font-size:12px}.summary-card.attention strong{color:#d97706}.tenant-tabs{background:#fff;border:1px solid #e7ebf0;border-radius:12px;padding:0 20px 18px}.tenant-tabs :deep(.el-tabs__header){margin:0 0 4px}.tenant-tabs :deep(.el-tabs__nav-wrap::after){height:1px;background:#edf0f3}.tenant-tabs :deep(.el-tabs__item){height:54px;font-weight:600}.customer-panel,.plan-panel{padding:21px 2px 0}.panel-heading{margin-bottom:19px}.panel-heading h2{margin:0;font-size:18px}.result-count{flex:none;color:#667085;font-size:13px}.filters{display:flex;gap:10px;margin-bottom:14px}.search-input{max-width:410px}.filter-select{width:160px}.customer-table{width:100%}.customer-table :deep(th.el-table__cell){height:45px;background:#f8fafc;color:#667085;font-size:12px;font-weight:600}.customer-table :deep(td.el-table__cell){height:64px;color:#344054}.space-cell{display:grid;gap:4px}.space-cell strong{color:#1d2939;font-size:14px;font-weight:600}.space-cell span,.usage-sub{color:#98a2b3;font-size:12px}.usage-sub{display:block;margin-top:3px}.plan-cell{font-weight:500}.activation-note{margin-top:18px}.activation-note :deep(.el-alert__title){font-size:13px;font-weight:600}.activation-note :deep(.el-alert__description){line-height:1.6}.plan-group+.plan-group{margin-top:28px}.plan-group>h3{display:flex;align-items:center;gap:9px;margin:0 0 14px;font-size:15px}.plan-group>h3 small{color:#98a2b3;font-size:12px;font-weight:400}.group-dot{width:8px;height:8px;border-radius:50%}.trial-dot{background:#7c6ee6}.paid-dot{background:#3370e8}.plan-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.plan-card{display:flex;flex-direction:column;min-height:203px;padding:17px 18px 12px;border:1px solid #e6eaf0;border-radius:12px;background:#fff;transition:border-color .15s,box-shadow .15s}.plan-card:hover{border-color:#bfd3ff;box-shadow:0 5px 18px #1d29390c}.plan-card.inactive{background:#fafbfc;opacity:.76}.plan-card-top{align-items:flex-start}.plan-card-top h4{margin:8px 0 0;font-size:15px}.plan-kind{display:inline-flex;padding:3px 7px;border-radius:5px;font-size:11px;font-weight:600}.trial-kind{background:#f1efff;color:#6554c0}.paid-kind{background:#edf4ff;color:#2362c7}.plan-duration{display:flex;align-items:baseline;gap:5px;margin:17px 0 15px}.plan-duration strong{font-size:28px;line-height:1;font-weight:700}.plan-duration>span{color:#667085;font-size:13px}.plan-duration .el-tag{align-self:center;margin-left:auto}.plan-quotas{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 0;border-top:1px solid #eff1f4;border-bottom:1px solid #eff1f4}.plan-quotas>span{display:grid;grid-template-columns:17px 1fr;align-items:center;column-gap:5px;color:#344054;font-size:12px}.plan-quotas :deep(.el-icon){color:#667085}.plan-quotas small{grid-column:2;color:#98a2b3;font-size:11px}.plan-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:10px}.drawer-intro{display:flex;align-items:center;justify-content:space-between;padding:0 0 20px;border-bottom:1px solid #edf0f3}.drawer-slug{color:#475467;font-size:13px;font-weight:600}.drawer-intro p{margin:6px 0 0;color:#98a2b3;font-size:12px}.drawer-section{padding:21px 0;border-bottom:1px solid #edf0f3}.section-heading{align-items:flex-start;margin-bottom:15px}.section-heading h3{margin:0;font-size:15px}.section-heading p{font-size:12px}.subscription-card{padding-top:17px}.subscription-facts{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:10px;margin:16px 0;padding:14px;border-radius:9px;background:#f8fafc}.subscription-facts>div{display:grid;gap:7px}.subscription-facts span{color:#667085;font-size:11px}.subscription-facts strong{font-size:13px;font-weight:600;line-height:1.5}.plan-assign{display:flex;gap:9px}.assign-select{min-width:0;flex:1}.inline-hint{margin:9px 0 0;color:#98a2b3;font-size:11px;line-height:1.5}.quota-form{display:flex;align-items:flex-end;gap:8px}.quota-form :deep(.el-form-item){margin:0 4px 0 0}.quota-form :deep(.el-input-number){width:130px}.member-actions{display:flex;gap:8px}.member-table :deep(th.el-table__cell){background:#f8fafc;color:#667085;font-size:12px}.advanced-section{margin-top:4px;border-bottom:1px solid #edf0f3}.advanced-section :deep(.el-collapse-item__header){height:53px;border-bottom:0;font-size:13px}.advanced-section :deep(.el-collapse-item__wrap){border-bottom:0}.advanced-title{color:#475467;font-weight:600}.plugin-box{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 0 17px}.plugin-box strong{font-size:13px}.plugin-box p{max-width:480px;margin:6px 0 0;color:#667085;font-size:12px;line-height:1.6}.plugin-actions{display:flex;flex:none;gap:6px}.archive-section{margin-top:20px;padding:15px 16px;border:1px solid #f1d0d0;border-radius:9px;background:#fffafa}.archive-section strong{color:#a63838;font-size:13px}.archive-section p{margin:5px 0 0;color:#8b6e6e;font-size:11px}.dialog-lead{margin:0 0 18px}.dialog-form :deep(.el-form-item){margin-bottom:17px}.dialog-form :deep(.el-form-item__label){padding-bottom:6px;color:#475467;font-weight:600}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.full-width{width:100%}.quota-input{display:flex;align-items:center;gap:12px}.quota-input :deep(.el-input-number){width:150px}
.activation-code-status{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e7ebf0;border-radius:8px;background:#f8fafc;color:#475467;font-size:13px}.activation-code-status span:first-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;letter-spacing:.04em}
.token-warning{color:#b54708!important}
@media(max-width:1000px){.tenant-page{padding:22px 20px}.plan-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.customer-table{min-width:980px}.customer-panel{overflow-x:auto}.tenant-tabs{padding-right:14px;padding-left:14px}}
@media(max-width:680px){.tenant-page{padding:18px 12px}.page-header{align-items:flex-start;flex-direction:column}.header-actions{width:100%}.header-actions .el-button{flex:1}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.summary-card{padding:13px}.summary-card strong{font-size:23px}.tenant-tabs{padding:0 10px 12px}.filters{flex-wrap:wrap}.search-input{max-width:none;width:100%}.filter-select{flex:1;width:auto;min-width:120px}.plan-grid{grid-template-columns:1fr}.plan-card{min-height:190px}.subscription-facts{grid-template-columns:1fr;gap:12px}.plan-assign{align-items:stretch;flex-direction:column}.quota-form{flex-wrap:wrap}.section-heading{align-items:flex-start;flex-direction:column}.member-actions{width:100%}.member-actions .el-button{flex:1}.plugin-box{align-items:flex-start;flex-direction:column}.form-row{grid-template-columns:1fr;gap:0}}
</style>
