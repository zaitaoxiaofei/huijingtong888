<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { ChatDotRound, CopyDocument, Flag, Refresh, Search, SwitchButton, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { copyToClipboard } from "../../utils/clipboard";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const loading = ref(false);
const settingsLoading = ref(false);
const rowActionKey = ref("");
const translationActionKey = ref("");
const activeTab = ref("tasks");
const chatVisible = ref(false);
const chatOrder = ref(null);
const chatDraft = ref("");
const chatSending = ref(false);
const historyLoading = ref(false);
const chatMessagesLoading = ref(false);
const syncingChats = ref(false);

const state = reactive({
  type: "unread",
  search: "",
  shopId: "",
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
  pageSize: 30,
  total: 0,
  totalPages: 1
});

const typeOptions = computed(() => [
  { value: "unread", label: "未读" },
  { value: "read", label: "已读" },
  { value: "marked", label: "已标记" }
]);

const shopOptions = computed(() => [
  { value: "", label: "全部店铺" },
  ...state.shops.map((shop) => ({ value: String(shop.shop_id), label: shop.shop_name }))
]);

const scenarioOrder = ["order_created", "order_update", "stall_comfort", "delay_comfort", "pickup_notice", "review_request"];

function dt(value) {
  return value ? String(value).slice(0, 19).replace("T", " ") : "-";
}

function actionKey(row, action) {
  return `${row.task_key}:${action}`;
}

function latestLine(row) {
  return String(row.real_chat_last_message || row.message_text || row.customer_message || "").split(/\n+/).find(Boolean) || "暂无消息";
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
  if (row.read_state !== "read") {
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
  if (!chatOrder.value.real_chat_available || !chatOrder.value.chat_id) {
    ElMessage.warning("该订单还没有匹配到 Ozon 聊天线程，不能直接发送。请先复制消息手动处理。");
    return;
  }
  chatSending.value = true;
  try {
    await apiClient.post("/api/customer-messages/send", {
      order_id: chatOrder.value.order_id,
      posting_number: chatOrder.value.posting_number,
      shop_id: chatOrder.value.shop_id,
      customer_id: chatOrder.value.customer_unique_id,
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
      type: state.type,
      search: state.search,
      page: String(state.page || 1),
      pageSize: String(state.pageSize || 30)
    });
    if (state.shopId) params.set("shop_id", state.shopId);
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
    state.pageSize = Number(data?.pageSize || data?.page_size || state.pageSize || 30);
    state.totalPages = Number(data?.total_pages || Math.max(1, Math.ceil(state.total / state.pageSize)));
  } catch (error) {
    ElMessage.error(error?.message || "客户消息任务加载失败");
  } finally {
    loading.value = false;
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

async function updateShop(shop) {
  rowActionKey.value = `shop:${shop.shop_id}`;
  try {
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

async function updateTemplate(template) {
  rowActionKey.value = `template:${template.scenario}`;
  try {
    const result = await apiClient.post("/api/customer-message-settings/template", template);
    if (result?.settings?.templates) state.templates = result.settings.templates;
    ElMessage.success("消息模板已保存");
    await loadRows();
  } catch (error) {
    ElMessage.error(error?.message || "保存模板失败");
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
  state.type = "unread";
  state.search = "";
  state.shopId = "";
  state.dateRange = [];
  state.page = 1;
  loadRows();
}

function changePage(page) {
  state.page = Math.max(1, Number(page || 1));
  loadRows();
}

function changePageSize(pageSize) {
  state.pageSize = Math.max(10, Number(pageSize || 30));
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
            { label: '消息任务', value: 'tasks' },
            { label: '店铺权限', value: 'shops' },
            { label: '模板规则', value: 'templates' }
          ]" />
          <div class="customer-message-header-actions">
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="syncingChats" @click="syncRealChats">同步真实聊天</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading || settingsLoading" @click="reloadAll">刷新</el-button>
          </div>
        </div>
      </template>

      <section v-if="activeTab === 'tasks'" class="customer-message-section">
        <div class="customer-message-toolbar">
          <el-segmented v-model="state.type" :options="typeOptions" @change="reloadFirstPage" />
          <div class="customer-message-search">
            <el-select v-model="state.shopId" class="shop-filter" filterable @change="reloadFirstPage">
              <el-option v-for="shop in shopOptions" :key="shop.value" :label="shop.label" :value="shop.value" />
            </el-select>
            <el-date-picker
              v-model="state.dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="下单开始"
              end-placeholder="下单结束"
              @change="reloadFirstPage"
            />
            <el-input v-model="state.search" clearable placeholder="订单号 / SKU / 商品 / 店铺" @keyup.enter="search">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" :loading="loading" @click="search">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" @click="reset">重置</el-button>
          </div>
          <span v-if="state.generatedAt" class="muted">生成时间 {{ dt(state.generatedAt) }}</span>
        </div>
        <div v-if="state.lastSyncResult" class="sync-result-panel">
          <strong>订单聊天匹配结果</strong>
          <span>同步 {{ state.lastSyncResult.threads_synced || 0 }} 个线程 · {{ state.lastSyncResult.messages_synced || 0 }} 条消息</span>
          <small v-if="state.lastSyncResult.errors?.length">{{ state.lastSyncResult.errors[0] }}</small>
          <small v-else>仅当 Ozon 返回订单号时，系统才会把真实聊天挂到对应订单。</small>
        </div>

        <el-table
          v-loading="loading"
          :data="state.rows"
          row-key="task_key"
          stripe
          class="erp-data-table customer-message-table"
          table-layout="fixed"
          :row-class-name="messageRowClass"
          empty-text="暂无符合条件的客户消息任务"
        >
          <el-table-column label="店铺" width="150">
            <template #default="{ row }">
              <div class="shop-cell">
                <strong>{{ row.shop_name || '-' }}</strong>
                <el-tag size="small" effect="light" :type="row.chat_enabled ? 'success' : 'info'">{{ row.chat_enabled ? '可聊天' : '未开通' }}</el-tag>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="订单号" width="180">
            <template #default="{ row }">
              <div class="order-with-image">
                <ProductImagePreview :src="row.image_url" :alt="productLine(row)" />
                <div>
                  <strong class="posting-number">{{ row.posting_number }}</strong>
                  <small class="muted-line">客户 {{ row.customer_unique_id || '-' }}</small>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="历史订单" width="110" align="center">
            <template #default="{ row }">
              <button class="history-pill" type="button" @click="openChat(row)">
                {{ row.customer_order_count || 1 }} 单
              </button>
            </template>
          </el-table-column>

          <el-table-column label="下单时间" width="150">
            <template #default="{ row }">
              {{ dt(row.ordered_at) }}
            </template>
          </el-table-column>

          <el-table-column label="最新消息" min-width="320">
            <template #default="{ row }">
              <div class="latest-cell">
                <div class="latest-line-head">
                  <strong>{{ latestLine(row) }}</strong>
                  <el-tag v-if="row.real_chat_available" size="small" effect="light" type="success">真实聊天</el-tag>
                </div>
                <small>{{ productLine(row) }}</small>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="聊天" width="110" align="center" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn erp-btn-primary chat-open-btn" type="primary" :icon="ChatDotRound" @click="openChat(row)">打开</el-button>
            </template>
          </el-table-column>

          <el-table-column label="订单状态" width="130" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="light" :type="orderStatusType(row)">{{ row.status_label_order || '-' }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="消息状态" min-width="430">
            <template #default="{ row }">
              <div class="status-flow">
                <span
                  v-for="scenario in state.scenarios"
                  :key="scenario.key"
                  class="status-orb"
                  :class="`is-${scenarioState(row, scenario).type}`"
                >
                  {{ scenario.label }}
                </span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <div class="message-actions">
                <el-button class="erp-btn erp-btn-secondary" plain :icon="Flag" :loading="rowActionKey === actionKey(row, 'problem')" @click="recordMessage(row, 'problem')">标记</el-button>
                <el-button class="erp-btn erp-btn-secondary" plain :icon="SwitchButton" :loading="rowActionKey === actionKey(row, 'skipped')" :disabled="row.status === 'disabled'" @click="recordMessage(row, 'skipped')">跳过</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div class="customer-message-pagination">
          <span>共 {{ state.total }} 条，第 {{ state.page }} / {{ state.totalPages }} 页</span>
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

      <section v-else-if="activeTab === 'shops'" class="customer-message-section settings-grid" v-loading="settingsLoading">
        <article v-for="shop in state.shops" :key="shop.shop_id" class="setting-panel">
          <div class="setting-panel__head">
            <div>
              <strong>{{ shop.shop_name }}</strong>
              <p>{{ shop.chat_enabled ? '该店铺订单会生成客户消息任务' : '该店铺没有聊天权限，不发送消息' }}</p>
            </div>
            <el-switch v-model="shop.chat_enabled" active-text="开通" inactive-text="关闭" />
          </div>
          <div class="setting-form">
            <label><span>发送模式</span><el-select v-model="shop.send_mode"><el-option label="不发送" value="none" /><el-option label="仅草稿" value="draft" /><el-option label="人工确认" value="confirm" /></el-select></label>
            <label><span>卡顿小时</span><el-input-number v-model="shop.stall_hours" :min="1" :max="240" /></label>
            <label><span>延误提前小时</span><el-input-number v-model="shop.delay_hours_before_due" :min="1" :max="168" /></label>
            <label><span>求好评延后小时</span><el-input-number v-model="shop.review_delay_hours" :min="1" :max="240" /></label>
          </div>
          <el-checkbox-group v-model="shop.enabled_scenarios" class="scenario-checks">
            <el-checkbox v-for="scenario in state.scenarios" :key="scenario.key" :label="scenario.key">{{ scenario.label }}</el-checkbox>
          </el-checkbox-group>
          <el-input v-model="shop.note" type="textarea" :rows="2" placeholder="店铺聊天权限、客服账号、备注" />
          <div class="setting-panel__actions">
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Flag" :loading="rowActionKey === `shop:${shop.shop_id}`" @click="updateShop(shop)">保存配置</el-button>
          </div>
        </article>
      </section>

      <section v-else class="customer-message-section template-list" v-loading="settingsLoading">
        <article v-for="template in state.templates" :key="template.scenario" class="template-panel">
          <div class="template-panel__head">
            <div>
              <strong>{{ template.label }}</strong>
              <p v-pre>可用变量：{{posting_number}}、{{product_summary}}、{{status_label}}、{{tracking_line}}、{{delivery_window_line}}</p>
            </div>
            <el-switch v-model="template.enabled" active-text="启用" inactive-text="停用" />
          </div>
          <div class="template-editor-grid">
            <div class="template-editor-box">
              <div class="template-editor-box__head">
                <strong>俄语发送模板</strong>
                <span>会发送给客户</span>
              </div>
              <el-input v-model="template.template_text" type="textarea" :rows="8" />
            </div>
            <div class="template-editor-box template-translation">
              <div class="template-editor-box__head">
                <div>
                  <strong>中文示意</strong>
                  <span>只给运营看，不发送给客户</span>
                </div>
                <el-button
                  class="erp-btn erp-btn-secondary"
                  size="small"
                  :loading="translationActionKey === `template-translate:${template.scenario}`"
                  @click="translateTemplate(template)"
                >
                  AI翻译释义
                </el-button>
              </div>
              <el-input
                v-model="template.template_translation"
                type="textarea"
                :rows="8"
                placeholder="这里显示当前俄语模板的中文意思。修改俄语模板后可点击 AI 翻译释义，它会替换这里的内容。"
              />
            </div>
          </div>
          <div class="setting-panel__actions">
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="View" :loading="rowActionKey === `template:${template.scenario}`" @click="updateTemplate(template)">保存模板</el-button>
          </div>
        </article>
      </section>
    </el-card>

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
              <p>{{ chatOrder.chat_id ? '该订单已有 Ozon 聊天线程，但暂未同步到历史消息。可以点击页面上方“同步真实聊天”重新拉取。' : 'Ozon 没有给这个订单返回可用 chat_id，当前只能生成草稿、复制后人工处理，不能直接真实发送。' }}</p>
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
                :disabled="!chatOrder.real_chat_available || !chatOrder.chat_id"
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
.customer-message-page { padding: 16px; gap: 12px; overflow: auto; }
.customer-message-main { overflow: visible; }
.customer-message-main :deep(.el-card__header) { position: sticky; top: 0; z-index: 8; background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(14px); }
.customer-message-header p, .muted, .setting-panel p, .template-panel p { margin: 0; color: var(--erp-text-secondary); }
.customer-message-tabs, .customer-message-toolbar, .customer-message-header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.customer-message-tabs { justify-content: space-between; }
.customer-message-search { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.customer-message-search .el-input { width: 280px; }
.customer-message-search .shop-filter { width: 160px; }
.customer-message-section { display: flex; flex-direction: column; gap: 12px; }
.customer-message-toolbar { position: sticky; top: 58px; z-index: 7; padding: 10px 0; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(14px); border-bottom: 1px solid rgba(226, 232, 240, 0.7); }
.sync-result-panel { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid rgba(59, 130, 246, 0.18); border-radius: var(--erp-radius); background: rgba(239, 246, 255, 0.66); color: #334155; }
.sync-result-panel small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--erp-text-secondary); }
.customer-message-table :deep(.el-table__row) { transition: background 0.18s ease, box-shadow 0.18s ease; }
.customer-message-table :deep(.el-table__row.is-unread-message) { font-weight: 600; background: rgba(239, 246, 255, 0.55); }
.customer-message-table :deep(.el-table__row.is-marked-message) { background: rgba(255, 247, 237, 0.72); }
.customer-message-table :deep(.el-table__row:hover > td) { background: rgba(248, 250, 252, 0.98) !important; }
.customer-message-pagination { position: sticky; bottom: 0; z-index: 6; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 4px 2px; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(14px); color: var(--erp-text-secondary); }
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
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
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
.setting-form label { display: flex; flex-direction: column; gap: 6px; color: var(--erp-text-secondary); }
.scenario-checks { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.template-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); }
@media (max-width: 1100px) {
  .customer-message-search { width: 100%; margin-left: 0; }
  .template-editor-grid { grid-template-columns: 1fr; }
  .chat-window { grid-template-columns: 1fr; }
}
</style>
