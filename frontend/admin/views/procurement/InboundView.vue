<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const listRequestGate = createLatestRequestGate();
let peopleLoaded = false;

const state = reactive({
  rows: [],
  people: [],
  total: 0,
  filters: {
    query: "",
    status: "all",
    page: 1,
    pageSize: 20
  }
});

const dialog = reactive({
  form: createDefaultForm()
});

const total = computed(() => state.total);

function createDefaultForm() {
  return {
    id: null,
    product_id: null,
    person_id: null,
    quantity: 0,
    amount: 0,
    shipping_amount: 0,
    purchase_url: "",
    status: "pending_arrival",
    note: "",
    qc_status: "pending"
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

function statusTagType(status) {
  if (String(status || "").includes("approved")) return "success";
  if (String(status || "").includes("pending")) return "warning";
  return "info";
}

function statusText(status) {
  if (status === "pending_arrival") return "待入库";
  if (status === "approved") return "已入库";
  return status || "-";
}

function handleSearch() {
  state.filters.page = 1;
  loadInboundRecords();
}

function handleReset() {
  state.filters.query = "";
  state.filters.status = "all";
  state.filters.page = 1;
  loadInboundRecords();
}

function handlePageChange(page) {
  state.filters.page = page;
  loadInboundRecords();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  loadInboundRecords();
}

function openCreateDialog() {
  dialog.form = createDefaultForm();
  dialogVisible.value = true;
}

function openEditDialog(row) {
  dialog.form = {
    id: row.id,
    product_id: row.product_id,
    person_id: row.person_id,
    quantity: Number(row.quantity || 0),
    amount: Number(row.amount || 0),
    shipping_amount: Number(row.shipping_amount || 0),
    purchase_url: row.purchase_url || "",
    status: row.status || "pending_arrival",
    note: row.note || "",
    qc_status: row.qc_status || "pending"
  };
  dialogVisible.value = true;
}

function closeDialog() {
  dialog.form = createDefaultForm();
}

async function submitDialog() {
  dialogSubmitting.value = true;
  try {
    const payload = {
      product_id: Number(dialog.form.product_id || 0) || null,
      person_id: Number(dialog.form.person_id || 0) || null,
      quantity: Number(dialog.form.quantity || 0),
      amount: Number(dialog.form.amount || 0),
      shipping_amount: Number(dialog.form.shipping_amount || 0),
      purchase_url: dialog.form.purchase_url || "",
      status: dialog.form.status || "pending_arrival",
      note: dialog.form.note || "",
      qc_status: dialog.form.qc_status || "pending"
    };

    if (dialog.form.id) {
      await apiClient.put(`/api/inbound-records/${dialog.form.id}`, payload);
      ElMessage.success("入库记录已更新");
    } else {
      await apiClient.post("/api/inbound-records", payload);
      ElMessage.success("入库记录已新增");
    }

    dialogVisible.value = false;
    closeDialog();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存入库记录失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function deleteRow(row) {
  try {
    await ElMessageBox.confirm(`确认删除入库记录“${row.purchase_order_no || row.id}”吗？`, "删除入库记录", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/inbound-records/${row.id}`);
    ElMessage.success("入库记录已删除");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除入库记录失败");
  }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const requests = [apiClient.get(`/api/inbound-records?${inboundQueryString()}`)];
    if (!peopleLoaded) requests.push(apiClient.get("/api/people"));
    const [result, people] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    applyInboundResult(result);
    if (!peopleLoaded) {
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      peopleLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "加载入库流水失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

function inboundQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    status: state.filters.status || "all",
    query: String(state.filters.query || "").trim()
  });
  return params.toString();
}

function applyInboundResult(result) {
  state.rows = Array.isArray(result?.rows) ? result.rows : [];
  state.total = Number(result?.total || 0);
}

async function loadInboundRecords() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/inbound-records?${inboundQueryString()}`);
    if (!listRequestGate.isLatest(requestToken)) return;
    applyInboundResult(result);
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "加载入库流水失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

onMounted(loadPageData);
</script>

<template>
  <div class="page-stack inbound-page procurement-workspace-page">
    <section class="page-hero">
      <div>
        <h2>入库流水</h2>
      </div>
      <div class="page-card-actions">
        <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">刷新数据</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateDialog">新建入库记录</el-button>
      </div>
    </section>

    <el-card shadow="never" class="page-card inbound-card procurement-workspace-card">
      <div class="procurement-toolbar procurement-toolbar-sticky procurement-filter-panel procurement-workspace-filter">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="采购单号 / 商品 / 申请人 / 备注"
              clearable
              style="width: 320px"
              @keyup.enter="handleSearch"
            />
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="state.filters.status" style="width: 160px">
              <el-option label="全部" value="all" />
              <el-option label="待入库" value="pending_arrival" />
              <el-option label="已入库" value="approved" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="list-wrap">
        <el-table v-loading="loading" :data="state.rows" height="100%" stripe border class="erp-data-table inbound-table">
          <el-table-column prop="purchase_order_no" label="采购单号" width="160" fixed="left" />
          <el-table-column prop="product_name" label="商品名称" min-width="240" />
          <el-table-column prop="person_name" label="申请人" width="120" />
          <el-table-column label="数量" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.quantity) }}</template>
          </el-table-column>
          <el-table-column label="货款" width="120" align="right">
            <template #default="{ row }">¥{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="运费" width="120" align="right">
            <template #default="{ row }">¥{{ money(row.shipping_amount) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="created_at" label="创建时间" width="180">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="160" align="center">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="deleteRow(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="inbound-footer procurement-workspace-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="dialog.form.id ? '编辑入库记录' : '新建入库记录'"
      width="860px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="closeDialog"
    >
      <el-form label-width="110px">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="商品 ID">
              <el-input v-model="dialog.form.product_id" placeholder="产品 ID" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="申请人">
              <el-select v-model="dialog.form.person_id" clearable>
                <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数量">
              <el-input-number v-model="dialog.form.quantity" :min="0" :precision="0" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-select v-model="dialog.form.status">
                <el-option label="待入库" value="pending_arrival" />
                <el-option label="已入库" value="approved" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="货款">
              <el-input-number v-model="dialog.form.amount" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="运费">
              <el-input-number v-model="dialog.form.shipping_amount" :min="0" :precision="2" controls-position="right" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="采购链接">
              <el-input v-model="dialog.form.purchase_url" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="dialog.form.note" type="textarea" :rows="3" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="dialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="dialogSubmitting" @click="submitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.inbound-page {
  min-height: 100%;
}

.inbound-card {
  border: 1px solid rgba(198, 209, 225, 0.85);
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.08), transparent 24%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.98));
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
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(14px);
}

.procurement-filter-panel {
  margin-bottom: 0;
  padding: 14px 16px;
  border: 1px solid rgba(219, 227, 239, 0.9);
  border-radius: 18px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
}

.inbound-table {
  min-width: 1200px;
}

.inbound-footer {
  margin-top: auto;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@media (max-width: 960px) {
  .procurement-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
