<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../stores/auth.js";
import { apiClient } from "../../utils/api";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { dateText, integer } from "./inventory-utils.js";

const authStore = useAuthStore();
const listRequestGate = createLatestRequestGate();
const loading = ref(false);
const actionLoadingId = ref("");
const selectedOrderIds = ref([]);
const adjustmentDialog = reactive({ visible: false, item: null, quantity: 0, reason: "", submitting: false });
const batchDetailDialog = reactive({ visible: false, loading: false, batch: null, orders: [] });
const previewFrameRef = ref(null);
const barcodeLoadingKeys = reactive({});
const barcodePrintPresets = [
  { label: "标签面单 30mm x 70mm", value: "barcode_70x30", printer: "label", printSettings: "noscale,portrait,monochrome,paper=70mm*30mm" },
  { label: "FBP 面单 72mm x 130mm", value: "fbp_label_72x130", printer: "label", printSettings: "noscale,portrait,monochrome,paper=72mm x 130mm" },
  { label: "订单面单 72mm x 130mm", value: "order_label_72x130", printer: "label", printSettings: "noscale,portrait,monochrome,paper=72mm x 130mm" }
];
const barcodePreview = reactive({
  visible: false,
  loading: false,
  url: "",
  filename: "",
  pdfBase64: "",
  count: 0,
  activeRow: null,
  printer: "",
  printers: barcodePrintPresets,
  helperAvailable: false,
  helperStatus: "",
  directPrinting: false
});

const state = reactive({
  rows: [],
  total: 0,
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    status: "applying",
    page: 1,
    pageSize: 10
  }
});

const statusTabs = [
  { label: "申请中", value: "applying" },
  { label: "已通过", value: "approved" },
  { label: "待发货", value: "waiting_shipment" },
  { label: "已完成", value: "completed" },
  { label: "已取消", value: "cancelled" },
  { label: "全部", value: "all" }
];

const currentUserId = computed(() => Number(authStore.user?.id || authStore.user?.person_id || 0) || 0);
function aggregateBatchOrder(orders) {
  const first = orders[0] || {};
  const itemMap = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      const sku = String(item.ozon_sku || "");
      if (!itemMap.has(sku)) itemMap.set(sku, { ...item, id: `batch-${first.batch_id}-${sku}`, requested_qty: 0, approved_qty: 0, adjustment_qty: 0, final_qty: 0, source_order_count: 0 });
      const total = itemMap.get(sku);
      total.requested_qty += Number(item.requested_qty || 0);
      total.approved_qty += Number(item.approved_qty || 0);
      total.adjustment_qty += Number(item.adjustment_qty || 0);
      total.final_qty += Number(item.final_qty || item.approved_qty || item.requested_qty || 0);
      total.source_order_count += 1;
    }
  }
  const statuses = [...new Set(orders.map((order) => statusText(order.status)))];
  return {
    ...first,
    id: `batch-${first.batch_id}`,
    order_no: first.batch_no,
    status: "batch_summary",
    _isBatchSummary: true,
    _sourceOrders: orders,
    status_summary: statuses.join(" / "),
    item_count: itemMap.size,
    total_requested_qty: [...itemMap.values()].reduce((sum, item) => sum + item.requested_qty, 0),
    total_approved_qty: [...itemMap.values()].reduce((sum, item) => sum + item.approved_qty, 0),
    total_final_qty: [...itemMap.values()].reduce((sum, item) => sum + item.final_qty, 0),
    items: [...itemMap.values()]
  };
}

const displayOrders = computed(() => {
  const displayed = [];
  const batchGroups = new Map();
  for (const order of state.rows) {
    if (!order.batch_id) displayed.push(order);
    else {
      if (!batchGroups.has(order.batch_id)) batchGroups.set(order.batch_id, []);
      batchGroups.get(order.batch_id).push(order);
    }
  }
  for (const orders of batchGroups.values()) displayed.push(aggregateBatchOrder(orders));
  return displayed.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
});

function flattenOrderRows(orders) {
  const rows = [];
  for (const order of orders) {
    const items = Array.isArray(order.items) && order.items.length ? order.items : [{ id: `empty-${order.id}` }];
    items.forEach((item, index) => {
      rows.push(Object.assign(item, {
        order,
        _groupFirst: index === 0,
        _groupSize: items.length
      }));
    });
  }
  return rows;
}

const tableRows = computed(() => flattenOrderRows(displayOrders.value));
const batchDetailRows = computed(() => flattenOrderRows(batchDetailDialog.orders));

function statusText(status) {
  if (status === "batch_summary") return "关联汇总";
  if (status === "draft") return "草稿";
  if (status === "pending_review") return "待通过";
  if (status === "approved") return "已通过";
  if (status === "sent" || status === "ozon_created") return "等待发货";
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "rejected") return "已驳回";
  return status || "-";
}

function statusTagText(status) {
  return statusText(status);
}

function statusType(status) {
  if (status === "batch_summary") return "primary";
  if (status === "pending_review" || status === "sent" || status === "ozon_created") return "warning";
  if (status === "approved" || status === "completed") return "success";
  if (status === "rejected" || status === "cancelled") return "danger";
  return "info";
}

function salesText(row) {
  return `${integer(row.week3_qty)} / ${integer(row.week2_qty)} / ${integer(row.week1_qty)}`;
}

function coverageText(row) {
  if (row.coverage_days === null || row.coverage_days === undefined) return "-";
  return `${Number(row.coverage_days || 0).toFixed(1)} 天`;
}

function orderDateText(row) {
  return row.order_date || String(row.created_at || "").slice(0, 10) || "-";
}

function orderDisplayName(order) {
  if (order?._isBatchSummary) return order.batch_no || "关联汇总批次";
  const shopName = String(order.shop_name || "未命名店铺").trim();
  const day = orderDateText(order).replace(/-/g, "") || "未定日期";
  const suffix = String(order.order_no || "").match(/(\d+)$/)?.[1] || String(order.id || 0).padStart(5, "0");
  return `${shopName}_FBP_${day}-${suffix}`;
}

function namesText(names = [], fallback = "-") {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  return list.length ? list.join("、") : fallback;
}

function applicantIds(row) {
  const ids = Array.isArray(row.applicant_ids) ? row.applicant_ids : [];
  return ids.map((id) => Number(id || 0)).filter(Boolean);
}

function isApplicant(row) {
  const userId = currentUserId.value;
  if (!userId) return false;
  if (Number(row.created_by || 0) === userId) return true;
  return applicantIds(row).includes(userId);
}

function approveDisabledReason(row) {
  if (!["draft", "pending_review"].includes(String(row.status || ""))) return "";
  if (!currentUserId.value) return "需要登录后由非申请人审核";
  if (isApplicant(row)) return "申请人不能审核通过自己的备货单";
  return "";
}

function canApprove(row) {
  return ["draft", "pending_review"].includes(String(row.status || ""));
}

