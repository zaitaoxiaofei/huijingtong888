<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Connection, Loading, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const props = defineProps({
  modelValue: { type: String, default: "" },
  shopId: { type: [String, Number], default: "" },
  fullRefresh: { type: Boolean, default: true },
  showSync: { type: Boolean, default: true },
  showSkuLookup: { type: Boolean, default: false },
  displayLabel: { type: String, default: "" },
  placeholder: { type: String, default: "搜索 Ozon 类目 / 中文名 / 俄文名 / ID" }
});

const emit = defineEmits(["update:modelValue", "select", "sync"]);

const categories = ref([]);
const loading = ref(false);
const syncing = ref(false);
const resolvingSku = ref(false);
const keyword = ref("");
const skuKeyword = ref("");
const selectedValue = ref(props.modelValue || "");
const searchPanelVisible = ref(false);
const selectRootRef = ref();
const categoryPopoverRef = ref();
const browsePath = ref([]);
const searchMode = ref(false);
const BROWSE_CATEGORY_LIMIT = 300;
const SEARCH_CATEGORY_LIMIT = 80;
let searchTimer = null;
let requestSeq = 0;

const categoryMap = computed(() => new Map(categories.value.map((category) => [category.ozon_category_id, category])));
const selectedCategory = computed(() => categoryMap.value.get(selectedValue.value) || null);
const isSearchMode = computed(() => searchMode.value && String(keyword.value || "").trim().length > 0);
const categoryTree = computed(() => buildCategoryTree(categories.value));
const browseColumns = computed(() => {
  const columns = [categoryTree.value];
  let children = categoryTree.value;
  for (const activeKey of browsePath.value) {
    const node = children.find((item) => item.key === activeKey);
    if (!node?.children?.length) break;
    children = node.children;
    columns.push(children);
  }
  return columns;
});

watch(() => props.modelValue, (value) => {
  selectedValue.value = value || "";
  if (!value) {
    keyword.value = "";
    return;
  }
  const category = categoryMap.value.get(value);
  if (category) keyword.value = displayCategoryLabel(category);
  else {
    keyword.value = displayModelValueLabel(value);
    loadCategories(value, { limit: 20, syncKeyword: true });
  }
});

watch(() => props.displayLabel, () => {
  if (!selectedValue.value) return;
  const category = categoryMap.value.get(selectedValue.value);
  keyword.value = category ? displayCategoryLabel(category) : displayModelValueLabel(selectedValue.value);
});

onMounted(() => {
  if (props.modelValue && props.displayLabel) keyword.value = displayModelValueLabel(props.modelValue);
  loadCategories(props.modelValue || "", { limit: props.modelValue ? 20 : BROWSE_CATEGORY_LIMIT, syncKeyword: Boolean(props.modelValue) });
  document.addEventListener("mousedown", handleDocumentMouseDown);
});

onBeforeUnmount(() => {
  if (searchTimer) window.clearTimeout(searchTimer);
  document.removeEventListener("mousedown", handleDocumentMouseDown);
});

async function loadCategories(query = "", options = {}) {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const params = new URLSearchParams();
    const cleanQuery = String(query || "").trim();
    if (cleanQuery) params.set("keyword", cleanQuery);
    params.set("limit", String(options.limit || 60));
    const rows = await apiClient.get(`/api/listing/ozon-categories?${params.toString()}`, { noCache: true });
    if (seq !== requestSeq) return;
    categories.value = Array.isArray(rows) ? rows : [];
    if (options.autoExpandQuery) {
      expandBestSearchMatch(cleanQuery, categories.value);
      scrollActiveCategoryIntoView();
    }
    if (options.syncKeyword && selectedValue.value) {
      const category = categoryMap.value.get(selectedValue.value);
      if (category) keyword.value = displayCategoryLabel(category);
      else keyword.value = displayModelValueLabel(selectedValue.value);
    }
  } finally {
    if (seq === requestSeq) loading.value = false;
    nextTick(() => categoryPopoverRef.value?.popperRef?.updatePopper?.());
  }
}

