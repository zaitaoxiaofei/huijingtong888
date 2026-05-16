<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import {
  applyFilterQuery,
  buildFilterQuery,
  dateText,
  integer,
  isWithinDateRange,
  money,
  normalizeSearch,
  paginate,
  percent
} from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
const SKU_PREVIEW_LIMIT = 2;
let syncingRoute = false;

const loading = ref(false);
const detailLoading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const detailDialogVisible = ref(false);
const detailDialogTitle = ref("");
const detailRows = ref([]);
const formRef = ref();

const state = reactive({
  products: [],
  mappings: [],
  people: [],
  suppliers: [],
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 30
  }
});

const dialog = reactive({
  mode: "create",
  form: createDefaultForm()
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 30
};

const formRules = {
  name: [{ required: true, message: "请输入商品名称", trigger: "blur" }],
  owner_person_id: [{ required: true, message: "请选择负责人", trigger: "change" }],
  purchase_quantity: [{ required: true, message: "请输入采购数量", trigger: "blur" }]
};

function createDefaultForm() {
  return {
    id: null,
    name: "",
    image_url: "",
    purchase_url: "",
    source_platform: "1688",
    supplier_id: "",
    supplier_note: "",
    owner_person_id: "",
    shipping_method: "air",
    purchase_cost: 0,
    domestic_shipping: 0,
    handling_fee: 0,
    purchase_quantity: 1,
    package_weight_g: 0,
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
    listing_price_rub: 0,
    air_sale_price_rmb: 0,
    exchange_rate: 11.32,
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    return_rate: 0.05
  };
}

function mappingPrimaryText(mapping) {
  return mapping.ozon_sku || mapping.offer_id || mapping.online_name || "-";
}

function mappingPreviewText(mapping) {
  const primary = mappingPrimaryText(mapping);
  return mapping.shop_name ? `${mapping.shop_name} / ${primary}` : primary;
}

const enrichedRows = computed(() => {
  const mappingMap = new Map();
  for (const mapping of state.mappings) {
    const productId = Number(mapping.product_id || 0);
    if (!productId) continue;
    if (!mappingMap.has(productId)) {
      mappingMap.set(productId, {
        ids: new Set(),
        names: new Set(),
        rows: []
      });
    }
    const entry = mappingMap.get(productId);
    if (mapping.shop_id) entry.ids.add(String(mapping.shop_id));
    if (mapping.shop_name) entry.names.add(mapping.shop_name);
    entry.rows.push(mapping);
  }

  return state.products.map((row) => {
    const mappingMeta = mappingMap.get(Number(row.id)) || { ids: new Set(), names: new Set(), rows: [] };
    const boundMappings = mappingMeta.rows.map((mapping) => ({
      id: mapping.id,
      shop_id: mapping.shop_id,
      shop_name: mapping.shop_name || "",
      ozon_sku: mapping.ozon_sku || "",
      offer_id: mapping.offer_id || "",
      online_name: mapping.online_name || ""
    }));
    return {
      ...row,
      shop_ids: [...mappingMeta.ids],
      shop_names: [...mappingMeta.names],
      bound_mappings: boundMappings,
      bound_sku_count: boundMappings.length,
      sku_preview: boundMappings.slice(0, SKU_PREVIEW_LIMIT),
      sku_preview_extra: Math.max(boundMappings.length - SKU_PREVIEW_LIMIT, 0)
    };
  });
});

const filteredRows = computed(() => {
  const query = normalizeSearch(state.filters.query);
  const shopId = String(state.filters.shopId || "all");
  return enrichedRows.value.filter((row) => {
    if (shopId !== "all" && !row.shop_ids.includes(shopId)) return false;
    if (!isWithinDateRange(row.created_at, state.filters.dateFrom, state.filters.dateTo)) return false;
    if (!query) return true;
    const haystack = [
      row.id,
      row.product_id,
      row.name,
      row.code,
      row.inventory_id,
      row.owner_name,
      row.mapped_skus,
      row.origin_skus,
      row.shop_names.join(" "),
      row.bound_mappings.map((item) => [item.shop_name, item.ozon_sku, item.offer_id, item.online_name].join(" ")).join(" ")
    ].map(normalizeSearch).join(" ");
    return haystack.includes(query);
  });
});

const pagedRows = computed(() => paginate(filteredRows.value, state.filters.page, state.filters.pageSize));

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
    if (route.query.productId && !state.filters.query) state.filters.query = String(route.query.productId);
  } finally {
    syncingRoute = false;
  }
}

