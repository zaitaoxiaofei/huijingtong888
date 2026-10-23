<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../admin/stores/auth.js";
import { currentApiCacheScope } from "../../admin/utils/api.js";
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText, shanghaiDateTimeText } from "../../admin/utils/shanghai-date.js";
import { oglDispatchService as service, normalizeOglOrderIds, oglMemberMatches, oglHandoverType } from "../services/ogl-dispatch-service.js";
import { orderStateKey } from "../constants/orders-ui.js";

const props = defineProps({ orderIds: { type: Array, default: () => [] }, batchId: { type: Number, default: 0 }, mode: { type: String, default: "history" } });
const emit = defineEmits(["close", "changed"]);
const auth = useAuthStore();
const currentScope = () => `${currentApiCacheScope()}:${auth.user?.id || ""}:${auth.user?.tenant?.id || ""}`;
const scope = computed(currentScope);
const initialScope = currentScope();
let alive = true;
let readSequence = 0;
const urls = new Set();
const current = () => alive && visible.value && currentScope() === initialScope;
const visible = ref(true);
const busy = ref(false);
const error = ref("");
const panelElement = ref(null);
const refreshingOfficial = ref(false);
const fileLoading = ref({});
const officialSnapshot = ref({ snapshot_at: null, notice: "" });
let officialListScroll = 0;
const tab = ref(props.mode === "create" ? "create" : props.mode === "official" ? "official" : "history");
const bootstrap = ref({ settings: {}, shops: [], can_manage_settings: false });
const defaultShopId = ref(null);
const syncShopId = ref(null);
const selectedIds = normalizeOglOrderIds(props.orderIds);
const preview = ref(null);
const acceptEligible = ref(false);
const rows = ref([]);
const page = ref(1);
const total = ref(0);
const detail = ref(null);
const officialDate = ref(shanghaiDateKey());
const officialRange = ref([shanghaiDateDaysAgo(6), shanghaiDateKey()]);
const officialMonth = ref(shanghaiDateKey().slice(0, 7));
const officialRows = ref([]);
const officialTotal = ref(0);
const officialShop = ref(null);
const officialDetail = ref(null);
const officialDetailDate = ref("");
const officialDetailShopId = ref(null);
const officialTracking = ref(null);
const trackingLoading = ref(false);
const trackingError = ref("");
let trackingSequence = 0;
const officialCarriage = computed(() => officialDetail.value?.carriage || {});
const officialMembers = computed(() => officialDetail.value?.members || []);
const officialLocalMembers = computed(() => officialDetail.value?.local_members || []);
const officialFailedPostings = computed(() => officialDetail.value?.failed_postings || officialCarriage.value.failed_postings || []);
const failureReason = (row) => typeof row.seller_error === "string" ? row.seller_error : row.seller_error?.message || row.seller_error?.reason || row.error?.message || (typeof row.error === "string" ? row.error : "") || row.reason || row.message || "官方未收录，请核对后重新读取申请";
const masterTrackingLabel = computed(() => officialTracking.value?.master_tracking_number || (officialTracking.value?.status === "ambiguous" ? "多个运单，主单关系待确认" : "待获取"));
const selectedMembers = ref([]);
const memberFilter = ref("all");
const assignment = ref(1);
const options = ref([]);
const officialSubmitting = ref(false);
const matchingOfficialOptions = computed(() => options.value.filter((option) => !oglHandoverType(option) || oglHandoverType(option) === form.handover_type));
const officialMethodOptions = computed(() => {
  const methods = new Map();
  for (const option of matchingOfficialOptions.value) {
    const key = String(option.id);
    if (!methods.has(key)) methods.set(key, { id: option.id, name: option.name || `配送方式 ${option.id}`, days: new Set() });
    const day = option.departure_date || option.date ? shanghaiDateKey(option.departure_date || option.date) : "";
    if (day) methods.get(key).days.add(day);
  }
  return [...methods.values()].map((method) => ({ id: method.id, label: `${method.name}${method.days.size ? `（${[...method.days].join('、')}）` : ''}` }));
});
const officialNotice = ref("");
const recoveryCarriageId = ref("");
const form = reactive({ container_count: 1, departure_date: "", delivery_method_id: "", handover_type: "courier", client_request_id: globalThis.crypto?.randomUUID?.() || `ogl-${Date.now()}-${Math.random().toString(36).slice(2)}` });
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
const observedBatch = computed(() => batch.value.source === "official_discovery" || batch.value.official_status === "observed");
const officialAdopted = computed(() => Boolean(batch.value.official_result?.local_management?.adopted_at));
const canDownloadOfficial = computed(() => officialExists.value && (officialReady.value || observedBatch.value) && (observedBatch.value || !batchFailedPostings.value.length));
const officialBatchId = computed(() => Number(officialCarriage.value.local_batch_id || officialCarriage.value.batch_id || 0));
const canCreateOfficial = computed(() => !closed.value && !officialExists.value && ["not_created", "failed"].includes(batch.value.official_status));
const officialSummary = computed(() => batch.value.official_result || {});
const batchFailedPostings = computed(() => officialSummary.value.failed_postings || detail.value?.failed_postings || []);
const officialInfo = computed(() => officialSummary.value.info || officialSummary.value.carriage || {});
const verifiedHandover = computed(() => oglHandoverType(officialInfo.value) || oglHandoverType(batch.value));
const handoverLabel = (value) => value === "courier" ? "上门取件" : value === "self" ? "自行送货" : "官方方式待核实";
const selectedOfficialOption = computed(() => options.value.find((row) => String(row.id) === String(form.delivery_method_id) && shanghaiDateKey(row.departure_date || row.date) === form.departure_date && (!oglHandoverType(row) || oglHandoverType(row) === form.handover_type)) || {});
const officialIntegration = computed(() => String(officialInfo.value.integration_type || selectedOfficialOption.value.integration_type || officialSummary.value.capabilities?.integration_type || "").toLowerCase());
const requiresCourierContact = computed(() => (verifiedHandover.value || form.handover_type) === "courier" && officialIntegration.value === "ozon_outsourced");
const showsCourierContact = computed(() => (verifiedHandover.value || form.handover_type) === "courier" && (!officialIntegration.value || requiresCourierContact.value));
const pendingObserved = computed(() => observedBatch.value && String(officialInfo.value.status || "").toLowerCase() === "new");
const validContainerCount = computed(() => Number.isSafeInteger(Number(form.container_count)) && Number(form.container_count) > 0 && Number(form.container_count) <= 1000);
const canEditOfficialConfirmation = computed(() => !closed.value && officialExists.value && (batch.value.official_status === "created" || batch.value.can_confirm === true || pendingObserved.value));
const canConfirmOfficial = computed(() => canEditOfficialConfirmation.value && validContainerCount.value && !batchFailedPostings.value.length);
const officialFlowStep = computed(() => officialReady.value ? 2 : officialExists.value ? 1 : 0);
const canContinueOfficial = computed(() => officialBatchId.value > 0 && ["new", "created"].includes(String(officialCarriage.value.status || "").toLowerCase()));
const canAssign = computed(() => !closed.value && hasSelected.value && ["not_created", "failed"].includes(batch.value.official_status) && selectedMembers.value.every((row) => !row.dispatched_at));
const canDispatch = computed(() => !closed.value && hasSelected.value && (officialReady.value || (observedBatch.value && officialAdopted.value)) && selectedMembers.value.every((row) => !row.dispatched_at && !row.online && !row.cancelled));
const canCreate = computed(() => eligible.value.length > 0 && (!rejected.value.length || acceptEligible.value) && Boolean(bootstrap.value.settings.dispatch_shop_id));
const formatTime = (value) => shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
const formatDeparture = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim()) ? shanghaiDateText(value) : formatTime(value);
const batchStatus = (value) => ({ draft: "准备中", preparing: "准备中", ready: "待交运", ready_to_dispatch: "待交运", in_transit: "跟进中", dispatched: "跟进中", following: "跟进中", tracking: "跟进中", closed: "已结束", cancelled: "已取消" }[value] || value || "准备中");
const officialStatus = (value) => ({ observed: "已申请·待交接", pending: "待创建", not_created: "待创建", created: "已创建", approved: "已确认", confirmed: "已确认", error: "处理失败", failed: "创建失败", creating: "创建中", unknown: "待核实", create_unknown: "创建结果待核实", sync_required: "清单待核实", mismatch: "清单不一致", confirming: "确认中", confirm_unknown: "确认结果待核实", cancelled: "已取消" }[value] || value || "待创建");
const carriageStatus = (row) => row.status_label || ({ formed: "已生成", received: "验收中", new: "待确认", created: "已创建", approved: "已确认", confirmed: "已确认", handed_over: "已交接", delivering: "运输中", completed: "已完成", cancelled: "已取消", canceled: "已取消" }[row.status]) || "平台状态待核对";
const dispatchStage = (row) => row.dispatch_stage_label || ({ applied: "已申请·待交接", dispatched: "已实际交运", in_transit: "运输中", delivered: "已签收", cancelled: "已取消" }[row.dispatch_stage]) || "待核对交接";
const carriageTracking = (row) => row.master_tracking_number || (row.tracking_status === "ambiguous" ? "多个运单，待核对" : "待获取");
const carriageDeliveryMethod = (row) => {
  const carrier = String(row.carrier_name || "").trim();
  if (carrier) return carrier;
  const method = String(row.delivery_method_name || "").trim();
  return /[\u3400-\u9fff]/.test(method) && !/[\u0400-\u04ff]/.test(method) ? method : "承运商待核实";
};
const officialCarriageKey = (row) => `${row.dispatch_shop?.id || ""}:${row.carriage_id || row.id}:${row.departure_date || ""}`;
function orderPath(row) {
  const id = Number(row.order_id || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  const query = new URLSearchParams({ orderId: String(id) });
  if (Number(row.shop_id) > 0) query.set("shopId", String(row.shop_id));
  return `/orders?${query}`;
}
const eventLabel = (value) => ({ create: "创建内部批次", assign: "分配货位", dispatch: "标记实际交运", withdraw: "撤回待发", exception: "标记异常", resolve: "解决异常", cancel: "取消批次", close: "结束跟进", refresh: "刷新物流", "official-sync": "核对官方单", "official-create-start": "开始创建官方单", "official-created": "官方单已创建", "official-create-error": "官方创建失败或待核实", "official-confirm-start": "开始确认官方单", "official-confirm-error": "官方确认待核实" }[value] || "批次操作");
const memberPhase = (row) => row.withdrawn_at || row.active === 0 || row.active === false ? "已撤回" : row.online ? "已上网" : row.dispatched_at ? "已发运" : "待交运";
const advancedPlatformStatus = (row) => ({ returned: "已退回", rejected: "拒收/未领取", cancelled: "已取消", delivered: "已签收", dispute: "有争议", delivering: "运输中" }[orderStateKey({ ...row, status: row.platform_status || row.status })]) || "";
const platformStatusLabel = (row) => advancedPlatformStatus(row) || row.logistics_status_label || ({ awaiting_packaging: "等待备货", awaiting_deliver: "等待发货", acceptance_in_progress: "交接处理中", posting_acceptance_in_progress: "交接处理中", awaiting_registration: "等待配送注册", posting_awaiting_registration: "等待配送注册", posting_registered: "配送已注册", posting_registration_error: "配送注册异常", sent_by_seller: "卖家已交运", posting_ready_for_pickup: "等待取件", posting_transferring_to_delivery: "正在移交配送", posting_in_carriage: "已加入发运", posting_transferring: "正在转运", delivering: "运输中", delivered: "已签收", cancelled: "已取消" }[row.logistics_status || row.tracking_stage || row.platform_status || row.status]) || (row.online ? "平台已上网" : row.cancelled ? "平台已取消" : "平台状态待核对");
const officialMemberStatus = (row) => advancedPlatformStatus(row) || ([row.platform_status, row.logistics_status, row.tracking_stage].some((value) => ["acceptance_in_progress", "posting_acceptance_in_progress"].includes(value)) ? "平台验收中" : platformStatusLabel(row));
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
  const result = await service.list(page.value, dateRangeQuery());
  if (!current()) return;
  rows.value = result.rows || [];
  total.value = Number(result.total || 0);
}

