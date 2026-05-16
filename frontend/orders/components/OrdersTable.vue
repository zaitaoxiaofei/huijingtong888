<script setup>
import { computed } from "vue";
import { ElMessage } from "element-plus";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  markOptions: { type: Array, default: () => [] },
  statusLabelFn: { type: Function, default: null },
  statusColorFn: { type: Function, default: null },
  availableActionsFn: { type: Function, default: null },
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
  "open-detail",
  "open-profit",
  "prepare-order",
  "print-order",
  "recalculate-profit",
  "save-mark",
  "open-bind-product-from-order",
  "open-create-product-from-order",
  "jump-stock-product",
  "open-procurement"
]);

const markChoices = computed(() => (
  (props.markOptions || []).filter((item) => item && item.value !== undefined)
));

function formatDateTime(value) {
  return value ? String(value).slice(0, 19).replace("T", " ") : "-";
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function copyText(value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => ElMessage.success("已复制"))
      .catch(() => ElMessage.warning("复制失败"));
    return;
  }
  ElMessage.warning("当前浏览器不支持复制");
}

function orderTitle(row) {
  return row.posting_number || row.order_number || `Order #${row.id}`;
}

function orderTrackingLink(row) {
  const orderNo = String(row?.posting_number || row?.order_number || "").trim();
  if (!orderNo) return "";
  const params = new URLSearchParams({ track: orderNo, local: "zh-Hans" });
  return `https://tracking.ozon.ru/?${params.toString()}`;
}

function statusLabel(row) {
  if (typeof props.statusLabelFn === "function") return props.statusLabelFn(row);
  return row.status || row.tracking_stage || "-";
}

function statusTagType(row) {
  const color = typeof props.statusColorFn === "function" ? props.statusColorFn(row) : "slate";
  if (color === "amber") return "warning";
  if (color === "blue") return "primary";
  if (color === "red") return "danger";
  if (color === "green" || color === "teal") return "success";
  return "info";
}

function availableActions(row) {
  if (typeof props.availableActionsFn === "function") return props.availableActionsFn(row) || {};
  return row.availableActions || {};
}

function rowSelected(row) {
  return props.selectedIds instanceof Set ? props.selectedIds.has(Number(row.id)) : false;
}

function quantitySummary(row) {
  return Number(row.total_quantity || row.quantity_total || row.quantity || row.item_count || 1);
}

function stockSummary(row) {
  const items = productDisplayRows(row);
  return items.reduce((summary, item) => ({
    fbs: summary.fbs + Number(item.stock?.fbs || 0),
    fbp: summary.fbp + Number(item.stock?.fbp || 0)
  }), { fbs: 0, fbp: 0 });
}

function shippingMethodLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "--";
  if (text.includes("fbp")) return "平台仓发货";
  if (text.includes("fbs")) return "自发货";
  if (text.includes("air")) return "空运";
  if (text.includes("sea")) return "海运";
  return String(value || "").trim();
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
  return markChoices.value.find((item) => String(item.value || "") === String(value || ""))?.label || "无标记";
}

function firstCsvValue(value) {
  return String(value || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function parseMappedPairs(value) {
  return String(value || "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, ...rest] = item.split(":");
      return { key: String(key || "").trim(), value: rest.join(":").trim() };
    })
    .filter((item) => item.key);
}

function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseSkuImages(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_images)) {
    if (!map.has(item.key) && item.value) map.set(item.key, item.value);
  }
  return map;
}

function parseSkuNames(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_names)) {
    if (!map.has(item.key) && item.value) map.set(item.key, item.value);
  }
  return map;
}

function parseSkuQuantities(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_quantities)) {
    map.set(item.key, Number(item.value || 0));
  }
  return map;
}

function parseSkuProductIds(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_product_ids)) {
    map.set(item.key, Number(item.value || 0));
  }
  return map;
}

function parseSkuOnlineIds(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_online_product_ids)) {
    map.set(item.key, Number(item.value || 0));
  }
  return map;
}

function parseSkuStockSummaries(row) {
  const map = new Map();
  for (const item of parseMappedPairs(row.sku_stock_summaries)) {
    const parts = String(item.value || "").split(":");
    map.set(item.key, { fbs: Number(parts[0] || 0), fbp: Number(parts[1] || 0) });
  }
  return map;
}

function productDisplayRows(row) {
  const skuImages = parseSkuImages(row);
  const skuNames = parseSkuNames(row);
  const skuQuantities = parseSkuQuantities(row);
  const productIds = parseSkuProductIds(row);
  const onlineIds = parseSkuOnlineIds(row);
  const stockMap = parseSkuStockSummaries(row);
  const skus = splitCsv(row.skus);
  const fallbackName = firstCsvValue(row.product_names) || "待绑定商品";
  const fallbackImage = firstCsvValue(row.order_image_urls) || firstCsvValue(row.image_urls);

  if (!skus.length) {
    return [{
      sku: row.ozon_sku || "-",
      name: fallbackName,
      quantity: quantitySummary(row),
      imageUrl: fallbackImage,
      stock: { fbs: 0, fbp: 0 },
      productId: 0,
      onlineId: 0,
      unbound: true
    }];
  }

  return skus.map((sku) => ({
    sku,
    name: skuNames.get(sku) || fallbackName,
    quantity: skuQuantities.get(sku) || 0,
    imageUrl: skuImages.get(sku) || fallbackImage,
    stock: stockMap.get(sku) || { fbs: 0, fbp: 0 },
    productId: productIds.get(sku) || 0,
    onlineId: onlineIds.get(sku) || 0,
    unbound: splitCsv(row.unbound_skus).includes(sku)
  }));
}

