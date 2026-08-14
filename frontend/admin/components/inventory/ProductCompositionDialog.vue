<script setup>
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Delete, Plus, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import ProductImagePreview from "../ProductImagePreview.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  product: { type: Object, default: null },
  refreshKey: { type: Number, default: 0 },
  readOnly: { type: Boolean, default: false }
});

const emit = defineEmits(["update:visible", "saved", "quick-create"]);

const loading = ref(false);
const saving = ref(false);
const optionLoading = ref(false);
const detailProduct = ref(null);
const componentRows = ref([]);
const optionRows = ref([]);
const optionTotal = ref(0);
const optionPage = ref(1);
const optionPageSize = ref(20);
const activeInventoryType = ref("single");
const searchQuery = ref("");
let optionRequestSeq = 0;

const inventoryTypeTabs = [
  { label: "单品", value: "single" },
  { label: "套装", value: "combo" },
  { label: "配件", value: "accessory" }
];

const parentProduct = computed(() => detailProduct.value || props.product || {});
const componentCount = computed(() => componentRows.value.length);
const availableValues = computed(() => componentRows.value.map(componentAvailable));
const compositionAvailable = computed(() => {
  const values = availableValues.value;
  return values.length ? Math.min(...values) : null;
});
const parentPurchaseCost = computed(() => Number(parentProduct.value?.purchase_cost || 0));
const componentPurchaseCost = computed(() => componentRows.value.reduce(
  (sum, row) => sum + Number(row.purchase_cost || 0) * Number(row.quantity || 0),
  0
));
const purchaseCostDifference = computed(() => componentPurchaseCost.value - parentPurchaseCost.value);
const hasPurchaseCostMismatch = computed(() => (
  componentRows.value.length > 0 && Math.abs(purchaseCostDifference.value) > 0.01
));
const purchaseCostWarning = computed(() => (
  `套装采购成本 ¥${parentPurchaseCost.value.toFixed(2)}，子产品单套成本合计 ¥${componentPurchaseCost.value.toFixed(2)}，差额 ${purchaseCostDifference.value >= 0 ? "+" : "-"}¥${Math.abs(purchaseCostDifference.value).toFixed(2)}。请核对套装成本口径；保存子产品不会自动修改利润。`
));
const bottleneckIds = computed(() => {
  if (!componentRows.value.length) return new Set();
  const minValue = compositionAvailable.value;
  return new Set(componentRows.value
    .filter((row) => componentAvailable(row) === minValue)
    .map((row) => Number(row.component_product_id)));
});

function closeDialog() {
  emit("update:visible", false);
}

function rowNumber(row, key) {
  return Number(row?.[key] || 0);
}

function integer(value) {
  return Math.floor(Number(value || 0)).toLocaleString("zh-CN");
}

function quantityText(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, "");
}

function fbpStock(row) {
  return rowNumber(row, "fbp_stock") || rowNumber(row, "fbp_available") || rowNumber(row, "fbpStock");
}

function productLocalStock(row = {}) {
  if (Number(row.component_count || 0) > 0 && row.component_available !== null && row.component_available !== undefined) {
    return Number(row.component_available || 0);
  }
  if (row.local_stock !== undefined && row.local_stock !== null) return Number(row.local_stock || 0);
  return rowNumber(row, "stock") - fbpStock(row);
}

function productTypeLabel(row = {}) {
  if (Number(row.component_count || 0) > 0) return "套装";
  return Number(row.is_accessory || 0) ? "配件" : "单品";
}

function productTypeTag(row = {}) {
  if (Number(row.component_count || 0) > 0) return "warning";
  return Number(row.is_accessory || 0) ? "success" : "info";
}

function normalizeComponentItem(item = {}) {
  return {
    component_product_id: Number(item.component_product_id || item.product_id || item.id || 0),
    component_name: item.component_name || item.product_name || item.name || "",
    inventory_id: item.inventory_id || item.code || "",
    code: item.code || "",
    image_url: item.image_url || item.product_image_url || "",
    stock_unit: item.stock_unit || "个",
    local_stock: Number(item.local_stock ?? productLocalStock(item) ?? 0),
    purchase_cost: Number(item.purchase_cost || 0),
    quantity: Number(item.quantity || 1) || 1
  };
}

function componentName(row = {}) {
  return row.component_name || row.name || row.inventory_id || row.code || `#${row.component_product_id || row.id || "-"}`;
}

function componentCode(row = {}) {
  return row.inventory_id || row.code || `#${row.component_product_id || row.id || "-"}`;
}