function syncRouteQuery() {
  if (syncingRoute) return;
  const next = buildFilterQuery(route, state.filters, filterDefaults);
  if (JSON.stringify(route.query || {}) === JSON.stringify(next)) return;
  router.replace({ query: next });
}

function handleSearch() {
  state.filters.page = 1;
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
}

function handlePageChange(page) {
  state.filters.page = page;
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
}

function openCreateDialog() {
  dialog.mode = "create";
  dialog.form = createDefaultForm();
  dialog.form.owner_person_id = state.people[0]?.id || "";
  dialogVisible.value = true;
}

async function openEditDialog(row) {
  detailLoading.value = true;
  try {
    const detail = await apiClient.get(`/api/products/${row.id}`);
    dialog.mode = "edit";
    dialog.form = {
      ...createDefaultForm(),
      ...detail,
      supplier_id: detail.supplier_id || "",
      owner_person_id: detail.owner_person_id || state.people[0]?.id || "",
      purchase_cost: Number(detail.purchase_cost || 0),
      domestic_shipping: Number(detail.domestic_shipping || 0),
      handling_fee: Number(detail.handling_fee || 0),
      purchase_quantity: Number(detail.purchase_quantity || 1),
      package_weight_g: Number(detail.package_weight_g || 0),
      length_cm: Number(detail.length_cm || 30),
      width_cm: Number(detail.width_cm || 20),
      height_cm: Number(detail.height_cm || 10),
      listing_price_rub: Number(detail.listing_price_rub || 0),
      air_sale_price_rmb: Number(detail.air_sale_price_rmb || 0),
      exchange_rate: Number(detail.exchange_rate || 11.32),
      desired_profit_value: Number(detail.desired_profit_value || 20),
      return_rate: Number(detail.return_rate || 0.05)
    };
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || "加载商品详情失败");
  } finally {
    detailLoading.value = false;
  }
}

function closeDialog() {
  dialog.form = createDefaultForm();
  formRef.value?.clearValidate?.();
}

