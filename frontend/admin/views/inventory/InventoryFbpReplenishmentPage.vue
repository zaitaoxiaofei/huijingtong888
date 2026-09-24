<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../stores/auth.js";
import { apiClient } from "../../utils/api";
import { copyToClipboard } from "../../utils/clipboard.js";
import { openBarcodePrintWindow } from "../../utils/barcode-print-window.js";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { dateText, integer } from "./inventory-utils.js";

const authStore = useAuthStore();
const sharedReplenishmentStatus = inject("inventoryFbpReplenishmentStatus", ref("applying"));
const listRequestGate = createLatestRequestGate();
const loading = ref(false);
const actionLoadingId = ref("");
const selectedOrderIds = ref([]);
const adjustmentDialog = reactive({ visible: false, item: null, quantity: 0, reason: "", submitting: false });
const batchDetailDialog = reactive({ visible: false, loading: false, batch: null, orders: [] });
const barcodePrintDialog = reactive({ visible: false, row: null, quantity: 1, recommended: 1, submitting: false });
const barcodePrintResultDialog = reactive({ visible: false, row: null, quantity: 0, confirming: false });
const fbpFillResultDialog = reactive({ visible: false, summary: "", successCount: 0, durationSeconds: 0, failures: [], requiresReload: false });
const barcodeLoadingKeys = reactive({});
const receiptDialog = reactive({ visible: false, loading: false, submitting: false, orders: [], rows: [] });
const allocationDialog = reactive({ visible: false, saving: false, inventory: null, items: [], reason: "" });

async function loadReceiptRows() {
  const rows = [];
  for (const order of receiptDialog.orders) {
    let page = 1;
    let count = 0;
    while (true) {
      const payload = await apiClient.get(`/api/fbp-transfer-records?order_id=${Number(order.id)}&page=${page}&pageSize=200`);
      for (const record of payload.rows || []) {
        if (["draft", "cancelled", "closed"].includes(record.status)) continue;
        rows.push({ ...record, order_no: order.order_no, remaining: Math.max(0, Number(record.quantity) - Number(record.listed_quantity)), receive_now: 0 });
      }
      count += (payload.rows || []).length;
      if (count >= Number(payload.total || 0) || !(payload.rows || []).length) break;
      page += 1;
    }
  }
  receiptDialog.rows = rows;
}

async function openReceiptDialog(order) {
  receiptDialog.orders = order._isBatchSummary ? order._sourceOrders.filter(canMarkCompleted) : [order];
  receiptDialog.rows = [];
  receiptDialog.visible = true;
  receiptDialog.loading = true;
  try { await loadReceiptRows(); }
  catch (error) { ElMessage.error(error.message || "入仓明细加载失败"); }
  finally { receiptDialog.loading = false; }
}

async function submitReceipt() {
  if (receiptDialog.submitting || receiptDialog.loading) return;
  const rows = receiptDialog.rows.filter((row) => Number(row.receive_now) > 0);
  if (!rows.length) { ElMessage.warning("请填写至少一条本次入仓数量"); return; }
  if (rows.some((row) => !Number.isInteger(Number(row.receive_now)) || Number(row.receive_now) > row.remaining)) {
    ElMessage.warning("本次入仓数量必须为整数，且不能超过剩余数量"); return;
  }
  receiptDialog.submitting = true;
  let saved = 0;
  try {
    for (const row of rows) {
      await apiClient.post("/api/fbp-transfer-records/confirm-received", {
        id: row.id, received_quantity: Number(row.receive_now), expected_listed_quantity: Number(row.listed_quantity)
      });
      row.receive_now = 0;
      saved += 1;
    }
    ElMessage.success(`已保存 ${saved} 条入仓记录；全部收齐的备货单自动转为已入仓`);
  } catch (error) {
    ElMessage.error(`已保存 ${saved} 条，其他记录未完成：${error.message || "请重试"}`);
  } finally {
    try { await loadReceiptRows(); await loadPageData(); }
    catch (error) { receiptDialog.rows = []; ElMessage.error("入仓明细刷新失败，请关闭弹窗后重新打开"); }
    receiptDialog.submitting = false;
  }
}

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
const viewMode = ref("operations");

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
      total.final_qty += Number(item.final_qty ?? item.approved_qty ?? item.requested_qty ?? 0);
      total.source_order_count += 1;
    }
  }
  const statuses = [...new Set(orders.map((order) => statusTagText(order.status, order.received_quantity)))];
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

const inventoryRows = computed(() => {
  const grouped = new Map();
  for (const order of state.rows) {
    for (const item of order.items || []) {
      const key = String(item.product_id || item.inventory_id || item.inventory_number || `unmapped:${item.id}`);
      if (!grouped.has(key)) grouped.set(key, {
        inventory_key: key,
        inventory_id: item.inventory_number || item.inventory_id || "未映射库存",
        product_name: item.product_name || "-",
        image_url: item.image_url || "",
        local_stock: Number(item.local_stock || 0),
        requested_qty: 0,
        final_qty: 0,
        pending_dispatch_qty: 0,
        pending_receipt_qty: 0,
        items: []
      });
      const total = grouped.get(key);
      total.local_stock = Math.max(total.local_stock, Number(item.local_stock || 0));
      total.requested_qty += Number(item.requested_qty || 0);
      total.final_qty += Number(item.final_qty || item.approved_qty || 0);
      if (["approved", "ozon_created"].includes(order.status)) total.pending_dispatch_qty += Number(item.final_qty || item.approved_qty || 0);
      if (order.status === "sent") total.pending_receipt_qty += Number(item.final_qty || item.approved_qty || 0);
      total.items.push({ ...item, order });
    }
  }
  return [...grouped.values()].sort((a, b) => String(a.inventory_id).localeCompare(String(b.inventory_id)));
});

const allocationTotal = computed(() => allocationDialog.items.reduce((sum, item) => sum + Math.max(0, Number(item.final_qty || 0)), 0));
function canInventoryItemEdit(item) {
  return true;
}

