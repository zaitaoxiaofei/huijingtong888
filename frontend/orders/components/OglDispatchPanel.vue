<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../admin/stores/auth.js";
import { currentApiCacheScope } from "../../admin/utils/api.js";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText, shanghaiDateTimeText } from "../../admin/utils/shanghai-date.js";
import { oglDispatchService as service, normalizeOglOrderIds, oglMemberMatches } from "../services/ogl-dispatch-service.js";

const props = defineProps({ orderIds: { type: Array, default: () => [] }, batchId: { type: Number, default: 0 }, mode: { type: String, default: "history" } });
const emit = defineEmits(["close", "changed"]);
const auth = useAuthStore();
const currentScope = () => `${currentApiCacheScope()}:${auth.user?.id || ""}:${auth.user?.tenant?.id || ""}`;
const scope = computed(currentScope);
const initialScope = currentScope();
let alive = true;
let readSequence = 0;
const urls = new Set();
const current = () => alive && currentScope() === initialScope;
const visible = ref(true);
const busy = ref(false);
const error = ref("");
const tab = ref(props.mode === "create" ? "create" : props.mode === "official" ? "official" : "history");
const bootstrap = ref({ settings: {}, shops: [], can_manage_settings: false });
const defaultShopId = ref(null);
const selectedIds = normalizeOglOrderIds(props.orderIds);
const preview = ref(null);
const acceptEligible = ref(false);
const rows = ref([]);
const page = ref(1);
const total = ref(0);
const detail = ref(null);
const officialDate = ref(shanghaiDateKey());
const officialRows = ref([]);
const officialTotal = ref(0);
const officialShop = ref(null);
const officialDetail = ref(null);
const officialDetailDate = ref("");
const officialTracking = ref(null);
const trackingLoading = ref(false);
const trackingError = ref("");
let trackingSequence = 0;
const officialCarriage = computed(() => officialDetail.value?.carriage || {});
const officialMembers = computed(() => officialDetail.value?.members || []);
const masterTrackingLabel = computed(() => officialTracking.value?.master_tracking_number || (officialTracking.value?.status === "ambiguous" ? "多个运单，主单关系待确认" : "待获取"));
const selectedMembers = ref([]);
const memberFilter = ref("all");
const assignment = ref(1);
const options = ref([]);
const officialMethodOptions = computed(() => {
  const methods = new Map();
  for (const option of options.value) {
    const key = String(option.id);
    if (!methods.has(key)) methods.set(key, { id: option.id, name: option.name || `配送方式 ${option.id}`, days: new Set() });
    const day = option.departure_date || option.date ? shanghaiDateKey(option.departure_date || option.date) : "";
    if (day) methods.get(key).days.add(day);
  }
  return [...methods.values()].map((method) => ({ id: method.id, label: `${method.name}${method.days.size ? `（${[...method.days].join('、')}）` : ''}` }));
});
const officialNotice = ref("");
const recoveryCarriageId = ref("");
const form = reactive({ container_count: 1, departure_date: "", delivery_method_id: "", client_request_id: globalThis.crypto?.randomUUID?.() || `ogl-${Date.now()}-${Math.random().toString(36).slice(2)}` });
const courier = reactive({ phone: "", wechat_nickname: "", comment: "" });
const batch = computed(() => detail.value?.batch || {});
const summary = computed(() => detail.value?.summary || {});
const members = computed(() => (detail.value?.members || []).filter((member) => oglMemberMatches(member, memberFilter.value)));
const eligible = computed(() => Array.isArray(preview.value?.eligible) ? preview.value.eligible : []);
const rejected = computed(() => Array.isArray(preview.value?.rejected) ? preview.value.rejected : []);
const sourceShops = computed(() => {
  const groups = new Map();
  for (const member of eligible.value) {
    const name = member.shop_name || `店铺 #${member.shop_id}`;
    groups.set(name, (groups.get(name) || 0) + 1);
  }
  return [...groups].map(([name, count]) => `${name}：${count} 单`).join("；");
});
const defaultShopName = computed(() => bootstrap.value.shops.find((shop) => Number(shop.id) === Number(bootstrap.value.settings.dispatch_shop_id))?.name || "未配置");
const hasSelected = computed(() => selectedMembers.value.length > 0);
const closed = computed(() => ["closed", "cancelled"].includes(batch.value.status));
const officialExists = computed(() => Boolean(batch.value.official_carriage_id));
const officialReady = computed(() => batch.value.official_status === "approved");
const canCreateOfficial = computed(() => !closed.value && !officialExists.value && ["not_created", "failed"].includes(batch.value.official_status));
const officialSummary = computed(() => batch.value.official_result || {});
const canAssign = computed(() => !closed.value && hasSelected.value && ["not_created", "failed"].includes(batch.value.official_status) && selectedMembers.value.every((row) => !row.dispatched_at));
const canDispatch = computed(() => !closed.value && hasSelected.value && officialReady.value && selectedMembers.value.every((row) => !row.dispatched_at && !row.online && !row.cancelled));
const canCreate = computed(() => eligible.value.length > 0 && (!rejected.value.length || acceptEligible.value) && Boolean(bootstrap.value.settings.dispatch_shop_id));
const formatTime = (value) => shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
const formatDeparture = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim()) ? shanghaiDateText(value) : formatTime(value);
const batchStatus = (value) => ({ draft: "准备中", preparing: "准备中", ready: "待交运", ready_to_dispatch: "待交运", in_transit: "跟进中", dispatched: "跟进中", following: "跟进中", tracking: "跟进中", closed: "已结束", cancelled: "已取消" }[value] || value || "准备中");
const officialStatus = (value) => ({ pending: "待创建", not_created: "待创建", created: "已创建", approved: "已确认", confirmed: "已确认", error: "处理失败", failed: "创建失败", creating: "创建中", unknown: "待核实", create_unknown: "创建结果待核实", sync_required: "清单待核实", mismatch: "清单不一致", confirming: "确认中", confirm_unknown: "确认结果待核实", cancelled: "已取消" }[value] || value || "待创建");
const carriageStatus = (row) => row.status_label || ({ formed: "已生成", received: "承运方已接收", new: "待确认", created: "已创建", approved: "已确认", confirmed: "已确认", handed_over: "已交接", delivering: "运输中", completed: "已完成", cancelled: "已取消", canceled: "已取消" }[row.status]) || "平台状态待核对";
const eventLabel = (value) => ({ create: "创建内部批次", assign: "分配货位", dispatch: "标记实际交运", withdraw: "撤回待发", exception: "标记异常", resolve: "解决异常", cancel: "取消批次", close: "结束跟进", refresh: "刷新物流", "official-sync": "核对官方单", "official-create-start": "开始创建官方单", "official-created": "官方单已创建", "official-create-error": "官方创建失败或待核实", "official-confirm-start": "开始确认官方单", "official-confirm-error": "官方确认待核实" }[value] || "批次操作");
const memberPhase = (row) => row.withdrawn_at || row.active === 0 || row.active === false ? "已撤回" : row.online ? "已上网" : row.dispatched_at ? "已发运" : "待交运";
const platformStatusLabel = (row) => row.logistics_status_label || ({ awaiting_packaging: "等待备货", awaiting_deliver: "等待发货", awaiting_registration: "等待配送注册", posting_awaiting_registration: "等待配送注册", posting_registered: "配送已注册", posting_registration_error: "配送注册异常", sent_by_seller: "卖家已交运", posting_ready_for_pickup: "等待取件", posting_transferring_to_delivery: "正在移交配送", posting_in_carriage: "已加入发运", posting_transferring: "正在转运", delivering: "运输中", delivered: "已签收", cancelled: "已取消" }[row.logistics_status || row.tracking_stage || row.platform_status || row.status]) || (row.online ? "平台已上网" : row.cancelled ? "平台已取消" : "平台状态待核对");
const officialMemberStatus = (row) => [row.platform_status, row.logistics_status, row.tracking_stage].some((value) => ["acceptance_in_progress", "posting_acceptance_in_progress"].includes(value)) ? "平台验收中" : platformStatusLabel(row);
const memberIds = () => normalizeOglOrderIds(selectedMembers.value.map((row) => row.order_id));

