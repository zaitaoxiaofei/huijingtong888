<script setup>
import { computed, reactive } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { useAuthStore } from "../../stores/auth";
import ProductImagePreview from "../ProductImagePreview.vue";
import { isImportCandidateVisible, normalizeImportCandidate, normalizeImportRows, sourceLabel } from "../../utils/ai-product-import";

const props = defineProps({ confirmText: { type: String, default: "导入为素材" } });
const emit = defineEmits(["import"]);
const authStore = useAuthStore();
const state = reactive({
  visible: false,
  source: "collector",
  keyword: "",
  loading: false,
  rows: [],
  selected: null,
  page: 1,
  pageSize: 12,
  total: 0,
  creatorId: "",
  shopId: "",
  developmentType: "",
  startDate: "",
  endDate: "",
  people: [],
  shops: []
});
const currentPersonId = computed(() => Number(authStore.user?.id || authStore.user?.person_id || 0) || 0);
const isDraftSource = computed(() => state.source === "draft");

async function open(source, options = {}) {
  state.source = source;
  state.visible = true;
  state.selected = null;
  state.page = 1;
  if (source === "draft" && options.defaultDraftScope === "mine" && !state.creatorId && currentPersonId.value) {
    state.creatorId = String(currentPersonId.value);
  }
  if (source === "draft") await loadDraftFilterOptions();
  await loadRows();
}

async function loadDraftFilterOptions() {
  const [people, shops] = await Promise.all([
    apiClient.get("/api/people", { noCache: true }).catch(() => []),
    apiClient.get("/api/shops", { noCache: true }).catch(() => [])
  ]);
  state.people = Array.isArray(people) ? people.filter((person) => person?.id) : [];
  state.shops = Array.isArray(shops) ? shops.filter((shop) => shop?.id && shop.status !== "deleted") : [];
}

async function loadRows() {
  state.loading = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: String(state.page), pageSize: String(state.pageSize) });
    if (state.keyword.trim()) params.set("query", state.keyword.trim());
    if (state.source === "draft") {
      params.set("lightweight", "1");
      params.set("status", "draft");
      if (state.creatorId) params.set("creatorId", state.creatorId);
      if (state.shopId) params.set("shopId", state.shopId);
      if (state.developmentType) params.set("developmentType", state.developmentType);
      if (state.startDate) params.set("startDate", state.startDate);
      if (state.endDate) params.set("endDate", state.endDate);
    }
    const endpoint = state.source === "collector" ? "/api/listing/collector-box" : state.source === "draft" ? "/api/listing/drafts" : "/api/online-products";
    const payload = await apiClient.get(`${endpoint}?${params.toString()}`, { noCache: true });
    state.rows = normalizeImportRows(payload).map((row, index) => normalizeImportCandidate(row, state.source, index)).filter(isImportCandidateVisible);
    state.total = Number(payload?.total || state.rows.length || 0);
  } catch (error) {
    state.rows = [];
    state.total = 0;
    ElMessage.error(error.message || "导入列表加载失败");
  } finally {
    state.loading = false;
  }
}

function search() { state.page = 1; state.selected = null; void loadRows(); }
function changePage(page) { state.page = Number(page || 1); state.selected = null; void loadRows(); }
function resetDraftFilters() {
  state.creatorId = "";
  state.shopId = "";
  state.developmentType = "";
  state.startDate = "";
  state.endDate = "";
  search();
}

async function confirm() {
  if (!state.selected) return ElMessage.warning("请先选择一个商品");
  state.loading = true;
  try {
    const candidate = await hydrate(state.selected);
    emit("import", candidate);
    state.visible = false;
  } finally {
    state.loading = false;
  }
}

