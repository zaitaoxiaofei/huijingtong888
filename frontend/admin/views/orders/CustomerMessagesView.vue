<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { ChatDotRound, CopyDocument, Flag, Refresh, Search, SwitchButton, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { copyToClipboard } from "../../utils/clipboard";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const loading = ref(false);
const settingsLoading = ref(false);
const rowActionKey = ref("");
const translationActionKey = ref("");
const activeTab = ref("templates");
const chatVisible = ref(false);
const chatOrder = ref(null);
const chatDraft = ref("");
const chatSending = ref(false);
const historyLoading = ref(false);
const chatMessagesLoading = ref(false);
const syncingChats = ref(false);
const templateDialogVisible = ref(false);
const shopConfigDialogVisible = ref(false);
const templateTestDialogVisible = ref(false);
const templateSearch = ref("");
const templatePage = ref(1);
const templatePageSize = ref(20);
const templateDialog = reactive({ mode: "edit", form: {} });
const shopConfigDialog = reactive({ form: {} });
const templateTestDialog = reactive({ form: {}, result: null, loading: false });
const upcoming = reactive({ rows: [], page: 1, pageSize: 20, total: 0, generatedAt: "", safety: {} });

const state = reactive({
  type: "all",
  scenarioFilter: "",
  search: "",
  shopId: null,
  sendMethodFilter: "all",
  dateRange: [],
  rows: [],
  counts: {},
  generatedAt: "",
  scenarios: [],
  shops: [],
  templates: [],
  historyOrders: [],
  chatMessages: [],
  lastSyncResult: null,
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1
});

const typeOptions = computed(() => [
  { value: "all", label: "全部" },
  { value: "pending", label: "待发送" },
  { value: "sending", label: "发送中" },
  { value: "retry", label: "待重试" },
  { value: "sent", label: "已发送" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" }
]);

const automationScenarios = computed(() => state.scenarios);
const primaryAutomationScenarioKeys = new Set(["pickup_notice", "review_request", "passport_reminder"]);
const automationTemplates = computed(() => state.templates.filter((item) => primaryAutomationScenarioKeys.has(item.scenario)));
const availableTemplateScenarios = computed(() => {
  const existing = new Set(automationTemplates.value.map((item) => item.scenario));
  return automationScenarios.value.filter((scenario) => primaryAutomationScenarioKeys.has(scenario.key) && !existing.has(scenario.key));
});
const filteredAutomationTemplates = computed(() => {
  const keyword = templateSearch.value.trim().toLowerCase();
  return automationTemplates.value.filter((template) => !keyword || `${template.label} ${template.template_text} ${template.template_translation}`.toLowerCase().includes(keyword));
});
const visibleAutomationTemplates = computed(() => {
  const start = (templatePage.value - 1) * templatePageSize.value;
  return filteredAutomationTemplates.value.slice(start, start + templatePageSize.value);
});

function searchTemplates() {
  templatePage.value = 1;
}

function changeTemplatePage(page) {
  templatePage.value = page;
}

function changeTemplatePageSize(size) {
  templatePageSize.value = size;
  templatePage.value = 1;
}
const templateVariables = [
  { key: "posting_number", label: "订单号" },
  { key: "product_summary", label: "商品名称" },
  { key: "shop_name", label: "店铺名称" },
  { key: "status_label", label: "订单状态" },
  { key: "tracking_number", label: "物流单号" },
  { key: "delivery_window", label: "取货时间" }
];

const triggerOptions = [
  { value: "pickup_ready", label: "订单到达取货点" },
  { value: "delivered", label: "订单已签收" },
  { value: "passport_missing", label: "护照资料仍未填写" },
  { value: "shipment_overdue", label: "订单超时未发货" },
  { value: "tracking_stalled", label: "物流长时间未更新" },
  { value: "delivery_delayed", label: "配送发生延误" },
  { value: "order_created", label: "客户下单" },
  { value: "customer_inquiry", label: "客户主动咨询" }
];

function insertTemplateVariable(template, key) {
  const token = `{{${key}}}`;
  const text = String(template.template_text || "");
  template.template_text = text ? `${text}${/\s$/.test(text) ? "" : " "}${token}` : token;
}

function openTemplateEditor(template = null) {
  if (template) {
    templateDialog.mode = "edit";
    templateDialog.form = JSON.parse(JSON.stringify(template));
  } else {
    const scenario = availableTemplateScenarios.value[0]?.key;
    if (!scenario) return;
    templateDialog.mode = "create";
    templateDialog.form = { scenario, label: automationScenarios.value.find((item) => item.key === scenario)?.label || "消息模板", enabled: false, trigger_condition: scenario, delay_hours: 1, template_text: "", template_translation: "", shop_ids: [] };
  }
  templateDialogVisible.value = true;
}

function openTemplateTest(template) {
  templateTestDialog.form = {
    scenario: template.scenario,
    label: template.label,
    shop_id: Number(template.shop_ids?.[0] || 0) || "",
    posting_number: ""
  };
  templateTestDialog.result = null;
  templateTestDialogVisible.value = true;
}

async function runTemplateTest(createDraft = false) {
  if (!templateTestDialog.form.shop_id) return ElMessage.warning("请选择测试店铺");
  templateTestDialog.loading = true;
  try {
    templateTestDialog.result = await apiClient.post("/api/customer-message-settings/template/test", {
      ...templateTestDialog.form,
      create_test_draft: createDraft
    });
    ElMessage.success(createDraft ? "测试草稿已生成，不会发送" : "模板预览已生成，不会发送");
    if (createDraft) await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "模板测试失败");
  } finally {
    templateTestDialog.loading = false;
  }
}

function openShopConfig(template) {
  shopConfigDialog.form = JSON.parse(JSON.stringify(template));
  shopConfigDialogVisible.value = true;
}

async function saveShopConfig() {
  await updateTemplate(shopConfigDialog.form);
  shopConfigDialogVisible.value = false;
}

async function saveTemplateEditor() {
  if (!String(templateDialog.form.template_text || "").trim()) return ElMessage.warning("请填写俄语模板内容");
  await updateTemplate(templateDialog.form);
  templateDialogVisible.value = false;
}

async function deleteTemplate(template) {
  await ElMessageBox.confirm(`确认删除模板“${template.label}”吗？删除后不会再生成该类型的新消息任务。`, "删除模板", { type: "warning" });
  rowActionKey.value = `template-delete:${template.scenario}`;
  try {
    const result = await apiClient.delete(`/api/customer-message-settings/template/${encodeURIComponent(template.scenario)}`);
    if (result?.settings?.templates) state.templates = result.settings.templates;
    ElMessage.success("模板已删除");
  } catch (error) {
    ElMessage.error(error?.message || "删除模板失败");
  } finally {
    rowActionKey.value = "";
  }
}

const shopOptions = computed(() => [
  { value: "", label: "全部店铺" },
  ...state.shops.map((shop) => ({ value: String(shop.shop_id), label: shop.shop_name }))
]);
const sendMethodOptions = [
  { value: "all", label: "全部方式" },
  { value: "manual", label: "人工" },
  { value: "auto", label: "自动" }
];

const scenarioOrder = ["pickup_notice", "review_request", "passport_reminder"];

function scenarioTimingText(templateOrScenario) {
  const template = typeof templateOrScenario === "object" ? templateOrScenario : { scenario: templateOrScenario };
  const trigger = triggerOptions.find((item) => item.value === template.trigger_condition)?.label
    || ({ order_created: "客户下单", passport_reminder: "护照资料仍未填写", order_update: "客户主动咨询", shipment_delay: "订单超时未发货", stall_comfort: "物流长时间未更新", delay_comfort: "配送发生延误", pickup_notice: "订单到达取货点", review_request: "订单已签收" })[template.scenario]
    || "按订单状态触发";
  const delay = Math.max(0, Number(template.delay_hours || 0));
  return `${trigger} · ${delay ? `${delay} 小时后` : "立即"}`;
}

function scenarioIconText(scenario) {
  return ({ order_created: "谢", passport_reminder: "照", order_update: "催", shipment_delay: "发", stall_comfort: "停", delay_comfort: "延", pickup_notice: "取", review_request: "评" })[scenario] || "信";
}

function dt(value) {
  return value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "-";
}

function capabilityLabel(shop) {
  const labels = { available: "聊天可用", unavailable: "无聊天权限", credentials_error: "凭证异常", temporary_error: "检测暂时失败", unchecked: "尚未检测" };
  return labels[shop.chat_capability] || "尚未检测";
}

function capabilityType(shop) {
  if (shop.chat_capability === "available") return "success";
  if (["unavailable", "credentials_error"].includes(shop.chat_capability)) return "danger";
  if (shop.chat_capability === "temporary_error") return "warning";
  return "info";
}

function actionKey(row, action) {
  return `${row.task_key}:${action}`;
}

function latestLine(row) {
  return String(row.real_chat_last_message || row.message_text || row.customer_message || "").split(/\n+/).find(Boolean) || "暂无消息";
}

function scenarioLabel(row) {
  return state.scenarios.find((scenario) => scenario.key === row.scenario)?.label || row.scenario || "-";
}

function taskStatusType(status) {
  if (status === "sent") return "success";
  if (["failed", "cancelled"].includes(status)) return "danger";
  if (status === "retry") return "warning";
  return "info";
}

function productLine(row) {
  return row.product_summary || row.product_names || "商品信息待同步";
}

function orderQuantity(row) {
  return Number(row.item_quantity || row.quantity || 0);
}

function scenarioState(row, scenario) {
  const current = row.scenario === scenario.key || row.message_type === scenario.key;
  const currentIndex = scenarioOrder.indexOf(row.scenario || row.message_type);
  const scenarioIndex = scenarioOrder.indexOf(scenario.key);
  const done = scenarioIndex >= 0 && currentIndex >= 0 && scenarioIndex < currentIndex;
  const actionDone = current && ["sent", "copied", "skipped"].includes(row.status);
  if (done || actionDone) return { type: "done", tagType: "success" };
  if (current) return { type: "current", tagType: "warning" };
  return { type: "pending", tagType: "info" };
}

function orderStatusType(row) {
  const text = `${row.status || ""} ${row.status_label_order || ""}`.toLowerCase();
  if (text.includes("cancel")) return "danger";
  if (text.includes("delivered") || text.includes("签收")) return "success";
  if (text.includes("pickup") || text.includes("取货")) return "warning";
  return "info";
}

function messageRowClass({ row }) {
  if (row.status === "problem") return "is-marked-message";
  if (row.read_state === "unread") return "is-unread-message";
  return "";
}

function chatDirectionLabel(message) {
  const direction = String(message?.direction || "");
  if (direction === "customer") return "客户";
  if (direction === "seller") return "店铺客服";
  return "系统";
}

function draftTranslation(row) {
  return row?.message_translation || "中文含义暂未生成，请以俄语正文为准。";
}

async function loadChatMessages(row) {
  state.chatMessages = [];
  if (!row?.shop_id || !row?.chat_id) return;
  chatMessagesLoading.value = true;
  try {
    const params = new URLSearchParams({ shop_id: String(row.shop_id), chat_id: row.chat_id });
    const data = await apiClient.get(`/api/customer-chats/messages?${params.toString()}`);
    state.chatMessages = Array.isArray(data?.rows) ? data.rows : [];
  } catch (error) {
    state.chatMessages = [];
    ElMessage.error(error?.message || "真实聊天记录加载失败");
  } finally {
    chatMessagesLoading.value = false;
  }
}

async function loadHistoryOrders(row) {
  if (!row?.shop_id || !row?.customer_unique_id) {
    state.historyOrders = [];
    return;
  }
  historyLoading.value = true;
  try {
    const params = new URLSearchParams({ shop_id: String(row.shop_id), customer_id: row.customer_unique_id });
    const data = await apiClient.get(`/api/customer-message-customer-orders?${params.toString()}`);
    state.historyOrders = Array.isArray(data?.rows) ? data.rows : [];
  } catch (error) {
    state.historyOrders = [];
    ElMessage.error(error?.message || "历史订单加载失败");
  } finally {
    historyLoading.value = false;
  }
}

async function openChat(row) {
  chatOrder.value = row;
  chatDraft.value = row.message_text || row.customer_message || "";
  chatVisible.value = true;
  await Promise.all([loadHistoryOrders(row), loadChatMessages(row)]);
  if (!row.task_id && row.read_state !== "read") {
    await recordMessage(row, row.status || "draft", false, { readState: "read", reload: false });
    row.read_state = "read";
    row.read_state_label = "已读";
  }
}

async function copyChatDraft() {
  if (!chatOrder.value) return;
  const ok = await copyToClipboard(chatDraft.value || "");
  if (!ok) return ElMessage.error("复制失败，请手动选中俄语正文复制");
  await recordMessage(chatOrder.value, "copied", false);
  ElMessage.success("俄语消息已复制，当前仍为手动测试模式");
}

async function sendChatMessage() {
  if (!chatOrder.value || !chatDraft.value.trim()) return;
  if (chatOrder.value.chat_capability !== "available") {
    ElMessage.warning("该店铺聊天能力尚未检测通过，不能直接发送。");
    return;
  }
  chatSending.value = true;
  try {
    await apiClient.post("/api/customer-messages/send", {
      order_id: chatOrder.value.order_id,
      posting_number: chatOrder.value.posting_number,
      shop_id: chatOrder.value.shop_id,
      customer_id: chatOrder.value.customer_unique_id,
      scenario: chatOrder.value.scenario,
      message_text: chatDraft.value
    });
    await recordMessage(chatOrder.value, "sent", false);
    ElMessage.success("消息已发送");
    chatVisible.value = false;
  } catch (error) {
    ElMessage.error(error?.message || "消息发送失败");
  } finally {
    chatSending.value = false;
  }
}

async function loadSettings() {
  settingsLoading.value = true;
  try {
    const data = await apiClient.get("/api/customer-message-settings");
    state.scenarios = Array.isArray(data?.scenarios) ? data.scenarios : [];
    state.shops = Array.isArray(data?.shops) ? data.shops : [];
    state.templates = Array.isArray(data?.templates) ? data.templates : [];
  } catch (error) {
    ElMessage.error(error?.message || "客户消息配置加载失败");
  } finally {
    settingsLoading.value = false;
  }
}

async function loadRows() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      view: "send_records",
      type: state.type,
      send_method: state.sendMethodFilter,
      search: state.search,
      page: String(state.page || 1),
      pageSize: String(state.pageSize || 20)
    });
    if (state.shopId) params.set("shop_id", state.shopId);
    if (state.scenarioFilter) params.set("scenario", state.scenarioFilter);
    if (Array.isArray(state.dateRange) && state.dateRange.length === 2) {
      params.set("date_from", state.dateRange[0]);
      params.set("date_to", state.dateRange[1]);
    }
    const data = await apiClient.get(`/api/customer-messages?${params.toString()}`);
    state.rows = Array.isArray(data?.rows) ? data.rows : [];
    state.counts = data?.counts || {};
    state.generatedAt = data?.generated_at || "";
    state.total = Number(data?.total || state.rows.length || 0);
    state.page = Number(data?.page || state.page || 1);
    state.pageSize = Number(data?.pageSize || data?.page_size || state.pageSize || 20);
    state.totalPages = Number(data?.total_pages || Math.max(1, Math.ceil(state.total / state.pageSize)));
  } catch (error) {
    ElMessage.error(error?.message || "消息发送记录加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadUpcoming() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      view: "upcoming",
      search: state.search,
      page: String(upcoming.page || 1),
      pageSize: String(upcoming.pageSize || 20)
    });
    if (state.shopId) params.set("shop_id", state.shopId);
    if (state.scenarioFilter) params.set("scenario", state.scenarioFilter);
    const data = await apiClient.get(`/api/customer-messages?${params.toString()}`);
    upcoming.rows = Array.isArray(data?.rows) ? data.rows : [];
    upcoming.total = Number(data?.total || 0);
    upcoming.page = Number(data?.page || upcoming.page || 1);
    upcoming.pageSize = Number(data?.pageSize || upcoming.pageSize || 20);
    upcoming.generatedAt = data?.generated_at || "";
    upcoming.safety = data?.safety || {};
  } catch (error) {
    ElMessage.error(error?.message || "即将发送候选加载失败");
  } finally {
    loading.value = false;
  }
}