function inventorySummaries(row) {
  const productIds = splitCsv(row.product_ids).map((item) => Number(item)).filter(Boolean);
  const productNames = splitCsv(row.product_names);

  return productIds.map((productId, index) => ({
    productId,
    sku: splitCsv(row.skus)[index] || "",
    productName: productNames[index] || productNames[0] || "库存商品",
    amountText: `CNY ${formatMoney(profitSummary(row).revenue)}`
  }));
}

function printedState(row) {
  return Boolean(row.printed_at);
}

function profitSummary(row) {
  const estimated = Number(row.estimated_profit || 0);
  const actual = Number(row.actual_profit || 0);
  const hasActual = Math.abs(actual) > 0.000001 || String(row.status || "").toLowerCase() === "delivered";
  return { revenue: Number(row.revenue || 0), estimated, actual, hasActual };
}

function logisticsSummary(row) {
  return {
    tracking: row.tracking_number || "",
    deliveryMethod: row.delivery_method_name || row.delivery_method || row.shipping_method || "",
    warehouse: row.warehouse_name || "",
    channel: row.logistics_channel || "",
    deadline: row.shipment_deadline_at || "",
    overdue: Boolean(row.is_overdue)
  };
}

function productLink(item) {
  return item.onlineId ? `#/online-products?onlineProductId=${item.onlineId}` : "";
}

function cancelReasonText(row) {
  const status = String(row?.status || "").toLowerCase();
  if (status !== "cancelled") return "--";
  return row?.cancel_reason_label || "--";
}

function amountText(row) {
  return `CNY ${formatMoney(profitSummary(row).revenue)}`;
}