const allocationHasEditable = computed(() => allocationDialog.items.some(canInventoryItemEdit));

function openAllocationDialog(inventory) {
  allocationDialog.inventory = inventory;
  allocationDialog.items = inventory.items.map((item) => ({ ...item, final_qty: Number(item.final_qty || 0) }));
  allocationDialog.reason = "";
  allocationDialog.visible = true;
}

async function saveInventoryAllocation() {
  if (!allocationHasEditable.value) return ElMessage.warning("没有可调整的店铺明细。");
  if (allocationTotal.value > Number(allocationDialog.inventory?.local_stock || 0)) {
    return ElMessage.warning(`分配总数 ${allocationTotal.value} 超过本地可用库存 ${integer(allocationDialog.inventory?.local_stock)}`);
  }
  if (allocationDialog.items.some((item) => !Number.isInteger(Number(item.final_qty)) || Number(item.final_qty) < 0)) {
    return ElMessage.warning("各店铺分配数量必须是非负整数");
  }
  allocationDialog.saving = true;
  try {
    await apiClient.post("/api/fbp-replenishment-orders/inventory-allocation", {
      inventory_key: allocationDialog.inventory.inventory_key,
      reason: allocationDialog.reason,
      items: allocationDialog.items.map((item) => ({ order_id: item.order_id, item_id: item.id, final_qty: Number(item.final_qty) }))
    });
    ElMessage.success("各店铺备货数量已保存，运营视角会同步显示最新数量");
    allocationDialog.visible = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "库存分配保存失败");
  } finally { allocationDialog.saving = false; }
}

async function createInventoryProcurement(row) {
  try {
    const { value } = await ElMessageBox.prompt(`为“${row.product_name}”创建采购需求`, "创建采购需求", { inputValue: String(Math.max(1, Number(row.final_qty || 1))), inputPattern: /^[1-9]\\d*$/, inputErrorMessage: "请输入大于 0 的整数", confirmButtonText: "提交采购工作台" });
    await apiClient.post("/api/fbp-replenishment-orders/inventory-procurement", { product_id: Number(row.items?.[0]?.product_id || 0), quantity: Number(value), reason_code: "fbp_stock_shortage", reason_note: "FBP备货库存不足" });
    ElMessage.success("采购需求已提交到采购工作台");
  } catch (error) { if (error !== "cancel") ElMessage.error(error.message || "采购需求提交失败"); }
}

