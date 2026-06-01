<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { uploadShopWatermark } from "../../api/tools/imageCropper";
import AuthenticatedImage from "../../components/AuthenticatedImage.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText, shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const activeSection = ref("shops");

const shopDialogVisible = ref(false);
const shopDialogSubmitting = ref(false);
const shopWatermarkUploading = ref(false);
const shopWatermarkDrag = ref(null);
const shopWatermarkPreviewVersion = ref(0);
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
const packagingRuleSubmitting = ref(false);
const historicalRecalcSubmitting = ref(false);
const loadedSections = reactive({
  shops: false,
  people: false,
  rates: false,
  profit: false,
  logistics: false,
  cancel: false
});

const state = reactive({
  shops: [],
  people: [],
  rates: [],
  logisticsRules: [],
  cancellationRules: [],
  packagingFeeRule: createDefaultPackagingFeeRule(),
  packagingFeeRuleChanges: [],
  packagingFeeRecalc: createDefaultPackagingFeeRecalc(),
  packagingFeeRecalcResult: null,
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
  { key: "profit", label: "利润规则", description: "维护利润测算中的包装费阈值和收费规则。" },
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
  profit: {
    title: "利润规则",
    description: "这里维护利润测算中的包装费规则，修改后新测算会按新规则执行。"
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
    updated_at: "",
    name: "",
    legal_entity: "",
    ozon_client_id: "",
    api_key_hint: "",
    ozon_api_key: "",
    performance_client_id: "",
    performance_client_secret: "",
    performance_client_secret_hint: "",
    performance_client_secret_configured: false,
    watermark_path: "",
    watermark_name: "",
    watermark_position: "bottom-right",
    watermark_x_percent: 75,
    watermark_y_percent: 75,
    watermark_scale_percent: 22,
    watermark_opacity_percent: 82,
    payout_rate: 0.33,
    status: "active"
  };
}

function createDefaultPersonForm() {
  return {
    id: null,
    updated_at: "",
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
    effective_date: shanghaiDateKey(),
    source: "manual",
    note: ""
  };
}

function createDefaultLogisticsForm() {
  return {
    id: null,
    updated_at: "",
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
    filter_keywords: "",
    note: ""
  };
}

function createDefaultPackagingFeeRule() {
  return {
    low_sale_threshold_cny: 50,
    low_fee_cny: 0.5,
    high_fee_cny: 1
  };
}

function createDefaultPackagingFeeRecalc() {
  const today = shanghaiDateKey();
  const last30 = shanghaiDateDaysAgo(29);
  return {
    from: last30,
    to: today,
    only_final: 1,
    only_with_finance: 1
  };
}

function createDefaultCancellationForm() {
  return {
    id: null,
    updated_at: "",
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
const shopWatermarkPreviewUrl = computed(() => {
  if (!shopDialog.form.id || !shopDialog.form.watermark_path) return "";
  return `/api/tools/image-cropper/shop-watermark/${encodeURIComponent(shopDialog.form.id)}/file?v=${shopWatermarkPreviewVersion.value}`;
});
const shopWatermarkSampleImage = computed(() => (
  "/preview-assets/shop-watermark-background.png"
));
const shopWatermarkOverlayStyle = computed(() => {
  const form = shopDialog.form;
  const base = {
    width: `${clampPercent(Number(form.watermark_scale_percent || 22), 8, 45)}%`,
    opacity: clampPercent(Number(form.watermark_opacity_percent || 82), 10, 100) / 100,
    cursor: "grab"
  };
  const position = String(form.watermark_position || "bottom-right");
  if (position === "custom") {
    return {
      ...base,
      left: `${clampPercent(Number(form.watermark_x_percent ?? 75), 0, 100)}%`,
      top: `${clampPercent(Number(form.watermark_y_percent ?? 75), 0, 100)}%`
    };
  }
  if (position === "top-left") return { ...base, top: "3.5%", left: "3.5%" };
  if (position === "top-right") return { ...base, top: "3.5%", right: "3.5%" };
  if (position === "bottom-left") return { ...base, bottom: "3.5%", left: "3.5%" };
  if (position === "center") return { ...base, top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  return { ...base, right: "3.5%", bottom: "3.5%" };
});

const shopWatermarkPositionOptions = [
  { label: "左上", value: "top-left" },
  { label: "右上", value: "top-right" },
  { label: "居中", value: "center" },
  { label: "左下", value: "bottom-left" },
  { label: "右下", value: "bottom-right" }
];

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function formatDate(value) {
  return shanghaiDateText(value, { assumeUtcWhenNaive: true });
}

function formatDateTime(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function maskCredential(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  if (text.includes("*")) return text;
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function secretConfiguredText(configured, hint) {
  return configured ? maskCredential(hint || "已配置") : "未配置";
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

async function loadSettingsData(force = false) {
  loading.value = true;
  try {
    await loadSectionData(activeSection.value, force);
    return;
    const [shops, people, rates, packagingFeeRule, packagingFeeRuleChanges, logisticsRules, cancellationRules] = await Promise.all([
      apiClient.get("/api/shops"),
      apiClient.get("/api/people"),
      apiClient.get("/api/exchange-rates"),
      apiClient.get("/api/settings/packaging-fee-rule"),
      apiClient.get("/api/settings/packaging-fee-rule/changes?limit=10"),
      apiClient.get("/api/logistics-rules"),
      apiClient.get("/api/order-cancellation-rules")
    ]);
    state.shops = Array.isArray(shops) ? shops : [];
    state.people = Array.isArray(people) ? people : [];
    state.rates = Array.isArray(rates) ? rates : [];
    state.packagingFeeRule = {
      ...createDefaultPackagingFeeRule(),
      ...(packagingFeeRule || {})
    };
    state.packagingFeeRuleChanges = Array.isArray(packagingFeeRuleChanges) ? packagingFeeRuleChanges : [];
    state.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules : [];
    state.cancellationRules = Array.isArray(cancellationRules) ? cancellationRules : [];
  } catch (error) {
    ElMessage.error(error.message || "系统设置页面加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadSectionData(section, force = false) {
  if (!force && loadedSections[section]) return;
  if (section === "shops") {
    const shops = await apiClient.get("/api/shops");
    state.shops = Array.isArray(shops) ? shops : [];
  } else if (section === "people") {
    const people = await apiClient.get("/api/people");
    state.people = Array.isArray(people) ? people : [];
  } else if (section === "rates") {
    const rates = await apiClient.get("/api/exchange-rates");
    state.rates = Array.isArray(rates) ? rates : [];
  } else if (section === "profit") {
    const [packagingFeeRule, packagingFeeRuleChanges] = await Promise.all([
      apiClient.get("/api/settings/packaging-fee-rule"),
      apiClient.get("/api/settings/packaging-fee-rule/changes?limit=10")
    ]);
    state.packagingFeeRule = {
      ...createDefaultPackagingFeeRule(),
      ...(packagingFeeRule || {})
    };
    state.packagingFeeRuleChanges = Array.isArray(packagingFeeRuleChanges) ? packagingFeeRuleChanges : [];
  } else if (section === "logistics") {
    const logisticsRules = await apiClient.get("/api/logistics-rules");
    state.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules : [];
  } else if (section === "cancel") {
    const cancellationRules = await apiClient.get("/api/order-cancellation-rules");
    state.cancellationRules = Array.isArray(cancellationRules) ? cancellationRules : [];
  }
  loadedSections[section] = true;
}

async function refreshSettingsData() {
  return loadSettingsData(true);
}

function openCreateShopDialog() {
  shopDialog.mode = "create";
  shopDialog.form = createDefaultShopForm();
  shopDialogVisible.value = true;
}

function openEditShopDialog(row) {
  shopDialog.mode = "edit";
  shopWatermarkPreviewVersion.value += 1;
  shopDialog.form = {
    id: row.id,
    updated_at: row.updated_at || "",
    name: row.name || "",
    legal_entity: row.legal_entity || "",
    ozon_client_id: row.ozon_client_id || "",
    api_key_hint: row.api_key_hint || "",
    ozon_api_key: row.ozon_api_key || "",
    performance_client_id: row.performance_client_id || "",
    performance_client_secret: "",
    performance_client_secret_hint: row.performance_client_secret_hint || "",
    performance_client_secret_configured: Boolean(row.performance_client_secret_configured),
    watermark_path: row.watermark_path || "",
    watermark_name: row.watermark_name || "",
    watermark_position: normalizeWatermarkPosition(row.watermark_position),
    watermark_x_percent: clampPercent(Number(row.watermark_x_percent ?? 75), 0, 100),
    watermark_y_percent: clampPercent(Number(row.watermark_y_percent ?? 75), 0, 100),
    watermark_scale_percent: clampPercent(Number(row.watermark_scale_percent ?? 22), 8, 45),
    watermark_opacity_percent: clampPercent(Number(row.watermark_opacity_percent ?? 82), 10, 100),
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
    updated_at: row.updated_at || "",
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
  stopShopWatermarkDrag();
  shopDialog.form = createDefaultShopForm();
  shopWatermarkUploading.value = false;
  shopFormRef.value?.clearValidate?.();
}

function validateShopWatermarkFile(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    ElMessage.error("水印仅支持 JPG、PNG、WEBP 图片");
    return false;
  }
  if (file.size > 25 * 1024 * 1024) {
    ElMessage.error("水印图片不能超过 25MB");
    return false;
  }
  return true;
}

async function uploadShopWatermarkRequest(options) {
  if (!shopDialog.form.id || !validateShopWatermarkFile(options.file)) return;
  shopWatermarkUploading.value = true;
  try {
    const result = await uploadShopWatermark(shopDialog.form.id, options.file);
    shopDialog.form.watermark_name = result.watermark_name || options.file.name;
    shopDialog.form.watermark_path = result.watermark_path || shopDialog.form.watermark_path || "uploaded";
    shopWatermarkPreviewVersion.value += 1;
    const row = state.shops.find((item) => Number(item.id) === Number(shopDialog.form.id));
    if (row) {
      row.watermark_name = shopDialog.form.watermark_name;
      row.watermark_path = shopDialog.form.watermark_path;
    }
    options.onSuccess?.(result);
    ElMessage.success("店铺水印已上传");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "店铺水印上传失败");
  } finally {
    shopWatermarkUploading.value = false;
  }
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
    const payload = {
      ...shopDialog.form,
      watermark_position: normalizeWatermarkPosition(shopDialog.form.watermark_position),
      watermark_x_percent: clampPercent(Number(shopDialog.form.watermark_x_percent ?? 75), 0, 100),
      watermark_y_percent: clampPercent(Number(shopDialog.form.watermark_y_percent ?? 75), 0, 100),
      watermark_scale_percent: clampPercent(Number(shopDialog.form.watermark_scale_percent ?? 22), 8, 45),
      watermark_opacity_percent: clampPercent(Number(shopDialog.form.watermark_opacity_percent ?? 82), 10, 100),
      payout_rate: Number(shopDialog.form.payout_rate || 0)
    };
    if (shopDialog.mode === "create") {
      await apiClient.post("/api/shops", payload);
      ElMessage.success("店铺已新增");
    } else {
      await apiClient.put(`/api/shops/${shopDialog.form.id}`, payload);
      ElMessage.success("店铺已更新");
    }
    shopDialogVisible.value = false;
    await refreshSettingsData();
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
    await refreshSettingsData();
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
    await refreshSettingsData();
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
    await refreshSettingsData();
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
    await refreshSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "取消规则保存失败");
  } finally {
    cancellationDialogSubmitting.value = false;
  }
}

async function submitPackagingFeeRule() {
  packagingRuleSubmitting.value = true;
  try {
    const payload = {
      low_sale_threshold_cny: Number(state.packagingFeeRule.low_sale_threshold_cny || 0),
      low_fee_cny: Number(state.packagingFeeRule.low_fee_cny || 0),
      high_fee_cny: Number(state.packagingFeeRule.high_fee_cny || 0)
    };
    const saved = await apiClient.post("/api/settings/packaging-fee-rule", payload);
    state.packagingFeeRule = {
      ...createDefaultPackagingFeeRule(),
      ...(saved || {})
    };
    ElMessage.success("包装费规则已更新");
    await refreshSettingsData();
  } catch (error) {
    ElMessage.error(error.message || "包装费规则保存失败");
  } finally {
    packagingRuleSubmitting.value = false;
  }
}

async function submitHistoricalProfitRecalc() {
  historicalRecalcSubmitting.value = true;
  try {
    const payload = {
      from: state.packagingFeeRecalc.from,
      to: state.packagingFeeRecalc.to,
      only_final: Number(state.packagingFeeRecalc.only_final ?? 1),
      only_with_finance: Number(state.packagingFeeRecalc.only_with_finance ?? 1)
    };
    const result = await apiClient.post("/api/profits/recalculate-historical", payload);
    state.packagingFeeRecalcResult = result || null;
    ElMessage.success(`历史利润重算完成：${Number(result.updated_orders || 0)} 单 / ${Number(result.updated_items || 0)} 行`);
  } catch (error) {
    ElMessage.error(error.message || "历史利润重算失败");
  } finally {
    historicalRecalcSubmitting.value = false;
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
    await refreshSettingsData();
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
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "停用失败");
  }
}

async function toggleLogisticsRule(row) {
  const nextEnabled = Number(row.enabled) === 0 ? 1 : 0;
  const actionText = nextEnabled === 0 ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(`确认${actionText}物流规则「${row.name || row.id}」吗？`, `${actionText}确认`, {
      type: "warning",
      confirmButtonText: `确认${actionText}`,
      cancelButtonText: "取消"
    });
    await apiClient.put(`/api/logistics-rules/${row.id}`, {
      ...row,
      enabled: nextEnabled
    });
    ElMessage.success(`物流规则已${actionText}`);
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || `${actionText}失败`);
  }
}

async function toggleCancellationRule(row) {
  const nextEnabled = Number(row.enabled) === 0 ? 1 : 0;
  const actionText = nextEnabled === 0 ? "停用" : "启用";
  try {
    await ElMessageBox.confirm(`确认${actionText}取消规则「${row.name || row.id}」吗？`, `${actionText}确认`, {
      type: "warning",
      confirmButtonText: `确认${actionText}`,
      cancelButtonText: "取消"
    });
    await apiClient.put(`/api/order-cancellation-rules/${row.id}`, {
      ...row,
      enabled: nextEnabled
    });
    ElMessage.success(`取消规则已${actionText}`);
    await refreshSettingsData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || `${actionText}失败`);
  }
}

function normalizeWatermarkPosition(value) {
  const position = String(value || "bottom-right");
  return ["top-left", "top-right", "bottom-left", "bottom-right", "center", "custom"].includes(position)
    ? position
    : "bottom-right";
}

function clampPercent(value, minimum = 0, maximum = 100) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function resetShopWatermarkOptions() {
  Object.assign(shopDialog.form, {
    watermark_position: "bottom-right",
    watermark_x_percent: 75,
    watermark_y_percent: 75,
    watermark_scale_percent: 22,
    watermark_opacity_percent: 82
  });
}

function startShopWatermarkDrag(event) {
  if (!shopWatermarkPreviewUrl.value) return;
  const overlay = event.currentTarget;
  const stage = overlay.closest(".shop-watermark-preview-stage");
  if (!stage) return;
  event.preventDefault();
  overlay.setPointerCapture?.(event.pointerId);
  const overlayRect = overlay.getBoundingClientRect();
  shopWatermarkDrag.value = {
    pointerId: event.pointerId,
    stage,
    overlay,
    offsetX: event.clientX - overlayRect.left,
    offsetY: event.clientY - overlayRect.top
  };
  moveShopWatermarkDrag(event);
  window.addEventListener("pointermove", moveShopWatermarkDrag);
  window.addEventListener("pointerup", stopShopWatermarkDrag);
  window.addEventListener("pointercancel", stopShopWatermarkDrag);
}

function moveShopWatermarkDrag(event) {
  const drag = shopWatermarkDrag.value;
  if (!drag) return;
  const stageRect = drag.stage.getBoundingClientRect();
  const overlayRect = drag.overlay.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;
  const maxX = Math.max(0, ((stageRect.width - overlayRect.width) / stageRect.width) * 100);
  const maxY = Math.max(0, ((stageRect.height - overlayRect.height) / stageRect.height) * 100);
  Object.assign(shopDialog.form, {
    watermark_position: "custom",
    watermark_x_percent: clampPercent(((event.clientX - stageRect.left - drag.offsetX) / stageRect.width) * 100, 0, maxX),
    watermark_y_percent: clampPercent(((event.clientY - stageRect.top - drag.offsetY) / stageRect.height) * 100, 0, maxY)
  });
}

function stopShopWatermarkDrag(event) {
  const drag = shopWatermarkDrag.value;
  if (drag?.overlay && event?.pointerId === drag.pointerId) {
    drag.overlay.releasePointerCapture?.(event.pointerId);
  }
  shopWatermarkDrag.value = null;
  window.removeEventListener("pointermove", moveShopWatermarkDrag);
  window.removeEventListener("pointerup", stopShopWatermarkDrag);
  window.removeEventListener("pointercancel", stopShopWatermarkDrag);
}

watch(activeSection, (section) => {
  loadSectionData(section, false);
});

onMounted(() => {
  loadSettingsData(false);
});

onBeforeUnmount(() => {
  stopShopWatermarkDrag();
});
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
          <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新数据</el-button>
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
        <section v-if="activeSection === 'shops'" class="shop-config-workbench">
          <header class="shop-config-header">
            <div>
              <span>配置工作台</span>
              <strong>{{ currentSectionMeta.title }}</strong>
              <p>{{ currentSectionMeta.description }}</p>
            </div>
            <div class="shop-config-metrics">
              <div>
                <span>店铺总数</span>
                <strong>{{ shopTotal }}</strong>
              </div>
              <div>
                <span>启用店铺</span>
                <strong>{{ filteredShops.filter((row) => row.status === "active").length }}</strong>
              </div>
              <div>
                <span>已配水印</span>
                <strong>{{ filteredShops.filter((row) => row.watermark_path).length }}</strong>
              </div>
            </div>
            <div class="settings-header-actions">
              <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
              <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateShopDialog">新增店铺</el-button>
            </div>
          </header>

          <div class="shop-config-content">
            <div class="shop-config-panel shop-filter-panel">
              <div>
                <div class="section-head compact">
                  <span>01</span>
                  <strong>筛选条件</strong>
                </div>
              </div>
              <el-form class="shop-filter-form">
                <el-form-item label="关键词">
                  <el-input v-model="state.filters.shopQuery" clearable placeholder="店铺名称 / 主体 / Client ID" @keyup.enter="state.filters.shopPage = 1" />
                </el-form-item>
                <el-form-item label="状态">
                  <el-select v-model="state.filters.shopStatus">
                    <el-option label="全部状态" value="all" />
                    <el-option label="启用" value="active" />
                    <el-option label="停用" value="inactive" />
                  </el-select>
                </el-form-item>
                <el-form-item class="shop-filter-actions">
                  <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.shopPage = 1">查询</el-button>
                  <el-button class="erp-btn erp-btn-secondary" @click="resetShopFilters">重置</el-button>
                </el-form-item>
              </el-form>
            </div>

            <div class="shop-config-panel shop-table-panel">
              <div class="section-head compact">
                <span>02</span>
                <strong>店铺与密钥配置</strong>
              </div>
              <div class="settings-table-wrap">
                <el-table v-loading="loading" :data="pagedShops" stripe class="erp-data-table shop-config-table">
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
                    <span class="muted-text">Key 标识：{{ maskCredential(row.api_key_hint) }}</span>
                    <span>广告 Client：{{ row.performance_client_id || "-" }}</span>
                    <span class="muted-text">广告 Secret：{{ secretConfiguredText(row.performance_client_secret_configured, row.performance_client_secret_hint) }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="结算比例" width="120" align="right">
                <template #default="{ row }">{{ Number(row.payout_rate || 0).toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="水印" min-width="190">
                <template #default="{ row }">
                  <div class="shop-watermark-table-cell">
                    <AuthenticatedImage
                      v-if="row.watermark_path"
                      :src="`/api/tools/image-cropper/shop-watermark/${encodeURIComponent(row.id)}/file`"
                      :alt="`${row.name || '店铺'}水印`"
                    />
                    <div class="settings-cell-stack">
                      <strong>{{ row.watermark_path ? "已配置" : "未配置" }}</strong>
                      <span class="muted-text">{{ row.watermark_name || "编辑店铺后上传水印" }}</span>
                    </div>
                  </div>
                </template>
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
                    <el-button class="erp-btn-link" link type="primary" @click="openEditShopDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="handleDeleteShop(row)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
              </div>
            </div>
          </div>

          <PageFooterPagination
            :total="shopTotal"
            :page="state.filters.shopPage"
            :page-size="state.filters.shopPageSize"
            :page-sizes="[10, 20, 50]"
            @update:page="state.filters.shopPage = $event"
            @update:pageSize="state.filters.shopPageSize = $event; state.filters.shopPage = 1"
          />
        </section>

        <el-card v-else-if="activeSection === 'people'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreatePersonDialog">新增人员</el-button>
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
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.personPage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetPersonFilters">重置</el-button>
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
                    <el-button class="erp-btn-link" link type="primary" @click="openEditPersonDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="handleDeletePerson(row)">停用</el-button>
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
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateRateDialog">新增汇率</el-button>
              </div>
            </div>
          </template>

          <div class="filter-panel">
            <el-form inline>
              <el-form-item label="关键词">
                <el-input v-model="state.filters.rateQuery" clearable placeholder="汇率 / 来源 / 备注 / 日期" style="width: 320px" @keyup.enter="state.filters.ratePage = 1" />
              </el-form-item>
              <el-form-item>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.ratePage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetRateFilters">重置</el-button>
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

        <el-card v-else-if="activeSection === 'profit'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" :loading="packagingRuleSubmitting" @click="submitPackagingFeeRule">保存规则</el-button>
                <el-button class="erp-btn erp-btn-secondary" :loading="historicalRecalcSubmitting" @click="submitHistoricalProfitRecalc">重算历史利润</el-button>
              </div>
            </div>
          </template>

          <div class="settings-table-wrap">
            <div class="page-stack" style="padding: 4px 0">
              <el-card shadow="never">
                <template #header>
                  <div class="page-card-header">
                    <div>
                      <strong>包装费规则</strong>
                      <span>按销售额阈值切换低档和高档包装费，影响利润估算和利润拆解。</span>
                    </div>
                  </div>
                </template>
                <el-form label-width="180px" style="max-width: 720px">
                  <el-form-item label="低档销售额阈值 CNY">
                    <el-input-number v-model="state.packagingFeeRule.low_sale_threshold_cny" :min="0" :precision="2" :step="1" controls-position="right" />
                  </el-form-item>
                  <el-form-item label="低档包装费 CNY">
                    <el-input-number v-model="state.packagingFeeRule.low_fee_cny" :min="0" :precision="2" :step="0.1" controls-position="right" />
                  </el-form-item>
                  <el-form-item label="高档包装费 CNY">
                    <el-input-number v-model="state.packagingFeeRule.high_fee_cny" :min="0" :precision="2" :step="0.1" controls-position="right" />
                  </el-form-item>
                  <el-form-item label="当前口径说明">
                    <div class="settings-cell-stack">
                      <span>销售额小于等于 {{ Number(state.packagingFeeRule.low_sale_threshold_cny || 0).toFixed(2) }} 时，包装费按 CNY {{ Number(state.packagingFeeRule.low_fee_cny || 0).toFixed(2) }} 计算。</span>
                      <span class="muted-text">销售额高于该阈值时，包装费按 CNY {{ Number(state.packagingFeeRule.high_fee_cny || 0).toFixed(2) }} 计算。</span>
                    </div>
                  </el-form-item>
                  <el-form-item label="风险提示">
                    <div class="settings-cell-stack">
                      <span>该规则只影响后续的新测算、重算和未锁定利润明细。</span>
                      <span class="muted-text">已经锁定或已入账的历史利润不会因这里的修改被自动回刷。</span>
                    </div>
                  </el-form-item>
                </el-form>
              </el-card>

              <el-card shadow="never">
                <template #header>
                  <div class="page-card-header">
                    <div>
                      <strong>最近变更</strong>
                      <span>记录最近 10 次包装费规则调整，便于追溯是谁改了什么。</span>
                    </div>
                  </div>
                </template>
                <el-table :data="state.packagingFeeRuleChanges" stripe border class="erp-data-table">
                  <el-table-column label="变更时间" min-width="180">
                    <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
                  </el-table-column>
                  <el-table-column label="操作人" min-width="140">
                    <template #default="{ row }">{{ row.updated_by_name || "系统" }}</template>
                  </el-table-column>
                  <el-table-column label="变更前" min-width="260">
                    <template #default="{ row }">
                      <div class="settings-cell-stack">
                        <span>阈值 {{ Number(row.old_value?.low_sale_threshold_cny || 0).toFixed(2) }}</span>
                        <span class="muted-text">低档 {{ Number(row.old_value?.low_fee_cny || 0).toFixed(2) }} / 高档 {{ Number(row.old_value?.high_fee_cny || 0).toFixed(2) }}</span>
                      </div>
                    </template>
                  </el-table-column>
                  <el-table-column label="变更后" min-width="260">
                    <template #default="{ row }">
                      <div class="settings-cell-stack">
                        <span>阈值 {{ Number(row.new_value?.low_sale_threshold_cny || 0).toFixed(2) }}</span>
                        <span class="muted-text">低档 {{ Number(row.new_value?.low_fee_cny || 0).toFixed(2) }} / 高档 {{ Number(row.new_value?.high_fee_cny || 0).toFixed(2) }}</span>
                      </div>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>

              <el-card shadow="never">
                <template #header>
                  <div class="page-card-header">
                    <div>
                      <strong>历史利润辅助重算</strong>
                      <span>用于在修改利润规则后，批量重算指定范围内的未锁定历史利润。</span>
                    </div>
                  </div>
                </template>
                <el-form label-width="180px" style="max-width: 720px">
                  <el-form-item label="开始日期">
                    <el-date-picker v-model="state.packagingFeeRecalc.from" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
                  </el-form-item>
                  <el-form-item label="结束日期">
                    <el-date-picker v-model="state.packagingFeeRecalc.to" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
                  </el-form-item>
                  <el-form-item label="只重算最终订单">
                    <el-switch v-model="state.packagingFeeRecalc.only_final" :active-value="1" :inactive-value="0" />
                  </el-form-item>
                  <el-form-item label="只重算已有财务订单">
                    <el-switch v-model="state.packagingFeeRecalc.only_with_finance" :active-value="1" :inactive-value="0" />
                  </el-form-item>
                  <el-form-item label="执行说明">
                    <div class="settings-cell-stack">
                      <span>默认只处理最终订单且已有财务数据的区间，风险最低，适合规则变更后的历史修正。</span>
                      <span class="muted-text">已锁定或已入账的利润明细不会被未授权地回刷；系统会优先复用已同步的财务结果。</span>
                    </div>
                  </el-form-item>
                </el-form>
              </el-card>

              <el-card v-if="state.packagingFeeRecalcResult" shadow="never">
                <template #header>
                  <div class="page-card-header">
                    <div>
                      <strong>最近一次重算结果</strong>
                      <span>展示当前页面最近一次手动执行历史利润重算的返回摘要。</span>
                    </div>
                  </div>
                </template>
                <el-descriptions :column="2" border>
                  <el-descriptions-item label="重算范围">{{ state.packagingFeeRecalcResult.from || "-" }} 至 {{ state.packagingFeeRecalcResult.to || "-" }}</el-descriptions-item>
                  <el-descriptions-item label="范围口径">{{ state.packagingFeeRecalcResult.scope === "final_orders" ? "最终订单" : "全部订单" }}</el-descriptions-item>
                  <el-descriptions-item label="订单数">{{ Number(state.packagingFeeRecalcResult.orders || 0) }}</el-descriptions-item>
                  <el-descriptions-item label="更新订单">{{ Number(state.packagingFeeRecalcResult.updated_orders || 0) }}</el-descriptions-item>
                  <el-descriptions-item label="更新明细">{{ Number(state.packagingFeeRecalcResult.updated_items || 0) }}</el-descriptions-item>
                  <el-descriptions-item label="未绑定项">{{ Number(state.packagingFeeRecalcResult.unbound || 0) }}</el-descriptions-item>
                  <el-descriptions-item label="仅财务订单">{{ Number(state.packagingFeeRecalcResult.only_with_finance || 0) !== 0 ? "是" : "否" }}</el-descriptions-item>
                  <el-descriptions-item label="财务重放">{{ Number(state.packagingFeeRecalcResult.finance_reapplied || 0) }}</el-descriptions-item>
                </el-descriptions>
              </el-card>
            </div>
          </div>
        </el-card>

        <el-card v-else-if="activeSection === 'logistics'" shadow="never" class="page-card settings-list-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>{{ currentSectionMeta.title }}</strong>
                <span>{{ currentSectionMeta.description }}</span>
              </div>
              <div class="settings-header-actions">
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateLogisticsDialog">新增物流规则</el-button>
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
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.logisticsPage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetLogisticsFilters">重置</el-button>
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
                    <el-button class="erp-btn-link" link type="primary" @click="openEditLogisticsDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link" link :type="Number(row.enabled) !== 0 ? 'danger' : 'success'" @click="toggleLogisticsRule(row)">{{ Number(row.enabled) !== 0 ? "停用" : "启用" }}</el-button>
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
                <el-button class="erp-btn erp-btn-secondary" @click="refreshSettingsData">刷新</el-button>
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateCancellationDialog">新增取消规则</el-button>
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
                <el-button class="erp-btn erp-btn-primary" type="primary" @click="state.filters.cancellationPage = 1">查询</el-button>
                <el-button class="erp-btn erp-btn-secondary" @click="resetCancellationFilters">重置</el-button>
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
                    <el-button class="erp-btn-link" link type="primary" @click="openEditCancellationDialog(row)">编辑</el-button>
                    <el-button class="erp-btn-link" link :type="Number(row.enabled) !== 0 ? 'danger' : 'success'" @click="toggleCancellationRule(row)">{{ Number(row.enabled) !== 0 ? "停用" : "启用" }}</el-button>
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

    <el-dialog v-model="shopDialogVisible" :title="shopDialogTitle" width="980px" align-center class="erp-centered-dialog" destroy-on-close @closed="clearShopForm">
      <el-form ref="shopFormRef" :model="shopDialog.form" :rules="shopFormRules" label-width="110px">
        <el-row :gutter="18">
          <el-col :span="12"><el-form-item label="店铺名称" prop="name"><el-input v-model="shopDialog.form.name" placeholder="请输入店铺名称" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="主体名称"><el-input v-model="shopDialog.form.legal_entity" placeholder="请输入主体名称" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="Client ID"><el-input v-model="shopDialog.form.ozon_client_id" placeholder="请输入 Ozon Client ID" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="API Key"><el-input v-model="shopDialog.form.ozon_api_key" type="password" show-password placeholder="Ozon Seller API Key，用于真实同步和上架" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="Key 标识"><el-input v-model="shopDialog.form.api_key_hint" placeholder="备注标识；未填 API Key 时兼容旧密钥字段" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="广告 Client ID"><el-input v-model="shopDialog.form.performance_client_id" placeholder="Ozon Performance Client ID" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="广告 Secret">
              <el-input
                v-model="shopDialog.form.performance_client_secret"
                type="password"
                show-password
                :placeholder="shopDialog.form.performance_client_secret_configured ? `已配置 ${shopDialog.form.performance_client_secret_hint || ''}，留空不修改` : 'Ozon Performance Client Secret'"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="结算比例"><el-input-number v-model="shopDialog.form.payout_rate" :min="0" :max="1" :precision="2" :step="0.01" controls-position="right" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="状态"><el-select v-model="shopDialog.form.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item></el-col>
          <el-col :span="24">
            <el-form-item label="店铺水印">
              <div class="shop-watermark-row">
                <el-upload
                  v-if="shopDialog.mode === 'edit'"
                  action="#"
                  :show-file-list="false"
                  :http-request="uploadShopWatermarkRequest"
                  :before-upload="validateShopWatermarkFile"
                  accept=".jpg,.jpeg,.png,.webp"
                >
                  <el-button :loading="shopWatermarkUploading">{{ shopDialog.form.watermark_name ? "替换水印" : "上传水印" }}</el-button>
                </el-upload>
                <span class="muted-text">
                  {{ shopDialog.mode === "edit" ? (shopDialog.form.watermark_name || "建议上传透明底 PNG 店铺水印") : "先保存店铺，再进入编辑上传水印" }}
                </span>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <div class="shop-watermark-config">
              <section class="shop-watermark-preview-card">
                <div class="shop-watermark-preview-head">
                  <strong>效果预览</strong>
                  <span>可直接拖动水印调整位置</span>
                </div>
                <div class="shop-watermark-preview-box">
                  <div class="shop-watermark-preview-stage">
                    <img :src="shopWatermarkSampleImage" alt="水印预览样例图" class="shop-watermark-sample-image" />
                    <AuthenticatedImage
                      v-if="shopWatermarkPreviewUrl"
                      :src="shopWatermarkPreviewUrl"
                      alt="店铺水印预览"
                      class="shop-watermark-overlay-image"
                      :style="shopWatermarkOverlayStyle"
                      @pointerdown="startShopWatermarkDrag"
                    />
                    <span v-else class="shop-watermark-preview-empty">上传后可预览水印效果</span>
                  </div>
                </div>
              </section>
              <section class="shop-watermark-controls">
                <el-form-item label="水印位置" label-width="80px">
                  <el-radio-group v-model="shopDialog.form.watermark_position" class="shop-watermark-position-group">
                    <el-radio-button v-for="item in shopWatermarkPositionOptions" :key="item.value" :label="item.value">{{ item.label }}</el-radio-button>
                  </el-radio-group>
                </el-form-item>
                <el-form-item :label="`大小 ${Math.round(shopDialog.form.watermark_scale_percent || 22)}%`" label-width="80px">
                  <el-slider v-model="shopDialog.form.watermark_scale_percent" :min="8" :max="45" :step="1" />
                </el-form-item>
                <el-form-item :label="`透明 ${Math.round(shopDialog.form.watermark_opacity_percent || 82)}%`" label-width="80px">
                  <el-slider v-model="shopDialog.form.watermark_opacity_percent" :min="10" :max="100" :step="1" />
                </el-form-item>
                <div class="shop-watermark-control-actions">
                  <el-button class="erp-btn erp-btn-secondary" @click="resetShopWatermarkOptions">恢复默认</el-button>
                  <span class="muted-text">保存后会作为该店铺图片生成的默认水印参数。</span>
                </div>
              </section>
            </div>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeShopDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="shopDialogSubmitting" @click="submitShopDialog">保存</el-button>
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
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closePersonDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="personDialogSubmitting" @click="submitPersonDialog">保存</el-button>
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
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeRateDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="rateDialogSubmitting" @click="submitRateDialog">保存</el-button>
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
          <el-col :span="24"><el-form-item label="筛选关键词"><el-input v-model="logisticsDialog.form.filter_keywords" type="textarea" :rows="3" placeholder="一行一个，保存后用于订单列表物流筛选匹配" /></el-form-item></el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="logisticsDialog.form.note" type="textarea" :rows="3" placeholder="可选" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeLogisticsDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="logisticsDialogSubmitting" @click="submitLogisticsDialog">保存</el-button>
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
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeCancellationDialog">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="cancellationDialogSubmitting" @click="submitCancellationDialog">保存</el-button>
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
.shop-config-workbench {
  min-height: calc(100vh - 276px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 14px;
  padding: 0 0 4px;
}
.shop-config-header {
  display: grid;
  grid-template-columns: minmax(300px, 1fr) auto auto;
  gap: 14px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(247, 250, 253, 0.94);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
}
.shop-config-header > div:first-child {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.shop-config-header > div:first-child > span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
}
.shop-config-header strong {
  color: #0f172a;
}
.shop-config-header > div:first-child > strong {
  font-size: 18px;
}
.shop-config-header p {
  margin: 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}
.shop-config-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(88px, 1fr));
  gap: 8px;
}
.shop-config-metrics div {
  min-height: 58px;
  display: grid;
  gap: 4px;
  align-content: center;
  padding: 8px 10px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #fff;
}
.shop-config-metrics span {
  color: #64748b;
  font-size: 12px;
}
.shop-config-metrics strong {
  font-size: 16px;
}
.shop-config-content {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
}
.shop-config-panel {
  min-width: 0;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
  padding: 14px;
}
.shop-filter-panel {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 16px;
  align-items: end;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-head.compact {
  margin-bottom: 12px;
}
.section-head span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: #0f172a;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.section-head strong {
  color: #0f172a;
}
.shop-filter-form {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 180px auto;
  gap: 12px;
  align-items: end;
}
.shop-filter-form :deep(.el-form-item) {
  margin: 0;
}
.shop-filter-form :deep(.el-input),
.shop-filter-form :deep(.el-select) {
  width: 100%;
}
.shop-filter-actions :deep(.el-form-item__content) {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
}
.shop-table-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.shop-config-table {
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  overflow: hidden;
}
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
.shop-watermark-row { min-height: 32px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.shop-watermark-table-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.shop-watermark-table-cell img { width: 52px; height: 32px; object-fit: contain; border: 1px solid var(--erp-border); border-radius: 6px; background:
  linear-gradient(45deg, rgba(148, 163, 184, 0.16) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.16) 75%),
  linear-gradient(45deg, rgba(148, 163, 184, 0.16) 25%, transparent 25%, transparent 75%, rgba(148, 163, 184, 0.16) 75%),
  #fff;
  background-position: 0 0, 8px 8px;
  background-size: 16px 16px;
}
.shop-watermark-config { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr); gap: 18px; padding: 16px; border: 1px solid var(--erp-border); border-radius: 12px; background: var(--erp-surface-alt); }
.shop-watermark-preview-card, .shop-watermark-controls { min-width: 0; }
.shop-watermark-preview-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.shop-watermark-preview-head span { color: var(--erp-text-secondary); font-size: 12px; }
.shop-watermark-preview-box { height: 360px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--erp-border); border-radius: 10px; background: #eef3fa; }
.shop-watermark-preview-stage { position: relative; width: min(270px, 100%); aspect-ratio: 3 / 4; max-height: 100%; }
.shop-watermark-sample-image { display: block; width: 100%; height: 100%; object-fit: contain; }
.shop-watermark-overlay-image { position: absolute; display: block; height: auto; max-height: 36%; object-fit: contain; touch-action: none; user-select: none; }
.shop-watermark-overlay-image:active { cursor: grabbing !important; }
.shop-watermark-preview-empty { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 6px 10px; border-radius: 999px; color: var(--erp-text-secondary); background: rgba(255, 255, 255, 0.88); font-size: 12px; }
.shop-watermark-controls { display: flex; flex-direction: column; justify-content: center; }
.shop-watermark-position-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
.shop-watermark-position-group :deep(.el-radio-button), .shop-watermark-position-group :deep(.el-radio-button__inner) { width: 100%; }
.shop-watermark-control-actions { display: flex; align-items: center; gap: 10px; padding-left: 80px; }
.muted-text { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
@media (max-width: 960px) {
  .settings-hero { flex-direction: column; align-items: flex-start; }
  .settings-list-card { height: auto; min-height: 0; }
  .shop-config-workbench { min-height: 0; }
  .shop-config-header, .shop-filter-panel, .shop-filter-form { grid-template-columns: 1fr; }
  .shop-config-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .shop-watermark-config { grid-template-columns: 1fr; }
  .shop-watermark-control-actions { padding-left: 0; }
}
</style>