async function loadOfficialCarriages() {
  const sequence = ++readSequence;
  const result = await service.officialSnapshot(dateRangeQuery());
  if (!current() || sequence !== readSequence) return;
  applyOfficialList(result);
}

function applyOfficialList(result) {
  officialRows.value = result.rows || [];
  officialTotal.value = Number(result.total ?? officialRows.value.length);
  officialShop.value = result.dispatch_shop || null;
  officialSnapshot.value = { snapshot_at: result.snapshot_at || result.last_checked_at || null, notice: result.notice || "已保存的申请快照；选择店铺并点击“同步申请”读取最新状态。" };
}

async function refreshOfficialCarriages() {
  if (!current() || refreshingOfficial.value || busy.value) return;
  const selectedShop = bootstrap.value.shops.find(shop => Number(shop.id) === Number(syncShopId.value));
  if (!selectedShop) { ElMessage.info("请先选择本企业要同步申请的店铺"); return; }
  const sequence = ++readSequence;
  refreshingOfficial.value = true;
  try {
    const synced = await service.discoverOfficial({ ...dateRangeQuery(), shop_id: Number(selectedShop.id) });
    if (!current() || sequence !== readSequence) return;
    const result = await service.officialSnapshot(dateRangeQuery());
    if (current() && sequence === readSequence) {
      applyOfficialList(result);
      if (synced.partial || Number(synced.failed) > 0) ElMessage.warning(synced.notice || `已保留成功同步的申请，${Number(synced.failed) || '部分'} 份暂未同步，请稍后重试`);
      else ElMessage.success("所选店铺申请已同步，已更新本企业全部已保存申请");
    }
  } catch (cause) {
    if (current() && sequence === readSequence) ElMessage.error(`暂未同步官方申请，已保留列表：${cause.message || "请稍后重试"}`);
  } finally { if (current()) refreshingOfficial.value = false; }
}