function exportInventorySummary() {
  const lines = [["库存 ID", "商品", "本地可用", "总需求", "待发货", "待入仓", "店铺", "Ozon SKU", "Offer ID", "店铺最终备货", "备货单状态"]];
  for (const inventory of inventoryRows.value) {
    for (const item of inventory.items) lines.push([
      inventory.inventory_id, inventory.product_name, inventory.local_stock, inventory.final_qty, inventory.pending_dispatch_qty, inventory.pending_receipt_qty,
      item.order.shop_name || "", item.ozon_sku || "", item.offer_id || "", item.final_qty, statusTagText(item.order.status, item.order.received_quantity)
    ]);
  }
  const content = `\ufeff${lines.map((line) => line.map((value) => String(value ?? "").replace(/[\t\r\n]/g, " ")).join("\t")).join("\n")}`;
  const blob = new Blob([content], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `FBP库存备货汇总-${new Date().toISOString().slice(0, 10)}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
}

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
  if (status === "pending_review") return "待审核";
  if (status === "approved" || status === "ozon_created") return "待发货";
  if (status === "sent") return "运输中";
  if (status === "completed") return "已入仓";
  if (status === "cancelled") return "已取消";
  if (status === "rejected") return "已驳回";
  return status || "-";
}

function statusTagText(status, receivedQuantity = 0) {
  if (status === "sent" && Number(receivedQuantity) > 0) return "部分入仓";
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
  return ["approved", "ozon_created"].includes(String(row.status || ""));
}

function canMarkBatchSent(row) {
  return Boolean(row?._isBatchSummary)
    && Array.isArray(row._sourceOrders)
    && row._sourceOrders.some((order) => canMarkSent(order));
}

function canCancelOrder(row) {
  return String(row.status || "") === "approved";
}

function canFillOzon(row) {
  return ["approved", "sent", "ozon_created"].includes(String(row.status || ""));
}

function canMarkCompleted(row) {
  return String(row.status || "") === "sent";
}

function canMarkBatchCompleted(row) {
  return Boolean(row?._isBatchSummary)
    && Array.isArray(row._sourceOrders)
    && row._sourceOrders.some((order) => canMarkCompleted(order));
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

async function refreshOrderViews(order) {
  await loadPageData();
  if (!batchDetailDialog.visible || Number(batchDetailDialog.batch?.batch_id) !== Number(order.batch_id)) return;
  const params = new URLSearchParams({ batchId: String(order.batch_id), status: "all", page: "1", pageSize: "100" });
  const payload = await apiClient.get(`/api/fbp-replenishment-orders?${params.toString()}`);
  const updatedOrder = (payload?.rows || []).find((item) => Number(item.id) === Number(order.id));
  batchDetailDialog.orders = batchDetailDialog.orders.map((item) => Number(item.id) === Number(order.id) ? (updatedOrder || item) : item);
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

function openFbpFillResultDialog(result, itemResults = []) {
  const failures = itemResults.filter((item) => !item.success).map((item) => ({
    sku: String(item.sku || ""),
    offerId: String(item.offerId || item.offer_id || ""),
    quantity: integer(item.quantity),
    message: String(item.message || "填写失败")
  }));
  if (result?.success === false && !failures.length) {
    failures.push({ sku: "任务", offerId: "-", quantity: 0, message: String(result?.message || "插件执行失败") });
  }
  fbpFillResultDialog.summary = String(result?.message || "填写任务已结束");
  fbpFillResultDialog.successCount = itemResults.length - failures.length;
  fbpFillResultDialog.durationSeconds = integer(result?.durationSeconds);
  fbpFillResultDialog.failures = failures;
  fbpFillResultDialog.requiresReload = ["PLUGIN_CONTEXT_INVALIDATED", "PLUGIN_RUNTIME_ERROR"].includes(String(result?.error || ""))
    || /Extension context invalidated/i.test(String(result?.message || ""));
  fbpFillResultDialog.visible = true;
}

function reloadAfterPluginUpdate() {
  window.location.reload();
}

async function copyFailedFbpItems() {
  const lines = ["Ozon SKU\t数量\t商家货号\t失败原因"];
  lines.push(...fbpFillResultDialog.failures.map((item) => `${item.sku}\t${item.quantity}\t${item.offerId}\t${item.message}`));
  const copied = await copyToClipboard(lines.join("\n"));
  if (copied) ElMessage.success(`已复制 ${fbpFillResultDialog.failures.length} 个失败项目`);
  else ElMessage.error("复制失败，请在表格中手工选择失败项目");
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
      offerId: String(item.offer_id || ""),
      quantity: integer(alreadyImported ? item.final_qty : item.pending_qty)
    })).filter((item) => item.quantity > 0);
    if (!requested.length) return ElMessage.info("该关联单没有可导入的 SKU 和数量");
    const detail = requested.map((item) => `${item.sku}：${item.quantity}`).join("\n");
    try {
      await ElMessageBox.confirm(`${preview.batch.batch_no}\n\n${detail}`, alreadyImported ? "确认再次导入" : "确认导入 Ozon", { type: alreadyImported ? "warning" : "info", confirmButtonText: "确认导入" });
    } catch { return; }
    const result = await requestPluginFbpFill({
      batchId: Number(row.batch_id), batchNo: row.batch_no,
      shopId: Number(row.shop_id), shopName: String(row.shop_name || ""),
      ozonCompanyId: String(preview.batch?.ozon_company_id || row.ozon_company_id || ""), items: requested
    });
    const resultBySku = new Map((result.results || []).map((item) => [String(item.sku || ""), item]));
    const recordedResults = requested.map((item) => {
      const pluginResult = resultBySku.get(item.sku) || { success: false, message: "插件未返回该 SKU 的结果" };
      return { ...pluginResult, sku: item.sku, quantity: item.quantity };
    });
    await apiClient.post("/api/fbp-replenishment-batches/fill-results", { batch_id: row.batch_id, repeat_import: alreadyImported, results: recordedResults });
    openFbpFillResultDialog(result, recordedResults);
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
    await refreshOrderViews(row.order);
  } catch (error) {
    ElMessage.error(error.message || "保存人工调整失败");
  } finally { adjustmentDialog.submitting = false; }
}

function barcodePrintQuantity(row) {
  return Math.max(1, Math.round(Number(row?.final_qty ?? row?.approved_qty ?? row?.requested_qty ?? 0)));
}

function rowBarcodeLoadingKey(row) {
  return `${String(row?.order_id || row?.order?.id || 0)}:${String(row?.id || 0)}`;
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
    page: String(viewMode.value === "inventory" ? 1 : state.filters.page),
    pageSize: String(viewMode.value === "inventory" ? 100 : state.filters.pageSize),
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
    let rawPageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (viewMode.value === "inventory" && Number(payload?.total || 0) > rawPageRows.length) {
      const pageSize = 100;
      const pageCount = Math.ceil(Number(payload.total) / pageSize);
      const pages = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
        const params = buildParams();
        params.set("page", String(index + 2));
        return apiClient.get(`/api/fbp-replenishment-orders?${params.toString()}`);
      }));
      if (!listRequestGate.isLatest(requestToken)) return;
      rawPageRows = rawPageRows.concat(...pages.flatMap((page) => Array.isArray(page?.rows) ? page.rows : []));
    }
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
  if (status === "completed") return openReceiptDialog(row);
  const disabledReason = status === "approved" ? approveDisabledReason(row) : "";
  if (disabledReason) {
    ElMessage.warning(disabledReason);
    return;
  }
  actionLoadingId.value = actionKey(row, status);
  try {
    await apiClient.post("/api/fbp-replenishment-orders/status", { id: row.id, status });
    ElMessage.success("备货单状态已更新");
    await refreshOrderViews(row);
  } catch (error) {
    ElMessage.error(error.message || "状态更新失败");
  } finally {
    actionLoadingId.value = "";
  }
}

async function markBatchSent(row) {
  const approvedOrders = (row?._sourceOrders || []).filter((order) => canMarkSent(order));
  if (!approvedOrders.length) {
    ElMessage.info("该关联汇总中没有待标记发送的已通过备货单");
    return;
  }
  actionLoadingId.value = `batch-sent-${row.batch_id}`;
  try {
    await Promise.all(approvedOrders.map((order) => apiClient.post("/api/fbp-replenishment-orders/status", {
      id: order.id,
      status: "sent"
    })));
    ElMessage.success(`已将关联汇总中的 ${approvedOrders.length} 张备货单确认发货`);
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "关联汇总标记发送失败");
  } finally {
    actionLoadingId.value = "";
  }
}

async function markBatchCompleted(row) {
  return openReceiptDialog(row);
}

async function cancelOrder(row) {
  try {
    await ElMessageBox.confirm(
      `确认取消 ${orderDisplayName(row)}？\n取消后会保留备货单记录，并释放审核时预留的本地库存；已确认发货的记录不能直接取消。`,
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
    await refreshOrderViews(row);
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
        requested_qty: item.requested_qty
      }))
    });
    ElMessage.success("备货数量已保存");
    await refreshOrderViews(row);
  } catch (error) {
    ElMessage.error(error.message || "保存备货数量失败");
  } finally {
    actionLoadingId.value = "";
  }
}

function requestPluginFbpFill(payload) {
  const requestId = `fbp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return new Promise((resolve, reject) => {
    const connectionTimeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("未检测到插件连接。请确认已启用最新版插件，然后刷新当前 ERP 页面再试。"));
    }, 5_000);
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("插件填写超时，请检查 Ozon 页面上的执行进度"));
    }, 10 * 60 * 1000);
    function cleanup() {
      window.clearTimeout(connectionTimeoutId);
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleResponse);
    }
    function handleResponse(event) {
      if (event.source !== window || event.data?.requestId !== requestId) return;
      if (event.data?.type === "OZON_ERP_FBP_BRIDGE_ACCEPTED") {
        window.clearTimeout(connectionTimeoutId);
        return;
      }
      if (event.data?.type !== "OZON_ERP_FBP_FILL_RESPONSE") return;
      cleanup();
      resolve(event.data.response || { success: false, message: "插件没有返回执行结果" });
    }
    window.addEventListener("message", handleResponse);
    window.postMessage({ type: "OZON_ERP_FBP_FILL_REQUEST", requestId, payload }, window.location.origin);
  });
}

