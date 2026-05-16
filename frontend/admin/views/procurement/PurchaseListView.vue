<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;

const loading = ref(false);
const confirming = ref(false);
const detailVisible = ref(false);
const detailSaving = ref(false);

const state = reactive({
  requests: [],
  filters: {
    query: "",
    page: 1,
    pageSize: 20
  },
  selectedProductIds: []
});

const detailDialog = reactive({
  productId: null,
  productName: "",
  rows: []
});

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value) {
  return Number(value || 0).toFixed(0);
}

function dateText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function productImage(row) {
  return row?.product_image_url || row?.image_url || "";
}

function sourceLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value === "1688") return "1688";
  if (value === "pdd") return "拼多多";
  if (value === "supplier") return "供应商";
  if (value === "wechat") return "微信";
  return source || "其他";
}

const submittedRequests = computed(() => state.requests.filter((row) => row.status === "submitted"));

const mergedRows = computed(() => {
  const grouped = new Map();

  for (const row of submittedRequests.value) {
    const productId = Number(row.product_id || 0);
    if (!productId) continue;

    if (!grouped.has(productId)) {
      grouped.set(productId, {
        product_id: productId,
        product_name: row.product_name || "",
        product_code: row.product_code || "",
        product_image_url: row.product_image_url || row.image_url || "",
        mapped_skus: row.mapped_skus || "",
        supplier_names: new Set(),
        requester_names: new Set(),
        purchase_links: new Set(),
        link_1688: "",
        link_pdd: "",
        other_source: "",
        total_quantity: 0,
        total_amount: 0,
        total_shipping: 0,
        request_count: 0,
        earliest_created_at: row.created_at || "",
        overdue: false,
        requests: []
      });
    }

    const target = grouped.get(productId);
    target.total_quantity += Number(row.quantity || 0);
    target.total_amount += Number(row.amount || 0);
    target.total_shipping += Number(row.shipping_amount || 0);
    target.request_count += 1;
    target.requests.push(row);

    if (row.person_name) target.requester_names.add(row.person_name);
    if (row.supplier_name) target.supplier_names.add(row.supplier_name);
    if (row.purchase_url) target.purchase_links.add(row.purchase_url);
    if (row.product_purchase_url) target.purchase_links.add(row.product_purchase_url);
    target.overdue = target.overdue || Boolean(row.overdue);

    const createdAt = String(row.created_at || "");
    if (!target.earliest_created_at || createdAt < target.earliest_created_at) {
      target.earliest_created_at = createdAt;
    }

    const source = String(row.source_type || row.product_source_platform || "1688").toLowerCase();
    const sourceUrl = row.purchase_url || row.product_purchase_url || "";
    if (source === "1688" && sourceUrl && !target.link_1688) target.link_1688 = sourceUrl;
    else if (source === "pdd" && sourceUrl && !target.link_pdd) target.link_pdd = sourceUrl;
    else if (!target.other_source) target.other_source = row.source_type || row.product_source_platform || "其他";
  }

  return Array.from(grouped.values())
    .map((row) => ({
      ...row,
      supplier_names: Array.from(row.supplier_names),
      requester_names: Array.from(row.requester_names),
      purchase_links: Array.from(row.purchase_links)
    }))
    .sort((a, b) => String(a.earliest_created_at || "").localeCompare(String(b.earliest_created_at || "")));
});

const filteredRows = computed(() => {
  const query = String(state.filters.query || "").trim().toLowerCase();
  if (!query) return mergedRows.value;

  return mergedRows.value.filter((row) => {
    const haystack = [
      row.product_code,
      row.product_name,
      row.mapped_skus,
      row.requester_names.join(" "),
      row.supplier_names.join(" "),
      row.purchase_links.join(" ")
    ].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  });
});

const pagedRows = computed(() => {
  const start = (state.filters.page - 1) * state.filters.pageSize;
  return filteredRows.value.slice(start, start + state.filters.pageSize);
});

const total = computed(() => filteredRows.value.length);
const selectedRows = computed(() => filteredRows.value.filter((row) => state.selectedProductIds.includes(Number(row.product_id))));

function averageUnitCost(row) {
  const quantity = Number(row.total_quantity || 0);
  if (!quantity) return "0.00";
  return money((Number(row.total_amount || 0) + Number(row.total_shipping || 0)) / quantity);
}

function requestSourceSummary(row) {
  const sources = row.requests.map((item) => sourceLabel(item.source_type || item.product_source_platform));
  return Array.from(new Set(sources)).join(" / ") || "-";
}

function handleSearch() {
  state.filters.page = 1;
}

function handleReset() {
  state.filters.query = "";
  state.filters.page = 1;
}

function handlePageChange(page) {
  state.filters.page = page;
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    const query = String(route.query.query || "");
    const productId = String(route.query.productId || "").trim();
    state.filters.query = query || productId;
    state.filters.page = asPositiveInt(route.query.page, 1);
    state.filters.pageSize = asPositiveInt(route.query.pageSize, 20);
  } finally {
    syncingRoute = false;
  }
}

