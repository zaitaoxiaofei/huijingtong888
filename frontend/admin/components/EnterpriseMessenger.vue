<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { apiClient, currentApiCacheScope } from "../utils/api";
import { shanghaiDateTimeText } from "../utils/shanghai-date";
import HeaderToolIcon from "./HeaderToolIcon.vue";

const auth = useAuthStore();
const router = useRouter();
const visible = ref(false), unread = ref(0), contacts = ref([]), conversations = ref([]);
const peerId = ref(null), messages = ref([]), hasOlder = ref(false), loading = ref(false), sending = ref(false);
const error = ref(""), transcript = ref(null), referenceType = ref("order"), referenceQuery = ref(""), references = ref([]), referenceLoading = ref(false), referencePicker = ref(false);
const detailVisible = ref(false), detailLoading = ref(false), detailError = ref(""), detailRecord = ref(null);
const drafts = reactive(new Map());
let scope = currentApiCacheScope(), generation = 0, threadVersion = 0, referenceVersion = 0, detailVersion = 0, afterId = 0, timer = 0, polling = false, disposed = false;
const controllers = new Set();
const me = computed(() => Number(auth.user?.id || auth.user?.person_id));
const peer = computed(() => contacts.value.find(person => Number(person.id) === Number(peerId.value)) || conversations.value.find(item => Number(item.peer.id) === Number(peerId.value))?.peer);
const draft = computed(() => {
  if (!drafts.has(peerId.value)) drafts.set(peerId.value, { text: "", reference: null, pending: null });
  return drafts.get(peerId.value);
});
const sameScope = version => !disposed && version === generation && scope === currentApiCacheScope();
function fail(failure) { if (failure?.name !== "AbortError") error.value = failure.message || "消息加载失败，请重试"; }
async function request(path, body) {
  const controller = new AbortController(); controllers.add(controller);
  try {
    const options = { signal: controller.signal, noCache: true, routeScoped: false };
    return body === undefined ? await apiClient.get(`/api/enterprise/messages/${path}`, options) : await apiClient.post(`/api/enterprise/messages/${path}`, body, options);
  } finally { controllers.delete(controller); }
}
function reset() {
  generation++; threadVersion++; referenceVersion++; detailVersion++; scope = currentApiCacheScope();
  for (const controller of controllers) controller.abort(); controllers.clear();
  visible.value = false; unread.value = 0; contacts.value = []; conversations.value = []; peerId.value = null;
  messages.value = []; afterId = 0; drafts.clear(); references.value = []; pendingReference.value = null; referenceQuery.value = ""; referenceType.value = "order"; referenceLoading.value = false;
  error.value = ""; loading.value = false; sending.value = false; referencePicker.value = false;
  detailVisible.value = false; detailRecord.value = null; detailError.value = ""; detailLoading.value = false;
}
async function refreshSummary() {
  const version = generation;
  const summary = await request("unread");
  if (!sameScope(version)) return;
  unread.value = Number(summary.unread_count || 0);
  if (visible.value) {
    const result = await request("conversations");
    if (sameScope(version)) conversations.value = result.rows || [];
  }
}
async function acknowledgeShown(version, selectedPeer, shown) {
  if (!sameScope(version) || !visible.value || document.visibilityState === "hidden" || Number(peerId.value) !== Number(selectedPeer)) return;
  const ids = shown.filter(item => Number(item.recipient_id) === me.value && !item.read_at).map(item => item.id).slice(0, 100);
  if (!ids.length) return;
  const response = await request("read", { peer_id: selectedPeer, message_ids: ids });
  if (!sameScope(version) || Number(peerId.value) !== Number(selectedPeer)) return;
  unread.value = Number(response.unread_count || 0);
  const readIds = new Set(ids);
  messages.value = messages.value.map(item => readIds.has(item.id) ? { ...item, read_at: new Date().toISOString() } : item);
}
async function loadThread({ older = false, incremental = false } = {}) {
  const selectedPeer = Number(peerId.value); if (!selectedPeer) return;
  const version = generation, ticket = ++threadVersion;
  const params = new URLSearchParams({ peer_id: String(selectedPeer), limit: "50" });
  if (older && messages.value.length) params.set("before_id", messages.value[0].id);
  if (incremental && afterId > 0) params.set("after_id", String(afterId));
  if (!incremental) loading.value = true;
  const beforeHeight = transcript.value?.scrollHeight || 0;
  const wasAtBottom = !transcript.value || transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 90;
  try {
    const response = await request(`thread?${params}`);
    if (!sameScope(version) || ticket !== threadVersion || Number(peerId.value) !== selectedPeer) return;
    const rows = response.rows || [];
    if (incremental || older) {
      const items = new Map(messages.value.map(item => [Number(item.id), item]));
      for (const item of rows) items.set(Number(item.id), item);
      messages.value = [...items.values()].sort((a, b) => Number(a.id) - Number(b.id));
    } else messages.value = rows;
    if (!incremental || afterId === 0) hasOlder.value = Boolean(response.has_more);
    if (!older && rows.length) afterId = Number(rows.at(-1).id);
    await nextTick();
    if (!sameScope(version) || ticket !== threadVersion) return;
    if (transcript.value && older) transcript.value.scrollTop = transcript.value.scrollHeight - beforeHeight;
    else if (transcript.value && (!incremental || wasAtBottom)) transcript.value.scrollTop = transcript.value.scrollHeight;
    await acknowledgeShown(version, selectedPeer, messages.value);
  } catch (failure) { if (sameScope(version) && ticket === threadVersion) fail(failure); }
  finally { if (sameScope(version) && ticket === threadVersion) loading.value = false; }
}
async function selectPeer(id) {
  threadVersion++; peerId.value = Number(id) || null; messages.value = []; afterId = 0; error.value = ""; hasOlder.value = false; referencePicker.value = false;
  await loadThread();
}
async function open(reference = null) {
  visible.value = true; error.value = "";
  const version = generation;
  try {
    const result = await request("contacts");
    if (!sameScope(version)) return;
    contacts.value = result.rows || [];
    await refreshSummary();
    if (!sameScope(version)) return;
    if (reference) {
      if (!peerId.value && contacts.value.length === 1) await selectPeer(contacts.value[0].id);
      if (!sameScope(version)) return;
      if (peerId.value) draft.value.reference = reference;
      else pendingReference.value = reference;
    }
    if (sameScope(version) && peerId.value) await loadThread();
  } catch (failure) { if (sameScope(version)) fail(failure); }
}
const pendingReference = ref(null);
async function choosePeer(id) {
  const version = generation, selectedPeer = Number(id);
  await selectPeer(id);
  if (sameScope(version) && Number(peerId.value) === selectedPeer && pendingReference.value && peerId.value) { draft.value.reference = pendingReference.value; pendingReference.value = null; }
}
async function findReferences() {
  const version = generation, selectedPeer = peerId.value, ticket = ++referenceVersion;
  referenceLoading.value = true; error.value = "";
  try {
    const result = await request(`references?${new URLSearchParams({ type: referenceType.value, q: referenceQuery.value, limit: "20" })}`);
    if (sameScope(version) && ticket === referenceVersion && selectedPeer === peerId.value) references.value = result.rows || [];
  } catch (failure) { if (sameScope(version) && ticket === referenceVersion) fail(failure); }
  finally { if (sameScope(version) && ticket === referenceVersion) referenceLoading.value = false; }
}
function chooseReference(reference) { draft.value.reference = reference; referencePicker.value = false; references.value = []; }
async function send() {
  if (sending.value || !peerId.value || !draft.value.text.trim()) return;
  const version = generation, selectedPeer = Number(peerId.value), source = draft.value;
  const content = { peer_id: selectedPeer, text: source.text.trim(), reference: source.reference ? { type: source.reference.type, id: source.reference.id } : null };
  const fingerprint = JSON.stringify(content);
  if (!source.pending || source.pending.fingerprint !== fingerprint) source.pending = { fingerprint, id: crypto.randomUUID() };
  sending.value = true; error.value = "";
  try {
    const response = await request("send", { ...content, client_message_id: source.pending.id });
    if (!sameScope(version)) return;
    source.text = ""; source.reference = null; source.pending = null;
    if (Number(peerId.value) === selectedPeer) {
      const items = new Map(messages.value.map(item => [Number(item.id), item])); items.set(Number(response.message.id), response.message);
      messages.value = [...items.values()].sort((a, b) => Number(a.id) - Number(b.id));
      await nextTick(); if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
    }
    await refreshSummary();
  } catch (failure) { if (sameScope(version)) fail(failure); }
  finally { if (sameScope(version)) sending.value = false; }
}
async function poll() {
  if (polling || disposed || document.visibilityState === "hidden") return;
  polling = true; const version = generation;
  try { await refreshSummary(); if (visible.value && peerId.value && !loading.value) await loadThread({ incremental: true }); }
  catch (failure) { if (sameScope(version) && visible.value) fail(failure); }
  finally { polling = false; }
}
function handleOpen(event) { void open(event.detail?.reference || null); }
async function visit(reference) {
  if (!reference?.available || !reference.route) return;
  if (reference.type !== "procurement") { visible.value = false; router.push(reference.route).catch(fail); return; }
  const version = generation, ticket = ++detailVersion;
  detailVisible.value = true; detailLoading.value = true; detailRecord.value = null; detailError.value = "";
  try {
    const response = await request(`reference?type=procurement&id=${Number(reference.id)}`);
    if (sameScope(version) && ticket === detailVersion && detailVisible.value) detailRecord.value = response.record;
  } catch (failure) { if (sameScope(version) && ticket === detailVersion) detailError.value = failure.message || "采购需求详情暂不可访问"; }
  finally { if (sameScope(version) && ticket === detailVersion) detailLoading.value = false; }
}
function procurementStatus(value) { return ({ pending: "待采购", ordered: "已下单", purchased: "已采购", completed: "已完成", cancelled: "已取消", rejected: "已拒绝", partially_received: "部分收货", received: "已收货" })[value] || value || "—"; }
onMounted(() => {
  window.addEventListener("erp:auth-scope-changed", reset); window.addEventListener("erp:open-private-message", handleOpen);
  document.addEventListener("visibilitychange", poll); timer = window.setInterval(poll, 15000); void poll();
});
onBeforeUnmount(() => {
  disposed = true; reset(); window.clearInterval(timer); window.removeEventListener("erp:auth-scope-changed", reset);
  window.removeEventListener("erp:open-private-message", handleOpen); document.removeEventListener("visibilitychange", poll);
});
</script>