function canEditQuantities(row) {
  if (row?._isBatchSummary) return false;
  return !["approved", "sent", "ozon_created", "completed", "cancelled"].includes(String(row.status || ""));
}

function canMarkSent(row) {
  return String(row.status || "") === "approved";
}

function canCancelOrder(row) {
  return String(row.status || "") === "approved";
}

function canFillOzon(row) {
  return ["approved", "sent", "ozon_created"].includes(String(row.status || ""));
}

function canMarkCompleted(row) {
  return ["sent", "ozon_created"].includes(String(row.status || ""));
}

function canDeleteOrder(row) {
  return !["approved", "sent", "ozon_created", "completed"].includes(String(row.status || ""));
}

function canDeleteItem(row) {
  return Number(row.id || 0) > 0 && canDeleteOrder(row.order);
}

function canAdjustQuantity(order) {
  if (order?._isBatchSummary) return false;
  return ["approved", "sent", "ozon_created", "completed"].includes(String(order?.status || ""));
}

async function openBatchDetails(row) {
  batchDetailDialog.visible = true;
  batchDetailDialog.loading = true;
  batchDetailDialog.batch = row;
  batchDetailDialog.orders = [];
  try {
    const params = new URLSearchParams({ batchId: String(row.batch_id), status: "all", page: "1", pageSize: "100" });
    const payload = await apiClient.get(`/api/fbp-replenishment-orders?${params.toString()}`);
    batchDetailDialog.orders = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "关联明细加载失败");
  } finally { batchDetailDialog.loading = false; }
}

function isOrderSelected(order) {
  return selectedOrderIds.value.includes(Number(order?.id || 0));
}

function toggleOrderSelection(order, checked) {
  const id = Number(order?.id || 0);
  selectedOrderIds.value = checked
    ? [...new Set([...selectedOrderIds.value, id])]
    : selectedOrderIds.value.filter((value) => value !== id);
}

async function linkSelectedOrders() {
  const orders = state.rows.filter((row) => selectedOrderIds.value.includes(Number(row.id)));
  if (orders.length < 2) return ElMessage.warning("请至少选择 2 张备货单");
  if (new Set(orders.map((row) => Number(row.shop_id))).size !== 1) return ElMessage.warning("只能合并同一店铺的备货单");
  if (orders.some((row) => row.batch_id)) return ElMessage.warning("所选备货单已有归属批次，请先解除原关联");
  try {
    await ElMessageBox.confirm(`确认将所选 ${orders.length} 张备货单建立关联汇总？原单、审核和库存流水都会保留。`, "关联汇总", { type: "info", confirmButtonText: "确认关联" });
  } catch { return; }
  actionLoadingId.value = "link-orders";
  try {
    await apiClient.post("/api/fbp-replenishment-orders/link", { order_ids: selectedOrderIds.value });
    ElMessage.success("关联汇总批次已创建");
    selectedOrderIds.value = [];
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "关联汇总失败");
  } finally { actionLoadingId.value = ""; }
}

async function unlinkOrder(row) {
  try {
    await ElMessageBox.confirm(`确认将 ${orderDisplayName(row)} 从 ${row.batch_no} 中解除？`, "解除关联", { type: "warning" });
  } catch { return; }
  actionLoadingId.value = actionKey(row, "unlink");
  try {
    await apiClient.post("/api/fbp-replenishment-orders/unlink", { order_id: row.id });
    ElMessage.success("关联已解除");
    batchDetailDialog.visible = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "解除关联失败");
  } finally { actionLoadingId.value = ""; }
}

async function fillBatchToOzon(row) {
  actionLoadingId.value = `fill-batch-${row.batch_id}`;
  try {
    const preview = await apiClient.get(`/api/fbp-replenishment-batches/fill-preview?batchId=${Number(row.batch_id)}`);
    const items = (preview.items || []).filter((item) => String(item.sku || "").trim() && Number(item.final_qty) > 0);
    if (!items.length) return ElMessage.info("该关联单没有可导入的 SKU 和数量");
    const alreadyImported = items.some((item) => Number(item.filled_qty) > 0);
    if (alreadyImported) {
      try {
        await ElMessageBox.confirm("该关联单已经导入过 Ozon。是否按当前最终数量再次整批导入？", "已导入过", { type: "warning", confirmButtonText: "再次导入", cancelButtonText: "取消" });
      } catch { return; }
    }
    const requested = (alreadyImported ? items : items.filter((item) => Number(item.pending_qty) > 0)).map((item) => ({
      sku: String(item.sku),
      quantity: integer(alreadyImported ? item.final_qty : item.pending_qty)
    })).filter((item) => item.quantity > 0);
    if (!requested.length) return ElMessage.info("该关联单没有可导入的 SKU 和数量");
    const detail = requested.map((item) => `${item.sku}：${item.quantity}`).join("\n");
    try {
      await ElMessageBox.confirm(`${preview.batch.batch_no}\n\n${detail}`, alreadyImported ? "确认再次导入" : "确认导入 Ozon", { type: alreadyImported ? "warning" : "info", confirmButtonText: "确认导入" });
    } catch { return; }
    const result = await requestPluginFbpFill({
      batchId: Number(row.batch_id), batchNo: row.batch_no,
      shopId: Number(row.shop_id), shopName: String(row.shop_name || ""), items: requested
    });
    const resultBySku = new Map((result.results || []).map((item) => [String(item.sku || ""), item]));
    const recordedResults = requested.map((item) => {
      const pluginResult = resultBySku.get(item.sku) || { success: false, message: "插件未返回该 SKU 的结果" };
      return { ...pluginResult, sku: item.sku, quantity: item.quantity };
    });
    await apiClient.post("/api/fbp-replenishment-batches/fill-results", { batch_id: row.batch_id, repeat_import: alreadyImported, results: recordedResults });
    const failed = recordedResults.filter((item) => !item.success);
    await ElMessageBox.alert(failed.length ? `成功 ${recordedResults.length - failed.length}，失败 ${failed.length}。` : `成功导入 ${recordedResults.length} 个 SKU，执行记录已保存。`, "Ozon 导入结果", { type: failed.length ? "warning" : "success" });
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "关联批次填入 Ozon 失败");
  } finally { actionLoadingId.value = ""; }
}

function openAdjustmentDialog(row) {
  adjustmentDialog.item = row;
  adjustmentDialog.quantity = 0;
  adjustmentDialog.reason = "";
  adjustmentDialog.visible = true;
}

async function submitAdjustment() {
  const row = adjustmentDialog.item;
  if (!Number(adjustmentDialog.quantity)) return ElMessage.warning("调整数量不能为 0");
  if (!String(adjustmentDialog.reason || "").trim()) return ElMessage.warning("请填写调整原因");
  adjustmentDialog.submitting = true;
  try {
    await apiClient.post("/api/fbp-replenishment-orders/items/adjustments", {
      order_id: row.order.id,
      item_id: row.id,
      adjustment_qty: adjustmentDialog.quantity,
      reason: adjustmentDialog.reason
    });
    ElMessage.success("人工数量调整已记录");
    adjustmentDialog.visible = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存人工调整失败");
  } finally { adjustmentDialog.submitting = false; }
}