function syncRouteQuery() {
  if (syncingRoute) return;
  const nextQuery = {
    query: state.filters.query || undefined,
    page: state.filters.page > 1 ? String(state.filters.page) : undefined,
    pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
  };
  const normalizedNext = Object.fromEntries(Object.entries(nextQuery).filter(([, value]) => value != null && value !== ""));
  if (JSON.stringify(route.query || {}) === JSON.stringify(normalizedNext)) return;
  router.replace({ query: normalizedNext });
}

function handleSelectionChange(rows) {
  state.selectedProductIds = rows.map((row) => Number(row.product_id));
}

function openEditDialog(row) {
  detailDialog.productId = Number(row.product_id);
  detailDialog.productName = row.product_name || row.product_code || "";
  detailDialog.rows = row.requests.map((item) => ({
    id: Number(item.id),
    product_id: Number(item.product_id || 0) || null,
    product_name: item.product_name || "",
    product_code: item.product_code || "",
    person_name: item.person_name || "",
    quantity: Number(item.quantity || 0),
    amount: Number(item.amount || 0),
    shipping_amount: Number(item.shipping_amount || 0),
    purchase_url: item.purchase_url || "",
    note: item.note || "",
    urgency: item.urgency || "normal",
    source_type: item.source_type || "1688",
    supplier_id: item.supplier_id || null,
    person_id: item.person_id || null,
    supplier_name: item.supplier_name || "",
    created_at: item.created_at || ""
  }));
  detailVisible.value = true;
}

function resetDetailDialog() {
  detailDialog.productId = null;
  detailDialog.productName = "";
  detailDialog.rows = [];
}

async function recalculateProductProfits(productIds = []) {
  const ids = [...new Set(productIds.map((item) => Number(item || 0)).filter(Boolean))];
  for (const productId of ids) {
    await apiClient.post(`/api/products/${productId}/recalculate-profits`, {});
  }
  return ids.length;
}

async function saveDetailRows() {
  if (!detailDialog.rows.length) return;

  detailSaving.value = true;
  try {
    for (const row of detailDialog.rows) {
      await apiClient.put(`/api/procurement/requests/${row.id}`, {
        product_id: row.product_id,
        person_id: Number(row.person_id || 0) || null,
        quantity: Number(row.quantity || 0),
        amount: Number(row.amount || 0),
        shipping_amount: Number(row.shipping_amount || 0),
        urgency: row.urgency || "normal",
        source_type: row.source_type || "1688",
        supplier_id: row.supplier_id || null,
        purchase_url: row.purchase_url || "",
        note: row.note || ""
      });
    }
    const recalculatedCount = await recalculateProductProfits(detailDialog.rows.map((row) => row.product_id));
    ElMessage.success(recalculatedCount ? "采购明细已更新，并已重算关联产品利润" : "采购明细已更新");
    detailVisible.value = false;
    resetDetailDialog();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存采购明细失败");
  } finally {
    detailSaving.value = false;
  }
}

async function confirmRequests(requestIds, label) {
  if (!requestIds.length) return;

  try {
    await ElMessageBox.confirm(`确认采购${label}吗？确认后会直接生成采购单并进入待入库。`, "确认采购", {
      type: "warning",
      confirmButtonText: "确认采购",
      cancelButtonText: "取消"
    });

    confirming.value = true;
    const result = await apiClient.post("/api/procurement/purchase-orders", {
      request_ids: requestIds
    });

    if (result?.id) {
      await apiClient.post(`/api/procurement/purchase-orders/${result.id}/confirm-purchased`, {});
    }

    ElMessage.success("已确认采购，已生成待入库记录");
    state.selectedProductIds = [];
    await loadPageData();
    router.push("/inbound");
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认采购失败");
  } finally {
    confirming.value = false;
  }
}

async function confirmRow(row) {
  const requestIds = row.requests.map((item) => Number(item.id)).filter(Boolean);
  await confirmRequests(requestIds, `产品“${row.product_name || row.product_code || row.product_id}”`);
}

async function confirmSelected() {
  const requestIds = selectedRows.value.flatMap((row) => row.requests.map((item) => Number(item.id))).filter(Boolean);
  await confirmRequests(requestIds, `已选中的 ${selectedRows.value.length} 种产品`);
}

async function confirmAll() {
  const requestIds = filteredRows.value.flatMap((row) => row.requests.map((item) => Number(item.id))).filter(Boolean);
  await confirmRequests(requestIds, `当前筛选结果中的 ${filteredRows.value.length} 种产品`);
}

