<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Connection, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const props = defineProps({
  modelValue: { type: String, default: "" },
  shopId: { type: [String, Number], default: "" },
  fullRefresh: { type: Boolean, default: true },
  showSkuLookup: { type: Boolean, default: false },
  placeholder: { type: String, default: "搜索 Ozon 真实类目 / 中文名 / 俄文名 / ID" }
});

const emit = defineEmits(["update:modelValue", "select", "sync"]);

const categories = ref([]);
const loading = ref(false);
const syncing = ref(false);
const resolvingSku = ref(false);
const keyword = ref("");
const skuKeyword = ref("");
const selectedValue = ref(props.modelValue || "");
const treeValue = ref(props.modelValue || "");

const cascaderProps = {
  value: "value",
  label: "label",
  children: "children",
  emitPath: false,
  checkStrictly: false
};

const categoryMap = computed(() => new Map(categories.value.map((category) => [category.ozon_category_id, category])));
const treeOptions = computed(() => buildCategoryTree(categories.value));

watch(() => props.modelValue, (value) => {
  selectedValue.value = value || "";
  treeValue.value = value || "";
});

onMounted(() => {
  loadCategories("");
});

async function loadCategories(query = "") {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (query) params.set("keyword", query);
    params.set("limit", query ? "120" : "10000");
    categories.value = await apiClient.get(`/api/listing/ozon-categories?${params.toString()}`, { noCache: true });
  } finally {
    loading.value = false;
  }
}

async function remoteSearch(query) {
  keyword.value = query || "";
  await loadCategories(keyword.value);
}

async function syncCategories() {
  syncing.value = true;
  try {
    const result = props.fullRefresh
      ? await apiClient.post("/api/listing/ozon-category-cache/refresh", {
        shop_id: props.shopId || undefined,
        mode: "manual_ui",
        language: "ZH_HANS"
      })
      : await apiClient.post("/api/listing/ozon-categories/sync", {
        shop_id: props.shopId || undefined,
        language: "ZH_HANS"
      });
    await loadCategories(keyword.value);
    emit("sync", result);
    ElMessage.success(props.fullRefresh
      ? `类目缓存已刷新：类目 ${result.categories || result.saved || 0}，属性 ${result.attributes || 0}`
      : `已同步 ${result.saved || 0} 个 Ozon 类目`);
  } finally {
    syncing.value = false;
  }
}

function onChange(value) {
  const item = categoryMap.value.get(value);
  emit("update:modelValue", value || "");
  if (item) emit("select", item);
}

function onTreeChange(value) {
  selectedValue.value = value || "";
  onChange(value);
}

async function resolveFromSku() {
  const sku = String(skuKeyword.value || "").trim();
  if (!sku) {
    ElMessage.warning("请输入 Ozon SKU 或 offer_id");
    return;
  }
  resolvingSku.value = true;
  try {
    const result = await apiClient.post("/api/listing/ozon-categories/resolve-from-sku", {
      sku,
      shop_id: props.shopId || undefined
    });
    const category = result.category;
    if (category?.ozon_category_id && !categoryMap.value.has(category.ozon_category_id)) {
      categories.value = [category, ...categories.value];
    }
    selectedValue.value = category?.ozon_category_id || "";
    treeValue.value = category?.ozon_category_id || "";
    emit("update:modelValue", selectedValue.value);
    if (category) emit("select", category);
    ElMessage.success(`已通过 SKU 绑定类目：${displayCategoryLabel(category) || selectedValue.value}`);
  } finally {
    resolvingSku.value = false;
  }
}

function hasCyrillic(value) {
  return /[\u0400-\u04ff]/.test(String(value || ""));
}

function cleanCategoryText(value) {
  return String(value || "").replace(/\s*>\s*/g, " / ").replace(/\s*\/\s*/g, " / ").trim();
}

function displayCategoryPath(category = {}) {
  const zh = cleanCategoryText(category.path_zh || category.pathZh || category.name_zh || category.nameZh || "");
  if (zh) return zh;
  const label = cleanCategoryText(category.label || category.name || "");
  if (label && !hasCyrillic(label)) return label;
  return category.ozon_category_id ? `待翻译类目 ${category.ozon_category_id}` : "";
}

function displayCategoryLabel(category = {}) {
  const path = displayCategoryPath(category);
  const ids = [category.description_category_id || category.descriptionCategoryId, category.type_id || category.typeId].filter(Boolean).join(":");
  return ids ? `${path} (${ids})` : path;
}

function displayCategorySubLabel(category = {}) {
  return cleanCategoryText(category.path_ru || category.pathRu || category.name_ru || category.nameRu || category.subLabel || "");
}

function buildCategoryTree(rows = []) {
  const roots = [];
  const branchMap = new Map();
  for (const category of rows) {
    const pathText = displayCategoryPath(category);
    const parts = String(pathText || "").split("/").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) parts.push(displayCategoryPath(category) || category.ozon_category_id);
    let children = roots;
    let branchKey = "";
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      branchKey = `${branchKey}/${part}`;
      if (isLeaf) {
        children.push({
          value: category.ozon_category_id,
          label: `${part} (${category.description_category_id}:${category.type_id})`,
          category
        });
        return;
      }
      let branch = branchMap.get(branchKey);
      if (!branch) {
        branch = { value: branchKey, label: part, children: [] };
        branchMap.set(branchKey, branch);
        children.push(branch);
      }
      children = branch.children;
    });
  }
  return roots;
}
</script>

<template>
  <div class="ozon-category-select">
    <div class="category-main-row">
      <el-select
        v-model="selectedValue"
        filterable
        remote
        clearable
        reserve-keyword
        :remote-method="remoteSearch"
        :loading="loading"
        :placeholder="placeholder"
        @change="onChange"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
        <el-option
          v-for="category in categories"
          :key="category.ozon_category_id"
          :label="displayCategoryLabel(category)"
          :value="category.ozon_category_id"
        >
          <div class="category-option">
            <span>{{ displayCategoryLabel(category) }}</span>
            <small v-if="displayCategorySubLabel(category)">Ozon 原文：{{ displayCategorySubLabel(category) }}</small>
          </div>
        </el-option>
      </el-select>
      <el-button :icon="Refresh" :loading="syncing" @click="syncCategories">{{ fullRefresh ? "刷新缓存" : "同步类目" }}</el-button>
      <template v-if="showSkuLookup">
        <el-input v-model="skuKeyword" clearable placeholder="粘贴 Ozon SKU / offer_id 自动识别类目" @keyup.enter="resolveFromSku" />
        <el-button :icon="Connection" :loading="resolvingSku" @click="resolveFromSku">按 SKU 识别</el-button>
      </template>
    </div>
    <el-cascader
      v-model="treeValue"
      class="category-tree-picker"
      filterable
      clearable
      :options="treeOptions"
      :props="cascaderProps"
      placeholder="或者像 Ozon 后台一样逐级展开选择类目"
      @change="onTreeChange"
    />
  </div>
</template>

<style scoped>
.ozon-category-select {
  display: grid;
  gap: 8px;
  width: 100%;
}

.category-main-row {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) auto minmax(240px, .7fr) auto;
  gap: 8px;
  width: 100%;
}

.category-main-row > .el-select {
  min-width: 0;
}

@media (max-width: 980px) {
  .category-main-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

.category-tree-picker {
  width: 100%;
}

.category-option {
  display: grid;
  gap: 2px;
  line-height: 1.25;
}

.category-option small {
  color: var(--el-text-color-secondary);
}
</style>