watch(scope, () => { alive = false; visible.value = false; emit("close"); });
watch(memberFilter, () => { selectedMembers.value = []; });
onBeforeUnmount(() => { alive = false; for (const url of urls) URL.revokeObjectURL(url); });

async function run(work, success = "") {
  if (!current() || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await work();
    if (!current()) return;
    if (success) ElMessage.success(success);
    return result;
  } catch (cause) {
    if (current() && cause !== "cancel" && cause !== "close") error.value = cause.message || "操作失败，请重试";
  } finally { if (current()) busy.value = false; }
}

async function loadHistory() {
  const result = await service.list(page.value);
  if (!current()) return;
  rows.value = result.rows || [];
  total.value = Number(result.total || 0);
}

async function loadOfficialCarriages() {
  if (!officialDate.value) { error.value = "请选择要查看的北京日期"; return; }
  const result = await service.officialList(officialDate.value);
  if (!current()) return;
  officialRows.value = result.rows || [];
  officialTotal.value = Number(result.total ?? officialRows.value.length);
  officialShop.value = result.dispatch_shop || null;
}

async function showOfficialCarriages(date = officialDate.value) {
  if (!current() || busy.value) return;
  officialDate.value = date || shanghaiDateKey();
  tab.value = "official";
  officialDetail.value = null;
  resetOfficialTracking();
  officialRows.value = [];
  officialTotal.value = 0;
  officialShop.value = null;
  await run(loadOfficialCarriages);
}

async function openOfficialCarriage(id) {
  if (!current() || busy.value) return;
  const sequence = ++readSequence;
  const date = officialDate.value;
  resetOfficialTracking();
  officialDetail.value = null;
  await run(async () => {
    const result = await service.officialDetail(id, date);
    if (!current() || sequence !== readSequence) return;
    officialDetail.value = result;
    officialDetailDate.value = date;
    officialShop.value = result.dispatch_shop || officialShop.value;
    tab.value = "official-detail";
    void loadOfficialTracking();
  });
}

function resetOfficialTracking() {
  trackingSequence += 1;
  officialTracking.value = null;
  trackingLoading.value = false;
  trackingError.value = "";
}

