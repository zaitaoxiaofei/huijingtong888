<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProcurementRequestCreateDialog from "../../components/procurement/ProcurementRequestCreateDialog.vue";

const route = useRoute();
const router = useRouter();
const listRequestGate = createLatestRequestGate();
let dictionaryLoaded = false;

const loading = ref(false);
const dialogVisible = ref(false);
const editDialogVisible = ref(false);
const editDialogSubmitting = ref(false);

const state = reactive({
  requests: [],
  total: 0,
  products: [],
  people: [],
  suppliers: [],
  selectedRequestIds: [],
  filters: {
    query: "",
    status: "waiting_purchase",
    urgency: "all",
    personId: "all",
    page: 1,
    pageSize: 20
  }
});

const editDialog = reactive({
  form: createDefaultForm(),
  requestId: null,
  productQuery: ""
});

const initialProductId = computed(() => Number(route.query.productId || 0) || null);
const lockCreateProduct = computed(() => Boolean(initialProductId.value));

function createDefaultForm() {
  return {
    product_id: null,
    person_id: null,
    quantity: 1,
    amount: 0,
    shipping_amount: 0,
    urgency: "normal",
    source_type: "1688",
    supplier_id: "",
    purchase_url: "",
    note: ""
  };
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value) {
  return Number(value || 0).toFixed(0);
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function isRequestCompleted(row) {
  const status = String(row?.status || "");
  const orderStatus = String(row?.purchase_order_status || "");
  return ["purchased", "done"].includes(status) || ["purchased", "partial_inbound", "inbound_done"].includes(orderStatus);
}

function statusTagType(row) {
  return isRequestCompleted(row) ? "success" : "warning";
}

function urgencyTagType(urgency) {
  return urgency === "urgent" ? "danger" : "info";
}

function requestStatusText(row) {
  return isRequestCompleted(row) ? "完成采购" : "等待采购";
}

function productImage(row) {
  return row?.product_image_url || row?.image_url || "";
}

function productCode(row) {
  return row?.product_code || row?.inventory_id || row?.code || "-";
}

function productSkuText(row) {
  return row?.mapped_skus || "未绑定 SKU";
}

function supplierName(id) {
  return state.suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || "";
}

const pagedRequests = computed(() => state.requests);
const totalRequests = computed(() => state.total);
const selectedRequestRows = computed(() => state.requests.filter((row) => state.selectedRequestIds.includes(Number(row.id))));

const editCandidateProducts = computed(() => {
  const query = String(editDialog.productQuery || "").trim().toLowerCase();
  const rows = state.products.filter((row) => Number(row.active ?? 1) !== 0);
  if (!query) return rows.slice(0, 12);
  return rows.filter((row) => {
    const haystack = [
      row.name,
      row.inventory_id,
      row.code,
      row.selection_id,
      row.mapped_skus,
      row.owner_name
    ].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  }).slice(0, 12);
});

const selectedEditProduct = computed(() => state.products.find((row) => Number(row.id) === Number(editDialog.form.product_id)) || null);

function isRequestSelectable(row) {
  return row.status === "pending";
}

function handleSelectionChange(rows) {
  state.selectedRequestIds = rows.map((row) => Number(row.id));
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  state.filters.query = "";
  state.filters.status = "waiting_purchase";
  state.filters.urgency = "all";
  state.filters.personId = "all";
  state.filters.page = 1;
  state.filters.pageSize = 20;
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

function openCreateDialog() {
  dialogVisible.value = true;
}

function handleCreateDialogClosed(visible) {
  dialogVisible.value = visible;
  if (!visible && initialProductId.value) {
    const nextQuery = { ...route.query };
    delete nextQuery.productId;
    delete nextQuery.from;
    router.replace({ query: nextQuery });
  }
}

async function ensureProductOptions(query = "") {
  if (state.products.length) return;
  const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "100" });
  if (query) params.set("query", query);
  const products = await apiClient.get(`/api/products?${params.toString()}`);
  state.products = Array.isArray(products?.rows) ? products.rows : [];
}

async function openEditRequestDialog(row) {
  editDialog.form = {
    product_id: row.product_id || null,
    person_id: row.person_id || null,
    quantity: Number(row.quantity || 1),
    amount: Number(row.amount || 0),
    shipping_amount: Number(row.shipping_amount || 0),
    urgency: row.urgency || "normal",
    source_type: row.source_type || "1688",
    supplier_id: row.supplier_id || "",
    purchase_url: row.purchase_url || "",
    note: row.note || ""
  };
  editDialog.requestId = row.id;
  editDialog.productQuery = row.product_name || row.product_code || "";
  await ensureProductOptions(editDialog.productQuery);
  editDialogVisible.value = true;
}

function closeEditDialog() {
  editDialog.form = createDefaultForm();
  editDialog.requestId = null;
  editDialog.productQuery = "";
}