function changeUpcomingPage(page) {
  upcoming.page = page;
  loadUpcoming();
}

function changeUpcomingPageSize(size) {
  upcoming.pageSize = size;
  upcoming.page = 1;
  loadUpcoming();
}

function reloadUpcomingFirstPage() {
  upcoming.page = 1;
  loadUpcoming();
}

function handleTabChange(tab) {
  if (tab === "upcoming") loadUpcoming();
}

function canTestUpcoming(row) {
  return Boolean(upcoming.safety.manual_test_enabled && row?.readiness === "ready");
}

function previewUpcoming(row) {
  const testEnabled = canTestUpcoming(row);
  ElMessageBox.confirm(String(row.message_text || row.customer_message || "暂无消息内容"), `${row.shop_name || "店铺"} · ${row.posting_number}`, {
    confirmButtonText: testEnabled ? "确认测试发送" : row?.readiness === "scheduled" ? "尚未到发送时间" : "仅预览",
    cancelButtonText: "关闭",
    showCancelButton: true,
    confirmButtonClass: testEnabled ? "" : "is-disabled",
    closeOnClickModal: false,
    customClass: "upcoming-message-preview",
    dangerouslyUseHTMLString: false
  }).then(async () => {
    if (!testEnabled) {
      ElMessage.warning(row?.readiness === "scheduled" ? "任务尚未到计划发送时间，目前只允许预览。" : "当前任务只允许预览。");
      return;
    }
    await sendUpcomingManualTest(row);
  }).catch(() => {});
}