async function fillOrderToOzon(row) {
  const alreadyImported = (row.items || []).some((item) => Number(item.filled_qty || 0) > 0)
    || Number(row.filled_qty || 0) > 0;
  const items = (row.items || []).map((item) => ({
    sku: String(item.ozon_sku || "").trim(),
    offerId: String(item.offer_id || "").trim(),
    quantity: Math.max(1, Math.round(Number(item.final_qty || item.approved_qty || item.requested_qty || 0)))
  })).filter((item) => item.sku && item.quantity > 0);
  if (!items.length) {
    ElMessage.error("该备货单没有可填写的 Ozon SKU 和数量");
    return;
  }
  if (alreadyImported) {
    try {
      await ElMessageBox.confirm("该备货单已经填入过 Ozon。若你已删除原商品或需要覆盖数量，可以再次按当前最终数量整单填入。", "确认再次填入", { type: "warning", confirmButtonText: "再次填入", cancelButtonText: "取消" });
    } catch { return; }
  }
  actionLoadingId.value = actionKey(row, "fill-ozon");
  try {
    const result = await requestPluginFbpFill({
      orderId: Number(row.id || 0),
      orderNo: String(row.order_no || ""),
      shopId: Number(row.shop_id || 0),
      shopName: String(row.shop_name || ""),
      ozonCompanyId: String(row.ozon_company_id || ""),
      items
    });
    openFbpFillResultDialog(result, Array.isArray(result?.results) ? result.results : []);
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

async function deleteInventoryItem(item) {
  const inventory = inventoryRows.value.find((row) => row.items.some((candidate) => Number(candidate.id) === Number(item.id)));
  if (!inventory) return;
  try { await ElMessageBox.confirm(`确认不再为 ${item.order.shop_name} 的 ${item.ozon_sku} 备货？系统会保留数量变动记录。`, "取消该店铺备货", { type: "warning" }); } catch { return; }
  allocationDialog.inventory = inventory;
  allocationDialog.items = inventory.items.map((candidate) => ({ ...candidate, final_qty: Number(candidate.id) === Number(item.id) ? 0 : Number(candidate.final_qty || 0) }));
  allocationDialog.reason = "取消该店铺 SKU 备货";
  allocationDialog.saving = true;
  try { await saveInventoryAllocation(); } finally { allocationDialog.saving = false; }
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
    return true;
  } catch (error) {
    ElMessage.warning(error.message || "条码已发起打印，但打印记录保存失败，请刷新后重试");
    return false;
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

async function regenerateBarcodeLabel(row) {
  await generateBarcode(row, { refreshCache: true, forceGenerate: true });
}

async function printBarcodeLabel(row) {
  if (!ensureBarcodeTarget(row, "打印条码")) return;
  const recommended = barcodePrintQuantity(row);
  barcodePrintDialog.row = row;
  barcodePrintDialog.recommended = recommended;
  barcodePrintDialog.quantity = recommended;
  barcodePrintDialog.visible = true;
}

async function confirmBarcodePrint() {
  const row = barcodePrintDialog.row;
  if (!row || barcodePrintDialog.submitting) return;
  const quantity = Math.max(1, Math.min(999, Math.round(Number(barcodePrintDialog.quantity || 1))));
  const key = `${rowBarcodeLoadingKey(row)}:print`;
  barcodePrintDialog.quantity = quantity;
  barcodePrintDialog.submitting = true;
  barcodeLoadingKeys[key] = true;
  let preview;
  try {
    preview = openBarcodePrintWindow();
    const response = await apiClient.blobResponse("/api/products/barcode-label", {
      method: "POST",
      body: JSON.stringify({
        items: [barcodeRequestItem(row, quantity)]
      })
    });
    barcodePrintDialog.visible = false;
    preview.show(response.blob, () => {
      barcodePrintResultDialog.row = row;
      barcodePrintResultDialog.quantity = quantity;
      barcodePrintResultDialog.visible = true;
    });
  } catch (error) {
    preview?.showError(error.message || "打印条码失败，请关闭此页后重试");
    ElMessage.error(error.message || "打印条码失败");
  } finally {
    barcodePrintDialog.submitting = false;
    delete barcodeLoadingKeys[key];
  }
}

async function confirmBarcodePrintCompleted() {
  const row = barcodePrintResultDialog.row;
  if (!row || barcodePrintResultDialog.confirming) return;
  barcodePrintResultDialog.confirming = true;
  try {
    const recorded = await recordBarcodePrinted(row, barcodePrintResultDialog.quantity);
    if (!recorded) return;
    barcodePrintResultDialog.visible = false;
    ElMessage.success(`已记录打印 ${barcodePrintResultDialog.quantity} 张`);
  } finally {
    barcodePrintResultDialog.confirming = false;
  }
}

function retryBarcodePrint() {
  const row = barcodePrintResultDialog.row;
  barcodePrintResultDialog.visible = false;
  if (row) printBarcodeLabel(row);
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  state.filters.query = "";
  state.filters.shopId = "all";
  state.filters.status = "applying";
  sharedReplenishmentStatus.value = "applying";
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

watch(viewMode, () => {
  state.filters.page = 1;
  loadPageData();
});

watch(sharedReplenishmentStatus, (status) => {
  if (state.filters.status === status) return;
  state.filters.status = status;
  state.filters.page = 1;
  loadPageData();
});

onMounted(loadPageData);
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <div class="replenishment-command-bar">
      <div class="replenishment-filter-row">
        <div class="replenishment-filter-heading">
          <strong>筛选备货单</strong>
          <span>按单号、商品或店铺快速定位</span>
        </div>
        <div class="replenishment-filter-controls">
          <el-radio-group v-model="viewMode" size="small">
            <el-radio-button value="operations">运营视角</el-radio-button>
            <el-radio-button value="inventory">库存视角</el-radio-button>
          </el-radio-group>
          <el-button v-if="viewMode === 'inventory'" @click="exportInventorySummary">导出库存汇总</el-button>
          <div class="replenishment-selection">
            <span class="selection-count">已选 <strong>{{ selectedOrderIds.length }}</strong> 张</span>
            <el-button type="primary" :disabled="selectedOrderIds.length < 2" :loading="actionLoadingId === 'link-orders'" @click="linkSelectedOrders">
              创建关联汇总
            </el-button>
          </div>
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

    <div v-if="viewMode === 'inventory'" class="inventory-table-wrap replenishment-table-wrap">
      <el-table :data="inventoryRows" row-key="inventory_key" border class="erp-data-table replenishment-table">
        <el-table-column type="expand"><template #default="{ row }"><el-table :data="row.items" size="small"><el-table-column prop="order.shop_name" label="店铺" /><el-table-column prop="ozon_sku" label="Ozon SKU" /><el-table-column prop="offer_id" label="Offer ID" /><el-table-column prop="final_qty" label="最终备货" /><el-table-column label="状态"><template #default="{ row: item }">{{ statusTagText(item.order.status, item.order.received_quantity) }}</template></el-table-column><el-table-column label="操作" width="210"><template #default="{ row: item }"><el-button link type="primary" @click="openAllocationDialog(row)">修改数量</el-button><el-button link type="primary" @click="printBarcodeLabel(item)">打印面单</el-button><el-button link type="danger" @click="deleteInventoryItem(item)">删除</el-button></template></el-table-column></el-table></template></el-table-column>
        <el-table-column label="库存" min-width="300"><template #default="{ row }"><div class="product-cell"><ProductImagePreview :src="row.image_url" /><div class="cell-stack"><strong>{{ row.product_name }}</strong><span class="inventory-id-display">库存 ID：{{ row.inventory_id }}</span></div></div></template></el-table-column>
        <el-table-column label="本地可用" prop="local_stock" width="130" align="center" />
        <el-table-column label="总需求" prop="final_qty" width="130" align="center" />
        <el-table-column label="待发货" prop="pending_dispatch_qty" width="130" align="center" />
        <el-table-column label="待入仓" prop="pending_receipt_qty" width="130" align="center" />
        <el-table-column label="操作" width="210" fixed="right" align="center"><template #default="{ row }"><el-button link type="primary" @click="openAllocationDialog(row)">分配店铺数量</el-button><el-button link type="warning" @click="createInventoryProcurement(row)">创建采购需求</el-button></template></el-table-column>
      </el-table>
    </div>

    <div v-else class="inventory-table-wrap replenishment-table-wrap">
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
                  {{ row.order._isBatchSummary ? row.order.status_summary : statusTagText(row.order.status, row.order.received_quantity) }}
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
                        type="primary"
                        :disabled="Boolean(approveDisabledReason(row.order))"
                        :loading="actionLoadingId === actionKey(row.order, 'approved')"
                        @click="updateStatus(row.order, 'approved')"
                      >
                        审核通过
                      </el-button>
                    </span>
                  </el-tooltip>
                  <el-button plain
                    v-if="!row.order._isBatchSummary && canEditQuantities(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'save')"
                    @click="saveOrderItems(row.order)"
                  >
                    保存
                  </el-button>
                  <el-button plain
                    v-if="!row.order._isBatchSummary && canFillOzon(row.order) && !row.order.batch_id"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'fill-ozon')"
                    @click="fillOrderToOzon(row.order)"
                  >
                    填入 Ozon
                  </el-button>
                  <el-button plain
                    v-if="row.order._isBatchSummary"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === `fill-batch-${row.order.batch_id}`"
                    @click="fillBatchToOzon(row.order)"
                  >导入 Ozon</el-button>
                  <el-button v-if="row.order._isBatchSummary" size="default" type="primary" plain @click="openBatchDetails(row.order)">关联明细 / 修改审批</el-button>
                  <el-button
                    v-if="canMarkBatchSent(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === `batch-sent-${row.order.batch_id}`"
                    @click="markBatchSent(row.order)"
                  >确认发货</el-button>
                  <el-button
                    v-if="canMarkBatchCompleted(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === `batch-completed-${row.order.batch_id}`"
                    @click="markBatchCompleted(row.order)"
                  >确认入仓</el-button>
                  
                  <el-button
                    v-if="!row.order._isBatchSummary && canMarkSent(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'sent')"
                    @click="updateStatus(row.order, 'sent')"
                  >
                    确认发货
                  </el-button>
                  
                  <el-button
                    v-if="!row.order._isBatchSummary && canMarkCompleted(row.order)"
                    size="default"
                    type="primary"
                    :loading="actionLoadingId === actionKey(row.order, 'completed')"
                    @click="updateStatus(row.order, 'completed')"
                  >
                    确认入仓
                  </el-button>
                  
                <el-dropdown v-if="!row.order._isBatchSummary && (canCancelOrder(row.order) || row.order.batch_id || canDeleteOrder(row.order))" trigger="click">
  <el-button :disabled="Boolean(actionLoadingId)">更多 <span aria-hidden="true">⌄</span></el-button>
  <template #dropdown><el-dropdown-menu>
    <el-dropdown-item v-if="row.order.batch_id" @click="unlinkOrder(row.order)">解除关联</el-dropdown-item>
    <el-dropdown-item v-if="canCancelOrder(row.order)" @click="cancelOrder(row.order)">取消备货单</el-dropdown-item>
    <el-dropdown-item v-if="canDeleteOrder(row.order)" @click="deleteOrder(row.order)">删除备货单</el-dropdown-item>
  </el-dropdown-menu></template>
</el-dropdown></el-space>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="产品信息" min-width="330">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <strong>{{ row.product_name || "-" }}</strong><span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || "-" }}</span>
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
                <el-dropdown trigger="click"><el-button link :loading="barcodeGenerateLoading(row)">更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item @click="regenerateBarcodeLabel(row)">重新生成条码</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
                <el-button
                  class="erp-btn-link"
                  link
                  type="primary"
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

    <el-dialog v-model="allocationDialog.visible" title="按店铺分配备货数量" width="860px" destroy-on-close>
      <div v-if="allocationDialog.inventory" class="allocation-summary"><span>库存 ID：{{ allocationDialog.inventory.inventory_id }}</span><span>本地可用：{{ integer(allocationDialog.inventory.local_stock) }}</span><span>分配总数：<strong>{{ integer(allocationTotal) }}</strong></span></div>
      <el-alert type="info" :closable="false" show-icon title="所有店铺明细均可调整；系统会记录调整原因与数量变动，已进入出入库流程的变动以调整记录留痕。" />
      <el-table :data="allocationDialog.items" border size="small" class="allocation-table"><el-table-column prop="order.shop_name" label="店铺" min-width="130" /><el-table-column prop="ozon_sku" label="Ozon SKU" min-width="150" /><el-table-column prop="offer_id" label="Offer ID" min-width="150" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ statusTagText(row.order.status, row.order.received_quantity) }}</template></el-table-column><el-table-column label="分配数量" width="150"><template #default="{ row }"><el-input-number v-model="row.final_qty" :min="0" :step="1" :precision="0" :disabled="!canInventoryItemEdit(row)" /></template></el-table-column></el-table>
      <el-form label-width="90px" class="allocation-reason"><el-form-item label="调整说明"><el-input v-model="allocationDialog.reason" maxlength="500" show-word-limit placeholder="例如：本地库存不足，按店铺优先级重新分配" /></el-form-item></el-form>
      <template #footer><el-button @click="allocationDialog.visible = false">取消</el-button><el-button type="primary" :loading="allocationDialog.saving" :disabled="!allocationHasEditable" @click="saveInventoryAllocation">确认保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="receiptDialog.visible" title="确认入仓" width="min(1000px, 94vw)" append-to-body :close-on-click-modal="false" :show-close="!receiptDialog.submitting" :close-on-press-escape="!receiptDialog.submitting">
      <div v-loading="receiptDialog.loading" class="receipt-content">
        <p class="receipt-hint">按实际收到的数量填写；未收到的商品留为 0，剩余数量继续显示在途。</p>
        <el-table :data="receiptDialog.rows" max-height="460" border>
          <el-table-column prop="order_no" label="备货单" min-width="180" />
          <el-table-column label="商品 / SKU" min-width="220"><template #default="{ row }"><strong>{{ row.product_name }}</strong><div class="muted-text">{{ row.ozon_sku }}</div></template></el-table-column>
          <el-table-column prop="quantity" label="已发" width="70" />
          <el-table-column prop="listed_quantity" label="已入仓" width="80" />
          <el-table-column prop="remaining" label="剩余" width="70" />
          <el-table-column label="本次入仓" width="170"><template #default="{ row }"><el-input-number v-model="row.receive_now" :min="0" :max="row.remaining" :precision="0" controls-position="right" :disabled="receiptDialog.submitting || !row.remaining" style="width: 140px" /></template></el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button :disabled="receiptDialog.submitting" @click="receiptDialog.visible = false">关闭</el-button>
        <el-button :disabled="receiptDialog.loading || receiptDialog.submitting" @click="receiptDialog.rows.forEach(row => row.receive_now = row.remaining)">填入全部剩余数量</el-button>
        <el-button type="primary" :disabled="receiptDialog.loading || !receiptDialog.rows.length" :loading="receiptDialog.submitting" @click="submitReceipt">保存入仓数量</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="barcodePrintDialog.visible"
      title="确认打印条码"
      width="520px"
      class="barcode-print-dialog"
      :close-on-click-modal="!barcodePrintDialog.submitting"
      :close-on-press-escape="!barcodePrintDialog.submitting"
      :show-close="!barcodePrintDialog.submitting"
      destroy-on-close
    >
      <div class="barcode-print-confirmation">
        <div class="barcode-print-product">
          <ProductImagePreview :src="barcodePrintDialog.row?.image_url" />
          <div>
            <strong>{{ barcodePrintDialog.row?.product_name || "未命名商品" }}</strong>
            <span>SKU {{ barcodePrintDialog.row?.ozon_sku || "-" }}</span>
            <span>Offer {{ barcodePrintDialog.row?.offer_id || "-" }}</span>
          </div>
        </div>
        <div class="barcode-print-rule">
          <span>推荐规则</span>
          <strong>最新保存的最终备货数量</strong>
          <b>推荐 {{ integer(barcodePrintDialog.recommended) }} 张</b>
        </div>
        <el-form label-position="top">
          <el-form-item label="本次打印数量">
            <el-input-number
              v-model="barcodePrintDialog.quantity"
              :min="1"
              :max="999"
              :step="1"
              step-strictly
              controls-position="right"
            />
          </el-form-item>
        </el-form>
        <el-alert
          title="确认后将打开条码预览页，核对内容后点击打印；打印完成后请回此页确认结果。"
          type="info"
          :closable="false"
          show-icon
        />
      </div>
      <template #footer>
        <el-button :disabled="barcodePrintDialog.submitting" @click="barcodePrintDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="barcodePrintDialog.submitting" @click="confirmBarcodePrint">
          确认并打开打印
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="barcodePrintResultDialog.visible"
      title="打印结果确认"
      width="460px"
      class="barcode-print-result-dialog"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <div class="barcode-print-result">
        <div class="barcode-print-result-icon">✓</div>
        <div>
          <strong>条码是否已正常打印？</strong>
          <p>本次共 {{ integer(barcodePrintResultDialog.quantity) }} 张。点击“打印完成”后记录打印数量、时间和操作人。</p>
        </div>
      </div>
      <template #footer>
        <el-button type="danger" plain :disabled="barcodePrintResultDialog.confirming" @click="retryBarcodePrint">
          打印失败，重新打印
        </el-button>
        <el-button type="primary" :loading="barcodePrintResultDialog.confirming" @click="confirmBarcodePrintCompleted">
          打印完成
        </el-button>
      </template>
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

    <el-dialog v-model="fbpFillResultDialog.visible" title="Ozon 填写结果" width="760px" destroy-on-close>
      <div class="fbp-fill-result">
        <el-alert
          :title="fbpFillResultDialog.summary"
          :type="fbpFillResultDialog.failures.length ? 'warning' : 'success'"
          :closable="false"
          show-icon
        />
        <template v-if="fbpFillResultDialog.failures.length">
          <div class="fbp-failure-heading">
            <strong>需要人工补录 {{ fbpFillResultDialog.failures.length }} 项</strong>
            <span>成功项目已经保留，不需要重新执行整单。</span>
          </div>
          <el-table :data="fbpFillResultDialog.failures" border max-height="420" class="fbp-failure-table">
            <el-table-column prop="sku" label="Ozon SKU" width="150" />
            <el-table-column prop="quantity" label="补录数量" width="100" align="center" />
            <el-table-column prop="offerId" label="商家货号" min-width="180" show-overflow-tooltip />
            <el-table-column prop="message" label="失败原因" min-width="250" show-overflow-tooltip />
          </el-table>
        </template>
        <el-result v-else icon="success" title="全部填写成功" sub-title="请在 Ozon 页面复核商品和货位数量后继续。" />
      </div>
      <template #footer>
        <el-button @click="fbpFillResultDialog.visible = false">关闭</el-button>
        <el-button v-if="fbpFillResultDialog.requiresReload" type="primary" @click="reloadAfterPluginUpdate">刷新 ERP 页面</el-button>
        <el-button v-if="fbpFillResultDialog.failures.length" type="primary" @click="copyFailedFbpItems">复制失败清单</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDetailDialog.visible" :title="`关联明细 · ${batchDetailDialog.batch?.batch_no || ''}`" width="96vw" top="4vh" destroy-on-close>
      <el-alert title="关联后仍按原单审批：审核前修改数量后点击保存，再由非申请人审核通过；审核后使用人工调整并填写原因。" type="info" :closable="false" show-icon />
      <div v-loading="batchDetailDialog.loading" class="batch-detail-list">
        <el-table v-if="batchDetailRows.length" :data="batchDetailRows" :span-method="tableSpanMethod" border class="erp-data-table replenishment-table batch-detail-table">
          <el-table-column label="备货单" min-width="260">
            <template #default="{ row }"><div class="order-cell"><div class="shop-banner">{{ row.order.shop_name || "未命名店铺" }}</div><div class="order-line"><span class="order-label">备货单号</span><strong class="order-title">{{ orderDisplayName(row.order) }}</strong></div><div class="order-line"><span class="order-label">创建时间</span><span class="order-value">{{ dateText(row.order.created_at) }}</span></div><div class="order-line"><span class="order-label">状态</span><el-tag :type="statusType(row.order.status)" effect="light">{{ statusTagText(row.order.status, row.order.received_quantity) }}</el-tag></div><div class="order-line"><span class="order-label">总览</span><div class="order-summary"><span>SKU {{ integer(row.order.item_count) }}</span><span>申请 {{ integer(row.order.total_requested_qty) }}</span><span>通过 {{ integer(row.order.total_approved_qty) }}</span><span>最终 {{ integer(row.order.total_final_qty) }}</span></div></div><div class="order-line"><span class="order-label">操作</span><el-space wrap class="order-actions" :size="8">
                  <el-button plain v-if="canEditQuantities(row.order)" type="primary" :loading="actionLoadingId === actionKey(row.order, 'save')" @click="saveOrderItems(row.order)">保存数量</el-button>
                  <el-tooltip v-if="canApprove(row.order)" :disabled="!approveDisabledReason(row.order)" :content="approveDisabledReason(row.order)" placement="top">
                    <span><el-button type="primary" :disabled="Boolean(approveDisabledReason(row.order))" :loading="actionLoadingId === actionKey(row.order, 'approved')" @click="updateStatus(row.order, 'approved')">审核通过</el-button></span>
                  </el-tooltip>
                  <el-button v-if="canMarkSent(row.order)" type="primary" :loading="actionLoadingId === actionKey(row.order, 'sent')" @click="updateStatus(row.order, 'sent')">确认发货</el-button>
                  <el-button v-if="canMarkCompleted(row.order)" type="primary" :loading="actionLoadingId === actionKey(row.order, 'completed')" @click="updateStatus(row.order, 'completed')">确认入仓</el-button>
                  
                  
                <el-dropdown v-if="!row.order._isBatchSummary && (canCancelOrder(row.order) || row.order.batch_id || canDeleteOrder(row.order))" trigger="click">
  <el-button :disabled="Boolean(actionLoadingId)">更多 <span aria-hidden="true">⌄</span></el-button>
  <template #dropdown><el-dropdown-menu>
    <el-dropdown-item v-if="row.order.batch_id" @click="unlinkOrder(row.order)">解除关联</el-dropdown-item>
    <el-dropdown-item v-if="canCancelOrder(row.order)" @click="cancelOrder(row.order)">取消备货单</el-dropdown-item>
    <el-dropdown-item v-if="canDeleteOrder(row.order)" @click="deleteOrder(row.order)">删除备货单</el-dropdown-item>
  </el-dropdown-menu></template>