function dateRangeQuery() {
  const [date_from, date_to] = officialRange.value || [];
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  const start = Date.parse(`${date_from}T00:00:00Z`), end = Date.parse(`${date_to}T00:00:00Z`);
  const days = (end - start) / 86400000;
  if (!valid.test(date_from || "") || !valid.test(date_to || "") || !Number.isInteger(days) || days < 0 || days > 30 || new Date(start).toISOString().slice(0, 10) !== date_from || new Date(end).toISOString().slice(0, 10) !== date_to) throw new Error("请选择有效的北京日期范围，每次最多查询 31 天");
  return { date_from, date_to };
}

function chooseRecentDates() {
  officialRange.value = [shanghaiDateDaysAgo(6), shanghaiDateKey()];
}

function chooseMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return;
  const [year, month] = value.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  officialRange.value = [`${value}-01`, `${value}-${last}`];
}

async function queryDispatchHistory() {
  page.value = 1;
  if (tab.value === "history") await run(loadHistory);
  else await showOfficialCarriages();
}

async function showOfficialCarriages(date = "") {
  if (!current() || busy.value) return;
  if (date) {
    officialDate.value = date;
    officialRange.value = [date, date];
  }
  tab.value = "official";
  officialDetail.value = null;
  resetOfficialTracking();
  await run(loadOfficialCarriages);
}

async function returnOfficialList() {
  tab.value = "official";
  resetOfficialTracking();
  await nextTick();
  const viewport = panelElement.value?.closest?.(".el-drawer__body");
  if (viewport) viewport.scrollTop = officialListScroll;
}

