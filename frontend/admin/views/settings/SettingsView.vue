<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const activeSection = ref("shops");

const shopDialogVisible = ref(false);
const shopDialogSubmitting = ref(false);
const shopFormRef = ref();

const personDialogVisible = ref(false);
const personDialogSubmitting = ref(false);
const personFormRef = ref();

const rateDialogVisible = ref(false);
const rateDialogSubmitting = ref(false);
const rateFormRef = ref();

const logisticsDialogVisible = ref(false);
const logisticsDialogSubmitting = ref(false);
const logisticsFormRef = ref();

const cancellationDialogVisible = ref(false);
const cancellationDialogSubmitting = ref(false);
const cancellationFormRef = ref();

const state = reactive({
  shops: [],
  people: [],
  rates: [],
  logisticsRules: [],
  cancellationRules: [],
  filters: {
    shopQuery: "",
    shopStatus: "all",
    shopPage: 1,
    shopPageSize: 10,
    personQuery: "",
    personStatus: "all",
    personPage: 1,
    personPageSize: 10,
    rateQuery: "",
    ratePage: 1,
    ratePageSize: 10,
    logisticsQuery: "",
    logisticsStatus: "all",
    logisticsPage: 1,
    logisticsPageSize: 10,
    cancellationQuery: "",
    cancellationStatus: "all",
    cancellationPage: 1,
    cancellationPageSize: 10
  }
});

const sectionOptions = [
  { key: "shops", label: "店铺管理", description: "维护店铺主体、Client ID、API Key 标识和结算比例。" },
  { key: "people", label: "人员管理", description: "维护账号、角色、启停状态和密码。" },
  { key: "rates", label: "汇率设置", description: "维护汇率历史记录，新增后即时生效。" },
  { key: "logistics", label: "物流设置", description: "维护物流规则，支持新增、编辑、停用。" },
  { key: "cancel", label: "取消规则设置", description: "维护取消/退货识别规则，支持新增、编辑、停用。" }
];

const sectionMetaMap = {
  shops: {
    title: "店铺管理",
    description: "当前分类下只管理店铺数据，新增、编辑、删除都在这里完成。"
  },
  people: {
    title: "人员管理",
    description: "当前分类下只管理人员数据，避免和其他设置共用一个新增入口。"
  },
  rates: {
    title: "汇率设置",
    description: "汇率只在汇率页面内新增，避免顶部新增按钮误导到汇率。"
  },
  logistics: {
    title: "物流设置",
    description: "物流规则在当前页面内独立完成新增、编辑、停用。"
  },
  cancel: {
    title: "取消规则设置",
    description: "取消/退货规则在当前页面内独立完成新增、编辑、停用。"
  }
};

const shopDialog = reactive({ mode: "create", form: createDefaultShopForm() });
const personDialog = reactive({ mode: "create", form: createDefaultPersonForm() });
const rateDialog = reactive({ mode: "create", form: createDefaultRateForm() });
const logisticsDialog = reactive({ mode: "create", form: createDefaultLogisticsForm() });
const cancellationDialog = reactive({ mode: "create", form: createDefaultCancellationForm() });

const shopFormRules = {
  name: [{ required: true, message: "请输入店铺名称", trigger: "blur" }]
};

const personFormRules = {
  name: [{ required: true, message: "请输入人员姓名", trigger: "blur" }]
};

const rateFormRules = {
  rate: [{ required: true, message: "请输入汇率", trigger: "blur" }],
  effective_date: [{ required: true, message: "请选择生效日期", trigger: "change" }]
};

const logisticsFormRules = {
  name: [{ required: true, message: "请输入规则名称", trigger: "blur" }]
};

const cancellationFormRules = {
  name: [{ required: true, message: "请输入规则名称", trigger: "blur" }],
  match_text: [{ required: true, message: "请输入匹配文本", trigger: "blur" }]
};

function createDefaultShopForm() {
  return {
    id: null,
    name: "",
    legal_entity: "",
    ozon_client_id: "",
    api_key_hint: "",
    payout_rate: 0.33,
    status: "active"
  };
}

function createDefaultPersonForm() {
  return {
    id: null,
    name: "",
    username: "",
    role: "operator",
    active: 1,
    password: ""
  };
}

function createDefaultRateForm() {
  return {
    rate: 11.32,
    effective_date: new Date().toISOString().slice(0, 10),
    source: "manual",
    note: ""
  };
}