function barcodePrintQuantity(row) {
  return Math.max(1, Math.round(Number(row?.final_qty || row?.approved_qty || row?.requested_qty || 0) + 2));
}

function rowBarcodeLoadingKey(row) {
  return `${String(row?.order_id || row?.order?.id || 0)}:${String(row?.id || 0)}`;
}

function barcodePreviewLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:preview`]);
}

function barcodeGenerateLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:generate`]);
}

function barcodePrintLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:print`]);
}

function barcodePrintedText(row) {
  if (!row?.barcode_printed_at) return "";
  return `已打印 ${integer(row.barcode_printed_qty)} 张 · ${dateText(row.barcode_printed_at)}`;
}

function actionKey(row, action) {
  return `${action}-${row.id}`;
}

function itemActionKey(row, action) {
  return `${action}-${row.order_id || row.order?.id}-${row.id}`;
}

function tableSpanMethod({ row, columnIndex }) {
  const mergedColumns = new Set([0]);
  if (!mergedColumns.has(columnIndex)) return [1, 1];
  return row._groupFirst ? [row._groupSize, 1] : [0, 0];
}

function tableRowClassName({ row }) {
  return [
    row._groupFirst ? "is-order-first" : "",
    Number(row.order?.id || 0) % 2 ? "is-order-tint" : "",
    String(row.order?.status || "") === "completed" ? "is-completed-order" : ""
  ].filter(Boolean).join(" ");
}

function buildParams() {
  const params = new URLSearchParams({
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    shopId: String(state.filters.shopId || "all"),
    status: String(state.filters.status || "all")
  });
  const query = String(state.filters.query || "").trim();
  if (query) params.set("query", query);
  return params;
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const requests = [apiClient.get(`/api/fbp-replenishment-orders?${buildParams().toString()}`), loadShopDictionary()];
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    const rawPageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    const pageRows = [...new Map(rawPageRows.map((row) => [Number(row.id), row])).values()];
    const batchIds = [...new Set(pageRows.map((row) => Number(row.batch_id || 0)).filter(Boolean))];
    state.rows = pageRows;
    selectedOrderIds.value = selectedOrderIds.value.filter((id) => state.rows.some((row) => Number(row.id) === id));
    state.total = Math.max(0, Number(payload?.total || 0) - pageRows.filter((row) => row.batch_id).length + batchIds.length);
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "FBP备货单加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

async function updateStatus(row, status) {
  const disabledReason = status === "approved" ? approveDisabledReason(row) : "";
  if (disabledReason) {
    ElMessage.warning(disabledReason);
    return;
  }
  actionLoadingId.value = actionKey(row, status);
  try {
    await apiClient.post("/api/fbp-replenishment-orders/status", { id: row.id, status });
    ElMessage.success("备货单状态已更新");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "状态更新失败");
  } finally {
    actionLoadingId.value = "";
  }
}

async function cancelOrder(row) {
  try {
    await ElMessageBox.confirm(
      `确认取消 ${orderDisplayName(row)}？\n取消后会保留备货单记录，并撤销审核生成的发仓记录、退回已扣减的本地库存。`,
      "取消已通过备货单",
      { type: "warning", confirmButtonText: "确认取消", cancelButtonText: "暂不取消" }
    );
  } catch { return; }
  actionLoadingId.value = actionKey(row, "cancelled");
  try {
    await apiClient.post("/api/fbp-replenishment-orders/status", {
      id: row.id,
      status: "cancelled",
      note: "人工取消已通过备货单"
    });
    ElMessage.success("备货单已取消，本地库存已退回");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "取消备货单失败");
  } finally {
    actionLoadingId.value = "";
  }
}

async function saveOrderItems(row) {
  actionLoadingId.value = actionKey(row, "save");
  try {
    await apiClient.post("/api/fbp-replenishment-orders/items", {
      order_id: row.id,
      items: (row.items || []).map((item) => ({
        id: item.id,
        requested_qty: item.requested_qty,
        approved_qty: item.approved_qty
      }))
    });
    ElMessage.success("备货数量已保存");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存备货数量失败");
  } finally {
    actionLoadingId.value = "";
  }
}

function requestPluginFbpFill(payload) {
  const requestId = `fbp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      reject(new Error("插件填写超时，请检查 Ozon 页面上的执行进度"));
    }, 10 * 60 * 1000);
    function handleResponse(event) {
      if (event.source !== window || event.data?.type !== "OZON_ERP_FBP_FILL_RESPONSE" || event.data?.requestId !== requestId) return;
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleResponse);
      resolve(event.data.response || { success: false, message: "插件没有返回执行结果" });
    }
    window.addEventListener("message", handleResponse);
    window.postMessage({ type: "OZON_ERP_FBP_FILL_REQUEST", requestId, payload }, window.location.origin);
  });
}

async function fillOrderToOzon(row) {
  const items = (row.items || []).map((item) => ({
    sku: String(item.ozon_sku || "").trim(),
    quantity: Math.max(1, Math.round(Number(item.final_qty || item.approved_qty || item.requested_qty || 0)))
  })).filter((item) => item.sku && item.quantity > 0);
  if (!items.length) {
    ElMessage.error("该备货单没有可填写的 Ozon SKU 和数量");
    return;
  }
  actionLoadingId.value = actionKey(row, "fill-ozon");
  try {
    const result = await requestPluginFbpFill({
      orderId: Number(row.id || 0),
      orderNo: String(row.order_no || ""),
      shopId: Number(row.shop_id || 0),
      shopName: String(row.shop_name || ""),
      items
    });
    const failed = Array.isArray(result?.results) ? result.results.filter((item) => !item.success) : [];
    const lines = [result?.message || "填写任务已结束"];
    if (failed.length) lines.push(...failed.slice(0, 12).map((item) => `${item.sku || "未知SKU"}：${item.message || "填写失败"}`));
    await ElMessageBox.alert(lines.join("\n"), result?.success ? "Ozon 填写完成" : "Ozon 填写结果", {
      confirmButtonText: "知道了",
      type: result?.success ? "success" : "warning"
    });
  } catch (error) {
    ElMessage.error(error.message || "调用浏览器插件失败，请确认已安装最新版插件并刷新 ERP 页面");
  } finally {
    actionLoadingId.value = "";
  }
}