async function loadOfficialTracking() {
  if (!current() || !officialDetail.value || tab.value !== "official-detail") return;
  const sequence = ++trackingSequence;
  const id = String(officialCarriage.value.carriage_id || officialCarriage.value.id);
  const date = officialDetailDate.value;
  const stillCurrent = () => current() && sequence === trackingSequence && tab.value === "official-detail" && String(officialCarriage.value.carriage_id || officialCarriage.value.id) === id && officialDetailDate.value === date;
  officialTracking.value = null;
  trackingError.value = "";
  trackingLoading.value = true;
  try {
    const result = await service.officialTracking(id, date);
    if (stillCurrent()) officialTracking.value = result.tracking || { status: "not_found" };
  } catch (cause) {
    if (stillCurrent()) trackingError.value = cause.message || "暂未取得官方标签中的运单号，请重试";
  } finally { if (stillCurrent()) trackingLoading.value = false; }
}

function useDetail(result) {
  if (!current()) return;
  detail.value = result;
  selectedMembers.value = [];
  form.departure_date = result.batch?.departure_date ? shanghaiDateKey(result.batch.departure_date) : "";
  form.delivery_method_id = result.batch?.delivery_method_id || "";
  tab.value = "detail";
}

async function openBatch(id) {
  const sequence = ++readSequence;
  await run(async () => {
    const result = await service.detail(id);
    if (sequence === readSequence && current()) { options.value = []; officialNotice.value = ""; useDetail(result); }
  });
}

async function saveSettings() {
  await run(async () => {
    await service.settings(defaultShopId.value);
    const result = await service.bootstrap();
    if (current()) bootstrap.value = result;
  }, "企业默认发运店铺已保存");
}

async function createBatch() {
  if (!canCreate.value) return;
  await run(async () => {
    const result = await service.create({ ...form, departure_date: form.departure_date || undefined, delivery_method_id: form.delivery_method_id || undefined, order_ids: eligible.value.map((row) => row.order_id || row.id) });
    if (!current()) return;
    useDetail(result);
    preview.value = null;
    emit("changed");
  }, "内部批次已保存，尚未标记实际交运");
}

async function action(name, payload = {}, success = "操作已完成") {
  const batchId = batch.value.id;
  await run(async () => {
    let result;
    try { result = await service.action(batchId, name, payload); }
    catch (cause) {
      try { useDetail(await service.detail(batchId)); } catch { /* Preserve the original actionable error. */ }
      throw cause;
    }
    if (!current()) return;
    if (result?.batch) useDetail(result);
    else useDetail(await service.detail(batchId));
    emit("changed");
  }, success);
}

async function selectedAction(name) {
  if (!hasSelected.value) return;
  const order_ids = memberIds();
  let reason = "";
  try {
    if (["withdraw", "exception", "resolve"].includes(name)) {
      const response = await ElMessageBox.prompt({ withdraw: "填写撤回原因；仅撤回核实未实际发走的订单，平台已揽收时需先人工核实。", exception: "填写缺货、漏装或其他需要核查的问题。", resolve: "填写本次处理结果，原异常历史仍会保留。" }[name], { withdraw: "撤回到等待发货", exception: "标记异常", resolve: "解决异常" }[name], { inputType: "textarea", inputValidator: (value) => Boolean(String(value || "").trim()) || "请填写原因或处理结果", confirmButtonText: "确认保存", cancelButtonText: "取消" });
      reason = response.value.trim();
    }
    if (name === "dispatch") await ElMessageBox.confirm(`确认这 ${order_ids.length} 个订单已经实际寄出或交给取件人员？生成官方单或打印标签不代表交运。`, "标记已发运", { confirmButtonText: "已实际交运", cancelButtonText: "取消", type: "warning" });
    await action(name, { order_ids, reason }, name === "dispatch" ? "已记录实际交运" : "订单处理已保存");
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause.message; }
}

async function endBatch(name) {
  try {
    const response = await ElMessageBox.prompt(name === "cancel" ? "填写取消批次原因。已实际交运的成员不能通过取消覆盖物流。" : "填写结束跟进说明。结束批次不会把未签收订单改为已签收。", name === "cancel" ? "取消批次" : "结束跟进", { inputValidator: (value) => Boolean(String(value || "").trim()) || "请填写说明", confirmButtonText: "确认", cancelButtonText: "取消" });
    await action(name, { reason: response.value.trim() });
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause.message; }
}

async function loadOfficialOptions() {
  await run(async () => {
    const result = await service.action(batch.value.id, "official-options");
    if (!current()) return;
    options.value = (result.options || []).map((option) => ({ ...option, id: option.delivery_method_id || option.id, name: option.delivery_method_name || option.name }));
    officialNotice.value = options.value.length ? "请选择默认店铺实际可用的 OGL 发运方式和日期。" : "默认店铺暂无可创建的发运方式；内部批次已保留，可稍后重试或检查店铺授权及待发货件。";
  });
}

function chooseOfficialOption(id) {
  const candidates = options.value.filter((row) => String(row.id) === String(id));
  const option = candidates.find((row) => shanghaiDateKey(row.departure_date || row.date) === form.departure_date) || candidates[0];
  if (option?.departure_date || option?.date) form.departure_date = shanghaiDateKey(option.departure_date || option.date);
}