function createDefaultLogisticsForm() {
  return {
    id: null,
    name: "",
    carrier: "CEL",
    channel: "standard",
    mode: "per_gram",
    min_weight_g: 0,
    max_weight_g: 500,
    min_price_rub: 0,
    max_price_rub: 999999,
    base_fee_cny: 0,
    per_gram_cny: 0.026,
    per_ticket_cny: 0,
    enabled: 1,
    note: ""
  };
}

function createDefaultCancellationForm() {
  return {
    id: null,
    name: "",
    match_text: "",
    match_mode: "contains",
    initiator_label: "",
    reason_label: "",
    reason_code: "other",
    reason_group_label: "其他取消/退货原因",
    priority: 100,
    enabled: 1,
    accounting_hint: "",
    note: ""
  };
}

const currentSectionMeta = computed(() => sectionMetaMap[activeSection.value] || sectionMetaMap.shops);

const filteredShops = computed(() => {

  const query = String(state.filters.shopQuery || "").trim().toLowerCase();
  const status = String(state.filters.shopStatus || "all");
  return state.shops.filter((row) => {
    if (status !== "all" && String(row.status || "active") !== status) return false;
    if (!query) return true;
    const haystack = [row.name, row.legal_entity, row.ozon_client_id, row.api_key_hint].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const filteredPeople = computed(() => {
  const query = String(state.filters.personQuery || "").trim().toLowerCase();
  const status = String(state.filters.personStatus || "all");
  return state.people.filter((row) => {
    if (status === "active" && Number(row.active) === 0) return false;
    if (status === "inactive" && Number(row.active) !== 0) return false;
    if (!query) return true;
    const haystack = [row.name, row.username, row.role].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const filteredRates = computed(() => {
  const query = String(state.filters.rateQuery || "").trim().toLowerCase();
  return state.rates.filter((row) => {
    if (!query) return true;
    const haystack = [row.rate, row.source, row.note, row.effective_date].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const filteredLogisticsRules = computed(() => {
  const query = String(state.filters.logisticsQuery || "").trim().toLowerCase();
  const status = String(state.filters.logisticsStatus || "all");
  return state.logisticsRules.filter((row) => {
    if (status === "active" && Number(row.enabled) === 0) return false;
    if (status === "inactive" && Number(row.enabled) !== 0) return false;
    if (!query) return true;
    const haystack = [row.name, row.carrier, row.channel, row.mode, row.note].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const filteredCancellationRules = computed(() => {
  const query = String(state.filters.cancellationQuery || "").trim().toLowerCase();
  const status = String(state.filters.cancellationStatus || "all");
  return state.cancellationRules.filter((row) => {
    if (status === "active" && Number(row.enabled) === 0) return false;
    if (status === "inactive" && Number(row.enabled) !== 0) return false;
    if (!query) return true;
    const haystack = [row.name, row.match_text, row.reason_label, row.reason_group_label, row.note].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const pagedShops = computed(() => paginate(filteredShops.value, state.filters.shopPage, state.filters.shopPageSize));
const pagedPeople = computed(() => paginate(filteredPeople.value, state.filters.personPage, state.filters.personPageSize));
const pagedRates = computed(() => paginate(filteredRates.value, state.filters.ratePage, state.filters.ratePageSize));
const pagedLogisticsRules = computed(() => paginate(filteredLogisticsRules.value, state.filters.logisticsPage, state.filters.logisticsPageSize));
const pagedCancellationRules = computed(() => paginate(filteredCancellationRules.value, state.filters.cancellationPage, state.filters.cancellationPageSize));

const shopTotal = computed(() => filteredShops.value.length);
const personTotal = computed(() => filteredPeople.value.length);
const rateTotal = computed(() => filteredRates.value.length);
const logisticsTotal = computed(() => filteredLogisticsRules.value.length);
const cancellationTotal = computed(() => filteredCancellationRules.value.length);

const shopDialogTitle = computed(() => (shopDialog.mode === "create" ? "新增店铺" : "编辑店铺"));
const personDialogTitle = computed(() => (personDialog.mode === "create" ? "新增人员" : "编辑人员"));
const rateDialogTitle = computed(() => "新增汇率");
const logisticsDialogTitle = computed(() => (logisticsDialog.mode === "create" ? "新增物流规则" : "编辑物流规则"));
const cancellationDialogTitle = computed(() => (cancellationDialog.mode === "create" ? "新增取消规则" : "编辑取消规则"));

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("zh-CN");
}

function resetShopFilters() {
  state.filters.shopQuery = "";
  state.filters.shopStatus = "all";
  state.filters.shopPage = 1;
}

function resetPersonFilters() {
  state.filters.personQuery = "";
  state.filters.personStatus = "all";
  state.filters.personPage = 1;
}

function resetRateFilters() {
  state.filters.rateQuery = "";
  state.filters.ratePage = 1;
}

function resetLogisticsFilters() {
  state.filters.logisticsQuery = "";
  state.filters.logisticsStatus = "all";
  state.filters.logisticsPage = 1;
}

function resetCancellationFilters() {
  state.filters.cancellationQuery = "";
  state.filters.cancellationStatus = "all";
  state.filters.cancellationPage = 1;
}

function goSection(key) {
  activeSection.value = key;
}

async function loadSettingsData() {
  loading.value = true;
  try {
    const [shops, people, rates, logisticsRules, cancellationRules] = await Promise.all([
      apiClient.get("/api/shops"),
      apiClient.get("/api/people"),
      apiClient.get("/api/exchange-rates"),
      apiClient.get("/api/logistics-rules"),
      apiClient.get("/api/order-cancellation-rules")
    ]);
    state.shops = Array.isArray(shops) ? shops : [];
    state.people = Array.isArray(people) ? people : [];
    state.rates = Array.isArray(rates) ? rates : [];
    state.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules : [];
    state.cancellationRules = Array.isArray(cancellationRules) ? cancellationRules : [];
  } catch (error) {
    ElMessage.error(error.message || "系统设置页面加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreateShopDialog() {
  shopDialog.mode = "create";
  shopDialog.form = createDefaultShopForm();
  shopDialogVisible.value = true;
}

function openEditShopDialog(row) {
  shopDialog.mode = "edit";
  shopDialog.form = {
    id: row.id,
    name: row.name || "",
    legal_entity: row.legal_entity || "",
    ozon_client_id: row.ozon_client_id || "",
    api_key_hint: row.api_key_hint || "",
    payout_rate: Number(row.payout_rate || 0.33),
    status: row.status || "active"
  };
  shopDialogVisible.value = true;
}

function openCreatePersonDialog() {
  personDialog.mode = "create";
  personDialog.form = createDefaultPersonForm();
  personDialogVisible.value = true;
}

function openEditPersonDialog(row) {
  personDialog.mode = "edit";
  personDialog.form = {
    id: row.id,
    name: row.name || "",
    username: row.username || "",
    role: row.role || "operator",
    active: Number(row.active ?? 1),
    password: ""
  };
  personDialogVisible.value = true;
}

function openCreateRateDialog() {
  rateDialog.mode = "create";
  rateDialog.form = createDefaultRateForm();
  rateDialogVisible.value = true;
}

function openCreateLogisticsDialog() {
  logisticsDialog.mode = "create";
  logisticsDialog.form = createDefaultLogisticsForm();
  logisticsDialogVisible.value = true;
}

function openEditLogisticsDialog(row) {
  logisticsDialog.mode = "edit";
  logisticsDialog.form = {
    ...createDefaultLogisticsForm(),
    ...row,
    id: row.id,
    enabled: Number(row.enabled ?? 1)
  };
  logisticsDialogVisible.value = true;
}

function openCreateCancellationDialog() {
  cancellationDialog.mode = "create";
  cancellationDialog.form = createDefaultCancellationForm();
  cancellationDialogVisible.value = true;
}

function openEditCancellationDialog(row) {
  cancellationDialog.mode = "edit";
  cancellationDialog.form = {
    ...createDefaultCancellationForm(),
    ...row,
    id: row.id,
    priority: Number(row.priority ?? 100),
    enabled: Number(row.enabled ?? 1)
  };
  cancellationDialogVisible.value = true;
}

function closeShopDialog() {
  shopDialogVisible.value = false;
}

function closePersonDialog() {
  personDialogVisible.value = false;
}

function closeRateDialog() {
  rateDialogVisible.value = false;
}

function closeLogisticsDialog() {
  logisticsDialogVisible.value = false;
}

function closeCancellationDialog() {
  cancellationDialogVisible.value = false;
}

function clearShopForm() {
  shopDialog.form = createDefaultShopForm();
  shopFormRef.value?.clearValidate?.();
}

function clearPersonForm() {
  personDialog.form = createDefaultPersonForm();
  personFormRef.value?.clearValidate?.();
}

function clearRateForm() {
  rateDialog.form = createDefaultRateForm();
  rateFormRef.value?.clearValidate?.();
}

function clearLogisticsForm() {
  logisticsDialog.form = createDefaultLogisticsForm();
  logisticsFormRef.value?.clearValidate?.();
}

function clearCancellationForm() {
  cancellationDialog.form = createDefaultCancellationForm();
  cancellationFormRef.value?.clearValidate?.();
}

async function submitShopDialog() {
  await shopFormRef.value?.validate();
  shopDialogSubmitting.value = true;
  try {
    const payload = { ...shopDialog.form, payout_rate: Number(shopDialog.form.payout_rate || 0) };
    if (shopDialog.mode === "create") {
      await apiClient.post("/api/shops", payload);
      ElMessage.success("店铺已新增");
    } else {
      await apiClient.put(`/api/shops/${shopDialog.form.id}`, payload);
      ElMessage.success("店铺已更新");
    }
    shopDialogVisible.value = false;
    await loadSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "店铺保存失败");
  } finally {
    shopDialogSubmitting.value = false;
  }
}

async function submitPersonDialog() {
  await personFormRef.value?.validate();
  personDialogSubmitting.value = true;
  try {
    const payload = { ...personDialog.form, active: Number(personDialog.form.active ?? 1) };
    if (personDialog.mode === "create") {
      await apiClient.post("/api/people", payload);
      ElMessage.success("人员已新增");
    } else {
      await apiClient.put(`/api/people/${personDialog.form.id}`, payload);
      ElMessage.success("人员已更新");
    }
    personDialogVisible.value = false;
    await loadSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "人员保存失败");
  } finally {
    personDialogSubmitting.value = false;
  }
}

async function submitRateDialog() {
  await rateFormRef.value?.validate();
  rateDialogSubmitting.value = true;
  try {
    await apiClient.post("/api/exchange-rate", {
      rate: Number(rateDialog.form.rate || 0),
      effective_date: rateDialog.form.effective_date,
      source: rateDialog.form.source,
      note: rateDialog.form.note
    });
    ElMessage.success("汇率已新增");
    rateDialogVisible.value = false;
    await loadSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "汇率保存失败");
  } finally {
    rateDialogSubmitting.value = false;
  }
}

async function submitLogisticsDialog() {
  await logisticsFormRef.value?.validate();
  logisticsDialogSubmitting.value = true;
  try {
    const payload = {
      ...logisticsDialog.form,
      min_weight_g: Number(logisticsDialog.form.min_weight_g || 0),
      max_weight_g: Number(logisticsDialog.form.max_weight_g || 0),
      min_price_rub: Number(logisticsDialog.form.min_price_rub || 0),
      max_price_rub: Number(logisticsDialog.form.max_price_rub || 0),
      base_fee_cny: Number(logisticsDialog.form.base_fee_cny || 0),
      per_gram_cny: Number(logisticsDialog.form.per_gram_cny || 0),
      per_ticket_cny: Number(logisticsDialog.form.per_ticket_cny || 0),
      enabled: Number(logisticsDialog.form.enabled ?? 1)
    };
    if (logisticsDialog.mode === "create") {
      await apiClient.post("/api/logistics-rules", payload);
      ElMessage.success("物流规则已新增");
    } else {
      await apiClient.put(`/api/logistics-rules/${logisticsDialog.form.id}`, payload);
      ElMessage.success("物流规则已更新");
    }
    logisticsDialogVisible.value = false;
    await loadSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "物流规则保存失败");
  } finally {
    logisticsDialogSubmitting.value = false;
  }
}

async function submitCancellationDialog() {
  await cancellationFormRef.value?.validate();
  cancellationDialogSubmitting.value = true;
  try {
    const payload = {
      ...cancellationDialog.form,
      priority: Number(cancellationDialog.form.priority || 0),
      enabled: Number(cancellationDialog.form.enabled ?? 1)
    };
    if (cancellationDialog.mode === "create") {
      await apiClient.post("/api/order-cancellation-rules", payload);
      ElMessage.success("取消规则已新增");
    } else {
      await apiClient.put(`/api/order-cancellation-rules/${cancellationDialog.form.id}`, payload);
      ElMessage.success("取消规则已更新");
    }
    cancellationDialogVisible.value = false;
    await loadSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "取消规则保存失败");
  } finally {
    cancellationDialogSubmitting.value = false;
  }
}

async function handleDeleteShop(row) {
  try {
    await ElMessageBox.confirm(`确认删除店铺「${row.name || row.id}」吗？`, "删除确认", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/shops/${row.id}`);
    ElMessage.success("店铺已删除");
    await loadSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除失败");
  }
}

async function handleDeletePerson(row) {
  try {
    await ElMessageBox.confirm(`确认停用人员「${row.name || row.id}」吗？`, "停用确认", {
      type: "warning",
      confirmButtonText: "确认停用",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/people/${row.id}`);
    ElMessage.success("人员已停用");
    await loadSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "停用失败");
  }
}

async function handleDeleteLogisticsRule(row) {
  try {
    await ElMessageBox.confirm(`确认停用物流规则「${row.name || row.id}」吗？`, "停用确认", {
      type: "warning",
      confirmButtonText: "确认停用",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/logistics-rules/${row.id}`);
    ElMessage.success("物流规则已停用");
    await loadSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "停用失败");
  }
}

async function handleDeleteCancellationRule(row) {
  try {
    await ElMessageBox.confirm(`确认停用取消规则「${row.name || row.id}」吗？`, "停用确认", {
      type: "warning",
      confirmButtonText: "确认停用",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/order-cancellation-rules/${row.id}`);
    ElMessage.success("取消规则已停用");
    await loadSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "停用失败");
  }
}

onMounted(loadSettingsData);
</script>

<template>
  <div class="page-stack settings-page">
    <el-card shadow="never" class="page-card settings-hero-card">
      <div class="settings-hero">
        <div>
          <el-tag effect="light" type="primary">新架构</el-tag>
          <h2>系统设置</h2>
          <p>旧版配置页不再作为新系统的配置入口。现在按左侧分类进入对应页面，每个页面只处理自己的新增、编辑、删除和刷新。</p>
        </div>
        <div class="page-card-actions">
          <el-button @click="loadSettingsData">刷新数据</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="6">
        <el-card shadow="never" class="page-card settings-section-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>设置分类</strong>
                <span>选择哪一个分类，右侧就管理哪一个分类。</span>
              </div>
            </div>
          </template>
          <div class="settings-section-list">
            <button
              v-for="item in sectionOptions"
              :key="item.key"
              type="button"
              class="settings-section-item"
              :class="{ active: activeSection === item.key }"
              @click="goSection(item.key)"
            >
              <strong>{{ item.label }}</strong>
              <span>{{ item.description }}</span>
            </button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="18">
        <el-card v-if="activeSection === 'shops'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button @click="loadSettingsData">刷新</el-button>
                <el-button type="primary" @click="openCreateShopDialog">新增店铺</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.shopQuery" clearable placeholder="店铺名称 / 主体 / Client ID" style="width: 320px" @keyup.enter="state.filters.shopPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.shopStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="state.filters.shopPage = 1">查询</el-button>
                <el-button @click="resetShopFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedShops" stripe border class="erp-data-table">
              <el-table-column label="店铺信息" min-width="240" fixed="left">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <strong>{{ row.name || "-" }}</strong>
                    <span class="muted-text">主体：{{ row.legal_entity || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="API 配置" min-width="220">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>Client ID：{{ row.ozon_client_id || "-" }}</span>
                    <span class="muted-text">Key 标识：{{ row.api_key_hint || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="结算比例" width="120" align="right">
                <template #default="{ row }">{{ Number(row.payout_rate || 0).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="light">{{ row.status === "active" ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" min-width="140">
                <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button link type="primary" @click="openEditShopDialog(row)">编辑</el-button>
                    <el-button link type="danger" @click="handleDeleteShop(row)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="shopTotal"
            :page="state.filters.shopPage"
            :page-size="state.filters.shopPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.shopPage = $event"
            @update:pageSize="state.filters.shopPageSize = $event; state.filters.shopPage = 1"
          />
        </el-card>

        <el-card v-else-if="activeSection === 'people'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button @click="loadSettingsData">刷新</el-button>
                <el-button type="primary" @click="openCreatePersonDialog">新增人员</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.personQuery" clearable placeholder="姓名 / 登录名 / 角色" style="width: 320px" @keyup.enter="state.filters.personPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.personStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="state.filters.personPage = 1">查询</el-button>
                <el-button @click="resetPersonFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedPeople" stripe border class="erp-data-table">
              <el-table-column label="人员信息" min-width="240">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <strong>{{ row.name || "-" }}</strong>
                    <span class="muted-text">登录名：{{ row.username || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="role" label="角色" width="120" />
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="Number(row.active) !== 0 ? 'success' : 'info'" effect="light">{{ Number(row.active) !== 0 ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="更新时间" min-width="140">
                <template #default="{ row }">{{ formatDate(row.updated_at || row.created_at) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button link type="primary" @click="openEditPersonDialog(row)">编辑</el-button>
                    <el-button link type="danger" @click="handleDeletePerson(row)">停用</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="personTotal"
            :page="state.filters.personPage"
            :page-size="state.filters.personPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.personPage = $event"
            @update:pageSize="state.filters.personPageSize = $event; state.filters.personPage = 1"
          />
        </el-card>

        <el-card v-else-if="activeSection === 'rates'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button @click="loadSettingsData">刷新</el-button>
                <el-button type="primary" @click="openCreateRateDialog">新增汇率</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.rateQuery" clearable placeholder="汇率 / 来源 / 备注 / 日期" style="width: 320px" @keyup.enter="state.filters.ratePage = 1" />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="state.filters.ratePage = 1">查询</el-button>
                <el-button @click="resetRateFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedRates" stripe border class="erp-data-table">
              <el-table-column prop="effective_date" label="生效日期" min-width="120" />
              <el-table-column label="汇率" width="120">
                <template #default="{ row }">{{ Number(row.rate || 0).toFixed(4) }}</template>
              </el-table-column>
              <el-table-column prop="source" label="来源" width="140" />
              <el-table-column prop="note" label="备注" min-width="260" />
            </el-table>
          </div>

          <PageFooterPagination
            :total="rateTotal"
            :page="state.filters.ratePage"
            :page-size="state.filters.ratePageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.ratePage = $event"
            @update:pageSize="state.filters.ratePageSize = $event; state.filters.ratePage = 1"
          />
        </el-card>

        <el-card v-else-if="activeSection === 'logistics'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button @click="loadSettingsData">刷新</el-button>
                <el-button type="primary" @click="openCreateLogisticsDialog">新增物流规则</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.logisticsQuery" clearable placeholder="规则名 / 物流商 / 渠道 / 模式" style="width: 320px" @keyup.enter="state.filters.logisticsPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.logisticsStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="state.filters.logisticsPage = 1">查询</el-button>
                <el-button @click="resetLogisticsFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedLogisticsRules" stripe border class="erp-data-table">
              <el-table-column label="规则" min-width="240" fixed="left">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <strong>{{ row.name || "-" }}</strong>
                    <span class="muted-text">{{ row.carrier || "-" }} / {{ row.channel || "-" }} / {{ row.mode === "fixed" ? "固定费用" : "按克重" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="匹配范围" min-width="200">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>克重：{{ Number(row.min_weight_g || 0) }} - {{ Number(row.max_weight_g || 0) }} g</span>
                    <span class="muted-text">售价：{{ Number(row.min_price_rub || 0) }} - {{ Number(row.max_price_rub || 0) }} RUB</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="费用" min-width="200">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>基础费：{{ Number(row.base_fee_cny || 0).toFixed(3) }}</span>
                    <span class="muted-text">每克：{{ Number(row.per_gram_cny || 0).toFixed(4) }} / 每票：{{ Number(row.per_ticket_cny || 0).toFixed(3) }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="Number(row.enabled) !== 0 ? 'success' : 'info'" effect="light">{{ Number(row.enabled) !== 0 ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button link type="primary" @click="openEditLogisticsDialog(row)">编辑</el-button>
                    <el-button link type="danger" @click="handleDeleteLogisticsRule(row)">停用</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="logisticsTotal"
            :page="state.filters.logisticsPage"
            :page-size="state.filters.logisticsPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.logisticsPage = $event"
            @update:pageSize="state.filters.logisticsPageSize = $event; state.filters.logisticsPage = 1"
          />
        </el-card>

        <el-card v-else shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button @click="loadSettingsData">刷新</el-button>
                <el-button type="primary" @click="openCreateCancellationDialog">新增取消规则</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.cancellationQuery" clearable placeholder="规则名 / 匹配文本 / 原因标签" style="width: 320px" @keyup.enter="state.filters.cancellationPage = 1" />
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="state.filters.cancellationStatus" style="width: 160px">
                  <el-option label="全部状态" value="all" />
                  <el-option label="启用" value="active" />
                  <el-option label="停用" value="inactive" />
                </el-select>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" @click="state.filters.cancellationPage = 1">查询</el-button>
                <el-button @click="resetCancellationFilters">重置</el-button>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-table-wrap">
            <el-table v-loading="loading" :data="pagedCancellationRules" stripe border class="erp-data-table">
              <el-table-column label="规则" min-width="220" fixed="left">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <strong>{{ row.name || "-" }}</strong>
                    <span class="muted-text">{{ row.reason_group_label || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="匹配条件" min-width="260">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>{{ row.match_text || "-" }}</span>
                    <span class="muted-text">{{ row.match_mode || "contains" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="业务标签" min-width="240">
                <template #default="{ row }">
                  <div class="settings-cell-stack">
                    <span>取消方：{{ row.initiator_label || "-" }}</span>
                    <span class="muted-text">原因：{{ row.reason_label || "-" }} / {{ row.reason_code || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="priority" label="优先级" width="100" align="center" />
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="Number(row.enabled) !== 0 ? 'success' : 'info'" effect="light">{{ Number(row.enabled) !== 0 ? "启用" : "停用" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <div class="table-actions">
                    <el-button link type="primary" @click="openEditCancellationDialog(row)">编辑</el-button>
                    <el-button link type="danger" @click="handleDeleteCancellationRule(row)">停用</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <PageFooterPagination
            :total="cancellationTotal"
            :page="state.filters.cancellationPage"
            :page-size="state.filters.cancellationPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.cancellationPage = $event"
            @update:pageSize="state.filters.cancellationPageSize = $event; state.filters.cancellationPage = 1"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="shopDialogVisible" :title="shopDialogTitle" width="720px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearShopForm">
      <el-form ref="shopFormRef" :model="shopDialog.form" :rules="shopFormRules" label-width="110px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="店铺名称" prop="name"><el-input v-model="shopDialog.form.name" placeholder="请输入店铺名称" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="主体名称"><el-input v-model="shopDialog.form.legal_entity" placeholder="请输入主体名称" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="Client ID"><el-input v-model="shopDialog.form.ozon_client_id" placeholder="请输入 Ozon Client ID" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="API Key 标识"><el-input v-model="shopDialog.form.api_key_hint" placeholder="只保存标识，不保存明文密钥" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="结算比例"><el-input-number v-model="shopDialog.form.payout_rate" :min="0" :max="1" :precision="2" :step="0.01" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="shopDialog.form.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closeShopDialog">取消</el-button>
          <el-button type="primary" :loading="shopDialogSubmitting" @click="submitShopDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="personDialogVisible" :title="personDialogTitle" width="720px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearPersonForm">
      <el-form ref="personFormRef" :model="personDialog.form" :rules="personFormRules" label-width="110px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="人员姓名" prop="name"><el-input v-model="personDialog.form.name" placeholder="请输入人员姓名" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="登录名"><el-input v-model="personDialog.form.username" placeholder="可选" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="角色"><el-select v-model="personDialog.form.role"><el-option label="operator" value="operator" /><el-option label="admin" value="admin" /><el-option label="manager" value="manager" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="personDialog.form.active"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="密码"><el-input v-model="personDialog.form.password" type="password" show-password placeholder="编辑时留空表示不修改密码" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closePersonDialog">取消</el-button>
          <el-button type="primary" :loading="personDialogSubmitting" @click="submitPersonDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="rateDialogVisible" :title="rateDialogTitle" width="640px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearRateForm">
      <el-form ref="rateFormRef" :model="rateDialog.form" :rules="rateFormRules" label-width="110px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="汇率" prop="rate"><el-input-number v-model="rateDialog.form.rate" :min="0" :precision="4" :step="0.01" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="生效日期" prop="effective_date"><el-date-picker v-model="rateDialog.form.effective_date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="来源"><el-input v-model="rateDialog.form.source" placeholder="manual / api / import" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="备注"><el-input v-model="rateDialog.form.note" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closeRateDialog">取消</el-button>
          <el-button type="primary" :loading="rateDialogSubmitting" @click="submitRateDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="logisticsDialogVisible" :title="logisticsDialogTitle" width="860px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearLogisticsForm">
      <el-form ref="logisticsFormRef" :model="logisticsDialog.form" :rules="logisticsFormRules" label-width="120px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="规则名称" prop="name"><el-input v-model="logisticsDialog.form.name" placeholder="例如：中国邮政 500g 以下" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="物流商"><el-input v-model="logisticsDialog.form.carrier" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="渠道"><el-input v-model="logisticsDialog.form.channel" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="计费模式"><el-select v-model="logisticsDialog.form.mode"><el-option label="按克重" value="per_gram" /><el-option label="固定费用" value="fixed" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最小克重"><el-input-number v-model="logisticsDialog.form.min_weight_g" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最大克重"><el-input-number v-model="logisticsDialog.form.max_weight_g" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最低售价(RUB)"><el-input-number v-model="logisticsDialog.form.min_price_rub" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="最高售价(RUB)"><el-input-number v-model="logisticsDialog.form.max_price_rub" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="基础费用(RMB)"><el-input-number v-model="logisticsDialog.form.base_fee_cny" :min="0" :precision="3" :step="0.001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="每克费用(RMB)"><el-input-number v-model="logisticsDialog.form.per_gram_cny" :min="0" :precision="4" :step="0.0001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="每票费用(RMB)"><el-input-number v-model="logisticsDialog.form.per_ticket_cny" :min="0" :precision="3" :step="0.001" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="logisticsDialog.form.enabled"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="logisticsDialog.form.note" type="textarea" :rows="3" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closeLogisticsDialog">取消</el-button>
          <el-button type="primary" :loading="logisticsDialogSubmitting" @click="submitLogisticsDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="cancellationDialogVisible" :title="cancellationDialogTitle" width="860px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearCancellationForm">
      <el-form ref="cancellationFormRef" :model="cancellationDialog.form" :rules="cancellationFormRules" label-width="120px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="规则名称" prop="name"><el-input v-model="cancellationDialog.form.name" placeholder="例如：买家未取货" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="匹配文本" prop="match_text"><el-input v-model="cancellationDialog.form.match_text" placeholder="例如：не забрал" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="匹配模式"><el-select v-model="cancellationDialog.form.match_mode"><el-option label="包含" value="contains" /><el-option label="完全等于" value="equals" /><el-option label="前缀匹配" value="starts_with" /><el-option label="正则" value="regex" /></el-select></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="取消方标签"><el-input v-model="cancellationDialog.form.initiator_label" placeholder="买家 / 卖家 / 平台" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因标签"><el-input v-model="cancellationDialog.form.reason_label" placeholder="例如：买家未取货" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因编码"><el-input v-model="cancellationDialog.form.reason_code" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="原因分组"><el-input v-model="cancellationDialog.form.reason_group_label" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="优先级"><el-input-number v-model="cancellationDialog.form.priority" :min="0" :precision="0" :step="1" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="cancellationDialog.form.enabled"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="口径说明"><el-input v-model="cancellationDialog.form.accounting_hint" type="textarea" :rows="2" placeholder="例如：通常不计入有效销售，真实损失按拒收模型处理" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="cancellationDialog.form.note" type="textarea" :rows="2" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="closeCancellationDialog">取消</el-button>
          <el-button type="primary" :loading="cancellationDialogSubmitting" @click="submitCancellationDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.settings-page { gap: 16px; }
.settings-hero-card { background: linear-gradient(180deg, rgba(231, 240, 255, 0.92), rgba(255, 255, 255, 0.98)); }
.settings-hero { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.settings-hero h2 { margin: 10px 0 8px; font-size: 24px; }
.settings-hero p { margin: 0; color: var(--erp-text-secondary); line-height: 1.7; max-width: 760px; }
.settings-section-card { height: 100%; }
.settings-list-card { height: calc(100vh - 330px); min-height: 520px; display: flex; flex-direction: column; }
.settings-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.settings-section-list { display: flex; flex-direction: column; gap: 10px; }
.settings-section-item { width: 100%; padding: 16px 14px; border-radius: 14px; border: 1px solid var(--erp-border); background: var(--erp-surface-alt); text-align: left; cursor: pointer; transition: all 0.2s ease; }
.settings-section-item strong { display: block; margin-bottom: 6px; color: var(--erp-text); }
.settings-section-item span { display: block; color: var(--erp-text-secondary); font-size: 12px; line-height: 1.6; }
.settings-section-item.active { border-color: rgba(37, 99, 235, 0.28); background: var(--erp-primary-soft); box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.08); }
.settings-header-actions, .dialog-footer, .table-actions, .settings-cell-stack { display: flex; }
.settings-header-actions, .dialog-footer { align-items: center; gap: 12px; }
.dialog-footer { justify-content: flex-end; }
.settings-cell-stack { flex-direction: column; gap: 4px; }
.table-actions { align-items: center; flex-wrap: wrap; gap: 2px 10px; }
.muted-text { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
@media (max-width: 960px) {
  .settings-hero { flex-direction: column; align-items: flex-start; }
  .settings-list-card { height: auto; min-height: 0; }
}
</style>