async function deleteOrder(row) {
  if (!canDeleteOrder(row)) {
    ElMessage.warning("已通过、已发送或已完成的备货单不能删除，请新建增加或减少的备货请求留痕");
    return;
  }
  try {
    await ElMessageBox.confirm(`确认删除整个备货单 ${orderDisplayName(row)}？`, "删除备货单", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  actionLoadingId.value = actionKey(row, "delete");
  try {
    await apiClient.post("/api/fbp-replenishment-orders/delete", { id: row.id });
    ElMessage.success("备货单已删除");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "删除备货单失败");
  } finally {
    actionLoadingId.value = "";
  }
}

async function deleteOrderItem(row) {
  if (!canDeleteItem(row)) {
    ElMessage.warning("已通过、已发送或已完成的备货单明细不能删除，请新建增加或减少的备货请求留痕");
    return;
  }
  try {
    await ElMessageBox.confirm(`确认删除 ${row.product_name || row.ozon_sku || "该SKU"} 这条记录？`, "删除记录", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  actionLoadingId.value = itemActionKey(row, "delete-item");
  try {
    await apiClient.post("/api/fbp-replenishment-orders/items/delete", {
      order_id: row.order.id,
      item_id: row.id
    });
    ElMessage.success("记录已删除");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "删除记录失败");
  } finally {
    actionLoadingId.value = "";
  }
}

function ensureBarcodeTarget(row, actionText) {
  if (!row?.online_product_id && !(row?.shop_id && (row?.ozon_sku || row?.offer_id))) {
    ElMessage.error(`这条备货明细缺少线上商品定位信息，暂时无法${actionText}`);
    return false;
  }
  return true;
}

function barcodeRequestItem(row, quantity = 1) {
  return {
    online_product_id: Number(row.online_product_id || 0),
    shop_id: Number(row.shop_id || row.order?.shop_id || 0),
    ozon_sku: String(row.ozon_sku || ""),
    offer_id: String(row.offer_id || ""),
    quantity
  };
}

function resetBarcodePreview() {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.visible = false;
  barcodePreview.loading = false;
  barcodePreview.url = "";
  barcodePreview.filename = "";
  barcodePreview.pdfBase64 = "";
  barcodePreview.count = 0;
  barcodePreview.activeRow = null;
  barcodePreview.printer = "";
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.helperAvailable = false;
  barcodePreview.helperStatus = "";
  barcodePreview.directPrinting = false;
}

function openBarcodePreviewDialog(count, row) {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.visible = true;
  barcodePreview.loading = true;
  barcodePreview.url = "";
  barcodePreview.filename = "";
  barcodePreview.pdfBase64 = "";
  barcodePreview.count = count;
  barcodePreview.activeRow = row || null;
  barcodePreview.printer = "barcode_70x30";
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.helperAvailable = false;
  barcodePreview.helperStatus = "正在生成条码 PDF...";
  barcodePreview.directPrinting = false;
}

function filenameFromDisposition(value, fallback = "ozon-barcodes.pdf") {
  const raw = String(value || "");
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {}
  }
  const plain = raw.match(/filename="?([^"]+)"?/i);
  return plain?.[1] || fallback;
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function openBarcodePreviewFromResponse(response, count, row) {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.url = URL.createObjectURL(response.blob);
  barcodePreview.pdfBase64 = await blobToBase64(response.blob);
  barcodePreview.filename = filenameFromDisposition(response.headers.get("Content-Disposition"), "ozon-barcodes.pdf");
  barcodePreview.count = count;
  barcodePreview.loading = false;
  barcodePreview.activeRow = row || null;
  await loadLocalPrinters();
}

async function loadLocalPrinters() {
  barcodePreview.helperAvailable = false;
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.printer = barcodePreview.printer || "barcode_70x30";
  barcodePreview.helperStatus = "正在检测服务器打印服务...";
  try {
    const payload = await apiClient.get("/api/print/printers");
    if (!payload?.ok || payload?.roles?.label?.installed === false) throw new Error("printers failed");
    barcodePreview.helperStatus = "服务器打印服务已连接";
    barcodePreview.helperAvailable = true;
  } catch {
    barcodePreview.helperAvailable = false;
    barcodePreview.helperStatus = "服务器打印服务不可用，可先预览或下载 PDF";
  }
}

async function markBarcodePrinted(row, quantity) {
  const itemId = Number(row?.id || 0);
  const orderId = Number(row?.order_id || row?.order?.id || 0);
  if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(orderId) || orderId <= 0) return;
  const payload = await apiClient.post("/api/fbp-replenishment-orders/items/barcode-printed", {
    order_id: orderId,
    item_id: itemId,
    quantity: Number(quantity || 1)
  });
  row.barcode_printed_qty = Number(payload?.barcode_printed_qty || quantity || 1);
  row.barcode_printed_at = payload?.barcode_printed_at || new Date().toISOString();
  row.barcode_printed_by = payload?.barcode_printed_by ?? currentUserId.value ?? null;
  row.barcode_printed_by_name = payload?.barcode_printed_by_name || authStore.user?.name || "";
}

async function recordBarcodePrinted(row, quantity) {
  try {
    await markBarcodePrinted(row, quantity);
  } catch (error) {
    ElMessage.warning(error.message || "条码已发起打印，但打印记录保存失败，请刷新后重试");
  }
}

async function printBarcodePreviewInBrowser() {
  const target = previewFrameRef.value?.contentWindow;
  if (!target) {
    ElMessage.warning("PDF 预览还没准备好，请稍后再试");
    return;
  }
  try {
    target.focus();
    target.print();
    await recordBarcodePrinted(barcodePreview.activeRow, barcodePreview.count);
  } catch {
    window.open(barcodePreview.url, "_blank", "noopener");
    ElMessage.warning("浏览器未能确认打印，已在新窗口打开 PDF，暂未标记为已打印");
  }
}

function downloadBarcodePreviewFile() {
  if (!barcodePreview.url) return;
  const link = document.createElement("a");
  link.href = barcodePreview.url;
  link.download = barcodePreview.filename || "ozon-barcodes.pdf";
  link.click();
}

function openBarcodePreviewInNewWindow() {
  if (!barcodePreview.url) return;
  window.open(barcodePreview.url, "_blank", "noopener");
}

async function directPrintBarcodePreview() {
  if (!barcodePreview.pdfBase64) {
    ElMessage.error("当前没有可打印的 PDF");
    return;
  }
  barcodePreview.directPrinting = true;
  barcodePreview.helperStatus = "正在发送到服务器打印机...";
  try {
    const preset = barcodePrintPresets.find((item) => item.value === barcodePreview.printer) || barcodePrintPresets[0];
    await apiClient.post("/api/print/jobs", {
      pdf_base64: barcodePreview.pdfBase64,
      filename: barcodePreview.filename || "ozon-barcodes.pdf",
      printer: preset.printer,
      print_settings: preset.printSettings,
      preset: preset.value,
      paper_size: preset.value,
      source: "fbp-replenishment-barcode-preview"
    });
    await recordBarcodePrinted(barcodePreview.activeRow, barcodePreview.count);
    barcodePreview.helperStatus = "已发送到打印机";
    ElMessage.success("条码已发送到服务器标签打印机");
  } catch (error) {
    barcodePreview.helperStatus = "直接打印失败，已回退到浏览器打印";
    ElMessage.warning(error.message || "直接打印失败，已回退到浏览器打印");
    printBarcodePreviewInBrowser();
  } finally {
    barcodePreview.directPrinting = false;
  }
}