<template>
  <el-badge :value="unread" :max="99" :hidden="!unread" class="erp-header-badge">
    <el-button circle class="erp-header-icon" aria-label="企业私信" title="企业私信" @click="open()"><el-icon><HeaderToolIcon name="messages" /></el-icon></el-button>
  </el-badge>
  <el-dialog v-model="visible" title="企业私信" width="min(960px, 95vw)" top="6vh" append-to-body class="enterprise-messenger" :close-on-click-modal="false" @closed="referencePicker = false">
    <div class="enterprise-messenger__layout">
      <aside class="messenger-contacts">
        <span class="messenger-hint">{{ auth.user?.tenant?.name }} · 仅企业内一对一私信</span>
        <el-select :model-value="peerId" aria-label="选择私信同事" placeholder="选择同事，开始私信" filterable clearable @change="choosePeer">
          <el-option v-for="person in contacts" :key="person.id" :label="person.name || person.username" :value="Number(person.id)" />
        </el-select>
        <div class="messenger-conversations">
          <button v-for="conversation in conversations" :key="conversation.peer.id" type="button" class="messenger-conversation" :class="{ 'is-active': Number(peerId) === Number(conversation.peer.id) }" @click="choosePeer(conversation.peer.id)">
            <strong>{{ conversation.peer.name || conversation.peer.username }} <el-badge v-if="conversation.unread_count" :value="conversation.unread_count" :max="99" /></strong>
            <span>{{ conversation.last_message?.text || '暂无消息' }}</span>
          </button>
          <p v-if="!conversations.length" class="messenger-hint">选择同事开始对话，消息会保存在当前企业中。</p>
        </div>
      </aside>
      <section class="messenger-thread">
        <header><strong>{{ peer?.name || peer?.username || '选择一位同事' }}</strong><small>私信内容仅收发双方可见</small></header>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <div ref="transcript" v-loading="loading" class="messenger-transcript" aria-label="私信记录">
          <el-button v-if="hasOlder" text :loading="loading" @click="loadThread({ older: true })">加载更早消息</el-button>
          <p v-if="peerId && !messages.length && !loading" class="messenger-hint">还没有消息，发送第一条私信吧。</p>
          <article v-for="message in messages" :key="message.id" class="messenger-message" :class="{ 'is-mine': Number(message.sender_id) === me }">
            <small>{{ Number(message.sender_id) === me ? '我' : (peer?.name || peer?.username) }} · {{ shanghaiDateTimeText(message.created_at, { assumeUtcWhenNaive: true }) }}</small>
            <div class="messenger-message__bubble">
              <button v-if="message.reference" type="button" class="messenger-reference" :disabled="!message.reference.available" @click="visit(message.reference)">{{ message.reference.label }} <span v-if="message.reference.available">↗</span></button>
              <p>{{ message.text }}</p>
            </div>
          </article>
        </div>
        <div v-if="peerId" class="messenger-composer">
          <div class="messenger-compose-tools"><el-button text size="small" :disabled="sending" @click="referencePicker = !referencePicker; references = []">引用订单 / 采购需求</el-button><el-tag v-if="draft.reference" closable @close="draft.reference = null">{{ draft.reference.label || `${draft.reference.type === 'order' ? '订单' : '采购需求'} #${draft.reference.id}` }}</el-tag></div>
          <div v-if="referencePicker" class="messenger-reference-picker">
            <div><el-select v-model="referenceType" aria-label="引用记录类型" @change="references = []"><el-option label="订单" value="order" /><el-option label="采购需求" value="procurement" /></el-select><el-input v-model="referenceQuery" aria-label="查找引用记录" placeholder="输入订单号或采购需求 ID" @keyup.enter="findReferences" /><el-button :loading="referenceLoading" @click="findReferences">查找</el-button></div>
            <button v-for="reference in references" :key="`${reference.type}:${reference.id}`" type="button" class="messenger-reference" @click="chooseReference(reference)">{{ reference.label }}</button>
            <p v-if="!references.length" class="messenger-hint">仅可引用当前企业且你有权查看的记录。</p>
          </div>
          <el-input v-model="draft.text" type="textarea" :rows="3" maxlength="4000" show-word-limit :disabled="sending" resize="none" aria-label="私信内容" placeholder="输入消息，Ctrl / Cmd + Enter 发送" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" />
          <div class="messenger-send"><span>Enter 换行 · Ctrl / Cmd + Enter 发送</span><el-button type="primary" :disabled="!draft.text.trim()" :loading="sending" @click="send">发送私信</el-button></div>
        </div>
        <p v-else-if="pendingReference" class="messenger-hint">已选中引用记录，请先选择收件同事。</p>
      </section>
    </div>
  </el-dialog>
  <el-dialog v-model="detailVisible" title="引用的采购需求" width="min(620px, 94vw)" append-to-body destroy-on-close>
    <div v-loading="detailLoading" class="messenger-record-detail">
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
      <el-descriptions v-if="detailRecord" :column="1" border>
        <el-descriptions-item label="需求编号">#{{ detailRecord.id }}</el-descriptions-item>
        <el-descriptions-item label="库存商品">{{ detailRecord.product_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="需求数量">{{ detailRecord.quantity }} 件</el-descriptions-item>
        <el-descriptions-item label="处理状态">{{ procurementStatus(detailRecord.status) }}</el-descriptions-item>
        <el-descriptions-item label="关联订单">{{ detailRecord.source_posting_number || '—' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ shanghaiDateTimeText(detailRecord.created_at, { assumeUtcWhenNaive: true }) }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ detailRecord.note || '—' }}</el-descriptions-item>
      </el-descriptions>
    </div>
    <template #footer><el-button @click="detailVisible = false">关闭</el-button><el-button v-if="detailRecord" type="primary" @click="detailVisible = false; visible = false; router.push('/procurement/workspace').catch(fail)">打开采购工作台</el-button></template>
  </el-dialog>
</template>

<style scoped>
:global(.enterprise-messenger.el-dialog) { max-width: 95vw; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
:global(.enterprise-messenger .el-dialog__body) { min-height: 0; flex: 1; padding-top: 12px; }
.enterprise-messenger__layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); height: min(680px, 73vh); min-height: 0; color: var(--erp-text-main); }
.messenger-contacts { min-width: 0; padding-right: 16px; border-right: 1px solid var(--erp-border); display: flex; flex-direction: column; gap: 14px; }
.messenger-hint { color: var(--erp-text-regular); font-size: 12px; line-height: 1.7; }
.messenger-conversations { min-height: 0; overflow: auto; }
.messenger-conversation { display: grid; gap: 7px; width: 100%; text-align: left; padding: 12px; border: 1px solid transparent; background: transparent; color: inherit; border-radius: 8px; cursor: pointer; }
.messenger-conversation strong { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
.messenger-conversation > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--erp-text-regular); font-size: 12px; }
.messenger-conversation:hover, .messenger-conversation.is-active { background: var(--erp-primary-soft); border-color: var(--erp-primary-border); }
.messenger-thread { min-width: 0; min-height: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
.messenger-thread > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--erp-border); }
.messenger-thread > header small { font-size: 11px; color: var(--erp-text-regular); }
.messenger-transcript { flex: 1; min-height: 80px; overflow: auto; padding: 4px 8px; overscroll-behavior: contain; }
.messenger-message { display: flex; align-items: flex-start; flex-direction: column; margin: 0 0 15px; gap: 5px; }
.messenger-message > small { font-size: 11px; color: var(--erp-text-regular); }
.messenger-message.is-mine { align-items: flex-end; }
.messenger-message__bubble { max-width: 88%; border-radius: 10px; padding: 10px 13px; background: var(--erp-surface-alt); border: 1px solid var(--erp-border); }
.is-mine .messenger-message__bubble { background: var(--erp-primary-soft); border-color: var(--erp-primary-border); }
.messenger-message__bubble p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; font-size: 13px; }
.messenger-composer { flex: none; border-top: 1px solid var(--erp-border); padding-top: 8px; display: grid; gap: 8px; }
.messenger-compose-tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.messenger-compose-tools :deep(.el-tag) { max-width: 100%; height: auto; white-space: normal; }
.messenger-reference { color: var(--erp-primary); background: var(--erp-primary-soft); padding: 7px 9px; border: 1px solid var(--erp-primary-border); border-radius: 6px; font: inherit; font-size: 12px; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.messenger-reference:disabled { color: var(--erp-text-regular); background: var(--erp-surface-alt); border-color: var(--erp-border); cursor: default; }
.messenger-message .messenger-reference { display: block; margin-bottom: 7px; }
.messenger-reference-picker { max-height: 180px; overflow: auto; display: grid; gap: 6px; padding: 8px; border: 1px solid var(--erp-border); border-radius: 8px; }
.messenger-reference-picker > div { display: flex; gap: 6px; }
.messenger-reference-picker :deep(.el-select) { width: 125px; flex: none; }
.messenger-send { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.messenger-send > span { font-size: 11px; color: var(--erp-text-regular); }
.messenger-record-detail { min-height: 120px; overflow-wrap: anywhere; }
@media (max-width: 650px) {
  .enterprise-messenger__layout { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); height: 74vh; gap: 10px; }
  .messenger-contacts { border: 0; padding: 0; gap: 6px; }
  .messenger-conversations { display: none; }
  .messenger-thread { padding: 0; }
  .messenger-thread > header small, .messenger-send > span { display: none; }
  .messenger-send { justify-content: flex-end; }
}
</style>