function componentAvailable(row = {}) {
  const quantity = Number(row.quantity || 0);
  if (!quantity) return 0;
  return Math.floor(Number(row.local_stock || 0) / quantity);
}

function isBottleneck(row = {}) {
  return bottleneckIds.value.has(Number(row.component_product_id || 0));
}

function isAlreadyAdded(row = {}) {
  const productId = Number(row.id || row.component_product_id || 0);
  return componentRows.value.some((item) => Number(item.component_product_id) === productId);
}

async function loadProductDetail() {
  const productId = Number(props.product?.id || 0);
  if (!productId) return;
  loading.value = true;
  try {
    const detail = await apiClient.get(`/api/products/${productId}`, { noCache: true });
    detailProduct.value = detail || props.product;
    componentRows.value = (Array.isArray(detail?.composition_items) ? detail.composition_items : []).map(normalizeComponentItem);
  } catch (error) {
    componentRows.value = [];
    ElMessage.error(error.message || "加载子产品组成失败");
  } finally {
    loading.value = false;
  }
}

async function loadOptions() {
  const productId = Number(props.product?.id || 0);
  const requestSeq = ++optionRequestSeq;
  optionLoading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(optionPage.value),
      pageSize: String(optionPageSize.value),
      inventoryType: activeInventoryType.value
    });
    const query = String(searchQuery.value || "").trim();
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    if (requestSeq !== optionRequestSeq) return;
    optionRows.value = (Array.isArray(result?.rows) ? result.rows : [])
      .filter((item) => Number(item.id || 0) !== productId);
    optionTotal.value = Number(result?.total || optionRows.value.length);
  } catch (error) {
    if (requestSeq === optionRequestSeq) {
      optionRows.value = [];
      optionTotal.value = 0;
      ElMessage.error(error.message || "加载商品列表失败");
    }
  } finally {
    if (requestSeq === optionRequestSeq) optionLoading.value = false;
  }
}

function handleSearch() {
  optionPage.value = 1;
  loadOptions();
}

function handleTypeChange() {
  optionPage.value = 1;
  loadOptions();
}

function handleOptionPageChange(page) {
  optionPage.value = page;
  loadOptions();
}

function openQuickCreate() {
  emit("quick-create");
}

function addComponent(row) {
  const item = normalizeComponentItem(row);
  if (!item.component_product_id) return;
  if (Number(item.component_product_id) === Number(props.product?.id || 0)) {
    ElMessage.warning("不能选择当前商品自己");
    return;
  }
  const existing = componentRows.value.find((component) => Number(component.component_product_id) === Number(item.component_product_id));
  if (existing) {
    existing.quantity = Number(existing.quantity || 0) + 1;
    return;
  }
  componentRows.value.push(item);
}

function removeComponent(productId) {
  componentRows.value = componentRows.value.filter((item) => Number(item.component_product_id) !== Number(productId));
}

async function saveComponents() {
  const productId = Number(props.product?.id || 0);
  if (!productId) return;
  const invalid = componentRows.value.find((row) => !Number(row.component_product_id || 0) || Number(row.quantity || 0) <= 0);
  if (invalid) {
    ElMessage.warning("请检查子产品用量");
    return;
  }
  saving.value = true;
  try {
    const result = await apiClient.put(`/api/products/${productId}/components`, {
      composition_items: componentRows.value.map((row) => ({
        component_product_id: Number(row.component_product_id),
        quantity: Number(row.quantity || 1)
      }))
    });
    const migratedCount = Number(result?.outbound_sync?.component_migrations || 0);
    const baseMessage = componentRows.value.length ? "子产品组成已保存" : "已恢复为单品库存逻辑";
    ElMessage.success(migratedCount > 0 ? `${baseMessage}，已迁移 ${migratedCount} 条未完成订单扣库` : baseMessage);
    emit("saved", { productId, outboundSync: result?.outbound_sync || null });
    emit("update:visible", false);
  } catch (error) {
    ElMessage.error(error.message || "保存子产品组成失败");
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    detailProduct.value = props.product || null;
    componentRows.value = [];
    searchQuery.value = "";
    activeInventoryType.value = "single";
    optionPage.value = 1;
    if (props.readOnly) await loadProductDetail();
    else await Promise.all([loadProductDetail(), loadOptions()]);
  }
);

watch(
  () => props.refreshKey,
  () => {
    if (props.visible) loadOptions();
  }
);
</script>