</el-dropdown></el-space></div></div></template>
          </el-table-column>
          <el-table-column label="产品信息" min-width="330"><template #default="{ row }"><div class="product-cell"><ProductImagePreview :src="row.image_url" /><div class="cell-stack"><strong>{{ row.product_name || "-" }}</strong><span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || "-" }}</span><span class="muted-text">SKU {{ row.ozon_sku || "-" }}</span><span class="muted-text">Offer {{ row.offer_id || "-" }}</span></div></div></template></el-table-column>
          <el-table-column label="销量" width="145" align="center"><template #default="{ row }"><div class="metric-stack"><strong>30天 {{ integer(row.recent_30d_qty) }}</strong><span>7天 {{ integer(row.recent_7d_qty) }}</span><span>三周 {{ salesText(row) }}</span></div></template></el-table-column>
          <el-table-column label="FBP库存" width="125" align="center"><template #default="{ row }"><div class="metric-stack"><strong>当前 {{ integer(row.fbp_stock) }}</strong><span>在途 {{ integer(row.fbp_in_transit) }}</span><span>有效 {{ integer(row.fbp_effective_stock) }}</span></div></template></el-table-column>
          <el-table-column label="本地库存" width="130" align="center"><template #default="{ row }"><div class="metric-stack"><strong>本地 {{ integer(row.local_stock) }}</strong><span>FBS {{ integer(row.fbs_stock) }}</span><span>采购中 {{ integer(row.purchase_pending_qty) }}</span></div></template></el-table-column>
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
            <el-table-column label="打印" width="220" align="center">
              <template #default="{ row }">
                <el-space wrap :size="6" class="barcode-actions">
                  <el-dropdown trigger="click"><el-button link :loading="barcodeGenerateLoading(row)">更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item @click="regenerateBarcodeLabel(row)">重新生成条码</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
                  <el-button link type="primary" :loading="barcodePrintLoading(row)" @click="printBarcodeLabel(row)">打印</el-button>
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
  flex: 0 0 auto;
  gap: 0;
  margin-bottom: 18px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
}