async function hydrate(row) {
  try {
    const endpoint = row.source === "collector"
      ? `/api/listing/collector-box/${encodeURIComponent(row.sourceId)}`
      : row.source === "draft"
        ? `/api/listing/drafts/${encodeURIComponent(row.sourceId)}`
        : `/api/online-products/${encodeURIComponent(row.sourceId)}/edit-draft`;
    const detail = await apiClient.get(endpoint, { noCache: true }).catch(() => null);
    return normalizeImportCandidate({ ...row.raw, ...(detail || {}) }, row.source, row.index);
  } catch (error) {
    ElMessage.warning(error.message || "详情加载失败，已使用列表数据导入");
    return row;
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="state.visible" :title="`选择${sourceLabel(state.source)}商品`" width="920px" destroy-on-close>
    <div class="import-dialog-body">
      <div class="import-toolbar">
        <el-input v-model="state.keyword" clearable placeholder="搜索 SKU / 标题" @keyup.enter="search" />
        <el-button type="primary" :loading="state.loading" @click="search">搜索</el-button>
        <el-button :icon="Refresh" @click="loadRows">刷新</el-button>
      </div>
      <div v-if="isDraftSource" class="import-filters">
        <el-select v-model="state.creatorId" clearable filterable placeholder="创建人" @change="search">
          <el-option label="全部用户" value="" />
          <el-option v-if="currentPersonId" label="我创建的" :value="String(currentPersonId)" />
          <el-option v-for="person in state.people" :key="person.id" :label="person.name || person.username || `用户 ${person.id}`" :value="String(person.id)" />
        </el-select>
        <el-select v-model="state.shopId" clearable filterable placeholder="店铺" @change="search">
          <el-option label="全部店铺" value="" />
          <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name || shop.shop_name || `店铺 ${shop.id}`" :value="String(shop.id)" />
        </el-select>
        <el-select v-model="state.developmentType" clearable placeholder="开发类型" @change="search">
          <el-option label="全部类型" value="" />
          <el-option label="AI 裂变" value="fission" />
          <el-option label="常规开发" value="normal" />
        </el-select>
        <el-date-picker v-model="state.startDate" type="date" value-format="YYYY-MM-DD" placeholder="更新开始" @change="search" />
        <el-date-picker v-model="state.endDate" type="date" value-format="YYYY-MM-DD" placeholder="更新结束" @change="search" />
        <el-button @click="resetDraftFilters">重置</el-button>
      </div>
      <el-table v-loading="state.loading" :data="state.rows" border height="460" highlight-current-row @current-change="(row) => { state.selected = row; }">
        <el-table-column label="图片" width="92" align="center">
          <template #default="{ row }">
            <ProductImagePreview v-if="row.imageUrl" class="import-thumb" :src="row.imageUrl" :preview-src-list="[row.imageUrl]" fit="cover" />
            <span v-else>无图</span>
          </template>
        </el-table-column>
        <el-table-column label="商品信息" min-width="360">
          <template #default="{ row }"><div class="import-meta"><strong>{{ row.title }}</strong><span>{{ row.sourceSku || row.sourceId }}</span><em>{{ row.tags.join(" ") }}</em></div></template>
        </el-table-column>
        <el-table-column label="详情图" width="90" align="center"><template #default="{ row }">{{ row.detailImages.length }}</template></el-table-column>
        <el-table-column label="来源" width="100"><template #default="{ row }">{{ sourceLabel(row.source) }}</template></el-table-column>
      </el-table>
      <el-pagination layout="prev, pager, next, total" :total="state.total" :page-size="state.pageSize" :current-page="state.page" @current-change="changePage" />
    </div>
    <template #footer>
      <el-button @click="state.visible = false">取消</el-button>
      <el-button type="primary" :loading="state.loading" @click="confirm">{{ props.confirmText }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-dialog-body { display: grid; gap: 12px; }
.import-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
.import-filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) repeat(2, 150px) auto; gap: 8px; }
.import-thumb { width: 64px; height: 84px; border-radius: 6px; overflow: hidden; }
.import-meta { min-width: 0; display: grid; gap: 5px; }
.import-meta strong, .import-meta span, .import-meta em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.import-meta em { color: #64748b; font-size: 12px; font-style: normal; }
@media (max-width: 980px) { .import-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .import-toolbar, .import-filters { grid-template-columns: 1fr; } }
</style>