async function openOfficialCarriage(carriage, live = false) {
  if (!current() || busy.value) return;
  if (tab.value === "official") officialListScroll = panelElement.value?.closest?.(".el-drawer__body")?.scrollTop || 0;
  const id = typeof carriage === "object" ? carriage.carriage_id || carriage.id : carriage;
  const sequence = ++readSequence;
  const listRow = typeof carriage === "object" ? carriage : officialRows.value.find((row) => String(row.carriage_id || row.id) === String(id));
  const date = listRow?.departure_date ? shanghaiDateKey(listRow.departure_date) : officialDate.value;
  const shopId = Number(listRow?.dispatch_shop?.id || officialShop.value?.id) || null;
  resetOfficialTracking();
  officialDetail.value = null;
  await run(async () => {
    const result = await service.officialDetail(id, date, { ...(live === true ? {} : { source: "snapshot" }), ...(shopId ? { shop_id: shopId } : {}) });
    if (!current() || sequence !== readSequence) return;
    officialDetail.value = result;
    officialDetailDate.value = date;
    officialDetailShopId.value = Number(result.dispatch_shop?.id || shopId) || null;
    officialShop.value = result.dispatch_shop || officialShop.value;
    tab.value = "official-detail";
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
  const shopId = officialDetailShopId.value;
  const stillCurrent = () => current() && sequence === trackingSequence && tab.value === "official-detail" && String(officialCarriage.value.carriage_id || officialCarriage.value.id) === id && officialDetailDate.value === date && officialDetailShopId.value === shopId;
  officialTracking.value = null;
  trackingError.value = "";
  trackingLoading.value = true;
  try {
    const result = await service.officialTracking(id, date, shopId);
    if (stillCurrent()) officialTracking.value = result.tracking || { status: "not_found" };
  } catch (cause) {
    if (stillCurrent()) trackingError.value = cause.message || "暂未取得官方标签中的运单号，请重试";
  } finally { if (stillCurrent()) trackingLoading.value = false; }
}

function useDetail(result) {
  if (!current()) return;
  const changedBatch = Number(detail.value?.batch?.id) !== Number(result.batch?.id);
  detail.value = result;
  selectedMembers.value = [];
  form.departure_date = result.batch?.departure_date ? shanghaiDateKey(result.batch.departure_date) : "";
  form.delivery_method_id = result.batch?.delivery_method_id || "";
  form.container_count = Number(result.batch?.containers_count) || 1;
  form.handover_type = verifiedHandover.value || (changedBatch ? "courier" : form.handover_type);
  if (changedBatch || form.handover_type === "self") clearCourierContact();
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
    if (current()) {
      bootstrap.value = result;
      if (tab.value === "official") await loadOfficialCarriages();
    }
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
  if (current() && tab.value === "detail" && canCreateOfficial.value) await loadOfficialOptions();
}

async function action(name, payload = {}, success = "操作已完成") {
  const batchId = batch.value.id;
  await run(async () => {
    let result;
    try { result = await service.action(batchId, name, payload); }
    catch (cause) {
      const enteredCount = form.container_count;
      try {
        useDetail(await service.detail(batchId));
        if (current() && name === "official-confirm" && canEditOfficialConfirmation.value) form.container_count = enteredCount;
      } catch { /* Preserve the original actionable error. */ }
      throw cause;
    }
    if (!current()) return;
    if (result?.batch) useDetail(result);
    else useDetail(await service.detail(batchId));
    emit("changed");
    if (batchFailedPostings.value.length) ElMessage.warning(`官方有 ${batchFailedPostings.value.length} 个货件未成功收录，请核对失败原因后再继续。`);
    else if (success) ElMessage.success(success);
  });
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

async function adoptOfficialTracking() {
  const count = Number(batch.value.containers_count);
  if (!Number.isSafeInteger(count) || count <= 0) { error.value = "官方货位数量尚未核实，请先核对官方状态再接管跟踪。"; return; }
  try {
    const response = await ElMessageBox.prompt(`请核对官方申请、订单和货位标签，并输入官方实际货位数 ${count}。接管仅保存跟踪关系，仍需在包裹实际交出后另行标记交运。`, "核对并接管跟踪", {
      inputPlaceholder: "输入已核对的货位数量", confirmButtonText: "核对并接管", cancelButtonText: "取消",
      inputValidator: (value) => /^\d+$/.test(String(value || "").trim()) && Number(value) === count || `请输入官方核实的 ${count} 个货位`
    });
    if (Number(response.value) !== count) return;
    await action("official-adopt", { container_count: count }, "已接管发运跟踪；尚未标记实际交运");
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause.message; }
}

async function endBatch(name) {
  try {
    const response = await ElMessageBox.prompt(name === "cancel" ? "填写取消批次原因。已实际交运的成员不能通过取消覆盖物流。" : "填写结束跟进说明。结束批次不会把未签收订单改为已签收。", name === "cancel" ? "取消批次" : "结束跟进", { inputValidator: (value) => Boolean(String(value || "").trim()) || "请填写说明", confirmButtonText: "确认", cancelButtonText: "取消" });
    await action(name, { reason: response.value.trim() });
  } catch (cause) { if (cause !== "cancel" && cause !== "close") error.value = cause.message; }
}

async function loadOfficialOptions() {
  const batchId = batch.value.id;
  const sequence = readSequence;
  await run(async () => {
    const result = await service.action(batchId, "official-options");
    if (!current() || sequence !== readSequence || Number(batch.value.id) !== Number(batchId)) return;
    options.value = (result.options || []).map((option) => ({ ...option, id: option.delivery_method_id || option.id, name: option.delivery_method_name || option.name }));
    chooseHandoverType(form.handover_type);
  });
}

function chooseOfficialOption(id) {
  const candidates = matchingOfficialOptions.value.filter((row) => String(row.id) === String(id));
  const option = candidates.find((row) => shanghaiDateKey(row.departure_date || row.date) === form.departure_date) || candidates[0];
  if (option?.departure_date || option?.date) form.departure_date = shanghaiDateKey(option.departure_date || option.date);
}

function clearCourierContact() {
  courier.phone = "";
  courier.wechat_nickname = "";
  courier.comment = "";
}

function chooseHandoverType(value) {
  if (!["courier", "self"].includes(value)) return;
  form.handover_type = verifiedHandover.value || value;
  if (form.handover_type === "self") clearCourierContact();
  if (officialExists.value) return;
  const known = options.value.filter((option) => oglHandoverType(option) === form.handover_type);
  const candidates = known.length ? known : matchingOfficialOptions.value;
  const selected = candidates.find((option) => String(option.id) === String(form.delivery_method_id));
  form.delivery_method_id = selected?.id || candidates[0]?.id || "";
  if (form.delivery_method_id) chooseOfficialOption(form.delivery_method_id);
  officialNotice.value = known.length ? `已取得${handoverLabel(form.handover_type)}的官方可用方式，请核对日期。`
    : options.value.length && candidates.length ? "官方返回的方式尚未提供完整取件／自送能力，需核对官方配置后再提交；系统不会将选择伪装成官方能力。"
      : `默认店铺暂无${handoverLabel(form.handover_type)}的可用发运方式，请在 Ozon 后台配置后重新获取；内部批次已保留。`;
}

async function officialAction(name) {
  if (!current() || busy.value || officialSubmitting.value) return;
  const batchId = batch.value.id;
  if (batchFailedPostings.value.length) { error.value = "官方存在未成功收录的货件，请先处理下方失败原因，再核对官方状态。"; return; }
  if (name === "official-create" && (!form.delivery_method_id || !form.departure_date)) { error.value = "请先获取可用发运方式，并填写发运日期，再创建官方单。内部草稿可继续保留。"; return; }
  if (name === "official-create") {
    const option = options.value.find((row) => String(row.id) === String(form.delivery_method_id) && shanghaiDateKey(row.departure_date || row.date) === form.departure_date && oglHandoverType(row) === form.handover_type);
    if (!option) { error.value = `官方尚未返回所选${handoverLabel(form.handover_type)}方式与日期的可用组合，请在 Ozon 后台核对配置后重新获取。`; return; }
  }
  if (name === "official-confirm" && !validContainerCount.value) { error.value = "请填写 1 至 1000 的实际总货位数量（大袋／大箱数）。"; return; }
  if (name === "official-confirm" && requiresCourierContact.value && !/^(?:\+86)?\d{11}$/.test(courier.phone.trim().replace(/[\s()-]/g, ""))) { error.value = "请填写有效的 11 位取件手机号，可带 +86 国家区号。"; return; }
  officialSubmitting.value = true;
  try {
    await ElMessageBox.confirm(name === "official-create" ? "将使用本批次创建店铺生成官方单，并核对本店所选货件的实际收录结果；其他店铺订单先保留 ERP 混装关联。此操作不会自动标记已发运。" : "确认向 Ozon 提交货位数量；上门取件时请填写联系电话，可补充微信及取件备注。", name === "official-create" ? "创建官方发运单" : "确认官方发运单", { confirmButtonText: "提交 Ozon", cancelButtonText: "取消", type: "warning" });
    if (!current() || Number(batch.value.id) !== Number(batchId)) return;
    await action(name, { delivery_method_id: form.delivery_method_id, departure_date: form.departure_date, handover_type: verifiedHandover.value || form.handover_type, container_count: Number(form.container_count), ...(showsCourierContact.value && name === "official-confirm" ? { courier_contact: { phone: courier.phone.trim(), wechat_nickname: courier.wechat_nickname.trim(), comment: courier.comment.trim() } } : {}) }, name === "official-create" ? "官方申请已创建，请继续核对货位及确认" : "官方确认已提交，请按核验结果下载货位标签");
  } catch (cause) { if (current() && cause !== "cancel" && cause !== "close") error.value = cause.message; }
  finally { if (current()) officialSubmitting.value = false; }
}

const fileKey = (batchId, type) => `${Number(batchId)}:${type}`;
const isFileLoading = (batchId, type) => Boolean(fileLoading.value[fileKey(batchId, type)]);
function fileCapability(row, type) {
  const capability = row?.file_capabilities?.[type === "container-labels" ? "container_labels" : "barcode"];
  return capability || { available: null, reason: "文件能力尚未核实，请选择原店铺同步申请后重试" };
}
async function downloadFile(type, previewFile = false, selectedBatchId = 0, carriage = officialCarriage.value) {
  const batchId = Number(selectedBatchId || batch.value.id);
  if (!current() || !batchId || isFileLoading(batchId, type)) return;
  const key = fileKey(batchId, type);
  const downloadName = selectedBatchId ? `OGL-${carriage.carriage_id || carriage.id}` : batch.value.batch_number || "OGL";
  fileLoading.value = { ...fileLoading.value, [key]: true };
  const target = previewFile ? window.open("about:blank", "_blank") : null;
  if (target) target.opener = null;
  try {
      const blob = await service.file(batchId, type);
      if (!current()) { target?.close(); return; }
      const url = URL.createObjectURL(blob);
      urls.add(url);
      if (previewFile && target && /^(application\/pdf|image\/(png|jpeg|webp))$/i.test(blob.type)) target.location.replace(url);
      else {
        target?.close();
        const link = document.createElement("a");
        link.href = url;
        link.download = `${String(downloadName).replace(/[^\w-]/g, "_")}-${type}.${blob.type === "application/pdf" ? "pdf" : blob.type === "image/png" ? "png" : "bin"}`;
        link.click();
        if (previewFile) ElMessage.info("文件已下载，请使用本地查看器打开并打印");
      }
  } catch (cause) {
    target?.close();
    if (current()) ElMessage.error(`${type === "container-labels" ? "货位标签" : "交接条码"}暂不可用：${cause.message || "请刷新申请状态后重试"}`);
  } finally {
    if (current()) fileLoading.value = { ...fileLoading.value, [key]: false };
  }
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
  <el-drawer v-model="visible" title="OGL 发运" size="min(1380px, 96vw)" destroy-on-close :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="emit('close')">
    <div ref="panelElement" class="ogl-dispatch-panel" v-loading="busy">
      <el-alert v-if="error" :title="error" type="error" :closable="true" show-icon @close="error = ''" />
      <el-alert v-if="['paused', 'partial', 'error'].includes(bootstrap.monitoring?.status)" :title="bootstrap.monitoring.notice || '自动跟踪暂未完成，请稍后重试；权限暂停时请由企业管理员核对设置。'" type="warning" :closable="false" show-icon />
      <div class="ogl-dispatch-nav">
        <el-button :disabled="busy" :type="tab.startsWith('official') ? 'primary' : 'default'" @click="showOfficialCarriages()">已申请</el-button>
        <el-button :disabled="busy" :type="tab === 'history' ? 'primary' : 'default'" @click="tab = 'history'; run(loadHistory)">发运历史</el-button>
        <el-button v-if="tab === 'official-detail'" :disabled="busy" @click="returnOfficialList">返回申请列表</el-button>
        <el-button v-if="preview" :disabled="busy" @click="tab = 'create'">创建批次（已选 {{ selectedIds.length }} 单）</el-button>
        <span>时间均为北京时间</span>
      </div>

      <section v-if="tab === 'create'" class="ogl-dispatch-settings" :class="{ 'ogl-dispatch-settings-required': !bootstrap.settings.dispatch_shop_id }" aria-label="企业默认发运店铺">
        <strong>默认发运店铺<span v-if="!bootstrap.can_manage_settings">：{{ defaultShopName }}</span></strong>
        <div v-if="bootstrap.can_manage_settings" class="ogl-dispatch-actions">
          <el-select v-model="defaultShopId" placeholder="首次使用：选择本企业店铺" aria-label="默认发运店铺" :disabled="busy" style="width: 260px"><el-option v-for="shop in bootstrap.shops" :key="shop.id" :label="shop.name" :value="Number(shop.id)" /></el-select>
          <el-button type="primary" :disabled="busy || !defaultShopId" @click="saveSettings">{{ bootstrap.settings.dispatch_shop_id ? '保存店铺' : '绑定默认发运店铺' }}</el-button>
        </div>
        <p v-if="!bootstrap.settings.dispatch_shop_id">请先由企业负责人或管理员绑定本企业店铺，再查询已有申请或创建发运。</p>
        <small v-else title="本企业共用此设置；更改只影响新批次，历史发运继续使用创建时的店铺。">更换仅影响新批次</small>
      </section>

      <div v-if="tab === 'official' || tab === 'history'" class="ogl-dispatch-actions ogl-dispatch-date-filter">
        <el-button :disabled="busy" @click="chooseRecentDates(); queryDispatchHistory()">近 7 天</el-button>
        <el-date-picker v-model="officialMonth" :disabled="busy" type="month" value-format="YYYY-MM" placeholder="选择月份" aria-label="发运月份（北京时间）" @change="chooseMonth" />
        <el-date-picker v-model="officialRange" :disabled="busy" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" aria-label="发运起止日期（北京时间）" unlink-panels />
        <el-button type="primary" :disabled="busy" @click="queryDispatchHistory">查询</el-button>
        <small>北京时间，每次最多 31 天</small>
      </div>

      <template v-if="tab === 'official'">
        <div class="ogl-dispatch-actions"><h3>已申请发运</h3><el-select v-model="syncShopId" placeholder="选择本企业店铺" aria-label="同步申请的店铺" :disabled="refreshingOfficial" style="width: 230px"><el-option v-for="shop in bootstrap.shops" :key="shop.id" :label="shop.name" :value="Number(shop.id)" /></el-select><el-button type="primary" :loading="refreshingOfficial" :disabled="busy || !syncShopId" @click="refreshOfficialCarriages">同步申请</el-button></div>
        <p class="ogl-dispatch-snapshot-note">{{ officialSnapshot.notice }} 最近缓存：{{ officialSnapshot.snapshot_at ? formatTime(officialSnapshot.snapshot_at) : '尚未获取' }}（逐行时间可能不同）</p>
        <p>本企业已保存申请 · 共 {{ officialTotal }} 份；选择店铺并点击“同步申请”才会读取 Ozon，不会更改默认发运店铺。</p>
        <el-table :data="officialRows" :row-key="officialCarriageKey" border @row-dblclick="openOfficialCarriage">
          <el-table-column label="Ozon 申请号" min-width="140"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openOfficialCarriage(row)">{{ row.carriage_id || row.id }}</el-button></template></el-table-column>
          <el-table-column label="创建店铺" min-width="150"><template #default="{ row }">{{ row.dispatch_shop?.name || '待获取' }}</template></el-table-column>
          <el-table-column label="官方状态" min-width="135"><template #default="{ row }">{{ carriageStatus(row) }}<small class="ogl-dispatch-status-code">{{ row.status || '待获取' }}</small></template></el-table-column>
          <el-table-column label="交运阶段" min-width="135"><template #default="{ row }">{{ dispatchStage(row) }}</template></el-table-column>
          <el-table-column label="承运商" min-width="100"><template #default="{ row }">{{ row.carrier_name || '待获取' }}</template></el-table-column>
          <el-table-column label="承运商运单号" min-width="190"><template #default="{ row }"><strong class="ogl-dispatch-tracking-number">{{ carriageTracking(row) }}</strong><small v-if="row.tracking_source === 'official_container_label'" class="ogl-dispatch-status-code">官方货位标签</small></template></el-table-column>
          <el-table-column label="申请创建时间" min-width="175"><template #default="{ row }">{{ row.created_at ? formatTime(row.created_at) : '待获取' }}</template></el-table-column>
          <el-table-column label="货位" width="100"><template #default="{ row }">{{ row.containers_count ?? '待获取' }}</template></el-table-column>
          <el-table-column label="订单数" width="100"><template #default="{ row }">{{ row.postings_count ?? '待获取' }}</template></el-table-column>
          <el-table-column label="缓存时间" min-width="170"><template #default="{ row }">{{ row.snapshot_at ? formatTime(row.snapshot_at) : '尚未获取' }}</template></el-table-column>
          <el-table-column label="操作" width="225" fixed="right"><template #default="{ row }"><div class="ogl-dispatch-row-actions"><el-tooltip :content="fileCapability(row, 'container-labels').reason || '下载官方货位标签 PDF'" placement="top"><span><el-button type="primary" plain :loading="isFileLoading(row.local_batch_id || row.batch_id, 'container-labels')" :disabled="!row.local_batch_id && !row.batch_id || fileCapability(row, 'container-labels').available !== true" @click.stop="downloadFile('container-labels', false, row.local_batch_id || row.batch_id, row)">下载货位标签</el-button></span></el-tooltip><el-button link type="primary" :disabled="busy" @click="openOfficialCarriage(row)">详情</el-button></div></template></el-table-column>
        </el-table>
      </template>

      <template v-if="tab === 'official-detail' && officialDetail">
        <div v-if="officialBatchId" class="ogl-dispatch-actions"><el-tooltip :content="fileCapability(officialCarriage, 'container-labels').reason || '下载官方货位标签 PDF'" placement="top"><span><el-button type="primary" :loading="isFileLoading(officialBatchId, 'container-labels')" :disabled="fileCapability(officialCarriage, 'container-labels').available !== true" @click="downloadFile('container-labels', false, officialBatchId)">下载货位标签</el-button></span></el-tooltip></div>
        <div class="ogl-dispatch-actions"><h3>Ozon 申请 {{ officialCarriage.carriage_id || officialCarriage.id }} <el-tag>{{ carriageStatus(officialCarriage) }}</el-tag></h3><el-button v-if="canContinueOfficial" type="primary" :disabled="busy" @click="openBatch(officialBatchId)">继续确认</el-button></div>
        <p class="ogl-dispatch-snapshot-note">{{ officialDetail.notice || (officialDetail.source === 'snapshot' ? '已保存的申请快照，需最新状态时请返回列表同步申请。' : '已读取官方申请详情。') }} 缓存 / 核对时间：{{ officialCarriage.snapshot_at || officialDetail.last_checked_at ? formatTime(officialCarriage.snapshot_at || officialDetail.last_checked_at) : '尚未获取' }}</p>
        <el-alert type="info" :closable="false" :title="officialCarriage.status === 'received' ? '官方申请验收中不代表每个订单已进入运输；订单物流以平台轨迹为准。' : '官方申请已生成不等于实际交运。订单交给取件人员后才记录实际交运，官方状态不会替代这一步。'" />
        <el-descriptions :column="3" border class="ogl-dispatch-readonly-detail">
          <el-descriptions-item label="创建店铺">{{ officialShop?.name || defaultShopName }}</el-descriptions-item>
          <el-descriptions-item label="官方状态"><span :title="officialCarriage.status || ''">{{ carriageStatus(officialCarriage) }}</span></el-descriptions-item>
          <el-descriptions-item label="实际货位（官方回读）">{{ officialCarriage.containers_count ?? '官方尚未返回' }}</el-descriptions-item>
          <el-descriptions-item label="发运日期（北京时间）">{{ formatDeparture(officialCarriage.departure_date) }}</el-descriptions-item>
          <el-descriptions-item label="发运方式">{{ carriageDeliveryMethod(officialCarriage) }}</el-descriptions-item>
          <el-descriptions-item label="申请创建时间">{{ officialCarriage.created_at ? formatTime(officialCarriage.created_at) : '官方尚未返回' }}</el-descriptions-item>
        </el-descriptions>
        <p class="ogl-dispatch-progress">官方货件 {{ officialDetail.summary?.official_members ?? '待获取' }} · 本地精确匹配 {{ officialDetail.summary?.matched_local ?? '待获取' }} · 本地未匹配 {{ officialDetail.summary?.unmatched_local ?? '待获取' }} · 平台已上网 {{ officialDetail.summary?.online ?? '待获取' }}</p>
        <el-alert v-if="officialFailedPostings.length" type="error" :closable="false" :title="`官方有 ${officialFailedPostings.length} 个货件未成功收录，请处理后重新核对申请。`" />
        <el-table v-if="officialFailedPostings.length" :data="officialFailedPostings" border max-height="220"><el-table-column prop="posting_number" label="未收录货件" min-width="190" /><el-table-column label="官方原因" min-width="260"><template #default="{ row }">{{ failureReason(row) }}</template></el-table-column></el-table>
        <h4>官方申请货件</h4>
        <el-table :data="officialMembers" border max-height="500">
          <el-table-column label="订单号" min-width="190"><template #default="{ row }"><router-link v-if="orderPath(row)" :to="orderPath(row)" target="_blank" rel="noopener" class="ogl-dispatch-order-link">{{ row.posting_number }}</router-link><span v-else>{{ row.posting_number }}</span><small v-if="!row.matched_local" class="ogl-dispatch-status-code">本地暂未匹配</small></template></el-table-column>
          <el-table-column prop="shop_name" label="订单原店铺" min-width="140" />
          <el-table-column label="下单时间" min-width="180"><template #default="{ row }">{{ row.ordered_at ? formatTime(row.ordered_at) : '待获取' }}</template></el-table-column>
          <el-table-column label="平台物流" min-width="150"><template #default="{ row }"><span v-if="row.matched_local" :title="row.logistics_status || row.platform_status || ''">{{ officialMemberStatus(row) }}</span><span v-else>本地无物流数据</span></template></el-table-column>
          <el-table-column label="上网情况" width="125"><template #default="{ row }">{{ !row.matched_local ? '待匹配核对' : row.online ? '平台已上网' : '未取得上网证据' }}</template></el-table-column>
          <el-table-column label="本地最近同步（北京时间）" min-width="200"><template #default="{ row }">{{ formatTime(row.last_synced_at) }}</template></el-table-column>
        </el-table>
        <section v-if="officialLocalMembers.length" class="ogl-dispatch-local-members" aria-label="ERP混袋订单">
          <h4>ERP 混袋订单</h4><p>本次混袋 {{ officialDetail.summary?.local_members_count ?? officialLocalMembers.length }} 单；仅 ERP 关联 {{ officialDetail.summary?.local_only_count ?? officialLocalMembers.filter(row => !row.official_member).length }} 单。以下显示各订单的真实来源店铺。</p>
          <el-table :data="officialLocalMembers" row-key="order_id" border max-height="350">
            <el-table-column label="订单号" min-width="190"><template #default="{ row }"><router-link v-if="orderPath(row)" :to="orderPath(row)" target="_blank" rel="noopener" class="ogl-dispatch-order-link">{{ row.posting_number }}</router-link><span v-else>{{ row.posting_number }}</span></template></el-table-column>
            <el-table-column prop="shop_name" label="真实来源店铺" min-width="150" />
            <el-table-column label="本次关联" min-width="220"><template #default="{ row }">{{ row.association_label || (row.official_member ? '默认店铺 · 官方已收录' : Number(row.shop_id) !== Number(officialDetailShopId || officialShop?.id) ? '其他店铺 · 仅 ERP 混袋关联' : '默认店铺 · 官方尚未收录，请核对') }}</template></el-table-column>
            <el-table-column label="平台物流" min-width="150"><template #default="{ row }">{{ platformStatusLabel(row) }}</template></el-table-column>
          </el-table>
        </section>
        <section class="ogl-dispatch-tracking" aria-label="货位标签与交接文件">
          <el-collapse>
            <el-collapse-item title="货位标签与交接文件" name="labels">
              <div class="ogl-dispatch-actions"><el-button :loading="trackingLoading" :disabled="trackingLoading" @click="loadOfficialTracking">{{ trackingLoading ? '正在读取官方标签' : '重新获取运单信息' }}</el-button></div>
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
            </el-collapse-item>
          </el-collapse>
        </section>
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
        <p>查看所选北京日期内的发运记录。已申请待交接与已实际交运分别展示。</p>
        <el-table :data="rows" border @row-dblclick="row => openBatch(row.id)">
          <el-table-column label="发运申请" min-width="190"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openBatch(row.id)">{{ row.official_carriage_id || row.batch_number }}</el-button></template></el-table-column>
          <el-table-column prop="dispatch_shop_name" label="创建店铺" min-width="140" />
          <el-table-column prop="containers_count" label="货位" width="75" />
          <el-table-column label="交运阶段" min-width="135"><template #default="{ row }">{{ row.dispatch_stage ? dispatchStage(row) : batchStatus(row.status) }}</template></el-table-column>
          <el-table-column label="官方单" width="120"><template #default="{ row }">{{ officialStatus(row.official_status) }}</template></el-table-column>
          <el-table-column label="有效 / 交运 / 上网" min-width="150"><template #default="{ row }">{{ row.summary?.active || 0 }} / {{ row.summary?.dispatched || 0 }} / {{ row.summary?.online || 0 }}</template></el-table-column>
          <el-table-column label="记录创建时间" min-width="170"><template #default="{ row }">{{ formatTime(row.created_at) }}</template></el-table-column>
          <el-table-column label="操作" width="95" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="busy" @click="openBatch(row.id)">查看详情</el-button></template></el-table-column>
        </el-table>
        <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="prev, pager, next, total" :disabled="busy" @current-change="run(loadHistory)" />
      </template>

      <template v-if="tab === 'detail' && detail">
        <h3>{{ batch.official_carriage_id ? `Ozon 申请 ${batch.official_carriage_id}` : batch.batch_number }} <el-tag>{{ batch.dispatch_stage ? dispatchStage(batch) : batchStatus(batch.status) }}</el-tag></h3>
        <el-alert v-if="observedBatch" :title="officialAdopted ? '已接管此申请的发运跟踪。仅在包裹实际交给取件人员后，勾选对应订单并标记实际交运。' : '此申请已加入发运跟踪，尚未记录实际交运。核对订单和货位标签后可接管跟踪，不会自动记录实际交运。'" type="info" :closable="false" />
        <el-descriptions :column="3" border>
          <el-descriptions-item label="创建店铺">{{ batch.dispatch_shop_name || `#${batch.default_shop_id}` }}</el-descriptions-item>
          <el-descriptions-item label="实际货位">{{ batch.containers_count }}</el-descriptions-item>
          <el-descriptions-item label="官方发运号">{{ batch.official_carriage_id || '尚未创建' }}</el-descriptions-item>
          <el-descriptions-item label="官方状态">{{ officialStatus(batch.official_status) }}</el-descriptions-item>
          <el-descriptions-item label="最近成功刷新">{{ formatTime(batch.last_refreshed_at) }}</el-descriptions-item>
          <el-descriptions-item label="记录创建时间">{{ formatTime(batch.created_at) }}</el-descriptions-item>
        </el-descriptions>
        <p class="ogl-dispatch-progress">计划 {{ summary.planned || 0 }} 单 · 当前有效 {{ summary.active || 0 }} · 已交运 {{ summary.dispatched || 0 }} · 已上网 {{ summary.online || 0 }} · 同批未上网 {{ summary.not_online || 0 }} · 物流待更新 {{ summary.sync_pending || 0 }} · 异常 {{ summary.exception || 0 }} · 已撤回 {{ summary.withdrawn || 0 }}</p>
        <el-alert v-if="batch.official_error || batch.last_error || batch.official_message" :title="batch.official_error || batch.last_error || batch.official_message" type="warning" show-icon :closable="false" />
        <div class="ogl-dispatch-actions">
          <el-button v-if="observedBatch && !officialAdopted" type="primary" :disabled="busy || closed || !detail.members?.length" @click="adoptOfficialTracking">核对并接管跟踪</el-button>
          <el-button :disabled="busy" @click="action('refresh', {}, '物流刷新完成')">刷新成员物流</el-button>
          <el-button :disabled="busy || closed" @click="endBatch('close')">结束跟进</el-button>
          <el-button :disabled="busy || closed" @click="endBatch('cancel')">取消批次</el-button>
        </div>
        <section class="ogl-dispatch-flow" aria-label="官方发运创建确认与标签">
            <el-steps :active="officialFlowStep" finish-status="success" simple><el-step title="选择方式并创建" /><el-step title="核对货位并确认" /><el-step title="下载货位标签" /></el-steps>
            <p>本次官方创建店铺：<strong>{{ batch.dispatch_shop_name || '创建时的默认店铺' }}</strong>。同企业其他店铺订单保留 ERP 混装关联，物流与财务仍归原店铺。</p>
            <div class="ogl-dispatch-flow-stage">
              <h4>1. 方式、日期与官方申请</h4>
              <el-form label-position="top" class="ogl-dispatch-form" :disabled="busy || officialSubmitting || closed">
                <el-form-item label="交货方式"><el-radio-group v-model="form.handover_type" :disabled="officialExists && Boolean(verifiedHandover)" @change="chooseHandoverType"><el-radio-button value="courier">上门取件</el-radio-button><el-radio-button value="self">自行送货</el-radio-button></el-radio-group><span v-if="verifiedHandover" class="ogl-dispatch-note">官方已核实：{{ handoverLabel(verifiedHandover) }}</span></el-form-item>
                <el-form-item v-if="!officialExists" label="官方可用方式"><el-select v-model="form.delivery_method_id" placeholder="获取默认店铺可用方式" @change="chooseOfficialOption"><el-option v-for="option in officialMethodOptions" :key="option.id" :value="option.id" :label="option.label" /></el-select></el-form-item>
                <el-form-item v-if="!officialExists" label="发运日期（北京时间）"><el-date-picker v-model="form.departure_date" type="date" value-format="YYYY-MM-DD" placeholder="选择官方可用日期" /></el-form-item>
              </el-form>
              <el-alert v-if="officialExists && !verifiedHandover" title="官方交货方式尚未核实。请选择实际取件或自送方式；确认时将重新核验官方配置，当前选择不会修改 Ozon 仓库配置。" type="warning" :closable="false" />
              <p v-if="officialNotice">{{ officialNotice }}</p>
              <div class="ogl-dispatch-actions">
                <el-button v-if="!officialExists && !observedBatch" :disabled="busy || officialSubmitting || !canCreateOfficial" @click="loadOfficialOptions">获取可用方式</el-button>
                <el-button v-if="!officialExists && !observedBatch" type="primary" :disabled="busy || officialSubmitting || !canCreateOfficial" @click="officialAction('official-create')">创建官方发运单</el-button>
                <el-tag v-if="officialExists" type="success">官方申请 {{ batch.official_carriage_id }} · {{ officialStatus(batch.official_status) }}</el-tag>
                <el-button v-if="officialExists" :disabled="busy || officialSubmitting" @click="action('official-sync', {}, '官方状态已刷新')">核对官方状态</el-button>
              </div>
            </div>
            <div v-if="!observedBatch || pendingObserved || batch.can_confirm || officialReady" class="ogl-dispatch-flow-stage">
              <h4>2. 实际总货位与确认</h4>
              <el-form label-position="top" class="ogl-dispatch-form" :disabled="busy || officialSubmitting || !canEditOfficialConfirmation">
                <el-form-item label="实际总货位数量"><el-input-number v-model="form.container_count" :min="1" :max="1000" :precision="0" /><span class="ogl-dispatch-note">所有店铺混装后的大袋／大箱总数</span></el-form-item>
                <template v-if="showsCourierContact">
                  <el-form-item :label="requiresCourierContact ? '取件电话（必填）' : '取件电话（官方能力待核实）'"><el-input v-model="courier.phone" placeholder="11 位手机号，可带 +86" autocomplete="off" /></el-form-item>
                  <el-form-item label="取件微信（选填）"><el-input v-model="courier.wechat_nickname" placeholder="微信昵称，最多 50 字符" :maxlength="50" autocomplete="off" /></el-form-item>
                  <el-form-item label="取件备注（选填）"><el-input v-model="courier.comment" placeholder="与取件人员沟通，最多 500 字符" :maxlength="500" autocomplete="off" /></el-form-item>
                </template>
              </el-form>
              <p v-if="!officialExists">先完成上方官方申请创建，再确认货位及联系人。</p>
              <p v-else-if="officialReady">官方已确认 {{ batch.containers_count }} 个货位，可下载下方标签。</p>
              <el-button v-if="!officialReady" type="primary" :disabled="busy || officialSubmitting || !canConfirmOfficial" @click="officialAction('official-confirm')">确认官方单与 {{ form.container_count }} 个货位</el-button>
            </div>
            <div v-if="!officialExists && batch.official_status === 'create_unknown'" class="ogl-dispatch-actions">
              <el-input v-model="recoveryCarriageId" placeholder="在创建店铺 Ozon 后台查到的官方发运编号" style="max-width: 400px" :disabled="busy" />
              <el-button :disabled="busy || !/^\d+$/.test(recoveryCarriageId)" @click="action('official-sync', { official_carriage_id: recoveryCarriageId }, '已核对官方发运')">按编号核实创建结果</el-button>
            </div>
            <el-alert v-if="officialSummary.extra?.length || officialSummary.missing?.length" type="warning" :closable="false" :title="`官方多出 ${officialSummary.extra?.length || 0} 单，缺少 ${officialSummary.missing?.length || 0} 单；请先修正官方清单并重新核对，暂不能确认。`" />
            <el-alert v-if="batchFailedPostings.length" type="error" :closable="false" :title="`官方有 ${batchFailedPostings.length} 个货件未成功收录，当前不能确认或下载标签。请处理失败原因后核对官方状态。`" />
            <el-table v-if="batchFailedPostings.length" :data="batchFailedPostings" border max-height="220"><el-table-column prop="posting_number" label="未收录货件" min-width="190" /><el-table-column label="官方原因" min-width="260"><template #default="{ row }">{{ failureReason(row) }}</template></el-table-column></el-table>
            <p v-if="officialSummary.extra?.length">官方多出：{{ officialSummary.extra.join('、') }}</p>
            <p v-if="officialSummary.missing?.length">官方缺少：{{ officialSummary.missing.join('、') }}</p>
            <el-alert v-if="officialSummary.cross_shop_local_only?.length" type="info" :closable="false" :title="`本批次有 ${officialSummary.cross_shop_local_only.length} 个其他店铺订单，仅记录在 ERP 混装批次中，尚未作为成员写入该官方单。请按已确认的物流商混装方式核对交接；跨店 API 收录待验证。`" />
            <div class="ogl-dispatch-flow-stage"><h4>3. 下载货位标签</h4><div class="ogl-dispatch-actions">
              <el-button :loading="isFileLoading(batch.id, 'container-labels')" :disabled="!canDownloadOfficial || fileCapability(batch, 'container-labels').available !== true" @click="downloadFile('container-labels')">下载货位标签</el-button>
              <span v-if="!canDownloadOfficial || fileCapability(batch, 'container-labels').available !== true" class="ogl-dispatch-note">{{ fileCapability(batch, 'container-labels').reason || '官方确认并开放标签后可下载' }}</span>
            </div>
            <p>每个货位的标签打印 3 份，贴在三个面；打印份数与实际货位数分别计算。打印完成仍需实际交运后手动标记。</p>
            </div>
        </section>
        <div class="ogl-dispatch-actions ogl-dispatch-selection-actions">
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
          <el-table-column label="订单号" min-width="190"><template #default="{ row }"><router-link v-if="orderPath(row)" :to="orderPath(row)" target="_blank" rel="noopener" class="ogl-dispatch-order-link">{{ row.posting_number }}</router-link><span v-else>{{ row.posting_number }}</span></template></el-table-column>
          <el-table-column prop="shop_name" label="原店铺" min-width="130" />
          <el-table-column label="下单时间" min-width="180"><template #default="{ row }">{{ row.ordered_at ? formatTime(row.ordered_at) : '待获取' }}</template></el-table-column>
          <el-table-column label="货位" width="110"><template #default="{ row }">{{ row.container_no ? `货位 ${row.container_no}` : '货位未记录' }}</template></el-table-column>
          <el-table-column label="本地阶段" width="100"><template #default="{ row }"><span :title="memberPhase(row) === '已发运' ? '运往集运仓' : ''">{{ memberPhase(row) }}</span></template></el-table-column>
          <el-table-column label="平台物流" min-width="160"><template #default="{ row }"><span :title="row.logistics_status || row.tracking_stage || row.platform_status || row.status || ''">{{ platformStatusLabel(row) }}</span><div v-if="row.sync_error" class="ogl-dispatch-error">物流待更新：{{ row.sync_error }}</div><small v-else-if="row.dispatched_at && !row.logistics_fresh && !row.online && !row.cancelled">尚无交运后的最新物流，请刷新核对</small></template></el-table-column>
          <el-table-column label="交运 / 最近同步" min-width="180"><template #default="{ row }"><div>{{ formatTime(row.dispatched_at) }}</div><div>{{ formatTime(row.last_synced_at) }}</div></template></el-table-column>
          <el-table-column label="异常 / 批次关联" min-width="180"><template #default="{ row }"><div>{{ row.exception_reason || row.exception_note || row.exception_code || '—' }}</div><small>{{ row.association_label || (row.official_member ? '默认店铺 · 官方已收录' : Number(row.shop_id) !== Number(batch.default_shop_id) ? '其他店铺 · 仅 ERP 混袋关联' : '默认店铺 · 官方尚未收录，请核对') }}</small></template></el-table-column>
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
.ogl-dispatch-settings { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 12px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-light); }
.ogl-dispatch-settings-required { border-color: var(--el-color-warning); background: var(--el-color-warning-light-9); }
.ogl-dispatch-settings .ogl-dispatch-actions { margin: 0; }
.ogl-dispatch-settings p { flex-basis: 100%; margin: 0; }
.ogl-dispatch-date-filter :deep(.el-date-editor.el-input) { width: 150px; }
.ogl-dispatch-date-filter :deep(.el-date-editor--daterange) { max-width: 320px; }
.ogl-dispatch-status-code { display: block; margin-top: 4px; }
.ogl-dispatch-order-link { color: var(--el-color-primary); text-decoration: none; }
.ogl-dispatch-order-link:hover { text-decoration: underline; }
.ogl-dispatch-selection-actions { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; }
.ogl-dispatch-selection-actions > * { flex-shrink: 0; }
.ogl-dispatch-readonly-detail { margin-top: 16px; }
.ogl-dispatch-tracking { margin: 18px 0; }
.ogl-dispatch-tracking h4 { margin: 0; }
.ogl-dispatch-row-actions { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.ogl-dispatch-snapshot-note { color: var(--el-text-color-secondary); font-size: 12px; }
.ogl-dispatch-tracking-number { font-family: Consolas, monospace; overflow-wrap: anywhere; }
.ogl-dispatch-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px 20px; margin-top: 18px; }
.ogl-dispatch-form .el-form-item { margin-bottom: 12px; }
.ogl-dispatch-note { margin-left: 8px; }
.ogl-dispatch-progress { padding: 12px; background: var(--el-fill-color-light); border-radius: 6px; }
.ogl-dispatch-flow { margin: 20px 0; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color); }
.ogl-dispatch-flow-stage { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--el-border-color-light); }
.ogl-dispatch-flow-stage h4 { margin: 0 0 10px; }
.ogl-dispatch-flow :deep(.el-steps--simple) { background: var(--el-fill-color-light); }
@media (max-width: 700px) {
  .ogl-dispatch-flow { padding: 12px; }
  .ogl-dispatch-flow :deep(.el-steps--simple) { align-items: stretch; flex-direction: column; gap: 10px; }
  .ogl-dispatch-flow :deep(.el-step__arrow) { display: none; }
}
.ogl-dispatch-error { color: var(--el-color-danger); font-size: 12px; }
.ogl-dispatch-actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>