async function generateBarcode(row, options = {}) {
  if (!ensureBarcodeTarget(row, "生成条码")) return false;
  const key = `${rowBarcodeLoadingKey(row)}:generate`;
  barcodeLoadingKeys[key] = true;
  try {
    await apiClient.post("/api/products/barcode-label/generate", {
      items: [barcodeRequestItem(row, 1)],
      refresh_cache: options.refreshCache !== false,
      force_generate: options.forceGenerate === true
    });
    ElMessage.success(options.forceGenerate ? "条码已重新生成" : "条码已生成");
    return true;
  } catch (error) {
    ElMessage.error(error.message || "生成条码失败");
    return false;
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

async function previewBarcodeLabel(row) {
  if (!ensureBarcodeTarget(row, "预览条码")) return;
  const quantity = barcodePrintQuantity(row);
  const key = `${rowBarcodeLoadingKey(row)}:preview`;
  barcodeLoadingKeys[key] = true;
  openBarcodePreviewDialog(quantity, row);
  try {
    const response = await apiClient.blobResponse("/api/products/barcode-label", {
      method: "POST",
      body: JSON.stringify({
        items: [barcodeRequestItem(row, quantity)]
      })
    });
    await openBarcodePreviewFromResponse(response, quantity, row);
  } catch (error) {
    resetBarcodePreview();
    ElMessage.error(error.message || "预览条码失败");
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

async function regenerateBarcodeLabel(row) {
  await generateBarcode(row, { refreshCache: true, forceGenerate: true });
}

async function printBarcodeLabel(row) {
  if (!ensureBarcodeTarget(row, "打印条码")) return;
  let promptValue = String(barcodePrintQuantity(row));
  try {
    const result = await ElMessageBox.prompt("请输入这次要打印的条码数量", "打印条码 PDF", {
      confirmButtonText: "继续",
      cancelButtonText: "取消",
      inputValue: promptValue,
      inputPattern: /^[1-9]\d{0,2}$/,
      inputErrorMessage: "请输入 1-999 的整数"
    });
    promptValue = String(result?.value || promptValue).trim();
  } catch {
    return;
  }

  const quantity = Math.max(1, Math.min(999, Math.round(Number(promptValue || 1))));
  const key = `${rowBarcodeLoadingKey(row)}:print`;
  barcodeLoadingKeys[key] = true;
  openBarcodePreviewDialog(quantity, row);
  try {
    const response = await apiClient.blobResponse("/api/products/barcode-label", {
      method: "POST",
      body: JSON.stringify({
        items: [barcodeRequestItem(row, quantity)]
      })
    });
    await openBarcodePreviewFromResponse(response, quantity, row);
  } catch (error) {
    resetBarcodePreview();
    ElMessage.error(error.message || "打印条码失败");
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

function handleStatusTab(tabName) {
  state.filters.status = tabName;
  state.filters.page = 1;
  loadPageData();
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  state.filters.query = "";
  state.filters.shopId = "all";
  state.filters.status = "applying";
  state.filters.page = 1;
  loadPageData();
}

function handlePageChange(page) {
  state.filters.page = page;
  loadPageData();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  loadPageData();
}

watch(() => state.filters.shopId, () => {
  state.filters.page = 1;
  loadPageData();
});

onMounted(loadPageData);
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <div class="replenishment-command-bar">
      <div class="replenishment-command-main">
        <div class="replenishment-status-nav">
          <span class="command-eyebrow">备货进度</span>
          <div class="replenishment-tabs">
            <el-tabs :model-value="state.filters.status" @tab-change="handleStatusTab">
              <el-tab-pane v-for="tab in statusTabs" :key="tab.value" :label="tab.label" :name="tab.value" />
            </el-tabs>
          </div>
        </div>
        <div class="replenishment-selection">
          <span class="selection-count">已选 <strong>{{ selectedOrderIds.length }}</strong> 张</span>
          <el-button type="primary" :disabled="selectedOrderIds.length < 2" :loading="actionLoadingId === 'link-orders'" @click="linkSelectedOrders">
            创建关联汇总
          </el-button>
        </div>
      </div>
      <div class="replenishment-filter-row">
        <div class="replenishment-filter-heading">
          <strong>筛选备货单</strong>
          <span>按单号、商品或店铺快速定位</span>
        </div>
        <div class="replenishment-filter-controls">
          <el-input
            v-model="state.filters.query"
            clearable
            class="replenishment-search"
            placeholder="搜索单号 / SKU / 产品 / 申请人"
            @keyup.enter="handleSearch"
          />
          <el-select v-model="state.filters.shopId" class="replenishment-shop-select" placeholder="选择店铺">
            <el-option label="全部店铺" value="all" />
            <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </div>
      </div>
    </div>

    <div class="inventory-table-wrap replenishment-table-wrap">
      <el-table
        v-loading="loading"
        :data="tableRows"
        :span-method="tableSpanMethod"
        :row-class-name="tableRowClassName"
        border
        class="erp-data-table replenishment-table"
        empty-text="暂无FBP备货单"
      >
        <el-table-column label="备货单" min-width="250">
          <template #default="{ row }">
            <div class="order-cell">
              <el-checkbox v-if="!row.order._isBatchSummary" :model-value="isOrderSelected(row.order)" :disabled="Boolean(row.order.batch_id)" @change="toggleOrderSelection(row.order, $event)">选择关联</el-checkbox>
              <div class="shop-banner">{{ row.order.shop_name || "未命名店铺" }}</div>
              <div class="order-line">
                <span class="order-label">备货单号</span>
                <strong class="order-title">{{ orderDisplayName(row.order) }}</strong>
              </div>
              <div class="order-line">
                <span class="order-label">创建时间</span>
                <span class="order-value">{{ dateText(row.order.created_at) }}</span>
              </div>
              <div class="order-line">
                <span class="order-label">状态</span>
                <el-tag :type="statusType(row.order.status)" effect="light">
                  {{ row.order._isBatchSummary ? row.order.status_summary : statusTagText(row.order.status) }}
                </el-tag>
              </div>
              <div class="order-line">
                <span class="order-label">总览</span>
                <div class="order-summary">
                  <span>SKU {{ integer(row.order.item_count) }}</span>
                  <span>申请 {{ integer(row.order.total_requested_qty) }}</span>
                  <span>通过 {{ integer(row.order.total_approved_qty) }}</span>
                  <span v-if="row.order._isBatchSummary">最终 {{ integer(row.order.total_final_qty) }}</span>
                  <span v-if="row.order._isBatchSummary">关联 {{ row.order._sourceOrders.length }} 张原单</span>
                </div>
              </div>
              <div class="order-line">
                <span class="order-label">操作</span>
                <el-space wrap class="order-actions" :size="8">
                  <el-tooltip :disabled="!approveDisabledReason(row.order)" :content="approveDisabledReason(row.order)" placement="top">
                    <span>
                      <el-button
                        v-if="!row.order._isBatchSummary && canApprove(row.order)"
                        size="default"
                        type="success"
                        :disabled="Boolean(approveDisabledReason(row.order))"
                        :loading="actionLoadingId === actionKey(row.order, 'approved')"
                        @click="updateStatus(row.order, 'approved')"
                      >
                        通过
                      </el-button>
                    </span>
                  </el-tooltip>
                  <el-button
                    v-if="!row.order._isBatchSummary && canEditQuantities(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'save')"
                    @click="saveOrderItems(row.order)"
                  >
                    保存
                  </el-button>
                  <el-button
                    v-if="!row.order._isBatchSummary && canFillOzon(row.order) && !row.order.batch_id"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'fill-ozon')"
                    @click="fillOrderToOzon(row.order)"
                  >
                    填入 Ozon
                  </el-button>
                  <el-button
                    v-if="row.order._isBatchSummary"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === `fill-batch-${row.order.batch_id}`"
                    @click="fillBatchToOzon(row.order)"
                  >导入 Ozon</el-button>
                  <el-button v-if="row.order._isBatchSummary" size="default" type="primary" plain @click="openBatchDetails(row.order)">查看关联明细</el-button>
                  <el-button
                    v-if="row.order.batch_id && !row.order._isBatchSummary"
                    size="default"
                    type="info"
                    plain
                    :loading="actionLoadingId === actionKey(row.order, 'unlink')"
                    @click="unlinkOrder(row.order)"
                  >解除关联</el-button>
                  <el-button
                    v-if="!row.order._isBatchSummary && canMarkSent(row.order)"
                    size="default"
                    type="warning"
                    :loading="actionLoadingId === actionKey(row.order, 'sent')"
                    @click="updateStatus(row.order, 'sent')"
                  >
                    标记已发送
                  </el-button>
                  <el-button
                    v-if="!row.order._isBatchSummary && canCancelOrder(row.order)"
                    size="default"
                    type="danger"
                    plain
                    :loading="actionLoadingId === actionKey(row.order, 'cancelled')"
                    @click="cancelOrder(row.order)"
                  >取消</el-button>
                  <el-button
                    v-if="!row.order._isBatchSummary && canMarkCompleted(row.order)"
                    size="default"
                    type="success"
                    :loading="actionLoadingId === actionKey(row.order, 'completed')"
                    @click="updateStatus(row.order, 'completed')"
                  >
                    完成
                  </el-button>
                  <el-button
                    v-if="!row.order._isBatchSummary && canDeleteOrder(row.order)"
                    size="default"
                    type="danger"
                    :loading="actionLoadingId === actionKey(row.order, 'delete')"
                    @click="deleteOrder(row.order)"
                  >
                    删除备货单
                  </el-button>
                </el-space>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="产品信息" min-width="330">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <strong>{{ row.product_name || "-" }}</strong>
                <span class="muted-text">SKU {{ row.ozon_sku || "-" }}</span>
                <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
                <span v-if="row.order._isBatchSummary" class="batch-source-count">来自 {{ integer(row.source_order_count) }} 张关联原单</span>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="销量" width="150" align="center">
          <template #default="{ row }">
            <div class="metric-stack">
              <strong>30天 {{ integer(row.recent_30d_qty) }}</strong>
              <span>7天 {{ integer(row.recent_7d_qty) }}</span>
              <span>三周 {{ salesText(row) }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="FBP库存" width="150" align="center">
          <template #default="{ row }">
            <div class="metric-stack">
              <strong>当前 {{ integer(row.fbp_available) }}</strong>
              <span>在途 {{ integer(row.fbp_transfer_in_transit_qty) }}</span>
              <span>有效 {{ integer(row.fbp_effective_available) }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="本地库存" width="150" align="center">
          <template #default="{ row }">
            <div class="metric-stack">
              <strong>本地 {{ integer(row.local_stock) }}</strong>
              <span>FBS {{ integer(row.fbs_available) }}</span>
              <span>采购中 {{ integer(row.pending_procurement_qty) }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="建议" width="130" align="center">
          <template #default="{ row }">
            <div class="metric-stack">
              <strong>{{ integer(row.suggested_qty) }}</strong>
              <span>{{ coverageText(row) }}</span>
              <span>{{ row.suggested_action_text || "-" }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="依据" min-width="220">
          <template #default="{ row }">
            <span class="muted-text">{{ row.reason || row.note || "-" }}</span>
          </template>
        </el-table-column>

        <el-table-column label="申请人" width="120" align="center">
          <template #default="{ row }">{{ row.requested_by_name || row.order.created_by_name || "-" }}</template>
        </el-table-column>

        <el-table-column label="审核人" width="120" align="center">
          <template #default="{ row }">{{ row.order.reviewed_by_name || "未审核" }}</template>
        </el-table-column>

        <el-table-column label="备货数量（原始 / 调整 / 最终）" width="210" align="center">
          <template #default="{ row }">
            <el-input-number
              v-if="canEditQuantities(row.order)"
              v-model="row.requested_qty"
              :disabled="!canEditQuantities(row.order)"
              :min="1"
              :step="1"
              controls-position="right"
              size="small"
              class="qty-input"
            />
            <div v-else class="quantity-audit">
              <span>原始 {{ integer(row.approved_qty || row.requested_qty) }}</span>
              <strong :class="Number(row.adjustment_qty) < 0 ? 'is-negative' : 'is-positive'">调整 {{ Number(row.adjustment_qty) > 0 ? '+' : '' }}{{ integer(row.adjustment_qty) }}</strong>
              <b>最终 {{ integer(row.final_qty) }}</b>
              <el-tooltip v-if="row.adjustment_summary" :content="row.adjustment_summary" placement="top">
                <span class="adjustment-history">查看调整记录</span>
              </el-tooltip>
              <el-button v-if="canAdjustQuantity(row.order)" link type="primary" @click="openAdjustmentDialog(row)">添加人工调整</el-button>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="打印" width="240" align="center">
          <template #default="{ row }">
            <div class="barcode-cell">
              <el-space wrap :size="6" class="barcode-actions">
                <el-button
                  class="erp-btn-link"
                  link
                  type="primary"
                  :loading="barcodePreviewLoading(row)"
                  @click="previewBarcodeLabel(row)"
                >
                  预览
                </el-button>
                <el-button
                  class="erp-btn-link"
                  link
                  type="warning"
                  :loading="barcodeGenerateLoading(row)"
                  @click="regenerateBarcodeLabel(row)"
                >
                  重新生成
                </el-button>
                <el-button
                  class="erp-btn-link"
                  link
                  type="success"
                  :loading="barcodePrintLoading(row)"
                  @click="printBarcodeLabel(row)"
                >
                  打印
                </el-button>
              </el-space>
              <div v-if="barcodePrintedText(row)" class="barcode-status is-printed">
                {{ barcodePrintedText(row) }}
              </div>
              <div v-else class="barcode-status muted-text">
                默认 {{ integer(barcodePrintQuantity(row)) }} 张
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="删除记录" width="105" align="center">
          <template #default="{ row }">
            <el-button
              v-if="!row.order._isBatchSummary && canDeleteItem(row)"
              class="erp-btn-link"
              link
              type="danger"
              :loading="actionLoadingId === itemActionKey(row, 'delete-item')"
              @click="deleteOrderItem(row)"
            >
              删除
            </el-button>
            <span v-else class="muted-text">-</span>
          </template>
        </el-table-column>

      </el-table>
    </div>

    <el-dialog
      v-model="barcodePreview.visible"
      title="条码 PDF 预览"
      width="min(1120px, 96vw)"
      top="4vh"
      destroy-on-close
      @closed="resetBarcodePreview"
    >
      <div class="barcode-preview-shell">
        <div class="barcode-preview-toolbar">
          <div class="cell-stack">
            <strong>{{ barcodePreview.count > 1 ? `条码打印预览（${barcodePreview.count} 张）` : "条码打印预览" }}</strong>
            <span class="muted-text">{{ barcodePreview.helperStatus || "先预览，确认无误后再打印" }}</span>
          </div>
          <div class="barcode-preview-actions">
            <el-select
              v-model="barcodePreview.printer"
              placeholder="打印尺寸"
              filterable
              style="width: 220px"
              :disabled="!barcodePreview.helperAvailable || barcodePreview.directPrinting"
            >
              <el-option
                v-for="preset in barcodePreview.printers"
                :key="preset.value"
                :label="preset.label"
                :value="preset.value"
              />
            </el-select>
            <el-button
              type="primary"
              :disabled="!barcodePreview.helperAvailable || barcodePreview.loading"
              :loading="barcodePreview.directPrinting"
              @click="directPrintBarcodePreview"
            >
              直接打印
            </el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="printBarcodePreviewInBrowser">浏览器打印</el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="downloadBarcodePreviewFile">下载 PDF</el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="openBarcodePreviewInNewWindow">新窗口打开</el-button>
          </div>
        </div>

        <div v-if="barcodePreview.loading" class="barcode-preview-loading">
          <el-skeleton :rows="8" animated />
        </div>
        <iframe
          v-else
          ref="previewFrameRef"
          class="barcode-preview-frame"
          :src="barcodePreview.url"
          title="条码 PDF 预览"
        />
      </div>
    </el-dialog>

    <el-dialog v-model="adjustmentDialog.visible" title="添加人工数量调整" width="480px" destroy-on-close>
      <el-alert title="原始审核数量不会被覆盖；本次调整和原因将作为独立记录保留。" type="info" :closable="false" show-icon />
      <el-form label-position="top" class="adjustment-form">
        <el-form-item label="调整数量（正数增加，负数减少）">
          <el-input-number v-model="adjustmentDialog.quantity" :min="-999999" :max="999999" :step="1" controls-position="right" />
        </el-form-item>
        <el-form-item label="调整原因">
          <el-input v-model="adjustmentDialog.reason" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="例如：装箱复核发现少 2 件" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustmentDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="adjustmentDialog.submitting" @click="submitAdjustment">保存调整记录</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDetailDialog.visible" :title="`关联明细 · ${batchDetailDialog.batch?.batch_no || ''}`" width="96vw" top="4vh" destroy-on-close>
      <div v-loading="batchDetailDialog.loading" class="batch-detail-list">
        <el-table v-if="batchDetailRows.length" :data="batchDetailRows" :span-method="tableSpanMethod" border class="erp-data-table replenishment-table batch-detail-table">
          <el-table-column label="备货单" min-width="260">
            <template #default="{ row }"><div class="order-cell"><div class="shop-banner">{{ row.order.shop_name || "未命名店铺" }}</div><div class="order-line"><span class="order-label">备货单号</span><strong class="order-title">{{ orderDisplayName(row.order) }}</strong></div><div class="order-line"><span class="order-label">创建时间</span><span class="order-value">{{ dateText(row.order.created_at) }}</span></div><div class="order-line"><span class="order-label">状态</span><el-tag :type="statusType(row.order.status)" effect="light">{{ statusTagText(row.order.status) }}</el-tag></div><div class="order-line"><span class="order-label">总览</span><div class="order-summary"><span>SKU {{ integer(row.order.item_count) }}</span><span>申请 {{ integer(row.order.total_requested_qty) }}</span><span>通过 {{ integer(row.order.total_approved_qty) }}</span><span>最终 {{ integer(row.order.total_final_qty) }}</span></div></div><div class="order-line"><span class="order-label">操作</span><el-button type="info" plain size="default" @click="unlinkOrder(row.order)">解除关联</el-button></div></div></template>
          </el-table-column>
          <el-table-column label="产品信息" min-width="330"><template #default="{ row }"><div class="product-cell"><ProductImagePreview :src="row.image_url" /><div class="cell-stack"><strong>{{ row.product_name || "-" }}</strong><span class="muted-text">SKU {{ row.ozon_sku || "-" }}</span><span class="muted-text">Offer {{ row.offer_id || "-" }}</span></div></div></template></el-table-column>
          <el-table-column label="销量" width="145" align="center"><template #default="{ row }"><div class="metric-stack"><strong>30天 {{ integer(row.recent_30d_qty) }}</strong><span>7天 {{ integer(row.recent_7d_qty) }}</span><span>三周 {{ salesText(row) }}</span></div></template></el-table-column>
          <el-table-column label="FBP库存" width="125" align="center"><template #default="{ row }"><div class="metric-stack"><strong>当前 {{ integer(row.fbp_stock) }}</strong><span>在途 {{ integer(row.fbp_in_transit) }}</span><span>有效 {{ integer(row.fbp_effective_stock) }}</span></div></template></el-table-column>
          <el-table-column label="本地库存" width="130" align="center"><template #default="{ row }"><div class="metric-stack"><strong>本地 {{ integer(row.local_stock) }}</strong><span>FBS {{ integer(row.fbs_stock) }}</span><span>采购中 {{ integer(row.purchase_pending_qty) }}</span></div></template></el-table-column>
          <el-table-column label="备货数量（原始 / 调整 / 最终）" width="210" align="center"><template #default="{ row }"><div class="quantity-audit"><span>原始 {{ integer(row.approved_qty || row.requested_qty) }}</span><strong :class="Number(row.adjustment_qty) < 0 ? 'is-negative' : 'is-positive'">调整 {{ Number(row.adjustment_qty) > 0 ? '+' : '' }}{{ integer(row.adjustment_qty) }}</strong><b>最终 {{ integer(row.final_qty) }}</b><span v-if="row.adjustment_summary" class="adjustment-history">{{ row.adjustment_summary }}</span></div></template></el-table-column>
            <el-table-column label="打印" width="220" align="center">
              <template #default="{ row }">
                <el-space wrap :size="6" class="barcode-actions">
                  <el-button link type="primary" :loading="barcodePreviewLoading(row)" @click="previewBarcodeLabel(row)">预览</el-button>
                  <el-button link type="warning" :loading="barcodeGenerateLoading(row)" @click="regenerateBarcodeLabel(row)">重新生成</el-button>
                  <el-button link type="success" :loading="barcodePrintLoading(row)" @click="printBarcodeLabel(row)">打印</el-button>
                </el-space>
                <div class="barcode-status muted-text">默认 {{ integer(barcodePrintQuantity(row)) }} 张</div>
              </template>
            </el-table-column>
        </el-table>
        <el-empty v-if="!batchDetailDialog.loading && !batchDetailDialog.orders.length" description="暂无关联明细" />
      </div>
    </el-dialog>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />
  </div>
</template>

<style scoped>
.replenishment-command-bar {
  display: grid;
  gap: 0;
  margin-bottom: 18px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
}

.replenishment-command-main {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 20px 0;
  background: linear-gradient(135deg, #f8faff 0%, #ffffff 58%, #f5f3ff 100%);
}

.replenishment-status-nav {
  min-width: 0;
}

.command-eyebrow {
  display: block;
  margin-bottom: 9px;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.replenishment-tabs {
  min-width: 0;
}

.replenishment-selection {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  flex: 0 0 auto;
}

.selection-count {
  color: #64748b;
  font-size: 13px;
}

.selection-count strong {
  color: #4f46e5;
  font-size: 16px;
}

.replenishment-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.replenishment-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: #dbe3ef;
}

.replenishment-tabs :deep(.el-tabs__item) {
  height: 42px;
  padding: 0 20px;
  color: #475569;
  font-weight: 600;
}

.replenishment-tabs :deep(.el-tabs__item.is-active) {
  color: #4f46e5;
}

.replenishment-tabs :deep(.el-tabs__active-bar) {
  height: 3px;
  border-radius: 999px 999px 0 0;
  background: #635bff;
}

.replenishment-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 20px;
  border-top: 1px solid #edf1f7;
}

.replenishment-filter-heading {
  display: grid;
  gap: 2px;
  flex: 0 0 auto;
}

.replenishment-filter-heading strong {
  color: #1e293b;
  font-size: 14px;
}

.replenishment-filter-heading span {
  color: #94a3b8;
  font-size: 12px;
}

.replenishment-filter-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
}

.replenishment-search {
  width: min(380px, 32vw);
}

.replenishment-shop-select {
  width: 180px;
}

.replenishment-filter-controls :deep(.el-input__wrapper),
.replenishment-filter-controls :deep(.el-select__wrapper) {
  min-height: 38px;
  border-radius: 9px;
  box-shadow: 0 0 0 1px #dbe3ef inset;
}

.replenishment-filter-controls :deep(.el-button) {
  min-height: 38px;
  border-radius: 9px;
  padding-inline: 18px;
}

.replenishment-table-wrap {
  min-height: 360px;
}

.replenishment-table :deep(.el-table__cell) {
  vertical-align: middle;
}

.replenishment-table :deep(.el-table__body tr) {
  background: #fff;
}

.replenishment-table :deep(.el-table__body tr.is-order-tint > td.el-table__cell) {
  background: #f8faff;
}

.replenishment-table :deep(.el-table__body tr.is-order-first > td.el-table__cell) {
  border-top: 3px solid #cbd5e1;
}

.replenishment-table :deep(.is-completed-order .order-title) {
  color: #15803d;
}

.order-cell {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.shop-banner {
  padding: 9px 12px;
  border-left: 4px solid #635bff;
  border-radius: 7px;
  background: #eef2ff;
  color: #312e81;
  font-size: 15px;
  font-weight: 800;
}

.batch-detail-list {
  min-height: 180px;
}

.batch-detail-table { width: 100%; }
.batch-detail-list .is-positive { color: #15803d; font-weight: 700; }
.batch-detail-list .is-negative { color: #dc2626; font-weight: 700; }
.batch-source-count { color: #4f46e5; font-size: 12px; font-weight: 700; }

.order-line {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  min-width: 0;
}

.order-label {
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
}

.order-value {
  min-width: 0;
  color: #334155;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.order-title {
  line-height: 1.35;
  word-break: break-word;
}

.order-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
}

.order-actions {
  min-width: 0;
}

.quantity-audit {
  display: grid;
  justify-items: center;
  gap: 3px;
  font-size: 12px;
}

.quantity-audit b { font-size: 15px; color: #0f172a; }
.quantity-audit .is-positive { color: #15803d; }
.quantity-audit .is-negative { color: #dc2626; }
.adjustment-history { color: #4f46e5; cursor: help; text-decoration: underline dotted; }

.adjustment-form { margin-top: 16px; }

@media (max-width: 1280px) {
  .replenishment-command-main,
  .replenishment-filter-row { align-items: stretch; flex-direction: column; gap: 12px; }
  .replenishment-selection { justify-content: space-between; padding-bottom: 16px; }
  .replenishment-filter-controls { justify-content: flex-start; flex-wrap: wrap; }
  .replenishment-search { width: min(100%, 420px); }
}

@media (max-width: 720px) {
  .replenishment-command-main,
  .replenishment-filter-row { padding-inline: 14px; }
  .replenishment-tabs { overflow-x: auto; }
  .replenishment-tabs :deep(.el-tabs__item) { padding: 0 13px; }
  .replenishment-filter-controls { display: grid; grid-template-columns: 1fr 1fr; }
  .replenishment-search,
  .replenishment-shop-select { width: 100%; grid-column: 1 / -1; }
}

.metric-stack {
  display: grid;
  gap: 2px;
  line-height: 1.35;
}

.metric-stack span {
  color: #64748b;
  font-size: 12px;
}

.qty-input {
  width: 104px;
}

.barcode-cell {
  display: grid;
  gap: 6px;
  justify-items: center;
}

.barcode-actions {
  justify-content: center;
}

.barcode-status {
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
}

.barcode-status.is-printed {
  color: #15803d;
}

.barcode-preview-shell {
  display: grid;
  gap: 12px;
}

.barcode-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.barcode-preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.barcode-preview-loading {
  min-height: 520px;
  padding: 18px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

.barcode-preview-frame {
  width: 100%;
  height: 72vh;
  border: 1px solid #dbe3ef;
  border-radius: 10px;
  background: #f8fafc;
}
</style>