function scheduleSearch(query) {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    loadCategories(query, { limit: SEARCH_CATEGORY_LIMIT, autoExpandQuery: true });
  }, 180);
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
    await loadCategories(keyword.value, { limit: 60 });
    emit("sync", result);
    ElMessage.success(props.fullRefresh
      ? `类目缓存已刷新：类目 ${result.categories || result.saved || 0}，属性 ${result.attributes || 0}`
      : `已同步 ${result.saved || 0} 个 Ozon 类目`);
  } finally {
    syncing.value = false;
  }
}

function openSearchPanel() {
  searchPanelVisible.value = true;
  const cleanValue = String(keyword.value || "").trim();
  if (cleanValue) {
    searchMode.value = true;
    if (!categories.value.length) loadCategories(cleanValue, { limit: SEARCH_CATEGORY_LIMIT, autoExpandQuery: true });
  } else if (!categories.value.length) {
    loadCategories("", { limit: BROWSE_CATEGORY_LIMIT });
  }
  nextTick(() => categoryPopoverRef.value?.popperRef?.updatePopper?.());
}

function handleDocumentMouseDown(event) {
  if (!searchPanelVisible.value) return;
  const target = event.target;
  if (selectRootRef.value?.contains(target)) return;
  if (target?.closest?.(".ozon-category-popper")) return;
  searchPanelVisible.value = false;
}

function handleKeywordInput(value) {
  searchPanelVisible.value = true;
  const cleanValue = String(value || "").trim();
  selectedValue.value = "";
  if (!cleanValue) {
    searchMode.value = false;
    emit("update:modelValue", "");
    loadCategories("", { limit: BROWSE_CATEGORY_LIMIT });
    return;
  }
  searchMode.value = true;
  loading.value = true;
  browsePath.value = [];
  categories.value = [];
  scheduleSearch(cleanValue);
  nextTick(() => categoryPopoverRef.value?.popperRef?.updatePopper?.());
}

function clearSelection() {
  selectedValue.value = "";
  keyword.value = "";
  searchMode.value = false;
  emit("update:modelValue", "");
  loadCategories("", { limit: BROWSE_CATEGORY_LIMIT });
}

function selectCategory(category = {}) {
  if (!category?.ozon_category_id) return;
  selectedValue.value = category.ozon_category_id;
  keyword.value = displayCategoryLabel(category);
  searchMode.value = false;
  searchPanelVisible.value = false;
  emit("update:modelValue", selectedValue.value);
  emit("select", category);
}

function handleBrowseNode(node, columnIndex, shouldSelect = false) {
  browsePath.value = [...browsePath.value.slice(0, columnIndex), node.key];
  if (shouldSelect && node.category) selectCategory(node.category);
}

function isBrowseNodeActive(node, columnIndex) {
  return browsePath.value[columnIndex] === node.key || selectedValue.value === node.category?.ozon_category_id;
}

function selectFirstCategory() {
  const category = bestSearchMatch(String(keyword.value || "").trim(), categories.value)?.category || categories.value[0];
  if (category) selectCategory(category);
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
    keyword.value = category ? displayCategoryLabel(category) : selectedValue.value;
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
  return path;
}

function displayModelValueLabel(value = selectedValue.value) {
  const id = String(value || "").trim();
  const label = cleanCategoryText(props.displayLabel || "");
  if (!id) return label;
  if (!label) return "已选择 Ozon 类目，点击搜索中文类目";
  if (/^Ozon\s*类目\s*\d+\s*:\s*\d+$/i.test(label)) return "已选择 Ozon 类目，点击搜索中文类目";
  return label;
}

function displayCategorySubLabel(category = {}) {
  return cleanCategoryText(category.path_ru || category.pathRu || category.name_ru || category.nameRu || category.subLabel || "");
}

function displayPathParts(category = {}) {
  const parts = displayCategoryPath(category).split("/").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [displayCategoryLabel(category)].filter(Boolean);
}

