<script setup>
import { computed, ref } from "vue";
import { CopyDocument, View } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { copyToClipboard } from "../../admin/utils/clipboard.js";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  markOptions: { type: Array, default: () => [] },
  selectedIds: { type: Object, default: () => new Set() },
  allSelected: { type: Boolean, default: false },
  someSelected: { type: Boolean, default: false },
  confirmingInboundRecordId: { type: Number, default: 0 },
  // Keep the table height tied to the flex layout instead of a viewport
  // max-height so the last row does not slide under the footer pagination.
  tableHeight: { type: [String, Number], default: "100%" }
});

const emit = defineEmits([
  "toggle-all",
  "toggle-row",
  "open-profit",
  "prepare-order",
  "split-order",
  "print-order",
  "save-mark",
  "open-bind-product-from-order",
  "edit-inventory-product",
  "open-product-components",
  "view-product-components",
  "open-create-product-from-order",
  "open-order-procurement",
  "view-procurement-details",
  "review-procurement-records",
  "view-inventory-detail",
  "confirm-procurement-inbound"
]);

const markChoices = computed(() => (
  (props.markOptions || []).filter((item) => item && item.value !== undefined)
));

const selectableMarkChoices = computed(() => (
  markChoices.value.filter((item) => item.value)
));

const markLabelMap = computed(() => (
  new Map(markChoices.value.map((item) => [String(item.value || ""), item.label || ""]))
));

const markMenu = ref({
  visible: false,
  rowId: null,
  top: 0,
  left: 0
});

function parseDateValue(value, assumeUtcWhenNaive = false) {
  if (!value) return "-";
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = assumeUtcWhenNaive && !hasTimezone
    ? `${text.replace(" ", "T")}Z`
    : text;
  return new Date(normalized);
}

function formatDateTime(value, options = {}) {
  if (!value) return "-";
  const date = parseDateValue(value, Boolean(options.assumeUtcWhenNaive));
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19).replace("T", " ");
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")} ${valueOf("hour")}:${valueOf("minute")}:${valueOf("second")}`;
}

function formatPrintDateTime(value) {
  return formatDateTime(value, { assumeUtcWhenNaive: true });
}

