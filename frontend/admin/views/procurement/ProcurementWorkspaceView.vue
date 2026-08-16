<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { useAuthStore } from "../../stores/auth.js";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const authStore = useAuthStore();
const loading = ref(false);
const submitting = ref(false);
const createVisible = ref(false);
const bindVisible = ref(false);
const suggestionLoading = ref(false);
const activeItemIndex = ref(0);
const inventorySearch = ref("");
let suggestionTimer = null;

const state = reactive({
  rows: [],
  total: 0,
  people: [],
  suppliers: [],
  suggestions: [],
  filters: { query: "", bindingStatus: "all", personId: "all", page: 1, pageSize: 20 }
});

const createForm = reactive(defaultCreateForm());
const bindForm = reactive({ id: null, raw_name: "", raw_spec: "", product_id: null, product_name: "", updated_at: "" });
const activeItem = computed(() => createForm.items[activeItemIndex.value] || createForm.items[0]);
const totalAmount = computed(() => createForm.items.reduce((sum, item) => sum + Number(item.amount || 0) + Number(item.shipping_amount || 0), 0));

function defaultItem() {
  return { raw_name: "", raw_spec: "", quantity: 1, amount: 0, shipping_amount: 0, purchase_url: "", product_id: null, product_name: "" };
}

function defaultCreateForm() {
  return { person_id: null, source_type: "pdd", supplier_id: null, urgency: "normal", note: "", items: [defaultItem()] };
}

function resetCreateForm() {
  Object.assign(createForm, defaultCreateForm());
  createForm.person_id = preferredPersonId();
  activeItemIndex.value = 0;
  state.suggestions = [];
  inventorySearch.value = "";
}

function preferredPersonId() {
  const currentId = Number(authStore.user?.id || 0);
  return state.people.some((person) => Number(person.id) === currentId) ? currentId : state.people[0]?.id || null;
}

function sourceLabel(value) {
  return ({ pdd: "拼多多", wechat: "微信", supplier: "供应商", other: "其他" })[String(value || "").toLowerCase()] || "1688";
}

function bindingLabel(row) {
  return row.product_id ? "已绑定" : "待绑定";
}

function bindingType(row) {
  return row.product_id ? "success" : "warning";
}

function productImage(row) {
  const id = Number(row?.product_id || 0);
  return id ? `/api/products/${id}/image?thumb=1&w=180` : "";
}

function productCode(row) {
  return row?.product_code || "-";
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function queryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    bindingStatus: state.filters.bindingStatus,
    personId: state.filters.personId
  });
  if (state.filters.query.trim()) params.set("query", state.filters.query.trim());
  return params.toString();
}