.replenishment-selection {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 10px;
  border-right: 1px solid #e2e8f0;
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

.replenishment-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 20px;
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
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.replenishment-table-wrap :deep(.replenishment-table) {
  height: 100%;
}

.inventory-page-shell > :deep(.page-footer-pagination) {
  flex: 0 0 auto;
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
  padding: 2px 0 6px;
  border-bottom: 1px solid #e2e8f0;
  color: #0f172a;
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
  grid-template-columns: 56px minmax(0, 1fr);
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

.fbp-fill-result { display: grid; gap: 16px; }
.fbp-failure-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fbp-failure-heading strong { color: #b45309; }
.fbp-failure-heading span { color: #64748b; font-size: 12px; }
.fbp-failure-table { width: 100%; }

@media (max-width: 1280px) {
  .replenishment-filter-row { align-items: stretch; flex-direction: column; gap: 12px; }
  .replenishment-filter-controls { justify-content: flex-start; flex-wrap: wrap; }
  .replenishment-search { width: min(100%, 420px); }
}

@media (max-width: 720px) {
  .replenishment-filter-row { padding-inline: 14px; }
  .replenishment-filter-controls { display: grid; grid-template-columns: 1fr 1fr; }
  .replenishment-selection { grid-column: 1 / -1; justify-content: space-between; padding-right: 0; padding-bottom: 10px; border-right: 0; border-bottom: 1px solid #e2e8f0; }
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
  color: #64748b;
}

.barcode-print-confirmation {
  display: grid;
  gap: 18px;
}

.barcode-print-product {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
}

.barcode-print-product > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.barcode-print-product strong {
  color: #0f172a;
  line-height: 1.45;
}

.barcode-print-product span {
  color: #64748b;
  font-size: 12px;
}

.barcode-print-rule {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  color: #4338ca;
  background: #eef2ff;
}

.barcode-print-rule span { font-size: 12px; }
.barcode-print-rule strong { font-size: 14px; }
.barcode-print-rule b { font-size: 16px; }
.barcode-print-confirmation :deep(.el-form-item) { margin-bottom: 0; }
.barcode-print-confirmation :deep(.el-input-number) { width: 100%; }

.barcode-print-result {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: start;
  gap: 14px;
}

.barcode-print-result-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  color: #fff;
  background: #16a34a;
  font-size: 24px;
  font-weight: 800;
}

.barcode-print-result strong {
  color: #0f172a;
  font-size: 17px;
}

.barcode-print-result p {
  margin: 8px 0 0;
  color: #64748b;
  line-height: 1.65;
}


.order-line:has(.order-actions) { display: block; padding-top: 6px; }
.order-line:has(.order-actions) > .order-label { display: none; }
.order-line > .el-tag { justify-self: start; }
.order-actions :deep(.el-button) { height: 32px; padding: 0 12px; border-radius: 6px; font-weight: 500; box-shadow: none; }
.order-actions :deep(.el-button--primary) { --el-color-primary: #2563eb; --el-color-primary-light-3: #60a5fa; --el-color-primary-light-9: #eff6ff; --el-color-primary-dark-2: #1d4ed8; }
.receipt-hint { margin: 0 0 16px; color: #64748b; line-height: 1.6; }
</style>