async function officialAction(name) {
  if (name === "official-create" && (!form.delivery_method_id || !form.departure_date)) { error.value = "请先获取可用发运方式，并填写发运日期，再创建官方单。内部草稿可继续保留。"; return; }
  try {
    await ElMessageBox.confirm(name === "official-create" ? "将使用本批次创建店铺生成官方单，并核对本店所选货件的实际收录结果；其他店铺订单先保留 ERP 混装关联。此操作不会自动标记已发运。" : "确认向 Ozon 提交货位数量；上门取件时请填写联系电话，可补充微信及取件备注。", name === "official-create" ? "创建官方发运单" : "确认官方发运单", { confirmButtonText: "提交 Ozon", cancelButtonText: "取消", type: "warning" });
    await action(name, { delivery_method_id: form.delivery_method_id, departure_date: form.departure_date, container_count: Number(batch.value.containers_count), courier_contact: { phone: courier.phone.trim(), wechat_nickname: courier.wechat_nickname.trim(), comment: courier.comment.trim() } }, "官方处理已完成，请核对下方成员及结果");
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause.message; }
}

async function downloadFile(type, previewFile = false) {
  const target = previewFile ? window.open("about:blank", "_blank") : null;
  if (target) target.opener = null;
  await run(async () => {
    try {
      const blob = await service.file(batch.value.id, type);
      if (!current()) { target?.close(); return; }
      const url = URL.createObjectURL(blob);
      urls.add(url);
      if (previewFile && target && /^(application\/pdf|image\/(png|jpeg|webp))$/i.test(blob.type)) target.location.replace(url);
      else {
        target?.close();
        const link = document.createElement("a");
        link.href = url;
        link.download = `${String(batch.value.batch_number || "OGL").replace(/[^\w-]/g, "_")}-${type}.${blob.type === "application/pdf" ? "pdf" : blob.type === "image/png" ? "png" : "bin"}`;
        link.click();
        if (previewFile) ElMessage.info("文件已下载，请使用本地查看器打开并打印");
      }
    } catch (cause) { target?.close(); throw cause; }
  });
}

onMounted(() => run(async () => {
  const initial = await service.bootstrap();
  if (!current()) return;
  bootstrap.value = initial;
  defaultShopId.value = initial.settings?.dispatch_shop_id || null;
  if (props.mode === "create") {
    const result = await service.preview(selectedIds);
    if (current()) preview.value = result;
  } else if (props.mode === "official") await loadOfficialCarriages();
  else if (props.batchId) useDetail(await service.detail(props.batchId));
  else await loadHistory();
}));
</script>