async function loadPageData() {
  loading.value = true;
  try {
    const rows = await apiClient.get("/api/procurement/requests");
    state.requests = Array.isArray(rows) ? rows : [];
  } catch (error) {
    ElMessage.error(error.message || "采购清单加载失败");
  } finally {
    loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="page-stack procurement-list-page procurement-workspace-page">
    <section class="page-hero">
      <div>
        <h2>采购清单</h2>
      </div>
      <div class="page-card-actions">
        <el-button @click="loadPageData">刷新数据</el-button>
        <el-button type="primary" :disabled="!selectedRows.length" :loading="confirming" @click="confirmSelected">
          确认采购所选
        </el-button>
      </div>
    </section>

    <el-card shadow="never" class="page-card procurement-list-card procurement-workspace-card">
      <template #header>
        <div class="page-card-header">
          <div class="page-card-actions">
            <el-tag type="info">已选 {{ selectedRows.length }} 种</el-tag>
            <el-button :disabled="!filteredRows.length" :loading="confirming" @click="confirmAll">全部确认采购</el-button>
          </div>
        </div>
      </template>

      <div class="procurement-toolbar procurement-toolbar-sticky procurement-workspace-filter">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="商品名称 / 编码 / SKU / 申请人 / 采购链接"
              clearable
              style="width: 360px"
              @keyup.enter="handleSearch"
            />
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
          :data="pagedRows"
          row-key="product_id"
          height="100%"
          stripe
          border
          class="erp-data-table"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="56" reserve-selection />

          <el-table-column label="产品信息" min-width="360" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <el-image
                  v-if="productImage(row)"
                  :src="productImage(row)"
                  fit="cover"
                  class="product-thumb"
                  :preview-src-list="[productImage(row)]"
                  preview-teleported
                />
                <div v-else class="product-thumb product-thumb-fallback">无图</div>
                <div class="product-cell-meta">
                  <strong>{{ row.product_name || "-" }}</strong>
                  <span>编码：{{ row.product_code || "-" }}</span>
                  <span>SKU：{{ row.mapped_skus || "未绑定 SKU" }}</span>
                  <span>申请人：{{ row.requester_names.join("、") || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="请求数" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.request_count) }}</template>
          </el-table-column>

          <el-table-column label="总数量" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.total_quantity) }}</template>
          </el-table-column>

          <el-table-column label="货款" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.total_amount) }}</template>
          </el-table-column>

          <el-table-column label="运费" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.total_shipping) }}</template>
          </el-table-column>

          <el-table-column label="均摊单价" width="110" align="right">
            <template #default="{ row }">¥{{ averageUnitCost(row) }}</template>
          </el-table-column>

          <el-table-column label="采购来源" min-width="240">
            <template #default="{ row }">
              <div class="source-cell">
                <span>供应商：{{ row.supplier_names.join("、") || row.other_source || "-" }}</span>
                <span>
                  1688：
                  <a v-if="row.link_1688" :href="row.link_1688" target="_blank" rel="noreferrer">{{ row.link_1688 }}</a>
                  <span v-else>-</span>
                </span>
                <span>
                  拼多多：
                  <a v-if="row.link_pdd" :href="row.link_pdd" target="_blank" rel="noreferrer">{{ row.link_pdd }}</a>
                  <span v-else>-</span>
                </span>
                <span>来源类型：{{ requestSourceSummary(row) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="row.overdue ? 'danger' : 'info'">{{ row.overdue ? "超期" : "正常" }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="最早创建时间" width="180">
            <template #default="{ row }">{{ dateText(row.earliest_created_at) }}</template>
          </el-table-column>

          <el-table-column label="操作" width="170" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEditDialog(row)">编辑明细</el-button>
              <el-button link type="success" :loading="confirming" @click="confirmRow(row)">确认采购</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="procurement-footer procurement-workspace-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="detailVisible"
      title="编辑采购明细"
      width="1180px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="resetDetailDialog"
    >
      <div class="page-stack">
        <div class="detail-header">
          <strong>{{ detailDialog.productName || "-" }}</strong>
          <span class="muted-text">这里修改的是这一个产品下所有已提交的采购请求。</span>
        </div>

        <el-alert
          type="info"
          :closable="false"
          class="profit-sync-alert"
          title="保存后会同步重算当前产品关联的订单利润。"
        />

        <el-table :data="detailDialog.rows" stripe border class="erp-data-table">
          <el-table-column prop="person_name" label="申请人" width="120" />
          <el-table-column prop="created_at" label="创建时间" width="170">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="数量" width="110" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" :precision="0" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="货款" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="运费" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.shipping_amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="采购链接" min-width="260">
            <template #default="{ row }">
              <el-input v-model="row.purchase_url" placeholder="https://..." />
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="220">
            <template #default="{ row }">
              <el-input v-model="row.note" placeholder="颜色、规格等备注" />
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="detailVisible = false">取消</el-button>
          <el-button type="primary" :loading="detailSaving" @click="saveDetailRows">保存修改</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.procurement-list-page {
  min-height: 100%;
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
  z-index: 3;
  background: var(--erp-surface);
}

.procurement-footer {
  margin-top: auto;
}

.product-cell {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.product-thumb {
  width: 68px;
  height: 68px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  background: #f2f4f7;
}

.product-thumb-fallback {
  display: grid;
  place-items: center;
  color: #909399;
  font-size: 12px;
}

.product-cell-meta,
.source-cell,
.detail-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-cell a {
  color: var(--el-color-primary);
  word-break: break-all;
}

.profit-sync-alert {
  margin-bottom: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