function statusDeadlineHint(row) {
  const status = String(row?.status || "").toLowerCase();
  if (!["awaiting_packaging", "awaiting_deliver"].includes(status)) return "";
  const deadline = logisticsSummary(row).deadline;
  if (!deadline) return "";
  const time = new Date(deadline).getTime();
  if (!Number.isFinite(time)) return "";
  const diffDays = Math.ceil((time - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return `超时 ${Math.abs(diffDays)} 天`;
  if (diffDays === 0) return "今天到期";
  return `剩余 ${diffDays} 天`;
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
            <el-popover placement="right" :width="190" trigger="click" popper-class="orders-mark-popover">
              <template #reference>
                <button type="button" class="orders-mark-pill" :title="markLabel(markValue(row))">
                  <span v-if="markValue(row)" class="orders-mark-dot" :class="`is-${markTone(markValue(row))}`" />
                  <span v-else class="orders-mark-pencil-ring">
                    <span class="orders-mark-pencil-icon" />
                  </span>
                </button>
              </template>
              <div class="orders-mark-menu">
                <div class="orders-mark-menu-title">选择颜色标记</div>
                <button type="button" class="orders-mark-menu-item" @click="emit('save-mark', row.id, '')">
                  <span class="orders-mark-dot-ring">
                    <span class="orders-mark-pencil-icon is-small" />
                  </span>
                  <span>无标记</span>
                </button>
                <button
                  v-for="option in markChoices.filter((item) => item.value)"
                  :key="option.value"
                  type="button"
                  class="orders-mark-menu-item"
                  @click="emit('save-mark', row.id, option.value)"
                >
                  <span class="orders-mark-dot" :class="`is-${markTone(option.value)}`" />
                  <span>{{ option.label }}</span>
                </button>
              </div>
            </el-popover>
            <div v-if="printedState(row)" class="orders-print-state orders-print-state-mark">
              <b>已打印</b>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="订单信息" min-width="180" fixed="left">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <a
              v-if="orderTrackingLink(row)"
              class="orders-posting-link orders-posting-emphasis"
              :href="orderTrackingLink(row)"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ orderTitle(row) }}
            </a>
            <div v-else class="orders-cell-title orders-posting-emphasis">{{ orderTitle(row) }}</div>
            <div class="orders-order-quantity" :class="{ 'is-multi': quantitySummary(row) > 1 }">
              数量: {{ quantitySummary(row) }}
            </div>
            <div class="orders-order-quantity">
              金额: {{ amountText(row) }}
            </div>
            <div class="orders-order-stock-line">
              <span>FBS: {{ stockSummary(row).fbs }}</span>
              <span>/</span>
              <span>FBP: {{ stockSummary(row).fbp }}</span>
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
            <el-tag effect="light" :type="statusTagType(row)">{{ statusLabel(row) }}</el-tag>
            <div
              v-if="statusDeadlineHint(row)"
              class="orders-status-deadline"
              :class="{ 'is-danger': statusDeadlineHint(row).startsWith('超时') }"
            >
              {{ statusDeadlineHint(row) }}
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="商品信息" min-width="300">
        <template #default="{ row }">
            <div class="orders-goods-list">
              <div v-for="item in productDisplayRows(row)" :key="`${row.id}-${item.sku}`" class="orders-goods-item">
                <div class="orders-thumb-wrap">
                  <div class="orders-thumb">
                    <el-image
                      v-if="item.imageUrl"
                      :src="item.imageUrl"
                      :preview-src-list="[item.imageUrl]"
                      preview-teleported
                      fit="cover"
                    />
                    <div v-else class="orders-thumb-empty">无图</div>
                  </div>
                </div>
                <div class="orders-product-copy">
                <a v-if="productLink(item)" class="orders-product-link orders-product-name" :href="productLink(item)">{{ item.name }}</a>
                <div v-else class="orders-cell-title orders-product-name">{{ item.name }}</div>
                <div class="orders-sku-row">
                  <span class="orders-cell-meta-line">SKU: {{ item.sku }}</span>
                  <button type="button" class="orders-copy-chip" @click="copyText(item.sku)">复制</button>
                </div>
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="利润" min-width="188" align="left">
        <template #default="{ row }">
          <div class="orders-cell-stack orders-money-cell">
            <div class="orders-cell-meta-line">预计: CNY {{ formatMoney(profitSummary(row).estimated) }}</div>
            <div class="orders-cell-meta-line">
              真实:
              <span v-if="profitSummary(row).hasActual">CNY {{ formatMoney(profitSummary(row).actual) }}</span>
              <span v-else>--</span>
            </div>
            <el-button class="orders-inline-accent-button orders-inline-accent-button-blue orders-profit-detail-button" size="small" @click="emit('open-profit', row.id)">详情</el-button>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="下单时间" min-width="196">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-cell-meta-line orders-time-line">下单: {{ formatDateTime(row.ordered_at) }}</div>
            <div class="orders-cell-meta-line orders-time-line">更新: {{ formatDateTime(row.updated_at) }}</div>
            <div class="orders-cell-meta-line orders-time-line" :class="{ 'orders-text-danger': logisticsSummary(row).overdue }">
              截止: {{ formatDateTime(logisticsSummary(row).deadline) }}
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="物流信息" min-width="168">
        <template #default="{ row }">
          <div class="orders-cell-stack">
            <div class="orders-delivery-main orders-delivery-main-compact">{{ logisticsSummary(row).deliveryMethod || "--" }}</div>
            <div class="orders-cell-meta-line orders-logistics-warehouse">{{ logisticsSummary(row).warehouse || "--" }}</div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="取消原因" min-width="148">
        <template #default="{ row }">
          <div class="orders-cancel-cell">
            <small>{{ cancelReasonText(row) }}</small>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="库存信息" min-width="220">
        <template #default="{ row }">
          <div class="orders-stock-list">
            <div
              v-for="product in inventorySummaries(row)"
              :key="`${row.id}-inventory-${product.productId}`"
              class="orders-inventory-item bound"
            >
              <span class="orders-stock-badge is-bound">✓</span>
              <small class="orders-stock-product-name orders-product-name">{{ product.productName }}</small>
              <div class="orders-inline-actions orders-inline-actions-compact">
                <el-button
                  v-if="product.sku"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-blue"
                  @click="emit('open-bind-product-from-order', row.id, product.sku)"
                >
                  修改绑定
                </el-button>
                <el-button
                  v-if="product.productId"
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-green"
                  @click="emit('open-procurement', product.productId)"
                >
                  创建采购
                </el-button>
              </div>
            </div>
            <div
              v-for="item in productDisplayRows(row).filter((entry) => entry.unbound)"
              :key="`${row.id}-unbound-${item.sku}`"
              class="orders-inventory-item pending"
            >
              <span class="orders-stock-badge is-unbound">×</span>
              <small class="orders-stock-product-name orders-product-name">{{ item.name }}</small>
              <div class="orders-inline-actions orders-inline-actions-compact">
                <el-button
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-amber"
                  @click="emit('open-bind-product-from-order', row.id, item.sku)"
                >
                  绑定库存
                </el-button>
                <el-button
                  size="small"
                  class="orders-inline-accent-button orders-inline-accent-button-purple"
                  @click="emit('open-create-product-from-order', row.id, item.sku)"
                >
                  创建库存
                </el-button>
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" min-width="210" fixed="right">
        <template #default="{ row }">
          <div class="orders-actions-cell orders-actions-cell-vertical">
              <el-button
                v-if="availableActions(row).prepare !== false"
                size="small"
                class="orders-inline-accent-button orders-inline-accent-button-green"
                @click="emit('prepare-order', row.id)"
              >
                备货
            </el-button>
              <el-button
                v-if="availableActions(row).print !== false"
                size="small"
                class="orders-inline-accent-button orders-inline-accent-button-amber"
                @click="emit('print-order', row.id)"
              >
                打印标签
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>