function applyProductToForm(form, row) {
  form.product_id = row.id;
  form.person_id = row.owner_person_id || state.people[0]?.id || null;
  form.supplier_id = row.supplier_id || "";
  form.purchase_url = row.purchase_url || "";
  form.amount = Number(row.purchase_cost || 0);
  form.shipping_amount = Number(row.domestic_shipping || 0);
}

function selectEditProduct(row) {
  applyProductToForm(editDialog.form, row);
}

async function recalculateProductProfits(productIds = []) {
  const ids = [...new Set(productIds.map((item) => Number(item || 0)).filter(Boolean))];
  for (const productId of ids) {
    await apiClient.post(`/api/products/${productId}/recalculate-profits`, {});
  }
  return ids.length;
}

async function submitEditDialog() {
  if (!editDialog.requestId) return;

  editDialogSubmitting.value = true;
  try {
    const originalRequest = state.requests.find((row) => Number(row.id) === Number(editDialog.requestId));
    await apiClient.put(`/api/procurement/requests/${editDialog.requestId}`, {
      ...editDialog.form,
      quantity: Number(editDialog.form.quantity || 1),
      amount: Number(editDialog.form.amount || 0),
      shipping_amount: Number(editDialog.form.shipping_amount || 0),
      person_id: Number(editDialog.form.person_id || 0) || null,
      supplier_id: editDialog.form.supplier_id || null
    });
    const recalculatedCount = await recalculateProductProfits([originalRequest?.product_id, editDialog.form.product_id]);
    ElMessage.success(recalculatedCount ? "采购请求已更新，并已重算关联商品利润" : "采购请求已更新");
    editDialogVisible.value = false;
    closeEditDialog();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "更新采购请求失败");
  } finally {
    editDialogSubmitting.value = false;
  }
}