<template>
  <el-dialog
    :model-value="visible"
    width="80vw"
    top="3vh"
    align-center
    destroy-on-close
    class="erp-centered-dialog product-composition-dialog"
    @update:model-value="emit('update:visible', $event)"
  >
    <template #header>
      <div class="composition-dialog-title">
        <span>{{ readOnly ? "查看子产品" : "添加子产品" }}</span>
        <el-tag :type="componentCount ? 'warning' : productTypeTag(parentProduct)" effect="light">
          {{ componentCount ? "套装" : productTypeLabel(parentProduct) }}
        </el-tag>
      </div>
    </template>

    <div v-loading="loading" class="composition-layout">
      <section class="composition-parent">
        <ProductImagePreview :src="parentProduct.image_url" size="small" />
        <div>
          <strong>{{ parentProduct.name || "-" }}</strong>
          <span>{{ parentProduct.inventory_id || parentProduct.code || "-" }}</span>
        </div>
        <div class="composition-parent-stock">
          <span>本地可组</span>
          <strong>{{ compositionAvailable === null ? integer(productLocalStock(parentProduct)) : integer(compositionAvailable) }}</strong>
        </div>
        <div class="composition-parent-stock">
          <span>子产品</span>
          <strong>{{ integer(componentCount) }}</strong>
        </div>
      </section>

      <el-alert
        v-if="hasPurchaseCostMismatch"
        type="warning"
        :closable="false"
        show-icon
        :title="purchaseCostWarning"
      />

      <div class="composition-main" :class="{ 'is-read-only': readOnly }">
        <section class="composition-current">
          <div class="composition-section-head">
            <strong>当前组成</strong>
            <span>本地可组 {{ compositionAvailable === null ? "-" : integer(compositionAvailable) }}</span>
          </div>

          <div v-if="componentRows.length" class="composition-component-list">
            <div
              v-for="row in componentRows"
              :key="row.component_product_id"
              class="composition-component-row"
              :class="{ 'is-bottleneck': isBottleneck(row) }"
            >
              <ProductImagePreview :src="row.image_url" size="small" />
              <div class="composition-component-info">
                <strong>{{ componentName(row) }}</strong>
                <span>{{ componentCode(row) }}</span>
              </div>
              <div class="composition-component-qty">
                <span>每套用量</span>
                <el-input-number
                  v-model="row.quantity"
                  :disabled="readOnly"
                  :min="0.01"
                  :step="1"
                  :precision="2"
                  size="small"
                  controls-position="right"
                />
              </div>
              <div class="composition-component-stock">
                <span>本地 {{ integer(row.local_stock) }} {{ row.stock_unit || "个" }}</span>
                <strong>可组 {{ integer(componentAvailable(row)) }}</strong>
              </div>
              <el-tooltip content="移除子产品" placement="top">
                <el-button
                  v-if="!readOnly"
                  class="composition-icon-button"
                  link
                  type="danger"
                  :icon="Delete"
                  @click="removeComponent(row.component_product_id)"
                />
              </el-tooltip>
            </div>
          </div>

          <div v-else class="composition-empty">暂无子产品</div>
        </section>

        <section v-if="!readOnly" class="composition-picker">
          <div class="composition-section-head composition-picker-head">
            <div>
              <strong>商品池</strong>
              <span>{{ integer(optionTotal) }} 个</span>
            </div>
            <el-button type="primary" plain :icon="Plus" @click="openQuickCreate">快速创建库存</el-button>
          </div>
          <el-tabs v-model="activeInventoryType" class="composition-tabs" @tab-change="handleTypeChange">
            <el-tab-pane
              v-for="tab in inventoryTypeTabs"
              :key="tab.value"
              :label="tab.label"
              :name="tab.value"
            />
          </el-tabs>
          <div class="composition-search">
            <el-input
              v-model="searchQuery"
              clearable
              placeholder="搜索商品名称 / SKU / 库存编号"
              @keyup.enter="handleSearch"
              @clear="handleSearch"
            />
            <el-button type="primary" :icon="Search" @click="handleSearch">搜索</el-button>
          </div>

          <div v-loading="optionLoading" class="composition-option-list">
            <div v-for="row in optionRows" :key="row.id" class="composition-option-row">
              <ProductImagePreview :src="row.image_url" size="portrait" />
              <div class="composition-option-info">
                <strong>{{ row.name || "-" }}</strong>
                <span>{{ row.inventory_id || row.code || "-" }}</span>
                <div>
                  <el-tag size="small" :type="productTypeTag(row)" effect="plain">{{ productTypeLabel(row) }}</el-tag>
                  <span>本地 {{ integer(productLocalStock(row)) }} {{ row.stock_unit || "个" }}</span>
                </div>
              </div>
              <el-tooltip :content="isAlreadyAdded(row) ? '已添加' : '添加子产品'" placement="top">
                <el-button
                  class="composition-add-button"
                  circle
                  type="primary"
                  :icon="Plus"
                  :disabled="isAlreadyAdded(row)"
                  @click="addComponent(row)"
                />
              </el-tooltip>
            </div>
            <div v-if="!optionLoading && !optionRows.length" class="composition-empty">暂无商品</div>
          </div>

          <el-pagination
            small
            background
            layout="prev, pager, next"
            :total="optionTotal"
            :page-size="optionPageSize"
            :current-page="optionPage"
            @current-change="handleOptionPageChange"
          />
        </section>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="closeDialog">{{ readOnly ? "关闭" : "取消" }}</el-button>
        <el-button v-if="!readOnly" type="primary" :loading="saving" @click="saveComponents">保存子产品</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.composition-dialog-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.composition-dialog-title span {
  font-weight: 700;
}