function displayLeafName(category = {}) {
  const parts = displayPathParts(category);
  return parts[parts.length - 1] || displayCategoryLabel(category);
}

function categoryIdText(category = {}) {
  const ids = [category.description_category_id || category.descriptionCategoryId, category.type_id || category.typeId].filter(Boolean);
  return ids.length ? ids.join(":") : category.ozon_category_id || "";
}

function buildCategoryTree(rows = []) {
  const roots = [];
  const nodeMap = new Map();
  for (const category of rows) {
    const parts = displayPathParts(category);
    let children = roots;
    let pathKey = "";
    parts.forEach((part, index) => {
      pathKey = `${pathKey}/${part}`;
      const isLeaf = index === parts.length - 1;
      let node = nodeMap.get(pathKey);
      if (!node) {
        node = {
          key: pathKey,
          label: part,
          children: [],
          category: null
        };
        nodeMap.set(pathKey, node);
        children.push(node);
      }
      if (isLeaf) node.category = category;
      children = node.children;
    });
  }
  return roots;
}

function expandBestSearchMatch(query, rows = []) {
  const match = bestSearchMatch(query, rows);
  if (!match) {
    browsePath.value = [];
    return;
  }
  browsePath.value = pathKeysForParts(match.parts, match.expandIndex);
}

function scrollActiveCategoryIntoView() {
  nextTick(() => {
    const poppers = Array.from(document.querySelectorAll(".ozon-category-popper"));
    const popper = poppers[poppers.length - 1];
    const active = popper?.querySelector?.(".category-cascader-node.active, .category-result-item.active");
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });
}

function bestSearchMatch(query, rows = []) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;
  let best = null;
  for (const category of rows) {
    const parts = displayPathParts(category);
    const normalizedParts = parts.map(normalizeSearchText);
    const leafIndex = parts.length - 1;
    let score = -1;
    let expandIndex = leafIndex;

    normalizedParts.forEach((part, index) => {
      if (!part.includes(normalizedQuery)) return;
      const isLeaf = index === leafIndex;
      const exactBonus = part === normalizedQuery ? 300 : 0;
      const depthBonus = index * 80;
      const leafBonus = isLeaf ? 1000 : 0;
      const candidateScore = leafBonus + depthBonus + exactBonus + part.length;
      if (candidateScore > score) {
        score = candidateScore;
        expandIndex = index;
      }
    });

    if (score < 0 && normalizeSearchText(displayCategoryLabel(category)).includes(normalizedQuery)) {
      score = 100 + parts.length * 40;
      expandIndex = leafIndex;
    }

    if (score >= 0 && (!best || score > best.score)) {
      best = { category, parts, expandIndex, score };
    }
  }
  return best;
}

function pathKeysForParts(parts = [], expandIndex = 0) {
  const keys = [];
  let pathKey = "";
  const safeIndex = Math.min(Math.max(Number(expandIndex || 0), 0), parts.length - 1);
  for (let index = 0; index <= safeIndex; index += 1) {
    pathKey = `${pathKey}/${parts[index]}`;
    keys.push(pathKey);
  }
  return keys;
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}
</script>

