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
  // Keep the table height tied to the flex layout instead of a viewport
  // max-height so the last row does not slide under the footer pagination.
  tableHeight: { type: [String, Number], default: "100%" }
});

const emit = defineEmits([
  "toggle-all",
  "toggle-row",
  "open-profit",
  "prepare-order",
  "print-order",
  "save-mark",
  "open-bind-product-from-order",
  "open-create-product-from-order",
  "open-procurement",
  "open-order-procurement"
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
</script>

<template>
  <el-card shadow="never" class="orders-table-card">
    <el-table
      :data="rows"
      :height="tableHeight"
      stripe
      border
      class="orders-table"
      table-layout="fixed"
      empty-text="当前筛选下暂无订单"
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
            <div class="orders-order-quantity" :class="{ 'is-multi': row.quantitySummary > 1 }">
              数量 {{ row.quantitySummary }}
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
            <div class="orders-cell-meta-line">预计: CNY {{ formatMoney(row.profitSummary.estimated) }}</div>
            <div class="orders-cell-meta-line">
              真实:
              <span v-if="row.profitSummary.hasActual">CNY {{ formatMoney(row.profitSummary.actual) }}</span>
              <span v-else>--</span>
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

      <el-table-column label="物流信息" min-width="168">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-delivery-main orders-delivery-main-compact">{{ row.logisticsSummary.deliveryMethodLabel || "FBS" }}</div>
            <div class="orders-cell-meta-line orders-logistics-warehouse">{{ row.logisticsSummary.resolvedRuleName || "--" }}</div>
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

      <el-table-column label="库存信息" min-width="220">
        <template #default="{ row }">
          <div class="orders-stock-list">
            <div
              v-for="product in row.inventorySummaries"
              :key="`${row.id}-inventory-${product.productId}`"
              class="orders-inventory-item orders-inventory-item-plain"
            >
              <small class="orders-stock-product-name orders-product-name">{{ product.productName }}</small>
              <div class="orders-stock-inline-facts">
                <span>FBP: {{ row.stockSummary?.fbp || 0 }}</span>
                <span>FBS: {{ row.stockSummary?.fbs || 0 }}</span>
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
                  v-if="product.productId"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-primary"
                  @click="emit('open-procurement', product.productId)"
                >
                  创建采购
                </el-button>
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
                <span>FBS: {{ item.stock?.fbs || 0 }}</span>
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
          </div>
        </template>
      </el-table-column>

      <el-table-column label="取消原因" min-width="148">
        <template #default="{ row }">
          <div class="orders-cancel-cell">
            <small>{{ row.cancelReasonText }}</small>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="210" fixed="right">
        <template #default="{ row }">
          <div class="orders-actions-cell orders-actions-cell-vertical">
            <el-button
              v-if="row.availableActions.purchase"
              size="small"
              class="orders-inline-accent-button orders-inline-accent-button-secondary"
              @click="emit('open-order-procurement', row.id)"
            >
              去采购
            </el-button>
            <div v-else-if="row.procurementState?.handled" class="orders-procurement-done">
              <el-tag type="success" effect="light">{{ row.procurementState.label }}</el-tag>
              <small>{{ row.procurementState.detail }}</small>
            </div>
            <el-button
              v-else
              size="small"
              class="orders-inline-accent-button orders-inline-accent-button-primary"
              :disabled="row.availableActions.prepare === false"
              @click="emit('prepare-order', row.id)"
            >
              备货
            </el-button>
            <el-button
              size="small"
              class="orders-inline-accent-button orders-inline-accent-button-secondary"
              :disabled="row.availableActions.print === false"
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