async function submitDialog() {
  if (!formRef.value) return;
  await formRef.value.validate();
  dialogSubmitting.value = true;
  try {
    const payload = {
      ...dialog.form,
      supplier_id: dialog.form.supplier_id || null,
      owner_person_id: Number(dialog.form.owner_person_id || 0) || null,
      purchase_cost: Number(dialog.form.purchase_cost || 0),
      domestic_shipping: Number(dialog.form.domestic_shipping || 0),
      handling_fee: Number(dialog.form.handling_fee || 0),
      purchase_quantity: Number(dialog.form.purchase_quantity || 1),
      package_weight_g: Number(dialog.form.package_weight_g || 0),
      length_cm: Number(dialog.form.length_cm || 30),
      width_cm: Number(dialog.form.width_cm || 20),
      height_cm: Number(dialog.form.height_cm || 10),
      listing_price_rub: Number(dialog.form.listing_price_rub || 0),
      air_sale_price_rmb: Number(dialog.form.air_sale_price_rmb || 0),
      exchange_rate: Number(dialog.form.exchange_rate || 11.32),
      desired_profit_value: Number(dialog.form.desired_profit_value || 20),
      return_rate: Number(dialog.form.return_rate || 0.05)
    };
    if (dialog.mode === "create") {
      await apiClient.post("/api/products", payload);
      ElMessage.success("商品已新增");
    } else {
      await apiClient.put(`/api/products/${dialog.form.id}`, payload);
      ElMessage.success("商品已更新");
    }
    dialogVisible.value = false;
    closeDialog();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存商品失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function deleteProduct(row) {
  try {
    await ElMessageBox.confirm(`确认删除商品「${row.name || row.id}」吗？`, "删除确认", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/products/${row.id}`);
    ElMessage.success("商品已删除");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除商品失败");
  }
}

async function recalculateProfits(row) {
  try {
    await apiClient.post(`/api/products/${row.id}/recalculate-profits`, {});
    ElMessage.success("该商品关联订单利润已重算");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "重算利润失败");
  }
}

async function openProfitDetails(row) {
  detailLoading.value = true;
  detailDialogVisible.value = true;
  detailDialogTitle.value = `${row.name || row.product_name} - 订单利润明细`;
  try {
    detailRows.value = await apiClient.get(`/api/products/${row.id}/order-profit-details`);
  } catch (error) {
    detailRows.value = [];
    ElMessage.error(error.message || "加载订单利润明细失败");
  } finally {
    detailLoading.value = false;
  }
}

async function openCancelDetails(row) {
  detailLoading.value = true;
  detailDialogVisible.value = true;
  detailDialogTitle.value = `${row.name || row.product_name} - 取消订单明细`;
  try {
    detailRows.value = await apiClient.get(`/api/products/${row.id}/cancel-details`);
  } catch (error) {
    detailRows.value = [];
    ElMessage.error(error.message || "加载取消订单明细失败");
  } finally {
    detailLoading.value = false;
  }
}

function openProcurement(row) {
  router.push({
    path: "/procurement",
    query: {
      productId: String(row.id),
      from: "inventory-products"
    }
  });
}

function openMappingDetails(row) {
  router.push({
    path: "/inventory/mappings",
    query: {
      productId: String(row.id),
      from: "inventory-products",
      returnTo: route.fullPath
    }
  });
}

async function loadPageData() {
  loading.value = true;
  try {
    const [products, mappings, people, suppliers, shops] = await Promise.all([
      apiClient.get("/api/products"),
      apiClient.get("/api/mappings"),
      apiClient.get("/api/people"),
      apiClient.get("/api/suppliers"),
      apiClient.get("/api/shops")
    ]);
    state.products = Array.isArray(products) ? products : [];
    state.mappings = Array.isArray(mappings) ? mappings.filter((item) => Number(item.active ?? 1) !== 0) : [];
    state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
    state.suppliers = Array.isArray(suppliers) ? suppliers : [];
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    ElMessage.error(error.message || "产品库存表加载失败");
  } finally {
    loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(
  () => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize],
  syncRouteQuery
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      query-label="产品搜索"
      query-placeholder="产品名称 / SKU / 库存ID / 负责人"
      @search="handleSearch"
      @reset="handleReset"
    >
      <template #actions>
        <el-button type="primary" @click="openCreateDialog">新增商品</el-button>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
      <el-table v-loading="loading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="产品信息" min-width="300" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image v-if="row.image_url" :src="row.image_url" fit="cover" class="product-thumb" />
              <div v-else class="product-thumb product-thumb-fallback">无图</div>
              <div class="cell-stack">
                <strong>{{ row.name || "-" }}</strong>
                <span class="muted-text">{{ row.inventory_id || row.code || "-" }}</span>
                <span class="muted-text">负责人：{{ row.owner_name || "-" }}</span>
                <span class="muted-text">店铺：{{ row.shop_names.join(" / ") || "-" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存 / 在途" width="140" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.stock) }}</strong>
              <span class="muted-text">在途 {{ integer(row.incoming_stock) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="采购均价" width="110" align="right">
          <template #default="{ row }">{{ money(row.avg_unit_cost) }}</template>
        </el-table-column>
        <el-table-column label="销量 / 利润率" width="160" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.total_sales_quantity) }}</strong>
              <span class="muted-text">{{ percent(row.profit_rate) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="已绑定 SKU" min-width="320">
          <template #default="{ row }">
            <div class="sku-summary-cell">
              <template v-if="row.bound_sku_count">
                <div class="sku-preview-list">
                  <el-tag
                    v-for="mapping in row.sku_preview"
                    :key="mapping.id"
                    size="small"
                    effect="plain"
                    class="sku-preview-tag"
                  >
                    {{ mappingPreviewText(mapping) }}
                  </el-tag>
                  <span v-if="row.sku_preview_extra" class="sku-preview-extra">+{{ row.sku_preview_extra }}</span>
                </div>
                <el-button link type="primary" class="sku-detail-link" @click="openMappingDetails(row)">查看详情</el-button>
              </template>
              <template v-else>
                <span class="muted-text">未绑定 SKU</span>
                <el-button link type="primary" class="sku-detail-link" @click="openMappingDetails(row)">去绑定 SKU</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="380" fixed="right">
          <template #default="{ row }">
            <el-space wrap>
              <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button link type="primary" @click="openMappingDetails(row)">{{ row.bound_sku_count ? "SKU详情" : "去绑定SKU" }}</el-button>
              <el-button link @click="openProcurement(row)">创建采购</el-button>
              <el-button link @click="openProfitDetails(row)">利润明细</el-button>
              <el-button link @click="openCancelDetails(row)">取消明细</el-button>
              <el-button link type="warning" @click="recalculateProfits(row)">重算利润</el-button>
              <el-button link type="danger" @click="deleteProduct(row)">删除</el-button>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="filteredRows.length"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      :page-sizes="[30, 50, 100]"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />

    <el-dialog
      v-model="dialogVisible"
      :title="dialog.mode === 'create' ? '新增商品' : '编辑商品'"
      width="920px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="closeDialog"
    >
      <el-form ref="formRef" :model="dialog.form" :rules="formRules" label-width="110px">
        <el-row :gutter="18">
          <el-col :span="12">
            <el-form-item label="商品名称" prop="name">
              <el-input v-model="dialog.form.name" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责人" prop="owner_person_id">
              <el-select v-model="dialog.form.owner_person_id">
                <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="供应商">
              <el-select v-model="dialog.form.supplier_id" clearable>
                <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="来源平台">
              <el-select v-model="dialog.form.source_platform">
                <el-option label="1688" value="1688" />
                <el-option label="淘宝" value="taobao" />
                <el-option label="拼多多" value="pinduoduo" />
                <el-option label="其他" value="other" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="采购链接">
              <el-input v-model="dialog.form.purchase_url" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="图片链接">
              <el-input v-model="dialog.form.image_url" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="采购成本">
              <el-input-number v-model="dialog.form.purchase_cost" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="国内运费">
              <el-input-number v-model="dialog.form.domestic_shipping" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="处理费">
              <el-input-number v-model="dialog.form.handling_fee" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="采购数量" prop="purchase_quantity">
              <el-input-number v-model="dialog.form.purchase_quantity" :min="1" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重量(g)">
              <el-input-number v-model="dialog.form.package_weight_g" :min="0" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="运输方式">
              <el-select v-model="dialog.form.shipping_method">
                <el-option label="陆空" value="air" />
                <el-option label="陆运" value="land" />
                <el-option label="海运" value="sea" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="长(cm)">
              <el-input-number v-model="dialog.form.length_cm" :min="0" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="宽(cm)">
              <el-input-number v-model="dialog.form.width_cm" :min="0" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="高(cm)">
              <el-input-number v-model="dialog.form.height_cm" :min="0" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="标价(RUB)">
              <el-input-number v-model="dialog.form.listing_price_rub" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="售价(RMB)">
              <el-input-number v-model="dialog.form.air_sale_price_rmb" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="汇率">
              <el-input-number v-model="dialog.form.exchange_rate" :min="0" :precision="4" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="利润模式">
              <el-select v-model="dialog.form.desired_profit_mode">
                <el-option label="净利率" value="margin" />
                <el-option label="利润额" value="profit" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="利润目标">
              <el-input-number v-model="dialog.form.desired_profit_value" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="退货率">
              <el-input-number v-model="dialog.form.return_rate" :min="0" :max="1" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="供应商备注">
              <el-input v-model="dialog.form.supplier_note" type="textarea" :rows="3" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="dialogSubmitting" @click="submitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="detailDialogVisible" :title="detailDialogTitle" width="980px" align-center class="erp-centered-dialog">
      <el-table v-loading="detailLoading" :data="detailRows" stripe border class="erp-data-table">
        <el-table-column prop="posting_number" label="订单号" min-width="180" />
        <el-table-column prop="shop_name" label="店铺" min-width="120" />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column prop="sale_price" label="售价" width="110" align="right">
          <template #default="{ row }">{{ money(row.sale_price) }}</template>
        </el-table-column>
        <el-table-column prop="estimated_profit" label="利润" width="110" align="right">
          <template #default="{ row }">{{ money(row.actual_profit || row.estimated_profit) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="140" />
        <el-table-column prop="ordered_at" label="下单时间" min-width="170">
          <template #default="{ row }">{{ dateText(row.ordered_at) }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<style scoped>
.sku-summary-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.sku-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.sku-preview-tag {
  max-width: 220px;
}

.sku-preview-extra {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.sku-detail-link {
  padding: 0;
}

.product-thumb-fallback {
  display: grid;
  place-items: center;
  background: #f3f6fb;
  color: #8c98aa;
  font-size: 12px;
}
</style>