async function sendUpcomingManualTest(row) {
  rowActionKey.value = `manual-test:${row.candidate_key}`;
  try {
    await apiClient.post("/api/customer-messages/manual-test-send", {
      order_id: row.order_id,
      scenario: row.scenario,
      reminder_step: row.reminder_step,
      candidate_key: row.candidate_key,
      message_text: row.message_text || row.customer_message || ""
    });
    ElMessage.success("测试消息已发送，请到 Ozon 后台核对聊天记录。");
    await loadUpcoming();
  } catch (error) {
    ElMessage.error(error?.message || "测试消息发送失败");
  } finally {
    rowActionKey.value = "";
  }
}

function reloadFirstPage() {
  state.page = 1;
  loadRows();
}

async function reloadAll() {
  await loadSettings();
  await loadRows();
}

async function syncRealChats() {
  syncingChats.value = true;
  try {
    const payload = {};
    if (state.shopId) payload.shop_id = Number(state.shopId);
    const data = await apiClient.post("/api/customer-chats/sync", payload);
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    if (errors.length) {
      ElMessage.warning(`同步完成，但有 ${errors.length} 个店铺/接口错误，请看后端日志或接口返回`);
    } else {
      ElMessage.success(`已同步 ${data?.threads_synced || 0} 个聊天，${data?.messages_synced || 0} 条消息`);
    }
    state.lastSyncResult = data || null;
    await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "真实聊天同步失败");
  } finally {
    syncingChats.value = false;
  }
}

async function recordMessage(row, status, showToast = true, options = {}) {
  rowActionKey.value = actionKey(row, status);
  try {
    await apiClient.post("/api/customer-messages/record", {
      order_id: row.order_id,
      scenario: row.scenario,
      status,
      read_state: options.readState || row.read_state || "unread",
      message_text: row.message_text || row.customer_message || ""
    });
    if (showToast) ElMessage.success(status === "problem" ? "已标记为需要追踪" : status === "sent" ? "已标记为已发送" : "已跳过");
    if (options.reload !== false) await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "状态记录失败");
  } finally {
    rowActionKey.value = "";
  }
}

async function copyMessage(row) {
  const ok = await copyToClipboard(row.message_text || row.customer_message || "");
  if (!ok) return ElMessage.error("复制失败，请手动选中文字复制");
  await recordMessage(row, "copied", false);
  ElMessage.success("消息已复制");
}

async function retryTask(row) {
  if (!row.task_id) return;
  rowActionKey.value = actionKey(row, "retry");
  try {
    await apiClient.post("/api/customer-messages/retry", { task_id: row.task_id });
    ElMessage.success("消息任务已进入重试队列");
    await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "重试任务失败");
  } finally {
    rowActionKey.value = "";
  }
}

async function updateShop(shop) {
  rowActionKey.value = `shop:${shop.shop_id}`;
  try {
    shop.send_mode = shop.chat_enabled ? "auto" : "none";
    const result = await apiClient.post("/api/customer-message-settings/shop", shop);
    if (result?.settings) {
      state.scenarios = result.settings.scenarios || state.scenarios;
      state.shops = result.settings.shops || state.shops;
      state.templates = result.settings.templates || state.templates;
    }
    ElMessage.success("店铺消息权限已保存");
    await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "保存店铺配置失败");
  } finally {
    rowActionKey.value = "";
  }
}

async function checkShopCapability(shop) {
  rowActionKey.value = `shop-check:${shop.shop_id}`;
  try {
    const result = await apiClient.post("/api/customer-message-settings/shop/check-capability", { shop_id: shop.shop_id });
    await loadSettings();
    if (result?.ok) ElMessage.success("店铺 Ozon 聊天能力检测通过");
    else ElMessage.warning(result?.error || "店铺没有可用的 Ozon 聊天权限");
  } catch (error) {
    ElMessage.error(error?.message || "聊天能力检测失败");
  } finally {
    rowActionKey.value = "";
  }
}

async function updateTemplate(template) {
  rowActionKey.value = `template:${template.scenario}`;
  try {
    const result = await apiClient.post("/api/customer-message-settings/template", template);
    if (result?.settings?.templates) state.templates = result.settings.templates;
    ElMessage.success("消息模板已保存");
    await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "保存模板失败");
    await loadSettings();
  } finally {
    rowActionKey.value = "";
  }
}

async function translateTemplate(template) {
  if (!String(template?.template_text || "").trim()) {
    ElMessage.warning("请先填写俄语模板内容");
    return;
  }
  translationActionKey.value = `template-translate:${template.scenario}`;
  try {
    const result = await apiClient.post("/api/customer-message-settings/template/translate-zh", {
      scenario: template.scenario,
      label: template.label,
      template_text: template.template_text
    });
    template.template_translation = result?.template_translation || result?.translated_text || template.template_translation || "";
    ElMessage.success("中文释义已更新，确认后记得保存模板");
  } catch (error) {
    ElMessage.error(error?.message || "AI 翻译失败，请检查 AI 配置");
  } finally {
    translationActionKey.value = "";
  }
}

function search() {
  reloadFirstPage();
}

function reset() {
  state.type = "all";
  state.search = "";
  state.scenarioFilter = "";
  state.shopId = null;
  state.sendMethodFilter = "all";
  state.dateRange = [];
  state.page = 1;
  loadRows();
}

function changePage(page) {
  state.page = Math.max(1, Number(page || 1));
  loadRows();
}

function changePageSize(pageSize) {
  state.pageSize = Math.max(20, Number(pageSize || 20));
  state.page = 1;
  loadRows();
}

onMounted(reloadAll);
</script>