function formatPrintDateParts(value) {
  const text = formatPrintDateTime(value);
  if (text === "-") return { date: "-", time: "" };
  const [date, time] = text.split(" ");
  return { date: date || text, time: time || "" };
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

async function copyText(value) {
  const text = String(value || "").trim();
  if (!text) return;
  const copied = await copyToClipboard(text);
  if (copied) {
    ElMessage.success("已复制");
    return;
  }
  ElMessage.warning("复制失败，请检查浏览器权限");
}

function openExternalLink(url) {
  const target = String(url || "").trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function resolveOzonLink(item) {
  const direct = String(item?.productLink || "").trim();
  if (direct) return direct;
  const productId = String(item?.ozonProductId || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
}

function resolveOzonPostingLink(row) {
  const postingNumber = String(row?.posting_number || row?.order_number || "").trim();
  if (!postingNumber) return "";
  const query = new URLSearchParams({
    tab: "all",
    postingNumber,
    postingDetails: postingNumber
  });
  return `https://seller.ozon.ru/app/postings/crossborder/fbs?${query.toString()}`;
}

function closeMarkMenu() {
  markMenu.value = {
    visible: false,
    rowId: null,
    top: 0,
    left: 0
  };
}

function openMarkMenu(orderId, event) {
  const trigger = event?.currentTarget;
  if (!trigger?.getBoundingClientRect) return;
  const rect = trigger.getBoundingClientRect();
  const panelWidth = 190;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const preferredLeft = rect.right + 12;
  const maxLeft = Math.max(12, viewportWidth - panelWidth - 12);
  const left = Math.max(12, Math.min(preferredLeft, maxLeft));
  const top = Math.max(12, Math.min(rect.top, viewportHeight - 260));
  markMenu.value = {
    visible: true,
    rowId: Number(orderId),
    top,
    left
  };
}

function applyMark(markType) {
  if (!markMenu.value.rowId) return;
  emit("save-mark", markMenu.value.rowId, markType);
  closeMarkMenu();
}

function statusTagType(color) {
  if (color === "amber") return "warning";
  if (color === "blue") return "primary";
  if (color === "red") return "danger";
  if (color === "green" || color === "teal") return "success";
  return "info";
}

function rowSelected(row) {
  return props.selectedIds instanceof Set ? props.selectedIds.has(Number(row.id)) : false;
}

function orderRowClassName({ row }) {
  return row?.profitSummary?.alertLevel ? "is-low-profit-order" : "";
}

function markValue(row) {
  return String(row.mark_type || "");
}

function markTone(value) {
  return {
    quality: "red",
    urgent: "red",
    follow: "orange",
    issue: "yellow",
    solved: "green",
    vip: "cyan",
    special: "purple",
    other: "gray"
  }[String(value || "")] || "none";
}

function markLabel(value) {
  return markLabelMap.value.get(String(value || "")) || "无标记";
}

function orderTitleParts(row) {
  return Array.isArray(row?.orderTitleParts) ? row.orderTitleParts : [];
}

function hasEnoughLocalStock(row) {
  const products = Array.isArray(row?.inventorySummaries) ? row.inventorySummaries : [];
  if (!products.length) return false;
  return products.every((product) => Number(product.stock?.local || 0) >= Math.max(1, Number(product.quantity || 1)));
}

function isInboundReceiptPending(row) {
  const id = Number(props.confirmingInboundRecordId || 0);
  return id > 0 && (Number(row?.procurementState?.inboundRecordId || 0) === id
    || (row?.procurement_coverage?.batches || []).some(batch => Number(batch.id) === id));
}

function hasProcurementIncoming(row) {
  const state = row?.procurementState;
  return !isFbpOrder(row) && Boolean(state?.hasOrderIncoming)
    && Number(state?.inboundDetails?.quantity || 0) > 0;
}

function isFbpOrder(row) {
  if (row?.procurement_coverage?.stock_location === "FBP" || row?.fulfillment_type_key === "fbp") return true;
  const text = [
    row?.logisticsSummary?.deliveryMethodLabel,
    row?.logisticsSummary?.resolvedRuleName,
    row?.logisticsSummary?.warehouse,
    row?.delivery_method_name,
    row?.delivery_method,
    row?.shipping_method,
    row?.logistics_channel
  ].map((item) => String(item || "").toLowerCase()).join(" ");
  return text.includes("fbp")
    || text.includes("hunchun")
    || text.includes("hun chun")
    || text.includes("珲春")
    || text.includes("混春")
    || text.includes("混川");
}

function procurementActionLabel(row) {
  const coverage = row.procurement_coverage;
  if (coverage?.quantity_needs_review) return '已采购 · 数量待核';
  if (coverage?.shortage_quantity > 0) return `待采购（缺 ${coverage.shortage_quantity}）`;
  if (coverage?.incoming_quantity > 0) return '采购在途';
  if (coverage?.needs_fulfillment) return '账面可覆盖';
  const detail = String(row?.procurementState?.detail || "");
  if (hasEnoughLocalStock(row)) return "有库存";
  if (row?.procurementState?.overdue && hasProcurementIncoming(row)) return `在途超${Math.max(3, Number(row.procurementState.inTransitDays || 0))}天`;
  if (hasProcurementIncoming(row)) return "采购在途";
  if (isFbpOrder(row)) return "有库存";
  if (row?.procurementState?.handled && detail.includes("库存可满足")) return "有库存";
  return "待采购";
}

function procurementActionClass(row) {
  if (row?.procurementState?.overdue && hasProcurementIncoming(row)) return "orders-inline-accent-button-danger-soft";
  const label = procurementActionLabel(row);
  return label === "有库存"
    || label === "采购在途"
    || label === "账面可覆盖"
    ? "orders-inline-accent-button-success"
    : "orders-inline-accent-button-danger-soft";
}

function procurementTimeText(row) {
  const value = row?.procurementState?.latestPurchaseAt;
  return value ? formatDateTime(value, { assumeUtcWhenNaive: true }) : "";
}
</script>

<template>
  <el-card shadow="never" class="orders-table-card">
    <div class="mobile-landscape-hint">订单信息较多，横屏查看更完整；表格可左右滑动。</div>
    <el-table
      :data="rows"
      :height="tableHeight"
      stripe
      border
      class="orders-table"
      table-layout="fixed"
      empty-text="当前筛选下暂无订单"
      :row-class-name="orderRowClassName"
    >
      <el-table-column width="54" fixed="left" align="center">
        <template #header>
          <el-checkbox
            :model-value="allSelected"
            :indeterminate="someSelected"
            @change="emit('toggle-all', $event)"
          />
        </template>
        <template #default="{ row }">
          <el-checkbox
            :model-value="rowSelected(row)"
            @change="emit('toggle-row', row.id, $event)"
          />
        </template>
      </el-table-column>

      <el-table-column label="标记" width="78" fixed="left" align="center">
        <template #default="{ row }">
          <div class="orders-mark-cell">
            <button type="button" class="orders-mark-pill" :title="markLabel(markValue(row))" @click="openMarkMenu(row.id, $event)">
              <span v-if="markValue(row)" class="orders-mark-dot" :class="`is-${markTone(markValue(row))}`" />
              <span v-else class="orders-mark-pencil-ring">
                <span class="orders-mark-pencil-icon" />
              </span>
            </button>
            <div v-if="row.printedState" class="orders-print-state orders-print-state-mark">
              <b>已打印</b>
              <span v-if="row.printed_at" class="orders-print-time">
                <span class="orders-print-time-date">{{ formatPrintDateParts(row.printed_at).date }}</span>
                <span class="orders-print-time-clock">{{ formatPrintDateParts(row.printed_at).time }}</span>
              </span>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="订单信息" min-width="180" fixed="left">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-cell-title orders-posting-emphasis orders-order-title">
              <a
                v-if="resolveOzonPostingLink(row)"
                class="orders-posting-link"
                :href="resolveOzonPostingLink(row)"
                target="_blank"
                rel="noopener noreferrer"
                :title="`打开 Ozon 订单 ${row.posting_number || row.order_number || ''}`"
                @click.prevent.stop="openExternalLink(resolveOzonPostingLink(row))"
              >
                <span
                  v-for="(part, index) in orderTitleParts(row)"
                  :key="`${row.id}-title-${index}`"
                  :class="{ 'is-strong': part.strong }"
                >
                  {{ part.text }}
                </span>
              </a>
              <template v-else>
                <span
                  v-for="(part, index) in orderTitleParts(row)"
                  :key="`${row.id}-title-${index}`"
                  :class="{ 'is-strong': part.strong }"
                >
                  {{ part.text }}
                </span>
              </template>
            </div>
            <el-tag v-if="row.qualityCheckOrder" class="orders-quality-check-tag" type="danger" size="small" effect="light">质检单</el-tag>
            <el-tag v-else-if="row.passportMissingOrder" class="orders-quality-check-tag" type="warning" size="small" effect="light">未提供护照</el-tag>
            <div class="orders-order-quantity">
              <span>数量</span>
              <span class="orders-item-quantity" :class="{ 'is-multi': Number(row.quantitySummary || 0) > 1 }">
                x{{ Number(row.quantitySummary || 0) || 1 }}
              </span>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="店铺" min-width="128">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-cell-title">{{ row.shop_name || "--" }}</div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="124" align="center">
        <template #default="{ row }">
          <div class="orders-cell-stack orders-cell-center orders-status-cell">
            <el-tag effect="light" :type="statusTagType(row.statusColor)">{{ row.statusLabel }}</el-tag>
            <div
              v-if="row.statusDeadlineHint"
              class="orders-status-deadline"
              :class="{ 'is-danger': row.statusDeadlineHint.startsWith('超时') }"
            >
              {{ row.statusDeadlineHint }}
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="商品信息" min-width="300">
        <template #default="{ row }">
          <div class="orders-goods-list">
            <div v-for="item in row.productDisplayRows" :key="`${row.id}-${item.sku}`" class="orders-goods-item">
              <div class="orders-thumb-wrap">
                <div class="orders-thumb">
                  <el-image
                    v-if="item.imageUrl"
                    :src="item.imageUrl"
                    :preview-src-list="[item.imageUrl]"
                    preview-teleported
                    lazy
                    fit="contain"
                    class="orders-thumb-image"
                  />
                  <div v-else class="orders-thumb-empty">无图</div>
                </div>
              </div>
              <div class="orders-product-copy">
                <a
                  v-if="resolveOzonLink(item)"
                  class="orders-product-link orders-product-name"
                  :href="resolveOzonLink(item)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="item.name"
                  @click.prevent.stop="openExternalLink(resolveOzonLink(item))"
                >
                  {{ item.name }}
                </a>
                <div v-else class="orders-cell-title orders-product-name">{{ item.name }}</div>
                <div class="orders-sku-row">
                  <span class="orders-cell-meta-line">SKU: {{ item.sku }}</span>
                  <span class="orders-item-quantity" :class="{ 'is-multi': Number(item.quantity || 0) > 1 }">
                    x{{ Number(item.quantity || 0) || 1 }}
                  </span>
                  <el-tooltip content="复制 SKU" placement="top">
                    <button type="button" class="orders-icon-button" aria-label="复制 SKU" @click="copyText(item.sku)">
                      <el-icon><CopyDocument /></el-icon>
                    </button>
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="利润" min-width="188" align="left">
        <template #default="{ row }">
          <div class="orders-cell-stack orders-money-cell">
            <div class="orders-cell-meta-line">金额: {{ row.amountText }}</div>
            <div
              class="orders-cell-meta-line"
              :class="{ 'orders-low-profit-value': row.profitSummary.effectiveType === 'estimated' && row.profitSummary.alertLevel }"
            >
              预计: CNY {{ formatMoney(row.profitSummary.estimated) }}
            </div>
            <div class="orders-cell-meta-line">
              真实:
              <span
                v-if="row.profitSummary.hasActual"
                :class="{ 'orders-low-profit-value': row.profitSummary.effectiveType === 'actual' && row.profitSummary.alertLevel }"
              >CNY {{ formatMoney(row.profitSummary.actual) }}</span>
              <span v-else>--</span>
            </div>
            <el-tag
              v-if="row.profitSummary.alertLevel"
              class="orders-low-profit-tag"
              type="danger"
              size="small"
              effect="light"
            >
              {{ row.profitSummary.alertLevel === "loss" ? "亏损" : "低利润" }}
            </el-tag>
            <div v-if="Number(row.productDisplayRows?.length || 0) > 1" class="orders-profit-merge-hint">
              已按 {{ Number(row.productDisplayRows?.length || 0) }} 个商品分别计算后汇总
            </div>
            <el-tooltip content="查看利润详情" placement="top">
              <el-button
                class="orders-inline-accent-button orders-inline-accent-button-secondary orders-profit-detail-button orders-icon-button-el is-view"
                size="small"
                aria-label="查看利润详情"
                @click="emit('open-profit', row.id)"
              >
                <el-icon><View /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="下单时间" min-width="196">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-cell-meta-line orders-time-line">下单: {{ formatDateTime(row.ordered_at) }}</div>
            <div class="orders-cell-meta-line orders-time-line">更新: {{ formatDateTime(row.updated_at) }}</div>
            <div class="orders-cell-meta-line orders-time-line" :class="{ 'orders-text-danger': row.logisticsSummary.overdue }">
              截止: {{ formatDateTime(row.logisticsSummary.deadline) }}
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="物流信息" min-width="220">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-delivery-main orders-delivery-main-compact">{{ row.logisticsSummary.deliveryMethodLabel || "FBS" }}</div>
            <div class="orders-cell-meta-line orders-logistics-warehouse">Ozon: {{ row.logisticsSummary.ozonMethodName || "--" }}</div>
            <div class="orders-cell-meta-line orders-logistics-warehouse">{{ row.logisticsSummary.ruleSourceLabel }}: {{ row.logisticsSummary.resolvedRuleName || "--" }}</div>
            <div v-if="row.logisticsSummary.shipmentNumber" class="orders-logistics-id-row">
              <span>货件: {{ row.logisticsSummary.shipmentNumber }}</span>
              <el-tooltip content="复制货件号" placement="top">
                <button type="button" class="orders-icon-button" aria-label="复制货件号" @click="copyText(row.logisticsSummary.shipmentNumber)">
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </el-tooltip>
            </div>
            <div v-if="row.logisticsSummary.trackingNumber" class="orders-logistics-id-row">
              <a
                v-if="row.logisticsSummary.trackingLink"
                class="orders-tracking-link"
                :href="row.logisticsSummary.trackingLink"
                target="_blank"
                rel="noopener noreferrer"
              >
                追踪: {{ row.logisticsSummary.trackingNumber }}
              </a>
              <span v-else>追踪: {{ row.logisticsSummary.trackingNumber }}</span>
              <el-tooltip content="复制追踪号" placement="top">
                <button type="button" class="orders-icon-button" aria-label="复制追踪号" @click="copyText(row.logisticsSummary.trackingNumber)">
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </el-tooltip>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="库存信息" min-width="240">
        <template #header>
          <span>库存信息</span>
          <el-popover trigger="click" placement="bottom" :width="340">
            <template #reference><el-button link type="primary" size="small">数量说明</el-button></template>
            <p><strong>本单需求</strong>只表示这一笔订单。同一商品两单各需 1 件，合计需求是 2 件。</p>
            <p><strong>账面余额</strong>是系统已记账出入库后的余额，包含已记账的订单扣减。同一商品会在多行重复展示这一余额，不能相加，也不要再减一次已扣订单的需求。</p>
            <p><strong>商品总在途</strong>是商品全部待入库数量；<strong>已占用</strong>是已按时间分给更早订单的数量；<strong>当前可分配</strong>才是还能给新订单使用的在途数量。</p>
            <p><strong>账面分配</strong>是系统分配给本单的数量；<strong>在途分配</strong>是已采购未入库、分配给本单的数量。它们与账面余额的口径不同。</p>
            <p>例如，两单各扣 1 件后账面还剩 1 件，这个 1 是扣后余额，不能再算成 1 − 2。</p>
            <p><strong>账面可覆盖不等于实物已核实。</strong>若实际找不到货，请核对入库、退货和盘点记录。组合商品按子产品数量换算。</p>
          </el-popover>
        </template>
        <template #default="{ row }">
          <div class="orders-stock-list">
            <div
              v-for="product in row.inventorySummaries"
              :key="`${row.id}-inventory-${product.inventoryKey || product.productId}`"
              class="orders-inventory-item orders-inventory-item-plain"
            >
              <small class="orders-stock-product-name orders-product-name">{{ product.productName }}</small>
              <strong v-if="product.inventoryMode !== 'combo'">库存编号：{{ product.inventoryNumber || "待补核心品名" }}</strong>
              <small v-else>库存编号：见子产品明细</small>
              <el-button v-if="product.productId && product.inventoryMode !== 'combo'" link type="primary" size="small" @click="emit('view-inventory-detail', row, product.productId)">明细</el-button>
              <div class="orders-stock-inline-facts">
                <span>FBP: {{ product.stock?.fbp || 0 }}</span>
                <el-tooltip content="已计入已记账的出入库和订单扣减，不是实物盘点数；详见表头“数量说明”。" placement="top">
                  <span>{{ product.inventoryMode === "combo" || Number(product.componentCount || 0) > 0 ? "账面可组余量" : "本地账面余额" }}: {{ product.stock?.local || 0 }}</span>
                </el-tooltip>
                <span>商品总在途: {{ Number(product.incoming || 0) }}</span>
              </div>
              <div class="orders-inline-actions orders-inline-actions-compact">
                <el-button
                  v-if="product.sku"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-secondary"
                  @click="emit('open-bind-product-from-order', row.id, product.sku)"
                >
                  修改绑定
                </el-button>
                <el-button
                  v-if="Number(product.productId || 0) > 0"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-secondary"
                  @click="emit('edit-inventory-product', product.productId)"
                >
                  编辑库存
                </el-button>
                <el-button
                  v-if="product.inventoryMode === 'single' && Number(product.productId || 0) > 0"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-secondary"
                  @click="emit('open-product-components', product.productId)"
                >
                  绑定子产品
                </el-button>
                <el-popover v-if="product.pickingItems?.length" trigger="click" placement="left" :width="560">
                  <template #reference>
                    <el-button size="small" class="orders-inline-accent-button orders-inline-accent-button-secondary">
                      查看子产品（{{ product.pickingItems.length }}）
                    </el-button>
                  </template>
                  <strong>子产品拣货明细</strong>
                  <el-table :data="product.pickingItems" size="small">
                    <el-table-column prop="product_name" label="库存产品名称" min-width="180" />
                    <el-table-column label="库存编号" width="110">
                      <template #default="{ row: part }"><strong>{{ part.inventory_number || '待补核心品名' }}</strong></template>
                    </el-table-column>
                    <el-table-column prop="per_set_quantity" label="每套数量" width="85" />
                    <el-table-column label="库存明细" width="95"><template #default="{ row: part }"><el-button v-if="part.product_id" link type="primary" @click="emit('view-inventory-detail', row, part.product_id)">明细</el-button></template></el-table-column>
                    <el-table-column label="本单需拣" width="100">
                      <template #default="{ row: part }">{{ part.required_quantity }} {{ part.stock_unit }}</template>
                    </el-table-column>
                  </el-table>
                  <el-button v-if="product.inventoryMode === 'single'" link type="primary" @click="emit('view-product-components', product.productId)">查看子产品库存详情</el-button>
                </el-popover>
              </div>
            </div>
            <div
              v-for="item in row.unboundItems"
              :key="`${row.id}-unbound-${item.sku}`"
              class="orders-inventory-item orders-inventory-item-plain is-warning"
            >
              <small class="orders-stock-product-name orders-product-name">{{ item.name }}</small>
              <div class="orders-stock-inline-facts">
                <span>FBP: {{ item.stock?.fbp || 0 }}</span>
                <span>本地: 未绑定</span>
              </div>
              <div class="orders-inline-actions orders-inline-actions-compact">
                <el-button
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-secondary"
                  @click="emit('open-bind-product-from-order', row.id, item.sku)"
                >
                  绑定库存
                </el-button>
                <el-button
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-primary"
                  @click="emit('open-create-product-from-order', row.id, item.sku)"
                >
                  创建库存
                </el-button>
              </div>
            </div>
            <div v-if="row.procurement_coverage && !isFbpOrder(row)" class="orders-coverage-summary">
              <small v-for="item in row.procurement_coverage.items" :key="`${item.order_item_id}-${item.product_id}`">
                <template v-if="row.procurement_coverage.items.length > 1">{{ item.product_name || '未绑定商品' }}：</template>本单需求 {{ item.quantity }} {{ item.unit }}
                <template v-if="row.procurement_coverage.needs_fulfillment && row.procurement_coverage.stock_location !== 'FBP'"><br />商品总在途 {{ item.product_total_incoming_quantity }} · 已占用 {{ item.product_reserved_incoming_quantity }} · 当前可分配 {{ item.product_available_incoming_quantity }}<br />账面分配 {{ item.stock_quantity }} · 在途分配 {{ item.incoming_quantity }} · {{ item.quantity_needs_review ? '数量待核' : `待采购 ${item.shortage_quantity}` }}</template>
              </small>

              <small v-if="row.procurement_coverage.inventory_needs_review">账面差额待核，不计入本次采购缺口。</small>
              <small v-if="row.procurement_coverage.quantity_needs_review">已采购但数量待核，请先核对采购凭据，避免重复购买。</small>
              <small v-if="row.procurement_coverage.missing_amount">采购金额待补，成本记录尚不完整。</small>
              <small v-if="row.procurement_coverage.missing_record_quantity > 0">已发订单有 {{ row.procurement_coverage.missing_record_quantity }} 件历史库存来源待核对，不新增采购需求。</small>
              <el-button v-if="row.procurement_coverage.missing_record_quantity > 0 || row.procurement_coverage.missing_amount || row.procurement_coverage.quantity_needs_review" size="small" link type="warning" @click="emit('review-procurement-records', row)">采购明细</el-button>
            </div>
            <div
              v-if="hasProcurementIncoming(row)"
              class="orders-procurement-transparency"
              :class="{ 'is-overdue': row.procurementState.overdue }"
            >
              <strong>
                {{ row.procurementState.inboundDetails?.personName || "未记录" }}
                · 关联采购总量 {{ row.procurementState.purchaseSummary || '待核对' }}
                <template v-if="row.procurement_coverage?.entered_transport"> · 历史库存来源待核对</template>
                <template v-else> · 等待{{ Number(row.procurementState.inTransitDays || 0) }}天</template>
              </strong>
              <small>下单时间：{{ procurementTimeText(row) || "待补充" }}</small>
              <div class="orders-procurement-actions">
                <el-button size="small" link type="primary" @click="emit('view-procurement-details', row)">
                  查看采购内容
                </el-button>
                <el-button
                  v-if="row.procurementState.canRegisterOrderReceipt"
                  size="small"
                  :type="row.procurementState.overdue ? 'danger' : 'success'"
                  plain
                  :loading="isInboundReceiptPending(row)"
                  :disabled="Number(confirmingInboundRecordId || 0) > 0"
                  @click="emit('confirm-procurement-inbound', row)"
                >
                  {{ row.procurement_coverage?.entered_transport ? '核对库存来源' : '登记实收' }}
                </el-button>
                <small v-else-if="Number(row.procurementState.inboundRecordCount || 0) > 1">
                  多个批次，请到采购页确认
                </small>
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="归类 / 具体原因" min-width="250">
        <template #default="{ row }">
          <div class="orders-cancel-cell">
            <strong v-if="row.cancelCategoryText !== '--'">{{ row.cancelCategoryText }}</strong>
            <small v-else>--</small>
            <span v-if="row.cancelReasonText !== '--'">具体原因：{{ row.cancelReasonText }}</span>
            <small v-if="row.cancelInitiatorText">{{ row.cancelInitiatorText }}</small>
            <small v-if="row.cancelReasonMeta">{{ row.cancelReasonMeta }}</small>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="210" fixed="right">
        <template #default="{ row }">
          <div class="orders-actions-cell orders-actions-cell-vertical">
            <template v-if="row.procurement_coverage?.entered_transport && !isFbpOrder(row)">
              <template v-for="item in row.procurement_coverage.items" :key="`history-${item.order_item_id}-${item.product_id}`">
                <el-button v-if="item.missing_purchase_quantity > 0 || item.missing_receipt_quantity > 0" size="small" type="warning" plain @click="emit('view-inventory-detail', row, item.product_id)">
                  {{ item.missing_purchase_quantity > 0 ? '补采购记录' : '核对历史收货' }}{{ row.procurement_coverage.items.length > 1 ? ' · ' + item.product_name : '' }}
                </el-button>
              </template>
            </template>
            <el-tag v-if="isFbpOrder(row)" type="success" size="small">官方仓履约 · 无需采购</el-tag>
            <el-button
              v-if="row.availableActions.showPurchase && !isFbpOrder(row) && !row.procurement_coverage?.entered_transport"
              size="small"
              class="orders-inline-accent-button"
              :class="procurementActionClass(row)"
              @click="emit('open-order-procurement', row.id)"
            >
              {{ procurementActionLabel(row) }}
            </el-button>
            <el-button
              v-if="row.availableActions.showPrepare"
              size="small"
              class="orders-inline-accent-button orders-inline-accent-button-primary"
              @click="emit('prepare-order', row.id)"
            >
              备货
            </el-button>
            <el-tooltip
              v-if="row.availableActions.showSplitPrepare"
              :content="row.availableActions.splitPrepare ? '按商品数量拆分多个包裹后备货' : '订单已经备货并进入等待发货，Ozon 不允许撤回后重新拆分'"
              placement="top"
            >
              <span>
                <el-button
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-secondary"
                  :disabled="row.availableActions.splitPrepare === false"
                  @click="emit('split-order', row.id)"
                >
                  {{ row.availableActions.splitPrepare ? "拆分备货" : "已备货，不能拆分" }}
                </el-button>
              </span>
            </el-tooltip>
            <el-button
              v-if="row.availableActions.showPrint"
              size="small"
              class="orders-inline-accent-button orders-inline-accent-button-secondary"
              :disabled="row.availableActions.print === false"
              :title="row.availableActions.print === false ? 'Ozon 尚未提供面单，请稍后同步订单或到 Ozon 后台检查配送注册情况' : ''"
              @click="emit('print-order', row.id)"
            >
              打印标签
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <Teleport to="body">
      <template v-if="markMenu.visible">
        <button type="button" class="orders-mark-overlay" aria-label="关闭标记菜单" @click="closeMarkMenu" />
        <div
          class="orders-mark-floating-panel"
          :style="{ top: `${markMenu.top}px`, left: `${markMenu.left}px` }"
        >
          <div class="orders-mark-menu">
            <div class="orders-mark-menu-title">选择颜色标记</div>
            <button type="button" class="orders-mark-menu-item" @click="applyMark('')">
              <span class="orders-mark-dot-ring">
                <span class="orders-mark-pencil-icon is-small" />
              </span>
              <span>无标记</span>
            </button>
            <button
              v-for="option in selectableMarkChoices"
              :key="option.value"
              type="button"
              class="orders-mark-menu-item"
              @click="applyMark(option.value)"
            >
              <span class="orders-mark-dot" :class="`is-${markTone(option.value)}`" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </div>
      </template>
    </Teleport>

  </el-card>
</template>