async function loadRows() {
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/requests?${queryString()}`);
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
  } catch (error) {
    ElMessage.error(error.message || "采购工作台加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadOptions() {
  const [people, suppliers] = await Promise.all([
    apiClient.get("/api/people"),
    apiClient.get("/api/suppliers?paged=1&page=1&pageSize=100")
  ]);
  state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
  state.suppliers = Array.isArray(suppliers?.rows) ? suppliers.rows : [];
}

function handleSearch() {
  state.filters.page = 1;
  loadRows();
}

function handleReset() {
  Object.assign(state.filters, { query: "", bindingStatus: "all", personId: "all", page: 1, pageSize: 20 });
  loadRows();
}

function openCreate() {
  resetCreateForm();
  createVisible.value = true;
}

function addItem() {
  createForm.items.push(defaultItem());
  activeItemIndex.value = createForm.items.length - 1;
  state.suggestions = [];
}

function removeItem(index) {
  if (createForm.items.length === 1) return;
  createForm.items.splice(index, 1);
  activeItemIndex.value = Math.min(activeItemIndex.value, createForm.items.length - 1);
  scheduleSuggestions();
}

function setActiveItem(index) {
  activeItemIndex.value = index;
  scheduleSuggestions();
}

function scheduleSuggestions() {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(loadSuggestions, 260);
}

async function loadSuggestions(queryOverride = "") {
  const text = String(queryOverride || activeItem.value?.raw_name || bindForm.raw_name || "").trim();
  if (!text) {
    state.suggestions = [];
    return;
  }
  suggestionLoading.value = true;
  try {
    state.suggestions = await apiClient.get(`/api/procurement/binding-suggestions?query=${encodeURIComponent(text)}`) || [];
  } catch (error) {
    state.suggestions = [];
  } finally {
    suggestionLoading.value = false;
  }
}

function chooseSuggestion(suggestion) {
  if (bindVisible.value) {
    bindForm.product_id = Number(suggestion.product_id);
    bindForm.product_name = suggestion.product_name;
    return;
  }
  activeItem.value.product_id = Number(suggestion.product_id);
  activeItem.value.product_name = suggestion.product_name;
}

function searchInventorySuggestions() {
  const text = String(inventorySearch.value || "").trim();
  if (!text) return ElMessage.warning("请输入库存名称或编码");
  loadSuggestions(text);
}

function clearItemBinding() {
  activeItem.value.product_id = null;
  activeItem.value.product_name = "";
}

async function submitCreate() {
  if (!createForm.person_id) return ElMessage.warning("请选择采购负责人");
  const invalidIndex = createForm.items.findIndex((item) => !String(item.raw_name || "").trim() && !item.product_id);
  if (invalidIndex >= 0) {
    activeItemIndex.value = invalidIndex;
    return ElMessage.warning(`第 ${invalidIndex + 1} 条采购明细缺少采购名称`);
  }
  submitting.value = true;
  try {
    await apiClient.post("/api/procurement/requests", {
      person_id: createForm.person_id,
      source_type: createForm.source_type,
      supplier_id: createForm.supplier_id,
      urgency: createForm.urgency,
      note: createForm.note,
      items: createForm.items.map((item) => ({ ...item, quantity: Number(item.quantity || 1), amount: Number(item.amount || 0), shipping_amount: Number(item.shipping_amount || 0) }))
    });
    ElMessage.success(`采购已创建，共 ${createForm.items.length} 条明细`);
    createVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "创建采购失败");
  } finally {
    submitting.value = false;
  }
}

function openBind(row) {
  Object.assign(bindForm, {
    id: Number(row.id), raw_name: row.raw_name || row.product_name || "", raw_spec: row.raw_spec || "",
    product_id: Number(row.product_id || 0) || null, product_name: row.product_id ? row.product_name : "", updated_at: row.updated_at || ""
  });
  bindVisible.value = true;
  inventorySearch.value = "";
  loadSuggestions(bindForm.raw_name);
}

async function saveBinding() {
  if (!bindForm.product_id) return ElMessage.warning("请选择要绑定的库存商品");
  submitting.value = true;
  try {
    await apiClient.put(`/api/procurement/requests/${bindForm.id}`, {
      updated_at: bindForm.updated_at || undefined,
      raw_name: bindForm.raw_name,
      raw_spec: bindForm.raw_spec,
      product_id: bindForm.product_id
    });
    ElMessage.success("库存绑定已保存，系统会把这次确认用于后续推荐");
    bindVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "绑定库存失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    await loadOptions();
    resetCreateForm();
  } catch (error) {
    ElMessage.error(error.message || "采购基础资料加载失败");
  }
  await loadRows();
});
</script>

<template>
  <div class="page-stack procurement-workspace">
    <ErpPageHeader title="采购工作台" description="先记录真实采购，库存可以立即绑定，也可以后续补齐。">
      <template #actions>
        <el-button class="erp-btn erp-btn-secondary" @click="loadRows">刷新</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreate">创建采购</el-button>
      </template>
    </ErpPageHeader>

    <el-card shadow="never" class="page-card">
      <ErpFilterBar>
        <el-form inline>
          <el-form-item label="关键词">
            <el-input v-model="state.filters.query" placeholder="采购名称 / 库存 / 链接 / 负责人" clearable @keyup.enter="handleSearch" />
          </el-form-item>
          <el-form-item label="库存绑定">
            <el-select v-model="state.filters.bindingStatus" style="width: 130px">
              <el-option label="全部" value="all" />
              <el-option label="待绑定" value="unbound" />
              <el-option label="已绑定" value="bound" />
            </el-select>
          </el-form-item>
          <el-form-item label="采购负责人">
            <el-select v-model="state.filters.personId" style="width: 150px">
              <el-option label="全部" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
        </el-form>
        <template #actions>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </template>
      </ErpFilterBar>

      <el-table v-loading="loading" :data="state.rows" row-key="id" stripe>
        <el-table-column label="采购商品" min-width="250">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="productImage(row)" size="square" />
              <div>
                <strong>{{ row.raw_name || row.product_name }}</strong>
                <div class="muted-text">{{ row.raw_spec || "未填写规格" }}</div>
                <div class="muted-text">{{ row.request_group_no || `采购-${row.id}` }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="数量" prop="quantity" width="80" />
        <el-table-column label="采购金额" width="120">
          <template #default="{ row }">¥{{ Number(row.amount || 0).toFixed(2) }}</template>
        </el-table-column>
        <el-table-column label="渠道/负责人" min-width="145">
          <template #default="{ row }">
            <div>{{ sourceLabel(row.source_type) }}</div>
            <div class="muted-text">{{ row.person_name || "未指定" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="库存绑定" min-width="220">
          <template #default="{ row }">
            <el-tag :type="bindingType(row)">{{ bindingLabel(row) }}</el-tag>
            <div v-if="row.product_id" class="binding-name">{{ row.product_name }} · {{ productCode(row) }}</div>
            <div v-else class="muted-text">采购已保留，等待绑定规范库存</div>
          </template>
        </el-table-column>
        <el-table-column label="采购链接" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <a v-if="row.purchase_url" :href="row.purchase_url" target="_blank" rel="noreferrer">打开链接</a>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="175">
          <template #default="{ row }">{{ dateText(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" fixed="right" width="110">
          <template #default="{ row }">
            <el-button link type="primary" @click="openBind(row)">{{ row.product_id ? "修改绑定" : "绑定库存" }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <PageFooterPagination
        :page="state.filters.page" :page-size="state.filters.pageSize" :total="state.total"
        @update:page="(page) => { state.filters.page = page; loadRows(); }"
        @update:page-size="(size) => { state.filters.pageSize = size; state.filters.page = 1; loadRows(); }"
      />
    </el-card>

    <el-dialog v-model="createVisible" title="创建采购" width="1180px" align-center destroy-on-close>
      <el-form label-width="92px">
        <el-row :gutter="16">
          <el-col :span="8"><el-form-item label="采购负责人"><el-select v-model="createForm.person_id"><el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="采购渠道"><el-select v-model="createForm.source_type"><el-option label="拼多多" value="pdd" /><el-option label="1688" value="1688" /><el-option label="微信" value="wechat" /><el-option label="供应商" value="supplier" /><el-option label="其他" value="other" /></el-select></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="供应商"><el-select v-model="createForm.supplier_id" clearable><el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" /></el-select></el-form-item></el-col>
          <el-col :span="4"><el-form-item label="优先级"><el-select v-model="createForm.urgency"><el-option label="普通" value="normal" /><el-option label="加急" value="urgent" /></el-select></el-form-item></el-col>
        </el-row>
      </el-form>

      <div class="create-layout">
        <div class="item-list">
          <div class="item-list-head"><strong>采购明细（{{ createForm.items.length }}）</strong><el-button link type="primary" @click="addItem">＋ 添加商品</el-button></div>
          <button v-for="(item, index) in createForm.items" :key="index" type="button" class="item-card" :class="{ active: activeItemIndex === index }" @click="setActiveItem(index)">
            <div><strong>{{ item.raw_name || `商品 ${index + 1}` }}</strong><span>{{ item.quantity }}件 · ¥{{ Number(item.amount || 0).toFixed(2) }}</span></div>
            <el-tag size="small" :type="item.product_id ? 'success' : 'warning'">{{ item.product_id ? "已绑定" : "可后绑定" }}</el-tag>
          </button>
        </div>

        <div v-if="activeItem" class="item-editor">
          <div class="section-head"><strong>填写采购商品</strong><el-button v-if="createForm.items.length > 1" link type="danger" @click="removeItem(activeItemIndex)">删除本条</el-button></div>
          <el-form label-width="92px">
            <el-form-item label="采购名称"><el-input v-model="activeItem.raw_name" placeholder="按采购习惯填写，例如：老王家黑色钥匙壳" @input="scheduleSuggestions" /></el-form-item>
            <el-form-item label="规格备注"><el-input v-model="activeItem.raw_spec" placeholder="颜色、型号、包装等" /></el-form-item>
            <el-row :gutter="12">
              <el-col :span="8"><el-form-item label="数量"><el-input-number v-model="activeItem.quantity" :min="1" :precision="0" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="货款"><el-input-number v-model="activeItem.amount" :min="0" :precision="2" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="运费"><el-input-number v-model="activeItem.shipping_amount" :min="0" :precision="2" /></el-form-item></el-col>
            </el-row>
            <el-form-item label="采购链接"><el-input v-model="activeItem.purchase_url" placeholder="拼多多、1688或其他采购链接" /></el-form-item>
          </el-form>
        </div>

        <div class="suggestion-panel" v-loading="suggestionLoading">
          <div class="section-head"><div><strong>建议绑定库存</strong><p>按历史采购名称和库存名称推荐</p></div><el-button v-if="activeItem?.product_id" link @click="clearItemBinding">暂不绑定</el-button></div>
          <div v-if="activeItem?.product_id" class="selected-binding">已选择：{{ activeItem.product_name }}</div>
          <el-input v-model="inventorySearch" placeholder="找不到时搜索库存名称/编码" clearable @keyup.enter="searchInventorySuggestions">
            <template #append><el-button @click="searchInventorySuggestions">搜索</el-button></template>
          </el-input>
          <button v-for="suggestion in state.suggestions" :key="suggestion.product_id" type="button" class="suggestion-card" @click="chooseSuggestion(suggestion)">
            <ProductImagePreview :src="suggestion.image_url" size="small" />
            <div><strong>{{ suggestion.product_name }}</strong><span>{{ suggestion.product_code || '-' }}</span><span>{{ suggestion.reason }} · {{ suggestion.confidence }}%</span></div>
          </button>
          <el-empty v-if="!state.suggestions.length" :image-size="72" description="填写采购名称后显示推荐；也可以先保存，之后再绑定。" />
        </div>
      </div>

      <el-form label-width="92px" class="create-note"><el-form-item label="整单备注"><el-input v-model="createForm.note" type="textarea" :rows="2" /></el-form-item></el-form>
      <template #footer><div class="dialog-summary"><span>共 {{ createForm.items.length }} 条，合计 ¥{{ totalAmount.toFixed(2) }}</span><div><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submitCreate">保存采购</el-button></div></div></template>
    </el-dialog>

    <el-dialog v-model="bindVisible" title="绑定规范库存" width="760px" align-center>
      <el-form label-width="92px">
        <el-form-item label="采购名称"><el-input v-model="bindForm.raw_name" @input="() => loadSuggestions(bindForm.raw_name)" /></el-form-item>
        <el-form-item label="采购规格"><el-input v-model="bindForm.raw_spec" /></el-form-item>
      </el-form>
      <div v-if="bindForm.product_id" class="selected-binding">当前选择：{{ bindForm.product_name }}</div>
      <el-input v-model="inventorySearch" placeholder="搜索库存名称或编码" clearable @keyup.enter="searchInventorySuggestions">
        <template #append><el-button @click="searchInventorySuggestions">搜索</el-button></template>
      </el-input>
      <div class="bind-suggestions" v-loading="suggestionLoading">
        <button v-for="suggestion in state.suggestions" :key="suggestion.product_id" type="button" class="suggestion-card" @click="chooseSuggestion(suggestion)">
          <ProductImagePreview :src="suggestion.image_url" size="small" />
          <div><strong>{{ suggestion.product_name }}</strong><span>{{ suggestion.product_code || '-' }} · {{ suggestion.reason }} · {{ suggestion.confidence }}%</span></div>
        </button>
      </div>
      <template #footer><el-button @click="bindVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="saveBinding">确认绑定</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-cell,.section-head,.item-list-head,.dialog-summary{display:flex;align-items:center;justify-content:space-between;gap:12px}.product-cell{justify-content:flex-start}.muted-text,.suggestion-card span,.item-card span,.section-head p{color:var(--erp-text-secondary);font-size:12px}.binding-name{margin-top:6px}.create-layout{display:grid;grid-template-columns:220px minmax(0,1fr) 310px;gap:16px;min-height:430px}.item-list,.item-editor,.suggestion-panel{padding:14px;border:1px solid var(--erp-border);border-radius:16px;background:#fff}.item-list,.suggestion-panel{display:flex;flex-direction:column;gap:10px}.item-card,.suggestion-card{border:1px solid var(--erp-border);border-radius:12px;background:#fff;text-align:left;cursor:pointer}.item-card{display:flex;justify-content:space-between;align-items:center;padding:12px}.item-card div,.suggestion-card div{display:grid;gap:4px}.item-card.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.suggestion-card{display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;padding:10px}.suggestion-card:hover{border-color:var(--el-color-primary)}.selected-binding{margin:8px 0 12px;padding:10px 12px;border-radius:10px;background:var(--el-color-success-light-9);color:var(--el-color-success-dark-2)}.section-head p{margin:3px 0 0;font-weight:400}.create-note{margin-top:16px}.bind-suggestions{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:360px;overflow:auto}.dialog-summary{width:100%}@media(max-width:1100px){.create-layout{grid-template-columns:190px 1fr}.suggestion-panel{grid-column:1/-1}.bind-suggestions{grid-template-columns:1fr}}
</style>