<template>
  <div class="page-stack customer-message-page">
    <el-card shadow="never" class="page-card customer-message-main">
      <template #header>
        <div class="customer-message-tabs">
          <el-segmented v-model="activeTab" :options="[
            { label: '消息模板', value: 'templates' },
            { label: '发送记录', value: 'records' },
            { label: '即将发送', value: 'upcoming' }
          ]" @change="handleTabChange" />
          <div class="customer-message-header-actions">
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading || settingsLoading" @click="reloadAll">刷新</el-button>
          </div>
        </div>
      </template>

      <section v-if="activeTab === 'records'" class="customer-message-section">
        <div class="records-page-heading"><div><h3>消息发送记录</h3><p>统一查询人工测试与自动消息的发送、失败及取消过程。</p></div><div class="records-summary"><span>累计记录</span><strong>{{ state.total }}</strong></div></div>
        <div class="customer-message-toolbar">
          <div class="customer-message-search">
            <el-select v-model="state.shopId" class="shop-filter" filterable clearable placeholder="店铺" @change="reloadFirstPage">
              <el-option v-for="shop in shopOptions" :key="shop.value" :label="shop.label" :value="shop.value" />
            </el-select>
            <el-input v-model="state.search" clearable placeholder="订单号 / 商品" @keyup.enter="search" />
            <el-select v-model="state.scenarioFilter" placeholder="消息类型" clearable @change="reloadFirstPage">
              <el-option v-for="scenario in automationScenarios" :key="scenario.key" :label="scenario.label" :value="scenario.key" />
            </el-select>
            <el-select v-model="state.type" placeholder="发送状态" @change="reloadFirstPage">
              <el-option v-for="option in typeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-select v-model="state.sendMethodFilter" placeholder="发送方式" @change="reloadFirstPage">
              <el-option v-for="option in sendMethodOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-date-picker
              v-model="state.dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="记录开始"
              end-placeholder="记录结束"
              @change="reloadFirstPage"
            />
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" :loading="loading" @click="search">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="reset">重置</el-button>
          </div>
          <span v-if="state.generatedAt" class="records-updated-at">更新于 {{ dt(state.generatedAt) }}</span>
        </div>
        <div v-if="state.lastSyncResult" class="sync-result-panel">
          <strong>订单聊天匹配结果</strong>
          <span>同步 {{ state.lastSyncResult.threads_synced || 0 }} 个线程 · {{ state.lastSyncResult.messages_synced || 0 }} 条消息</span>
          <small v-if="state.lastSyncResult.errors?.length">{{ state.lastSyncResult.errors[0] }}</small>
          <small v-else>仅当 Ozon 返回订单号时，系统才会把真实聊天挂到对应订单。</small>
        </div>

        <div class="records-table-shell paged-table-shell"><el-table
          v-loading="loading"
          :data="state.rows"
          height="100%"
          row-key="task_key"
          class="erp-data-table customer-message-table"
          table-layout="fixed"
          :row-class-name="messageRowClass"
          empty-text="暂无符合筛选条件的人工或自动发送记录"
        >
          <el-table-column label="店铺 / 场景" width="180">
            <template #default="{ row }">
              <div class="shop-cell">
                <strong>{{ row.shop_name || '-' }}</strong>
                <el-tag size="small" effect="light">{{ scenarioLabel(row) }}</el-tag>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="订单 / 商品" min-width="310">
            <template #default="{ row }">
              <div class="order-with-image">
                <ProductImagePreview :src="row.image_url" :alt="productLine(row)" />
                <div>
                  <strong class="posting-number">{{ row.posting_number }}</strong>
                  <small class="muted-line">{{ productLine(row) }}</small>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="订单状态" width="140" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="orderStatusType(row)">{{ row.status_label_order || '-' }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="计划 / 实际时间" width="190">
            <template #default="{ row }">
              <div class="task-time-cell">
                <span v-if="row.scheduled_at">计划 {{ dt(row.scheduled_at) }}</span>
                <span v-else>操作 {{ dt(row.event_at || row.record_created_at) }}</span>
                <span v-if="row.sent_at">发送 {{ dt(row.sent_at) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="发送内容" min-width="320">
            <template #default="{ row }">
              <div class="latest-cell">
                <strong>{{ latestLine(row) }}</strong>
                <small v-if="row.attempts">已尝试 {{ row.attempts }} 次</small>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="发送状态" width="180">
            <template #default="{ row }">
              <div class="task-status-cell">
                <el-tag size="small" effect="light" :type="taskStatusType(row.status)">{{ row.status_label || row.status }}</el-tag>
                <small v-if="row.last_error" class="capability-error">{{ row.last_error }}</small>
                <small v-else-if="row.cancel_reason">{{ row.cancel_reason }}</small>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="发送方式" width="100" align="center">
            <template #default="{ row }"><el-tag size="small" effect="plain" :type="row.send_method === 'manual' ? 'warning' : 'info'">{{ row.send_method_label || (row.send_method === 'manual' ? '人工' : '自动') }}</el-tag></template>
          </el-table-column>

          <el-table-column label="操作" width="190" fixed="right">
            <template #default="{ row }">
              <div class="message-actions message-actions--row">
                <el-button class="erp-btn erp-btn-primary" type="primary" :icon="ChatDotRound" @click="openChat(row)">查看</el-button>
                <el-button v-if="['failed', 'cancelled'].includes(row.status) && row.task_id" class="erp-btn erp-btn-secondary" plain :icon="Refresh" :loading="rowActionKey === actionKey(row, 'retry')" @click="retryTask(row)">重试</el-button>
                <el-button v-if="['pending', 'retry'].includes(row.status)" class="erp-btn erp-btn-secondary" plain :icon="SwitchButton" :loading="rowActionKey === actionKey(row, 'skipped')" @click="recordMessage(row, 'skipped')">取消</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table></div>
        <div class="global-pagination-bar">
          <span>共 {{ state.total }} 条记录</span>
          <el-pagination
            background
            layout="sizes, prev, pager, next, jumper"
            :current-page="state.page"
            :page-size="state.pageSize"
            :page-sizes="[20, 30, 50, 80]"
            :total="state.total"
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </div>
      </section>

      <section v-else-if="activeTab === 'upcoming'" class="customer-message-section">
        <div class="records-page-heading">
          <div><h3>即将发送</h3><p>展示三类真实自动任务，包括未来排期、已到发送时间和重试任务。</p></div>
          <div class="records-summary"><span>排期任务</span><strong>{{ upcoming.total }}</strong></div>
        </div>
        <el-alert
          :title="upcoming.safety.manual_test_enabled ? '人工测试发送已开启；每次发送前仍需在预览窗口二次确认。' : '自动发送和人工测试发送均保持关闭，当前页面只读预览。'"
          :type="upcoming.safety.manual_test_enabled ? 'warning' : 'success'"
          :closable="false"
          show-icon
        />
        <div class="customer-message-toolbar">
          <div class="customer-message-search upcoming-search">
            <el-select v-model="state.shopId" class="shop-filter" filterable clearable placeholder="店铺" @change="reloadUpcomingFirstPage">
              <el-option v-for="shop in shopOptions" :key="shop.value" :label="shop.label" :value="shop.value" />
            </el-select>
            <el-input v-model="state.search" clearable placeholder="订单号 / 商品" @keyup.enter="reloadUpcomingFirstPage" />
            <el-select v-model="state.scenarioFilter" placeholder="消息类型" clearable @change="reloadUpcomingFirstPage">
              <el-option label="到货取货" value="pickup_notice" />
              <el-option label="签收后求好评" value="review_request" />
              <el-option label="护照未填" value="passport_reminder" />
            </el-select>
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" :loading="loading" @click="reloadUpcomingFirstPage">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="loadUpcoming">刷新</el-button>
          </div>
          <span v-if="upcoming.generatedAt" class="records-updated-at">更新于 {{ dt(upcoming.generatedAt) }}</span>
        </div>
        <div class="upcoming-safety-note">
          <span>未取货：到达后立即、1 天、3 天，最多三次</span>
          <span>好评：签收 1 天后发送，3 天内未发可补发</span>
          <span>护照：下单 24 小时内提醒一次</span>
        </div>
        <div class="records-table-shell paged-table-shell">
          <el-table v-loading="loading" :data="upcoming.rows" height="100%" row-key="candidate_key" class="erp-data-table customer-message-table" table-layout="fixed" empty-text="当前没有符合安全条件的待发送订单">
            <el-table-column label="店铺 / 类型" width="180"><template #default="{ row }"><div class="shop-cell"><strong>{{ row.shop_name || '-' }}</strong><el-tag size="small" effect="light">{{ scenarioLabel(row) }}</el-tag></div></template></el-table-column>
            <el-table-column label="订单 / 商品" min-width="300"><template #default="{ row }"><div class="order-with-image"><ProductImagePreview :src="row.image_url" :alt="productLine(row)" /><div><strong class="posting-number">{{ row.posting_number }}</strong><small class="muted-line">{{ productLine(row) }}</small></div></div></template></el-table-column>
            <el-table-column label="当前订单状态" width="145" align="center"><template #default="{ row }"><el-tag size="small" effect="light" :type="orderStatusType(row)">{{ row.status_label_order || '-' }}</el-tag></template></el-table-column>
            <el-table-column label="触发 / 计划时间" width="205"><template #default="{ row }"><div class="task-time-cell"><span>触发 {{ dt(row.trigger_at) }}</span><span>计划 {{ dt(row.scheduled_at) }}</span></div></template></el-table-column>
            <el-table-column label="准备发送的俄语消息" min-width="360"><template #default="{ row }"><p class="upcoming-message-text">{{ row.message_text || '-' }}</p></template></el-table-column>
            <el-table-column label="任务状态" width="190" align="center"><template #default="{ row }"><div class="task-status-cell"><el-tag size="small" effect="light" :type="row.readiness === 'ready' ? 'warning' : row.readiness === 'retry' ? 'danger' : 'info'">{{ row.readiness_label }}</el-tag><small v-if="row.scenario === 'pickup_notice'">第 {{ row.reminder_step }} 次提醒</small></div></template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button link type="primary" :icon="View" :loading="rowActionKey === `manual-test:${row.candidate_key}`" @click="previewUpcoming(row)">{{ canTestUpcoming(row) ? '预览并测试' : '预览' }}</el-button></template></el-table-column>
          </el-table>
        </div>
        <div class="global-pagination-bar">
          <span>共 {{ upcoming.total }} 条排期任务</span>
          <el-pagination background layout="sizes, prev, pager, next, jumper" :current-page="upcoming.page" :page-size="upcoming.pageSize" :page-sizes="[20, 30, 50, 80]" :total="upcoming.total" @current-change="changeUpcomingPage" @size-change="changeUpcomingPageSize" />
        </div>
      </section>

      <section v-else class="customer-message-section" v-loading="settingsLoading">
        <div class="template-list-toolbar">
          <div><h3>自动消息模板</h3><p>每种触发类型保留一套模板，内容和适用店铺分别维护。</p></div>
          <div class="template-toolbar-actions"><el-input v-model="templateSearch" clearable placeholder="搜索模板" :prefix-icon="Search" @input="searchTemplates" /><el-button class="erp-btn erp-btn-primary" type="primary" :disabled="!availableTemplateScenarios.length" @click="openTemplateEditor()">新增模板</el-button></div>
        </div>
        <div class="template-table-shell paged-table-shell"><el-table :data="visibleAutomationTemplates" height="100%" class="erp-data-table template-display-table" empty-text="暂无消息模板">
          <el-table-column label="模板名称" width="230"><template #default="{ row }"><div class="template-name-cell"><span class="template-name-icon">{{ scenarioIconText(row.scenario) }}</span><div><strong>{{ row.label }}</strong><small>{{ scenarioTimingText(row) }}</small></div></div></template></el-table-column>
          <el-table-column label="中文释义" min-width="300"><template #default="{ row }"><p class="template-copy template-copy--zh">{{ row.template_translation || '-' }}</p></template></el-table-column>
          <el-table-column label="俄语模板内容" min-width="380"><template #default="{ row }"><p class="template-copy">{{ row.template_text || '-' }}</p></template></el-table-column>
          <el-table-column label="适用店铺" min-width="220">
            <template #default="{ row }"><div class="template-shop-tags"><el-tag v-for="shop in state.shops.filter(item => row.shop_ids?.includes(Number(item.shop_id))).slice(0, 3)" :key="shop.shop_id" size="small" effect="plain">{{ shop.shop_name }}</el-tag><el-tag v-if="(row.shop_ids?.length || 0) > 3" size="small" type="info">+{{ row.shop_ids.length - 3 }}</el-tag><span v-if="!row.shop_ids?.length">未配置</span></div></template>
          </el-table-column>
          <el-table-column label="状态" width="92" align="center"><template #default="{ row }"><el-switch v-model="row.enabled" @change="updateTemplate(row)" /></template></el-table-column>
          <el-table-column label="操作" width="260" fixed="right"><template #default="{ row }"><div class="template-row-actions"><el-button link type="primary" @click="openTemplateEditor(row)">编辑</el-button><el-button link type="primary" @click="openShopConfig(row)">配置店铺</el-button><el-button link type="primary" @click="openTemplateTest(row)">测试</el-button><el-dropdown trigger="click"><el-button link class="more-action">•••</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item class="danger-menu-item" @click="deleteTemplate(row)">删除模板</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div></template></el-table-column>
        </el-table></div>
        <div class="global-pagination-bar"><span>共 {{ filteredAutomationTemplates.length }} 个模板</span><el-pagination background layout="sizes, prev, pager, next, jumper" :current-page="templatePage" :page-size="templatePageSize" :page-sizes="[20, 30, 50, 80]" :total="filteredAutomationTemplates.length" @current-change="changeTemplatePage" @size-change="changeTemplatePageSize" /></div>
      </section>
    </el-card>

    <el-dialog v-model="templateDialogVisible" :title="templateDialog.mode === 'create' ? '新增消息模板' : '编辑消息模板'" width="900px" destroy-on-close>
      <div class="template-dialog-body">
        <el-form label-width="90px">
          <el-form-item label="消息类型"><el-select v-model="templateDialog.form.scenario" :disabled="templateDialog.mode === 'edit'"><el-option v-for="scenario in (templateDialog.mode === 'edit' ? automationScenarios : availableTemplateScenarios)" :key="scenario.key" :label="scenario.label" :value="scenario.key" /></el-select></el-form-item>
          <el-form-item label="模板名称"><el-input v-model="templateDialog.form.label" /></el-form-item>
          <el-form-item label="触发条件"><el-select v-model="templateDialog.form.trigger_condition" style="width: 100%"><el-option v-for="option in triggerOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
          <el-form-item label="触发时间"><div class="trigger-delay-field"><span>满足条件后</span><el-input-number v-model="templateDialog.form.delay_hours" :min="0" :max="720" /><span>小时生成消息任务</span></div></el-form-item>
          <el-form-item label="插入变量"><div class="template-variable-bar"><el-button v-for="variable in templateVariables" :key="variable.key" size="small" plain @click="insertTemplateVariable(templateDialog.form, variable.key)">+ {{ variable.label }}</el-button></div></el-form-item>
          <el-form-item label="俄语内容"><el-input v-model="templateDialog.form.template_text" type="textarea" :rows="6" /></el-form-item>
          <el-form-item label="中文释义"><div class="dialog-field-stack"><el-input v-model="templateDialog.form.template_translation" type="textarea" :rows="4" /><el-button plain :loading="translationActionKey === `template-translate:${templateDialog.form.scenario}`" @click="translateTemplate(templateDialog.form)">根据俄语更新中文释义</el-button></div></el-form-item>
          <el-form-item label="启用"><el-switch v-model="templateDialog.form.enabled" /></el-form-item>
        </el-form>
      </div>
      <template #footer><el-button @click="templateDialogVisible=false">取消</el-button><el-button type="primary" :loading="rowActionKey === `template:${templateDialog.form.scenario}`" @click="saveTemplateEditor">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="shopConfigDialogVisible" title="配置适用店铺" width="620px" destroy-on-close>
      <div class="shop-config-dialog">
        <div class="shop-config-summary"><div><strong>{{ shopConfigDialog.form.label }}</strong><span>{{ scenarioTimingText(shopConfigDialog.form) }}</span></div><el-tag type="info" effect="plain">已选 {{ shopConfigDialog.form.shop_ids?.length || 0 }} 家</el-tag></div>
        <el-checkbox-group v-model="shopConfigDialog.form.shop_ids" class="shop-config-grid"><label v-for="shop in state.shops" :key="shop.shop_id" class="shop-config-item"><el-checkbox :label="Number(shop.shop_id)"><span class="shop-config-name">{{ shop.shop_name }}</span></el-checkbox></label></el-checkbox-group>
        <el-empty v-if="!state.shops.length" description="暂无可配置店铺" :image-size="72" />
      </div>
      <template #footer><el-button @click="shopConfigDialogVisible=false">取消</el-button><el-button type="primary" :loading="rowActionKey === `template:${shopConfigDialog.form.scenario}`" @click="saveShopConfig">保存店铺配置</el-button></template>
    </el-dialog>

    <el-dialog v-model="templateTestDialogVisible" title="模板安全测试" width="760px" destroy-on-close>
      <div class="template-test-dialog">
        <el-alert title="测试只读取真实订单并渲染模板，不会创建聊天或发送任何消息。" type="info" :closable="false" show-icon />
        <el-form label-width="90px">
          <el-form-item label="测试模板"><strong>{{ templateTestDialog.form.label }}</strong></el-form-item>
          <el-form-item label="测试店铺"><el-select v-model="templateTestDialog.form.shop_id" filterable style="width: 100%"><el-option v-for="shop in state.shops" :key="shop.shop_id" :label="shop.shop_name" :value="Number(shop.shop_id)" /></el-select></el-form-item>
          <el-form-item label="订单号"><el-input v-model="templateTestDialog.form.posting_number" clearable placeholder="可留空，系统选择该店铺最近一笔订单" /></el-form-item>
        </el-form>
        <section v-if="templateTestDialog.result" class="template-test-result">
          <div class="template-test-meta"><el-tag :type="templateTestDialog.result.condition_matched ? 'success' : 'warning'">{{ templateTestDialog.result.condition_matched ? '当前订单满足触发条件' : '当前订单不满足触发条件，仅展示预览' }}</el-tag><span>订单 {{ templateTestDialog.result.order?.posting_number }}</span><span>计划 {{ dt(templateTestDialog.result.scheduled_at) }}</span></div>
          <div><strong>俄语发送内容</strong><pre>{{ templateTestDialog.result.message_text }}</pre></div>
          <div><strong>中文释义</strong><pre>{{ templateTestDialog.result.message_translation }}</pre></div>
        </section>
      </div>
      <template #footer><el-button @click="templateTestDialogVisible=false">关闭</el-button><el-button :loading="templateTestDialog.loading" @click="runTemplateTest(false)">生成预览</el-button><el-button type="primary" plain :loading="templateTestDialog.loading" @click="runTemplateTest(true)">生成测试草稿</el-button></template>
    </el-dialog>

    <el-dialog v-model="chatVisible" title="订单消息" width="1120px" class="chat-window-dialog" destroy-on-close>
      <div v-if="chatOrder" class="chat-window">
        <aside class="chat-sidebar">
          <section class="chat-order-card">
            <div class="chat-order-title">
              <strong>{{ chatOrder.posting_number }}</strong>
              <el-tag size="small" effect="light" :type="orderStatusType(chatOrder)">{{ chatOrder.status_label_order || '-' }}</el-tag>
            </div>
            <div class="current-order-product">
              <ProductImagePreview :src="chatOrder.image_url" :alt="productLine(chatOrder)" />
              <div>
                <strong>{{ productLine(chatOrder) }}</strong>
                <span>{{ chatOrder.shop_name }}</span>
                <span>SKU {{ chatOrder.skus || '-' }} · 数量 {{ orderQuantity(chatOrder) || 1 }}</span>
              </div>
            </div>
            <span>客户 {{ chatOrder.customer_unique_id }}</span>
            <div class="chat-meta-list">
              <span>下单：{{ dt(chatOrder.ordered_at) }}</span>
              <span>预计：{{ chatOrder.delivery_window_text || '-' }}</span>
              <span>物流：{{ chatOrder.tracking_number || '待同步' }}</span>
            </div>
          </section>
          <section class="chat-history-card" v-loading="historyLoading">
            <div class="chat-history-head">
              <strong>历史订单</strong>
              <small>{{ state.historyOrders.length }} 单</small>
            </div>
            <div v-for="order in state.historyOrders" :key="order.id" class="history-order">
              <ProductImagePreview :src="order.image_url" :alt="order.product_summary || order.posting_number || '商品图片'" />
              <div>
                <strong>{{ order.posting_number }}</strong>
                <span>{{ dt(order.ordered_at) }} · {{ order.status_label }}</span>
                <span>{{ order.product_summary }}</span>
                <span>SKU {{ order.skus || '-' }} · 数量 {{ order.item_quantity || 0 }}</span>
              </div>
            </div>
          </section>
        </aside>

        <main class="chat-main">
          <div class="chat-context-bar">
            <div>
              <strong>客户 {{ chatOrder.customer_unique_id || '-' }}</strong>
              <span>{{ chatOrder.read_state_label || '未读' }} · 历史 {{ chatOrder.customer_order_count || 1 }} 单 · {{ chatOrder.chat_id ? `chat ${String(chatOrder.chat_id).slice(0, 8)}` : '未匹配 Ozon 聊天' }}</span>
            </div>
            <el-tag size="small" effect="light" :type="chatOrder.chat_enabled ? 'success' : 'info'">
              {{ chatOrder.real_chat_available ? '可查看真实聊天' : chatOrder.chat_enabled ? '仅生成订单消息' : '店铺未开通' }}
            </el-tag>
          </div>
          <div class="chat-thread" v-loading="chatMessagesLoading">
            <template v-if="state.chatMessages.length">
              <div
                v-for="message in state.chatMessages"
                :key="message.id || message.message_id"
                class="chat-bubble"
                :class="message.direction || 'system'"
              >
                <small>{{ chatDirectionLabel(message) }} · {{ dt(message.message_at || message.created_at) }}</small>
                <p>{{ message.message_text || '[空消息]' }}</p>
              </div>
            </template>
            <div v-else class="chat-bubble system">
              <small>{{ chatOrder.chat_id ? '真实聊天记录' : '未匹配真实聊天' }}</small>
              <p>{{ chatOrder.chat_id ? '该订单已有 Ozon 聊天线程，但当前没有可展示的历史消息。' : 'Ozon 没有给这个订单返回可用 chat_id，当前只能生成草稿、复制后人工处理，不能直接真实发送。' }}</p>
            </div>
            <div class="chat-bubble seller">
              <small>俄语建议回复</small>
              <p>{{ chatDraft }}</p>
            </div>
            <div class="chat-translation-card">
              <strong>中文含义（不发送给客户）</strong>
              <p>{{ draftTranslation(chatOrder) }}</p>
            </div>
          </div>
          <div class="chat-composer">
            <el-input v-model="chatDraft" type="textarea" :rows="5" placeholder="俄语正文，可按实际情况微调" />
            <div class="chat-actions">
              <el-button class="erp-btn erp-btn-secondary" :icon="CopyDocument" @click="copyChatDraft">复制俄语</el-button>
              <el-button
                class="erp-btn erp-btn-primary"
                type="primary"
                :loading="chatSending"
                :disabled="chatOrder.chat_capability !== 'available'"
                @click="sendChatMessage"
              >
                发送到 Ozon
              </el-button>
            </div>
          </div>
        </main>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.customer-message-page { height: calc(100dvh - 96px); min-height: 0; padding: 16px; gap: 12px; overflow: hidden; }
.customer-message-main { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.customer-message-main :deep(.el-card__body) { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.customer-message-main :deep(.el-card__header) { position: sticky; top: 0; z-index: 8; background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(14px); }
.customer-message-header p, .muted, .setting-panel p, .template-panel p { margin: 0; color: var(--erp-text-secondary); }
.customer-message-tabs, .customer-message-toolbar, .customer-message-header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.customer-message-tabs { justify-content: space-between; }
.customer-message-search { display: grid; grid-template-columns: 140px minmax(180px, 1fr) 160px 135px 125px 240px auto auto; align-items: center; gap: 10px; width: 100%; }
.customer-message-search .el-input { width: 100%; }
.customer-message-search .shop-filter { width: 100%; }
.customer-message-section { display: flex; flex: 1 1 auto; flex-direction: column; gap: 12px; min-height: 0; overflow: hidden; }
.capability-row, .task-delivery-state { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--erp-text-secondary); font-size: 12px; }
.task-delivery-state { margin-top: 8px; }
.capability-error { color: var(--el-color-danger); overflow-wrap: anywhere; }
.customer-message-toolbar { position: relative; display: flex; align-items: center; padding: 14px; border: 1px solid #e8edf5; border-radius: 12px; background: #fbfcfe; }
.sync-result-panel { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid rgba(59, 130, 246, 0.18); border-radius: var(--erp-radius); background: rgba(239, 246, 255, 0.66); color: #334155; }
.sync-result-panel small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--erp-text-secondary); }
.records-page-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 4px 4px 6px; }
.records-page-heading h3 { margin: 0 0 5px; color: #172033; font-size: 17px; }
.records-page-heading p { margin: 0; color: var(--erp-text-secondary); font-size: 13px; }
.records-summary { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; border-radius: 9px; background: #f1f5f9; color: #64748b; font-size: 12px; }
.records-summary strong { color: #334155; font-size: 18px; }
.records-updated-at { position: absolute; right: 14px; bottom: -26px; color: var(--erp-text-secondary); font-size: 12px; }
.records-table-shell { min-height: 360px; margin-top: 14px; overflow: hidden; border: 1px solid #e8edf5; border-radius: 12px; background: #fff; }
.paged-table-shell { flex: 1 1 auto; min-height: 300px; margin-top: 0; }
.customer-message-table { --el-table-header-bg-color: #f8fafc; }
.customer-message-table :deep(th.el-table__cell) { height: 48px; color: #64748b; font-weight: 600; }
.customer-message-table :deep(.el-table__empty-block) { min-height: 300px; }
.customer-message-table :deep(.el-table__row) { transition: background 0.18s ease, box-shadow 0.18s ease; }
.customer-message-table :deep(.el-table__row.is-unread-message) { font-weight: 600; background: rgba(239, 246, 255, 0.55); }
.customer-message-table :deep(.el-table__row.is-marked-message) { background: rgba(255, 247, 237, 0.72); }
.customer-message-table :deep(.el-table__row:hover > td) { background: rgba(248, 250, 252, 0.98) !important; }
.customer-message-table :deep(.muted-line), .customer-message-table :deep(.task-status-cell small) { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.global-pagination-bar { display: flex; flex: 0 0 48px; align-items: center; justify-content: space-between; gap: 16px; min-height: 48px; padding: 8px 4px 0; color: var(--erp-text-secondary); font-size: 13px; border-top: 1px solid #eef2f7; }
.upcoming-search { grid-template-columns: 180px minmax(220px, 1fr) 190px auto auto; }
.upcoming-safety-note { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: -2px 0 14px; padding: 10px 14px; border-radius: 8px; background: #f8fafc; color: var(--erp-text-secondary); font-size: 13px; }
.upcoming-message-text { display: -webkit-box; overflow: hidden; margin: 0; line-height: 1.55; white-space: pre-line; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.upcoming-message-preview .el-message-box__message { max-height: 60vh; overflow: auto; white-space: pre-line; }
.shop-cell, .order-cell, .task-cell, .latest-cell { display: flex; flex-direction: column; gap: 7px; }
.latest-line-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.latest-line-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.order-cell__top, .task-cell > div, .setting-panel__head, .template-panel__head, .setting-panel__actions { display: flex; align-items: center; gap: 8px; }
.order-cell__top, .setting-panel__head, .template-panel__head { justify-content: space-between; }
.order-cell p, .task-cell p { margin: 0; }
.order-cell__meta { display: flex; flex-wrap: wrap; gap: 6px 10px; color: var(--erp-text-secondary); font-size: 12px; }
.order-with-image { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 9px; min-width: 0; }
.order-with-image > div:last-child { min-width: 0; }
.posting-number { display: block; color: #334155; }
.muted-line { display: block; margin-top: 6px; color: var(--erp-text-secondary); }
.history-pill { min-width: 58px; height: 28px; border: 1px solid rgba(37, 99, 235, 0.22); border-radius: 999px; background: rgba(239, 246, 255, 0.78); color: #2563eb; cursor: pointer; }
.history-pill:hover { border-color: rgba(37, 99, 235, 0.42); background: rgba(219, 234, 254, 0.96); }
.message-preview { max-height: 180px; margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); background: #fbfcff; font-family: inherit; line-height: 1.6; }
.message-actions { display: flex; flex-direction: column; gap: 8px; }
.message-actions--row { flex-direction: row; flex-wrap: wrap; }
.task-time-cell, .task-status-cell { display: flex; flex-direction: column; gap: 6px; color: var(--erp-text-secondary); font-size: 12px; }
.status-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.status-orb { display: inline-flex; align-items: center; justify-content: center; min-width: 54px; height: 24px; padding: 0 9px; border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 999px; background: rgba(248, 250, 252, 0.62); color: #94a3b8; font-size: 12px; transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease, opacity 0.16s ease; backdrop-filter: blur(12px); opacity: 0.78; }
.status-orb.is-current { min-width: 76px; height: 32px; color: #b45309; border-color: rgba(245, 158, 11, 0.48); background: rgba(255, 247, 237, 0.92); box-shadow: 0 10px 26px rgba(245, 158, 11, 0.18); font-weight: 700; opacity: 1; transform: scale(1.05); }
.status-orb.is-done { color: #047857; border-color: rgba(16, 185, 129, 0.36); background: rgba(236, 253, 245, 0.88); opacity: 0.92; }
.status-flow:hover .status-orb { filter: saturate(0.82); }
.status-flow .status-orb:hover { transform: translateY(-2px) scale(1.08); filter: none; box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14); z-index: 1; }
.chat-open-btn { min-width: 72px; }
.chat-window { display: grid; grid-template-columns: 330px minmax(0, 1fr); gap: 14px; min-height: 640px; }
.chat-sidebar, .chat-main, .chat-order-card, .chat-history-card, .chat-thread, .chat-composer { border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); background: #fff; }
.chat-sidebar { display: flex; flex-direction: column; gap: 12px; border: 0; background: transparent; }
.chat-order-card, .chat-history-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.chat-order-card { background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%); }
.chat-order-title, .chat-context-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.current-order-product { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); background: #fff; }
.current-order-product div:last-child { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.current-order-product strong, .current-order-product span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-meta-list { display: grid; gap: 4px; padding-top: 8px; border-top: 1px solid var(--erp-border-light); }
.chat-order-card span, .chat-history-card span, .chat-history-card small, .latest-cell small { color: var(--erp-text-secondary); }
.chat-history-head { display: flex; justify-content: space-between; align-items: center; }
.history-order { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; padding: 8px 0; border-top: 1px solid var(--erp-border-light); }
.history-order div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.history-order span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-main { display: grid; grid-template-rows: auto 1fr auto; overflow: hidden; }
.chat-context-bar { padding: 12px 14px; border-bottom: 1px solid var(--erp-border-light); background: #fff; }
.chat-context-bar div { display: flex; flex-direction: column; gap: 3px; }
.chat-context-bar span { color: var(--erp-text-secondary); font-size: 12px; }
.chat-thread { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: auto; background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%); }
.chat-bubble { max-width: 76%; padding: 12px 14px; border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06); }
.chat-bubble small { display: block; margin-bottom: 6px; color: var(--erp-text-secondary); }
.chat-bubble p { margin: 0; white-space: pre-wrap; line-height: 1.7; }
.chat-bubble.customer { align-self: flex-start; background: #fff; border: 1px solid var(--erp-border-light); }
.chat-bubble.system { align-self: flex-start; max-width: 86%; color: #475569; background: rgba(248, 250, 252, 0.96); border: 1px dashed rgba(148, 163, 184, 0.5); box-shadow: none; }
.chat-bubble.seller { align-self: flex-end; color: #fff; background: #5b5cf6; }
.chat-bubble.seller small { color: rgba(255, 255, 255, 0.76); }
.chat-translation-card { align-self: flex-end; width: min(76%, 680px); padding: 12px 14px; border: 1px solid rgba(37, 99, 235, 0.16); border-radius: 12px; background: rgba(239, 246, 255, 0.82); color: #334155; }
.chat-translation-card strong { display: block; margin-bottom: 6px; color: #2563eb; }
.chat-translation-card p { margin: 0; white-space: pre-wrap; line-height: 1.7; }
.chat-composer { padding: 12px; border-width: 1px 0 0; border-radius: 0; }
.chat-actions { display: flex; justify-content: flex-end; gap: 8px; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
.setting-panel, .template-panel { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); background: #fff; }
.template-editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
.template-editor-box { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px 12px; border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); background: #fff; }
.template-editor-box__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.template-editor-box__head > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.template-editor-box strong { display: block; color: #0f172a; }
.template-editor-box span { color: var(--erp-text-secondary); font-size: 12px; }
.template-editor-box :deep(.el-textarea__inner) { min-height: 184px !important; line-height: 1.6; resize: vertical; }
.template-translation { border-color: rgba(37, 99, 235, 0.18); background: rgba(239, 246, 255, 0.66); }
.template-translation strong { color: #2563eb; }
.template-translation :deep(.el-textarea__inner) { background: rgba(255, 255, 255, 0.9); }
.setting-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.setting-form label { display: grid; grid-template-columns: minmax(110px, 1fr) auto; align-items: center; gap: 6px 10px; color: var(--erp-text-secondary); }
.setting-form label small { grid-column: 1 / -1; color: var(--erp-text-secondary); }
.scenario-checks { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.template-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.template-list-toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; padding: 4px 4px 8px; }
.template-list-toolbar h3 { margin: 0 0 5px; color: #172033; font-size: 17px; }
.template-list-toolbar p { margin: 0; color: var(--erp-text-secondary); font-size: 13px; }
.template-toolbar-actions { display: flex; align-items: center; gap: 10px; }
.template-toolbar-actions .el-input { width: 260px; }
.template-table-shell { overflow: hidden; border: 1px solid #e8edf5; border-radius: 12px; background: #fff; }
.template-display-table { --el-table-border-color: transparent; --el-table-header-bg-color: #f8fafc; }
.template-display-table :deep(th.el-table__cell) { height: 48px; color: #64748b; font-weight: 600; }
.template-display-table :deep(td.el-table__cell) { padding: 18px 0; vertical-align: top; border-bottom-color: #eef2f7; }
.template-display-table :deep(.el-table__row:hover > td.el-table__cell) { background: #fbfdff; }
.template-display-table p { margin: 0; white-space: pre-wrap; line-height: 1.65; }
.template-copy { display: -webkit-box; overflow: hidden; white-space: pre-line !important; -webkit-box-orient: vertical; -webkit-line-clamp: 6; }
.template-display-table strong, .template-display-table small { display: block; }
.template-display-table small { margin-top: 5px; color: var(--erp-text-secondary); }
.template-name-cell { display: flex; align-items: flex-start; gap: 10px; }
.template-name-icon { display: inline-flex; flex: 0 0 34px; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; color: #4f46e5; background: #eef2ff; font-weight: 700; }
.template-copy { color: #334155; }
.template-copy--zh { color: #475569; }
.template-shop-tags { display: flex; flex-wrap: wrap; gap: 7px; color: var(--erp-text-secondary); }
.template-shop-tags :deep(.el-tag) { max-width: 116px; overflow: hidden; text-overflow: ellipsis; border-radius: 6px; }
.template-row-actions { display: flex; align-items: center; gap: 2px; white-space: nowrap; }
.more-action { padding: 0 6px; color: #94a3b8; font-size: 18px; letter-spacing: 1px; }
.template-dialog-body { max-height: 68vh; overflow: auto; padding-right: 8px; }
.dialog-field-stack, .dialog-shop-select { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.dialog-field-stack .el-button { align-self: flex-end; }
.dialog-shop-select :deep(.el-checkbox-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 12px; }
.dialog-shop-select span { color: var(--erp-text-secondary); font-size: 12px; }
.shop-config-dialog { display: flex; flex-direction: column; gap: 16px; }
.shop-config-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-radius: 10px; background: #f8fafc; }
.shop-config-summary > div { display: flex; flex-direction: column; gap: 4px; }
.shop-config-summary span { color: var(--erp-text-secondary); font-size: 12px; }
.shop-config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; max-height: 360px; overflow: auto; }
.shop-config-item { padding: 11px 12px; border: 1px solid #e7ebf2; border-radius: 9px; background: #fff; cursor: pointer; transition: border-color .18s ease, background .18s ease; }
.shop-config-item:hover { border-color: #a5b4fc; background: #fafaff; }
.shop-config-name { display: inline-block; max-width: 190px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; white-space: nowrap; }
.template-list--automation { grid-template-columns: 1fr; }
.template-operation-row { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 18px; }
.template-main-editor { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.template-variable-bar { display: flex; flex-wrap: wrap; gap: 6px; }
.template-variable-bar :deep(.el-button + .el-button) { margin-left: 0; }
.trigger-delay-field { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; color: var(--erp-text-secondary); }
.template-test-dialog { display: flex; flex-direction: column; gap: 18px; }
.template-test-result { display: grid; gap: 14px; padding: 16px; border: 1px solid #e7ebf2; border-radius: 12px; background: #f8fafc; }
.template-test-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; color: var(--erp-text-secondary); font-size: 13px; }
.template-test-result pre { margin: 8px 0 0; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid #e7ebf2; border-radius: 9px; background: #fff; font: inherit; line-height: 1.65; }
.template-translation-inline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.template-translation-inline > div { display: flex; flex-direction: column; gap: 3px; }
.template-translation-inline span, .template-shop-config span, .template-shop-config small, .template-save-actions > span { color: var(--erp-text-secondary); font-size: 12px; }
.template-shop-config { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-left: 1px solid var(--erp-border-light); background: rgba(248, 250, 252, 0.72); }
.template-shop-list { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.template-shop-list :deep(.el-checkbox) { margin-right: 0; }
.template-save-actions { justify-content: space-between; border-top: 1px solid var(--erp-border-light); padding-top: 12px; }
.template-group-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px; }
.template-group-head p { margin: 4px 0 0; color: var(--erp-text-secondary); }
.template-group-head--manual { margin-top: 8px; padding-top: 18px; border-top: 1px solid var(--erp-border-light); }
.manual-template-collapse { border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); padding: 0 14px; }
@media (max-width: 1100px) {
  .customer-message-search { grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .customer-message-search :deep(.el-date-editor) { width: 100%; }
  .template-list-toolbar, .records-page-heading, .global-pagination-bar { align-items: flex-start; flex-direction: column; }
  .template-editor-grid { grid-template-columns: 1fr; }
  .settings-grid, .template-list { grid-template-columns: 1fr; }
  .template-operation-row { grid-template-columns: 1fr; }
  .template-shop-config { border-left: 0; border-top: 1px solid var(--erp-border-light); }
  .chat-window { grid-template-columns: 1fr; }
}
</style>