<template>
  <el-drawer v-model="visible" title="OGL 发运批次" size="min(1180px, 96vw)" destroy-on-close :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="emit('close')">
    <div class="ogl-dispatch-panel" v-loading="busy">
      <el-alert v-if="error" :title="error" type="error" :closable="true" show-icon @close="error = ''" />
      <div class="ogl-dispatch-nav">
        <el-button :disabled="busy" @click="tab = 'history'; run(loadHistory)">批次历史</el-button>
        <el-button :disabled="busy" :type="tab.startsWith('official') ? 'primary' : 'default'" @click="showOfficialCarriages()">Ozon 后台已有单</el-button>
        <el-button v-if="preview" :disabled="busy" @click="tab = 'create'">创建批次（已选 {{ selectedIds.length }} 单）</el-button>
        <span>时间均为北京时间</span>
      </div>

      <el-collapse v-if="bootstrap.can_manage_settings" class="ogl-dispatch-settings">
        <el-collapse-item title="企业默认发运店铺（同企业用户共用）" name="settings">
          <el-select v-model="defaultShopId" placeholder="选择本企业已授权店铺" :disabled="busy" style="width: 260px"><el-option v-for="shop in bootstrap.shops" :key="shop.id" :label="shop.name" :value="Number(shop.id)" /></el-select>
          <el-button :disabled="busy || !defaultShopId" @click="saveSettings">保存默认店铺</el-button>
          <p>更改只影响新批次。历史批次继续使用创建时的店铺。</p>
        </el-collapse-item>
      </el-collapse>

      <template v-if="tab === 'official'">
        <h3>Ozon 后台已有发运单</h3>
        <p>查看默认发运店铺在 Ozon 后台已创建的单据，无需先选订单或建立 ERP 批次。此处仅查看，不确认官方单或标记实际交运。</p>
        <div class="ogl-dispatch-actions">
          <el-button :disabled="busy" @click="showOfficialCarriages(shanghaiDateKey())">今天</el-button>
          <el-button :disabled="busy" @click="showOfficialCarriages(shanghaiDateDaysAgo(1))">昨天</el-button>
          <el-date-picker v-model="officialDate" :disabled="busy" type="date" value-format="YYYY-MM-DD" placeholder="发运日期（北京时间）" aria-label="后台发运日期（北京时间）" />
          <el-button :disabled="busy || !officialDate" @click="showOfficialCarriages()">查询后台单</el-button>
        </div>
        <p>创建店铺：{{ officialShop?.name || defaultShopName }} · 北京日期 {{ officialDate }} · 共 {{ officialTotal }} 单</p>
        <el-table :data="officialRows" border @row-dblclick="row => openOfficialCarriage(row.carriage_id || row.id)">
          <el-table-column label="Ozon 申请号" min-width="145"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openOfficialCarriage(row.carriage_id || row.id)">{{ row.carriage_id || row.id }}</el-button></template></el-table-column>
          <el-table-column label="官方状态" min-width="120"><template #default="{ row }"><span :title="row.status || ''">{{ carriageStatus(row) }}</span></template></el-table-column>
          <el-table-column prop="delivery_method_name" label="发运方式" min-width="170" />
          <el-table-column label="发运日期（北京时间）" min-width="180"><template #default="{ row }">{{ formatDeparture(row.departure_date) }}</template></el-table-column>
          <el-table-column label="官方货件" width="100"><template #default="{ row }">{{ row.postings_count ?? '详情查看' }}</template></el-table-column>
          <el-table-column label="货位" width="110"><template #default="{ row }">{{ row.containers_count ?? '详情查看' }}</template></el-table-column>
          <el-table-column label="ERP 关联" min-width="170"><template #default="{ row }">{{ row.local_batch_id ? (row.local_batch_number || `内部批次 #${row.local_batch_id}`) : '只读，未关联内部批次' }}</template></el-table-column>
        </el-table>
      </template>

      <template v-if="tab === 'official-detail' && officialDetail">
        <div class="ogl-dispatch-actions"><el-button :disabled="busy" @click="tab = 'official'; resetOfficialTracking()">返回后台单列表</el-button><el-button :disabled="busy" @click="openOfficialCarriage(officialCarriage.carriage_id || officialCarriage.id)">刷新只读详情</el-button></div>
        <h3>Ozon 申请 {{ officialCarriage.carriage_id || officialCarriage.id }} <el-tag>{{ carriageStatus(officialCarriage) }}</el-tag></h3>
        <el-alert type="info" :closable="false" :title="officialCarriage.local_batch_id ? '此页面仅查看官方记录与本地订单匹配结果，不改变官方状态、ERP 批次或实际交运记录。' : '此单仅作只读展示，尚未关联 ERP 内部批次；匹配到本地订单不代表已建立批次或已实际交运。'" />
        <el-descriptions :column="2" border class="ogl-dispatch-readonly-detail">
          <el-descriptions-item label="创建店铺">{{ officialShop?.name || defaultShopName }}</el-descriptions-item>
          <el-descriptions-item label="官方状态"><span :title="officialCarriage.status || ''">{{ carriageStatus(officialCarriage) }}</span></el-descriptions-item>
          <el-descriptions-item label="实际货位（官方回读）">{{ officialCarriage.containers_count ?? '官方尚未返回' }}</el-descriptions-item>
          <el-descriptions-item label="发运日期（北京时间）">{{ formatDeparture(officialCarriage.departure_date) }}</el-descriptions-item>
          <el-descriptions-item label="发运方式">{{ officialCarriage.delivery_method_name || '官方尚未返回' }}</el-descriptions-item>
          <el-descriptions-item label="ERP 关联">{{ officialCarriage.local_batch_id ? (officialCarriage.local_batch_number || `内部批次 #${officialCarriage.local_batch_id}`) : '未关联内部批次' }}</el-descriptions-item>
        </el-descriptions>
        <section class="ogl-dispatch-tracking" aria-label="承运商运单与货位标签">
          <div class="ogl-dispatch-actions"><h4>承运商运单与货位标签</h4><el-button :loading="trackingLoading" :disabled="trackingLoading" @click="loadOfficialTracking">{{ trackingLoading ? '正在读取官方标签' : '重新获取运单信息' }}</el-button></div>
          <el-alert v-if="trackingError" type="warning" :closable="false" :title="`主运单号待获取：${trackingError}`" />
          <el-alert v-else-if="!trackingLoading && officialTracking?.status === 'not_found'" type="info" :closable="false" :title="officialTracking.notice || '官方标签中暂未取得可核实运单号，可稍后重新获取。'" />
          <el-descriptions :column="2" border>
            <el-descriptions-item label="承运商">{{ officialTracking?.carrier_name || '待获取' }}</el-descriptions-item>
            <el-descriptions-item label="主运单号"><strong class="ogl-dispatch-tracking-number">{{ masterTrackingLabel }}</strong></el-descriptions-item>
            <el-descriptions-item label="实际货位数量">{{ officialTracking?.containers_count ?? officialCarriage.containers_count ?? '待获取' }}</el-descriptions-item>
            <el-descriptions-item label="标签页数">{{ officialTracking?.page_count ?? (trackingLoading ? '读取中' : '待获取') }}</el-descriptions-item>
          </el-descriptions>
          <p v-if="trackingLoading">申请详情已加载；正在单独读取官方货位标签中的承运商运单。</p>
          <p v-if="officialTracking?.source === 'official_container_label'">来源：Ozon 官方货位标签。Ozon 申请号与承运商运单号分别展示。</p>
          <div v-if="officialTracking?.tracking_numbers?.length" class="ogl-dispatch-actions"><span>标签中全部运单号：</span><el-tag v-for="number in officialTracking.tracking_numbers" :key="number" class="ogl-dispatch-tracking-number">{{ number }}</el-tag></div>
          <el-alert v-if="officialTracking?.status === 'ambiguous'" type="warning" :closable="false" :title="officialTracking.notice || '标签识别到多个运单号，尚未确认主单或子母关系，请逐项核对。'" />
          <el-table v-if="officialTracking?.labels?.length" :data="officialTracking.labels" border max-height="250">
            <el-table-column label="标签页序" width="130"><template #default="{ row }">第 {{ row.label_page }} 页</template></el-table-column>
            <el-table-column label="该页运单号" min-width="230"><template #default="{ row }">{{ row.tracking_numbers?.length ? row.tracking_numbers.join('、') : '该页未识别到可核实运单号' }}</template></el-table-column>
          </el-table>
          <p>标签页序仅用于定位 PDF，不代表已核实的官方货位编号；多个运单号不会据此推断子母单关系。</p>
        </section>
        <p class="ogl-dispatch-progress">官方货件 {{ officialDetail.summary?.official_members ?? officialMembers.length }} · 本地精确匹配 {{ officialDetail.summary?.matched_local || 0 }} · 本地未匹配 {{ officialDetail.summary?.unmatched_local || 0 }} · 平台已上网 {{ officialDetail.summary?.online || 0 }}</p>
        <el-table :data="officialMembers" border max-height="500">
          <el-table-column prop="posting_number" label="官方货件号" min-width="180" />
          <el-table-column label="本地匹配" min-width="145"><template #default="{ row }">{{ row.matched_local ? `已匹配订单 #${row.order_id}` : '本地未匹配' }}</template></el-table-column>
          <el-table-column prop="shop_name" label="订单原店铺" min-width="140" />
          <el-table-column label="平台物流" min-width="150"><template #default="{ row }"><span v-if="row.matched_local" :title="row.logistics_status || row.platform_status || ''">{{ officialMemberStatus(row) }}</span><span v-else>本地无物流数据</span></template></el-table-column>
          <el-table-column label="上网情况" width="125"><template #default="{ row }">{{ !row.matched_local ? '待匹配核对' : row.online ? '平台已上网' : '未取得上网证据' }}</template></el-table-column>
          <el-table-column label="本地最近同步（北京时间）" min-width="200"><template #default="{ row }">{{ formatTime(row.last_synced_at) }}</template></el-table-column>
        </el-table>
      </template>

      <template v-if="tab === 'create'">
        <h3>核对本次所选订单</h3>
        <p>实际已选 {{ selectedIds.length }} 单（包含跨页勾选）；可入批 {{ eligible.length }} 单；不可入批 {{ rejected.length }} 单。</p>
        <p v-if="sourceShops">来源：{{ sourceShops }}</p>
        <el-alert v-if="!bootstrap.settings.dispatch_shop_id" type="warning" :closable="false" title="尚未配置本企业默认发运店铺。请由企业管理员在上方配置后再保存批次。" />
        <el-table v-if="rejected.length" :data="rejected" max-height="220" border>
          <el-table-column label="货件 / 订单" min-width="180"><template #default="{ row }">{{ row.posting_number || row.order_id || row.id }}</template></el-table-column>
          <el-table-column label="不可入批原因" min-width="260"><template #default="{ row }">{{ row.reason || row.message || '当前订单不符合入批条件，请刷新后核对' }}</template></el-table-column>
        </el-table>
        <el-checkbox v-if="rejected.length" v-model="acceptEligible" :disabled="busy">仅将上述 {{ eligible.length }} 个可入批订单保存到批次，排除其余订单</el-checkbox>
        <el-table v-if="eligible.length" :data="eligible" max-height="260" border>
          <el-table-column prop="posting_number" label="本次货件" min-width="190" />
          <el-table-column prop="shop_name" label="来源店铺" min-width="150" />
        </el-table>
        <el-form label-position="top" class="ogl-dispatch-form" :disabled="busy">
          <el-form-item label="官方创建店铺"><strong>{{ defaultShopName }}</strong></el-form-item>
          <el-form-item label="实际货位数量"><el-input-number v-model="form.container_count" :min="1" :max="1000" :precision="0" /><span class="ogl-dispatch-note">大袋 / 大箱数量；每单归属可保存后批量分配</span></el-form-item>
          <el-form-item label="发运日期（可稍后填写）"><el-date-picker v-model="form.departure_date" type="date" value-format="YYYY-MM-DD" placeholder="北京时间日期" /></el-form-item>
        </el-form>
        <p>保存内部批次后再获取官方可用方式、创建官方单和打印标签。订单仍归各自原店铺同步物流与财务。</p>
        <el-button type="primary" :disabled="busy || !canCreate" @click="createBatch">保存内部批次（{{ eligible.length }} 单）</el-button>
      </template>

      <template v-if="tab === 'history'">
        <el-table :data="rows" border @row-dblclick="row => openBatch(row.id)">
          <el-table-column label="批次" min-width="190"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openBatch(row.id)">{{ row.batch_number }}</el-button></template></el-table-column>
          <el-table-column prop="dispatch_shop_name" label="创建店铺" min-width="140" />
          <el-table-column prop="containers_count" label="货位" width="75" />
          <el-table-column label="阶段" width="105"><template #default="{ row }">{{ batchStatus(row.status) }}</template></el-table-column>
          <el-table-column label="官方单" width="120"><template #default="{ row }">{{ officialStatus(row.official_status) }}</template></el-table-column>
          <el-table-column label="有效 / 交运 / 上网" min-width="150"><template #default="{ row }">{{ row.summary?.active || 0 }} / {{ row.summary?.dispatched || 0 }} / {{ row.summary?.online || 0 }}</template></el-table-column>
          <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ formatTime(row.created_at) }}</template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="prev, pager, next, total" :disabled="busy" @current-change="run(loadHistory)" />
      </template>

      <template v-if="tab === 'detail' && detail">
        <h3>{{ batch.batch_number }} <el-tag>{{ batchStatus(batch.status) }}</el-tag></h3>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="创建店铺">{{ batch.dispatch_shop_name || `#${batch.default_shop_id}` }}</el-descriptions-item>
          <el-descriptions-item label="实际货位">{{ batch.containers_count }}</el-descriptions-item>
          <el-descriptions-item label="官方发运号">{{ batch.official_carriage_id || '尚未创建' }}</el-descriptions-item>
          <el-descriptions-item label="官方状态">{{ officialStatus(batch.official_status) }}</el-descriptions-item>
          <el-descriptions-item label="最近成功刷新">{{ formatTime(batch.last_refreshed_at) }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatTime(batch.created_at) }}</el-descriptions-item>
        </el-descriptions>
        <p class="ogl-dispatch-progress">计划 {{ summary.planned || 0 }} 单 · 当前有效 {{ summary.active || 0 }} · 已交运 {{ summary.dispatched || 0 }} · 已上网 {{ summary.online || 0 }} · 同批未上网 {{ summary.not_online || 0 }} · 物流待更新 {{ summary.sync_pending || 0 }} · 异常 {{ summary.exception || 0 }} · 已撤回 {{ summary.withdrawn || 0 }}</p>
        <el-alert v-if="batch.official_error || batch.last_error || batch.official_message" :title="batch.official_error || batch.last_error || batch.official_message" type="warning" show-icon :closable="false" />
        <div class="ogl-dispatch-actions">
          <el-button :disabled="busy" @click="action('refresh', {}, '物流刷新完成')">刷新成员物流</el-button>
          <el-button :disabled="busy || closed" @click="endBatch('close')">结束跟进</el-button>
          <el-button :disabled="busy || closed" @click="endBatch('cancel')">取消批次</el-button>
        </div>
        <el-collapse>
          <el-collapse-item title="官方发运单、货位标签与交接条码" name="official">
            <p>本批次使用 {{ batch.dispatch_shop_name || '创建时的默认店铺' }} 建一份官方单；来源订单的店铺归属保持原样。创建后会核对 Ozon 实际收录的货件，失败结果保留在本批次。</p>
            <el-button :disabled="busy || !canCreateOfficial" @click="loadOfficialOptions">获取可用发运方式</el-button>
            <p v-if="officialNotice">{{ officialNotice }}</p>
            <el-form label-position="top" class="ogl-dispatch-form" :disabled="busy || closed">
              <el-form-item label="官方发运方式"><el-select v-model="form.delivery_method_id" :disabled="officialExists" placeholder="先获取可用方式" @change="chooseOfficialOption"><el-option v-for="option in officialMethodOptions" :key="option.id" :value="option.id" :label="option.label" /></el-select></el-form-item>
              <el-form-item label="发运日期"><el-date-picker v-model="form.departure_date" :disabled="officialExists" type="date" value-format="YYYY-MM-DD" placeholder="北京时间日期" /></el-form-item>
              <el-form-item label="取件微信（选填）"><el-input v-model="courier.wechat_nickname" placeholder="微信昵称，最多 50 字符" :maxlength="50" autocomplete="off" /></el-form-item>
              <el-form-item label="取件电话"><el-input v-model="courier.phone" placeholder="11 位手机号，可带 +86；系统自动转换格式" autocomplete="off" /></el-form-item>
              <el-form-item label="取件备注（选填）"><el-input v-model="courier.comment" placeholder="与取件人员沟通的备注，最多 500 字符" :maxlength="500" autocomplete="off" /></el-form-item>
            </el-form>
            <div class="ogl-dispatch-actions">
              <el-button type="primary" :disabled="busy || !canCreateOfficial" @click="officialAction('official-create')">创建官方发运单</el-button>
              <el-button :disabled="busy || batch.official_status !== 'created' || closed" @click="officialAction('official-confirm')">确认官方单与 {{ batch.containers_count }} 个货位</el-button>
              <el-button :disabled="busy || !officialExists" @click="action('official-sync', {}, '官方状态已刷新')">核对官方状态</el-button>
            </div>
            <div v-if="!officialExists && batch.official_status === 'create_unknown'" class="ogl-dispatch-actions">
              <el-input v-model="recoveryCarriageId" placeholder="在创建店铺 Ozon 后台查到的官方发运编号" style="max-width: 400px" :disabled="busy" />
              <el-button :disabled="busy || !/^\d+$/.test(recoveryCarriageId)" @click="action('official-sync', { official_carriage_id: recoveryCarriageId }, '已核对官方发运')">按编号核实创建结果</el-button>
            </div>
            <el-alert v-if="officialSummary.extra?.length || officialSummary.missing?.length" type="warning" :closable="false" :title="`官方多出 ${officialSummary.extra?.length || 0} 单，缺少 ${officialSummary.missing?.length || 0} 单；请先修正官方清单并重新核对，暂不能确认。`" />
            <p v-if="officialSummary.extra?.length">官方多出：{{ officialSummary.extra.join('、') }}</p>
            <p v-if="officialSummary.missing?.length">官方缺少：{{ officialSummary.missing.join('、') }}</p>
            <el-alert v-if="officialSummary.cross_shop_local_only?.length" type="info" :closable="false" :title="`本批次有 ${officialSummary.cross_shop_local_only.length} 个其他店铺订单，仅记录在 ERP 混装批次中，尚未作为成员写入该官方单。请按已确认的物流商混装方式核对交接；跨店 API 收录待验证。`" />
            <div class="ogl-dispatch-actions">
              <el-button :disabled="busy || !officialReady" @click="downloadFile('container-labels')">下载货位标签</el-button>
              <el-button :disabled="busy || !officialReady" @click="downloadFile('container-labels', true)">打开标签 / 打印</el-button>
              <el-button :disabled="busy || !officialReady" @click="downloadFile('barcode')">下载交接条码</el-button>
              <el-button :disabled="busy || !officialReady" @click="downloadFile('barcode', true)">打开条码 / 打印</el-button>
            </div>
            <p>每个货位的标签打印 3 份，贴在三个面；打印份数与实际货位数分别计算。打印完成仍需实际交运后手动标记。</p>
          </el-collapse-item>
        </el-collapse>
        <div class="ogl-dispatch-actions">
          <el-select v-model="memberFilter" :disabled="busy" style="width: 160px"><el-option v-for="item in [{value:'all',label:'全部成员'},{value:'awaiting_dispatch',label:'待交运'},{value:'not_online',label:'同批未上网'},{value:'sync_pending',label:'物流待更新'},{value:'exception',label:'异常待核查'},{value:'withdrawn',label:'已撤回'}]" :key="item.value" :label="item.label" :value="item.value" /></el-select>
          <span>已选 {{ selectedMembers.length }} / 当前 {{ members.length }} 单</span>
          <el-input-number v-model="assignment" :min="1" :max="Number(batch.containers_count)" :precision="0" :disabled="busy || closed" style="width: 110px" />
          <el-button :disabled="busy || !canAssign" @click="action('assign', { order_ids: memberIds(), container_no: assignment }, '货位已分配')">分配货位</el-button>
          <el-button type="primary" :disabled="busy || !canDispatch" @click="selectedAction('dispatch')">标记已发运</el-button>
          <el-button :disabled="busy || !hasSelected || closed" @click="selectedAction('withdraw')">撤回待发</el-button>
          <el-button :disabled="busy || !hasSelected || closed" @click="selectedAction('exception')">标记异常</el-button>
          <el-button :disabled="busy || !hasSelected || closed" @click="selectedAction('resolve')">解决异常</el-button>
        </div>
        <el-table :key="`${batch.id}-${memberFilter}`" :data="members" row-key="order_id" border max-height="440" @selection-change="selectedMembers = $event">
          <el-table-column type="selection" width="46" :selectable="row => !busy && !row.withdrawn_at && row.active !== false && row.active !== 0" />
          <el-table-column prop="posting_number" label="货件号" min-width="180" />
          <el-table-column prop="shop_name" label="原店铺" min-width="130" />
          <el-table-column label="货位" width="110"><template #default="{ row }">{{ row.container_no ? `货位 ${row.container_no}` : '货位未记录' }}</template></el-table-column>
          <el-table-column label="本地阶段" width="100"><template #default="{ row }"><span :title="memberPhase(row) === '已发运' ? '运往集运仓' : ''">{{ memberPhase(row) }}</span></template></el-table-column>
          <el-table-column label="平台物流" min-width="160"><template #default="{ row }"><span :title="row.logistics_status || row.tracking_stage || row.platform_status || row.status || ''">{{ platformStatusLabel(row) }}</span><div v-if="row.sync_error" class="ogl-dispatch-error">物流待更新：{{ row.sync_error }}</div><small v-else-if="row.dispatched_at && !row.logistics_fresh && !row.online && !row.cancelled">尚无交运后的最新物流，请刷新核对</small></template></el-table-column>
          <el-table-column label="交运 / 最近同步" min-width="180"><template #default="{ row }"><div>{{ formatTime(row.dispatched_at) }}</div><div>{{ formatTime(row.last_synced_at) }}</div></template></el-table-column>
          <el-table-column label="异常 / 官方收录" min-width="180"><template #default="{ row }"><div>{{ row.exception_reason || row.exception_note || row.exception_code || '—' }}</div><small>{{ row.official_member ? '官方已收录' : '官方尚未收录' }}</small></template></el-table-column>
        </el-table>
        <el-collapse class="ogl-dispatch-events"><el-collapse-item title="操作与异常历史" name="events"><el-timeline><el-timeline-item v-for="event in detail.events || []" :key="event.id" :timestamp="formatTime(event.created_at)"><strong>{{ event.action_label || eventLabel(event.action || event.event_type) }}</strong> {{ event.reason || event.note || '' }} <small>{{ event.person_name || event.actor_name || (event.person_id ? `操作人 #${event.person_id}` : '') }}</small></el-timeline-item></el-timeline></el-collapse-item></el-collapse>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.ogl-dispatch-panel { min-height: 200px; color: var(--el-text-color-primary); }
.ogl-dispatch-nav, .ogl-dispatch-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.ogl-dispatch-nav > span, .ogl-dispatch-note, .ogl-dispatch-panel small { color: var(--el-text-color-secondary); font-size: 12px; }
.ogl-dispatch-panel p { line-height: 1.7; }
.ogl-dispatch-settings, .ogl-dispatch-events { margin: 16px 0; }
.ogl-dispatch-readonly-detail { margin-top: 16px; }
.ogl-dispatch-tracking { margin: 18px 0; }
.ogl-dispatch-tracking h4 { margin: 0; }
.ogl-dispatch-tracking-number { font-family: Consolas, monospace; overflow-wrap: anywhere; }
.ogl-dispatch-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px 20px; margin-top: 18px; }
.ogl-dispatch-form .el-form-item { margin-bottom: 12px; }
.ogl-dispatch-note { margin-left: 8px; }
.ogl-dispatch-progress { padding: 12px; background: var(--el-fill-color-light); border-radius: 6px; }
.ogl-dispatch-error { color: var(--el-color-danger); font-size: 12px; }
.ogl-dispatch-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