.product-composition-dialog {
  min-width: min(1480px, calc(100vw - 40px));
  max-width: calc(100vw - 48px);
}

.product-composition-dialog :deep(.el-dialog__body) {
  max-height: calc(100vh - 180px);
  overflow: hidden;
}

.composition-layout {
  display: grid;
  gap: 14px;
}

.composition-parent {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #dbe6f3;
  border-radius: 8px;
  background: #f8fbff;
}

.composition-parent > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.composition-parent strong {
  color: #0f172a;
  font-size: 14px;
  line-height: 1.35;
}

.composition-parent span,
.composition-section-head span,
.composition-component-info span,
.composition-component-qty span,
.composition-component-stock span,
.composition-option-info span {
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
}

.composition-parent-stock {
  min-width: 90px;
  text-align: right;
}

.composition-parent-stock strong {
  color: #1d4ed8;
  font-size: 20px;
}

.composition-main {
  display: grid;
  grid-template-columns: minmax(620px, 1.45fr) minmax(420px, 0.75fr);
  grid-template-areas: "picker current";
  gap: 18px;
  min-height: min(660px, calc(100vh - 330px));
}

.composition-main.is-read-only {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "current";
}

.composition-main.is-read-only .composition-current {
  padding-left: 0;
  border-left: 0;
}

.composition-current,
.composition-picker {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
}

.composition-current {
  grid-area: current;
  padding-left: 16px;
  border-left: 1px solid #e2e8f0;
}

.composition-picker {
  grid-area: picker;
}

.composition-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.composition-picker-head > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.composition-section-head strong {
  color: #0f172a;
  font-size: 14px;
}

.composition-component-list,
.composition-option-list {
  display: grid;
  gap: 8px;
}

.composition-component-list {
  max-height: min(600px, calc(100vh - 380px));
  overflow: auto;
}

.composition-option-list {
  min-height: min(570px, calc(100vh - 390px));
  max-height: min(570px, calc(100vh - 390px));
  overflow: auto;
}

.composition-component-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 132px 120px 28px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #dbe6f3;
  border-radius: 8px;
  background: #ffffff;
}

.composition-component-row.is-bottleneck {
  border-color: #f59e0b;
  background: #fffbeb;
}

.composition-component-info,
.composition-component-qty,
.composition-component-stock,
.composition-option-info {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.composition-component-info strong,
.composition-option-info strong {
  color: #0f172a;
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.composition-component-stock strong {
  color: #1d4ed8;
  font-size: 13px;
}

.composition-icon-button.el-button {
  min-width: 24px;
  height: 24px;
  padding: 0;
}

.composition-tabs {
  --el-tabs-header-height: 32px;
}

.composition-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 88px;
  gap: 8px;
}

.composition-option-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 98px;
  padding: 10px 12px;
  border: 1px solid #dbe6f3;
  border-radius: 8px;
  background: #ffffff;
}

.composition-option-info > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.composition-add-button.el-button {
  width: 30px;
  height: 30px;
}

.composition-empty {
  display: grid;
  place-items: center;
  min-height: 140px;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  color: #94a3b8;
  font-size: 13px;
}

@media (max-width: 980px) {
  .composition-parent,
  .composition-main {
    grid-template-columns: 1fr;
  }

  .composition-main {
    grid-template-areas:
      "picker"
      "current";
  }

  .composition-current {
    padding-left: 0;
    border-left: 0;
  }

  .composition-component-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .composition-component-qty,
  .composition-component-stock {
    grid-column: 2 / -1;
  }
}
</style>