async function deleteRequest(row) {
  try {
    await ElMessageBox.confirm(`确认删除采购请求「${row.product_name || row.product_code || row.id}」吗？`, "删除采购请求", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/procurement/requests/${row.id}`);
    ElMessage.success("采购请求已删除");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除采购请求失败");
  }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      status: String(state.filters.status || "all"),
      urgency: String(state.filters.urgency || "all"),
      personId: String(state.filters.personId || "all")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const loaders = [apiClient.get(`/api/procurement/requests?${params.toString()}`)];
    if (!dictionaryLoaded) loaders.push(apiClient.get("/api/people"), apiClient.get("/api/suppliers?paged=1&page=1&pageSize=100"));
    const [requests, people, suppliers] = await Promise.all(loaders);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.requests = Array.isArray(requests?.rows) ? requests.rows : [];
    state.total = Number(requests?.total || 0);
    if (!dictionaryLoaded) {
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      state.suppliers = Array.isArray(suppliers?.rows) ? suppliers.rows : [];
      dictionaryLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "加载采购请求失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(
  () => route.query.productId,
  (productId) => {
    if (productId) dialogVisible.value = true;
  },
  { immediate: true }
);

onMounted(loadPageData);
</script>

<template>
  <div class="page-stack procurement-page procurement-workspace-page">
    <el-card shadow="never" class="page-card procurement-card procurement-workspace-card">
      <template #header>
        <div class="page-card-header procurement-header-row">
          <div class="page-card-actions">
            <strong>采购请求</strong>
            <el-tag type="info">共 {{ totalRequests }} 条</el-tag>
          </div>
          <div class="page-card-actions">
            <el-button @click="loadPageData">刷新数据</el-button>
            <el-button type="primary" @click="openCreateDialog">新建采购请求</el-button>
          </div>
        </div>
      </template>

      <div class="procurement-toolbar procurement-toolbar-sticky procurement-filter-panel procurement-workspace-filter">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="商品 / 编码 / 申请人 / 采购链接 / 备注"
              clearable
              style="width: 320px"
              @keyup.enter="handleSearch"
            />
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="state.filters.status" style="width: 160px">
              <el-option label="等待采购" value="waiting_purchase" />
              <el-option label="完成采购" value="completed_purchase" />
            </el-select>
          </el-form-item>
          <el-form-item label="紧急程度">
            <el-select v-model="state.filters.urgency" style="width: 140px">
              <el-option label="全部" value="all" />
              <el-option label="普通" value="normal" />
              <el-option label="加急" value="urgent" />
            </el-select>
          </el-form-item>
          <el-form-item label="申请人">
            <el-select v-model="state.filters.personId" style="width: 160px">
              <el-option label="全部" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="list-wrap">
        <el-table
          v-loading="loading"
          :data="pagedRequests"
          height="100%"
          stripe
          border
          class="erp-data-table procurement-table"
        >
          <el-table-column label="商品" min-width="340" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview :src="productImage(row)" />
                <div class="product-cell-meta">
                  <strong>{{ row.product_name || "-" }}</strong>
                  <span>编码：{{ productCode(row) }}</span>
                  <span>SKU：{{ productSkuText(row) }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="person_name" label="申请人" width="120" />
          <el-table-column label="数量" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.quantity) }}</template>
          </el-table-column>
          <el-table-column label="货款" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="运费" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.shipping_amount) }}</template>
          </el-table-column>
          <el-table-column label="紧急程度" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="urgencyTagType(row.urgency)">{{ row.urgency === "urgent" ? "加急" : "普通" }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="supplier_name" label="供应商" min-width="160" />
          <el-table-column prop="status" label="状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row)">{{ requestStatusText(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="采购链接" min-width="220">
            <template #default="{ row }">
              <a
                v-if="row.purchase_url || row.product_purchase_url"
                :href="row.purchase_url || row.product_purchase_url"
                target="_blank"
                rel="noreferrer"
              >
                {{ row.purchase_url || row.product_purchase_url }}
              </a>
              <span v-else class="muted-text">暂无链接</span>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="220">
            <template #default="{ row }">{{ row.note || "-" }}</template>
          </el-table-column>
          <el-table-column prop="created_at" label="创建时间" width="170">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="180" fixed="right" align="center">
            <template #default="{ row }">
              <el-space wrap>
                <el-button link type="primary" @click="openEditRequestDialog(row)">编辑</el-button>
                <el-button link type="danger" @click="deleteRequest(row)">删除</el-button>
              </el-space>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="procurement-footer procurement-workspace-footer"
        :total="totalRequests"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <ProcurementRequestCreateDialog
      :model-value="dialogVisible"
      :initial-product-id="initialProductId"
      :lock-product="lockCreateProduct"
      @update:model-value="handleCreateDialogClosed"
      @created="loadPageData"
    />

    <el-dialog
      v-model="editDialogVisible"
      title="编辑采购请求"
      width="1180px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="closeEditDialog"
    >
      <div class="proc-dialog">
        <div class="proc-dialog-left">
          <div class="dialog-search-head">
            <strong>选择商品</strong>
            <span>如有需要，可以把当前采购请求重新绑定到正确的库存商品。</span>
          </div>
          <el-input v-model="editDialog.productQuery" placeholder="搜索商品名称、库存编码或 SKU" clearable />
          <div class="product-picker-list">
            <button
              v-for="product in editCandidateProducts"
              :key="product.id"
              type="button"
              class="product-picker-item"
              :class="{ active: Number(editDialog.form.product_id) === Number(product.id) }"
              @click="selectEditProduct(product)"
            >
              <ProductImagePreview :src="productImage(product)" size="square" />
              <div class="picker-item-meta">
                <strong>{{ product.name || "-" }}</strong>
                <span>编码：{{ productCode(product) }}</span>
                <span>SKU：{{ productSkuText(product) }}</span>
                <span>负责人：{{ product.owner_name || "-" }}</span>
              </div>
            </button>
            <div v-if="!editCandidateProducts.length" class="picker-empty">没有匹配到商品。</div>
          </div>
        </div>

        <div class="proc-dialog-right">
          <div class="selected-product-card">
            <template v-if="selectedEditProduct">
              <div class="selected-product-main">
                <ProductImagePreview :src="productImage(selectedEditProduct)" size="square" />
                <div class="selected-product-meta">
                  <strong>{{ selectedEditProduct.name }}</strong>
                  <span>编码：{{ productCode(selectedEditProduct) }}</span>
                  <span>负责人：{{ selectedEditProduct.owner_name || "-" }}</span>
                  <span>供应商：{{ supplierName(selectedEditProduct.supplier_id) || "-" }}</span>
                </div>
              </div>
              <div class="selected-product-facts">
                <div class="fact-pill">
                  <span>默认货款</span>
                  <strong>¥{{ money(selectedEditProduct.purchase_cost) }}</strong>
                </div>
                <div class="fact-pill">
                  <span>默认运费</span>
                  <strong>¥{{ money(selectedEditProduct.domestic_shipping) }}</strong>
                </div>
                <div class="fact-pill">
                  <span>SKU</span>
                  <strong>{{ productSkuText(selectedEditProduct) }}</strong>
                </div>
              </div>
            </template>
            <span v-else class="muted-text">请先在左侧选择商品。</span>
          </div>

          <el-alert
            type="info"
            :closable="false"
            class="profit-sync-alert"
            title="保存后会同步重算当前采购商品关联的订单利润。"
          />

          <el-form label-width="110px">
            <el-row :gutter="16">
              <el-col :span="12">
                <el-form-item label="申请人">
                  <el-select v-model="editDialog.form.person_id">
                    <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="紧急程度">
                  <el-select v-model="editDialog.form.urgency">
                    <el-option label="普通" value="normal" />
                    <el-option label="加急" value="urgent" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="数量">
                  <el-input-number v-model="editDialog.form.quantity" :min="1" :precision="0" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="来源类型">
                  <el-select v-model="editDialog.form.source_type">
                    <el-option label="1688" value="1688" />
                    <el-option label="拼多多" value="pdd" />
                    <el-option label="供应商" value="supplier" />
                    <el-option label="微信" value="wechat" />
                    <el-option label="其他" value="other" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="货款">
                  <el-input-number v-model="editDialog.form.amount" :min="0" :precision="2" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="运费">
                  <el-input-number v-model="editDialog.form.shipping_amount" :min="0" :precision="2" controls-position="right" />
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <el-form-item label="供应商">
                  <el-select v-model="editDialog.form.supplier_id" clearable>
                    <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <el-form-item label="采购链接">
                  <el-input v-model="editDialog.form.purchase_url" />
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <el-form-item label="备注">
                  <el-input v-model="editDialog.form.note" type="textarea" :rows="3" />
                </el-form-item>
              </el-col>
            </el-row>
          </el-form>
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="editDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="editDialogSubmitting" @click="submitEditDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.procurement-page {
  min-height: 100%;
}

.procurement-card {
  border: 1px solid rgba(198, 209, 225, 0.85);
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.08), transparent 24%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.98));
}

.procurement-header-row {
  justify-content: space-between;
}

.procurement-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}

.procurement-toolbar-sticky {
  position: sticky;
  top: 0;
  z-index: 6;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(14px);
}

.procurement-filter-panel {
  margin-bottom: 0;
  padding: 14px 16px;
  border: 1px solid rgba(219, 227, 239, 0.9);
  border-radius: 18px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
}

.procurement-table {
  min-width: 1500px;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.product-thumb,
.selected-product-thumb {
  width: 64px;
  height: 64px;
  flex: none;
  border-radius: 18px;
  overflow: hidden;
  border: 1px solid rgba(198, 209, 225, 0.75);
  background: #fff;
}

.product-thumb-fallback,
.picker-thumb-fallback {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
  background:
    linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(15, 23, 42, 0.04)),
    #fff;
}

.product-cell-meta,
.picker-item-meta,
.selected-product-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.product-cell-meta strong,
.picker-item-meta strong,
.selected-product-meta strong {
  font-size: 14px;
}

.product-cell-meta span,
.picker-item-meta span,
.selected-product-meta span {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.dialog-search-head {
  display: grid;
  gap: 4px;
}

.dialog-search-head strong {
  font-size: 15px;
}

.dialog-search-head span,
.muted-text {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.procurement-footer {
  margin-top: auto;
}

.proc-dialog {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  min-height: 520px;
}

.proc-dialog-left,
.proc-dialog-right {
  display: grid;
  gap: 12px;
  min-height: 0;
}

.product-picker-list {
  display: grid;
  gap: 10px;
  max-height: 460px;
  overflow: auto;
  padding-right: 4px;
}

.product-picker-item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(248, 250, 252, 1));
  text-align: left;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.product-picker-item:hover {
  transform: translateY(-2px);
  border-color: rgba(37, 99, 235, 0.35);
  box-shadow: 0 16px 30px rgba(37, 99, 235, 0.12);
}

.product-picker-item.active {
  border-color: var(--el-color-primary);
  background:
    linear-gradient(135deg, rgba(37, 99, 235, 0.12), rgba(255, 255, 255, 0.96)),
    #fff;
  box-shadow: 0 18px 36px rgba(37, 99, 235, 0.14);
}

.picker-thumb {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid rgba(198, 209, 225, 0.75);
}

.picker-empty {
  padding: 28px 16px;
  border: 1px dashed var(--erp-border-strong);
  border-radius: 16px;
  text-align: center;
  color: var(--erp-text-secondary);
  background: rgba(248, 250, 252, 0.9);
}

.selected-product-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(191, 219, 254, 0.9);
  border-radius: 20px;
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.14), transparent 28%),
    linear-gradient(180deg, rgba(239, 246, 255, 0.88), rgba(248, 250, 252, 0.98));
  box-shadow: 0 16px 32px rgba(37, 99, 235, 0.08);
}

.selected-product-main {
  display: flex;
  gap: 14px;
  align-items: center;
}

.selected-product-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.fact-pill {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(191, 219, 254, 0.9);
}

.fact-pill span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.fact-pill strong {
  font-size: 14px;
}

.profit-sync-alert {
  margin-bottom: 4px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@media (max-width: 1360px) {
  .selected-product-facts {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 960px) {
  .procurement-header-row,
  .procurement-toolbar,
  .selected-product-main {
    flex-direction: column;
    align-items: stretch;
  }

  .proc-dialog {
    grid-template-columns: 1fr;
  }
}
</style>


