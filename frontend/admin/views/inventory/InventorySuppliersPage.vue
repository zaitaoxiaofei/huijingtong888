<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createDefaultRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, dateText } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();
let lastLoadedQueryKey = "";

const loading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const state = reactive({
  rows: [],
  total: 0,
  filters: {
    query: "",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 20
  }
});

const dialog = reactive({
  id: null,
  name: "",
  contact_person: "",
  contact_phone: "",
  wechat_id: "",
  business_note: ""
});

const filterDefaults = {
  query: "",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20
};

const pagedRows = computed(() => state.rows);
const syncRouteQuery = createDefaultRouteQuerySync({
  route,
  router,
  filters: state.filters,
  defaults: filterDefaults,
  manualKeys: ["query"],
  isSyncingRoute: () => syncingRoute
});

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
  } finally {
    syncingRoute = false;
  }
}

function handleSearch() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
  lastLoadedQueryKey = "";
  syncRouteQuery("manual");
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
  Object.assign(dialog, { id: null, name: "", contact_person: "", contact_phone: "", wechat_id: "", business_note: "" });
  dialogVisible.value = true;
}

function openEditDialog(row) {
  Object.assign(dialog, {
    id: row.id,
    name: row.name || "",
    contact_person: row.contact_person || "",
    contact_phone: row.contact_phone || "",
    wechat_id: row.wechat_id || "",
    business_note: row.business_note || ""
  });
  dialogVisible.value = true;
}

async function submitDialog() {
  if (!dialog.name.trim()) {
    ElMessage.warning("请输入供应商名称");
    return;
  }
  dialogSubmitting.value = true;
  try {
    const payload = {
      name: dialog.name,
      contact_person: dialog.contact_person,
      contact_phone: dialog.contact_phone,
      wechat_id: dialog.wechat_id,
      business_note: dialog.business_note
    };
    if (dialog.id) {
      await apiClient.put(`/api/suppliers/${dialog.id}`, payload);
      ElMessage.success("供应商已更新");
    } else {
      await apiClient.post("/api/suppliers", payload);
      ElMessage.success("供应商已新增");
    }
    dialogVisible.value = false;
    await loadPageData({ force: true });
  } catch (error) {
    ElMessage.error(error.message || "保存供应商失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function deleteSupplier(row) {
  try {
    await ElMessageBox.confirm(`确认删除供应商「${row.name}」吗？`, "删除供应商", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/suppliers/${row.id}`);
    ElMessage.success("供应商已删除");
    await loadPageData({ force: true });
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除供应商失败");
  }
}

function buildRequestKey() {
  return JSON.stringify({
    page: Number(state.filters.page || 1),
    pageSize: Number(state.filters.pageSize || 20),
    query: String(state.filters.query || "").trim(),
    dateFrom: String(state.filters.dateFrom || ""),
    dateTo: String(state.filters.dateTo || "")
  });
}

async function loadPageData(options = {}) {
  const force = options.force === true;
  const requestKey = buildRequestKey();
  if (!force && requestKey === lastLoadedQueryKey) return;
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      dateFrom: String(state.filters.dateFrom || ""),
      dateTo: String(state.filters.dateTo || "")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const rows = await apiClient.get(`/api/suppliers?${params.toString()}`);
    if (!listRequestGate.isLatest(requestToken)) return;
    lastLoadedQueryKey = requestKey;
    state.rows = Array.isArray(rows?.rows) ? rows.rows : [];
    state.total = Number(rows?.total || 0);
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "供应商配置加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <InventoryPageToolbar
      :filters="state.filters"
      :show-shop="false"
      query-label="供应商搜索"
      query-placeholder="供应商名称 / 联系人 / 手机 / 微信"
      @search="handleSearch"
      @reset="handleReset"
    >
      <template #actions>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateDialog">新增供应商</el-button>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
      <el-table v-loading="loading" :data="pagedRows" row-key="id" stripe border class="erp-data-table">
        <el-table-column prop="name" label="供应商名称" min-width="220" fixed="left" />
        <el-table-column prop="contact_person" label="联系人" min-width="120" />
        <el-table-column prop="contact_phone" label="联系电话" min-width="150" />
        <el-table-column prop="wechat_id" label="微信" min-width="150" />
        <el-table-column prop="product_count" label="绑定产品数" width="110" align="center" />
        <el-table-column prop="business_note" label="备注" min-width="240" />
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at || row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <div class="erp-inline-actions">
              <el-button class="erp-btn-link" link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="deleteSupplier(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />

    <el-dialog v-model="dialogVisible" :title="dialog.id ? '编辑供应商' : '新增供应商'" width="760px" align-center class="erp-centered-dialog">
      <el-form label-width="100px">
        <el-form-item label="供应商名称">
          <el-input v-model="dialog.name" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="dialog.contact_person" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="dialog.contact_phone" />
        </el-form-item>
        <el-form-item label="微信">
          <el-input v-model="dialog.wechat_id" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="dialog.business_note" type="textarea" :rows="4" />
        </el-form-item>
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