<template>
  <div ref="selectRootRef" class="ozon-category-select">
    <div class="category-main-row" :class="{ 'is-clean': !showSync && !showSkuLookup }">
      <el-popover
        ref="categoryPopoverRef"
        v-model:visible="searchPanelVisible"
        trigger="manual"
        placement="bottom-start"
        :width="760"
        popper-class="ozon-category-popper"
      >
        <template #reference>
          <el-input
            v-model="keyword"
            clearable
            :placeholder="placeholder"
            @focus="openSearchPanel"
            @click="openSearchPanel"
            @input="handleKeywordInput"
            @clear="clearSelection"
            @keyup.enter="selectFirstCategory"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
            <template #suffix>
              <el-icon v-if="loading" class="is-loading"><Loading /></el-icon>
            </template>
          </el-input>
        </template>

        <div class="category-result-panel">
          <div class="category-result-head">
            <span>{{ isSearchMode ? "搜索类目" : "按层级选择类目" }}</span>
            <small>{{ loading ? "加载中..." : `显示 ${categories.length} 条` }}</small>
          </div>

          <div v-if="!loading && !categories.length" class="category-empty">
            没有找到匹配类目，可以换一个关键词或同步类目缓存。
          </div>

          <div v-if="categories.length" class="category-cascader-panel">
            <div v-for="(column, columnIndex) in browseColumns" :key="columnIndex" class="category-cascader-column">
              <button
                v-for="node in column"
                :key="node.key"
                type="button"
                class="category-cascader-node"
                :class="{ active: isBrowseNodeActive(node, columnIndex) }"
                @mouseenter="handleBrowseNode(node, columnIndex)"
                @mousedown.prevent="handleBrowseNode(node, columnIndex, true)"
              >
                <span>{{ node.label }}</span>
                <span v-if="node.children?.length" class="category-cascader-arrow">›</span>
              </button>
            </div>
          </div>

          <div v-if="loading" class="category-loading">正在加载类目...</div>
          <div v-if="selectedCategory" class="category-selected">
            当前已选：{{ displayCategoryLabel(selectedCategory) }}
          </div>
        </div>
      </el-popover>

      <el-button v-if="showSync" :icon="Refresh" :loading="syncing" @click="syncCategories">
        {{ fullRefresh ? "刷新缓存" : "同步类目" }}
      </el-button>

      <template v-if="showSkuLookup">
        <el-input v-model="skuKeyword" clearable placeholder="粘贴 Ozon SKU / offer_id 自动识别类目" @keyup.enter="resolveFromSku" />
        <el-button :icon="Connection" :loading="resolvingSku" @click="resolveFromSku">按 SKU 识别</el-button>
      </template>
    </div>
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

.category-main-row.is-clean {
  grid-template-columns: minmax(0, 1fr);
}

.category-main-row > :deep(.el-popover__reference-wrapper) {
  min-width: 0;
}

.category-main-row > :deep(.el-input) {
  min-width: 0;
}

@media (max-width: 980px) {
  .category-main-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}

:global(.ozon-category-popper) {
  padding: 0;
  max-width: min(760px, calc(100vw - 32px));
}

.category-result-panel {
  display: grid;
  max-height: 360px;
  overflow-y: auto;
  padding: 8px;
  gap: 6px;
}

.category-result-head,
.category-selected,
.category-empty,
.category-loading {
  padding: 8px 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.category-result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: -8px;
  z-index: 1;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.category-result-head span {
  color: var(--el-text-color-primary);
  font-weight: 600;
}

.category-cascader-panel {
  display: flex;
  min-height: 280px;
  max-height: 330px;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.category-result-list {
  display: grid;
  gap: 4px;
  max-height: 330px;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 6px;
  background: var(--el-bg-color);
}

.category-cascader-column {
  flex: 0 0 240px;
  min-width: 0;
  padding: 6px;
  overflow-y: auto;
  border-right: 1px solid var(--el-border-color-lighter);
}

.category-cascader-column:last-child {
  flex-basis: 360px;
  border-right: 0;
}

.category-cascader-node {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 7px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
}

.category-cascader-node span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-cascader-node:hover,
.category-cascader-node.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.category-cascader-arrow {
  color: var(--el-text-color-secondary);
  font-size: 18px;
  line-height: 1;
}

.category-result-item {
  display: grid;
  gap: 6px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-primary);
  text-align: left;
  cursor: pointer;
}

.category-sub {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-result-item:hover,
.category-result-item.active {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.category-leaf {
  font-weight: 600;
  line-height: 1.35;
}

.category-path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  color: var(--el-text-color-regular);
  font-size: 12px;
}

.category-path-node {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  max-width: 180px;
  padding: 2px 8px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-path-node + .category-path-node::before {
  content: "/";
  margin-right: 4px;
  color: var(--el-text-color-placeholder);
}

.category-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--el-text-color-secondary);
}
</style>
