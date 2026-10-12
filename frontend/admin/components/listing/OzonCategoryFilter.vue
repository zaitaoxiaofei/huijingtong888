<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { apiClient } from "../../utils/api";

const props = defineProps({ modelValue: { type: String, default: "" } });
const emit = defineEmits(["update:modelValue", "change"]);
const visible = ref(false);
const keyword = ref("");
const columns = ref([[]]);
const matches = ref([]);
const loading = ref(false);
let sequence = 0;
let timer;

async function browse(path = "", index = 0) {
  const current = ++sequence;
  loading.value = true;
  try {
    const params = new URLSearchParams({ mode: "browse" });
    if (path) params.set("parent_path", path);
    const result = await apiClient.get(`/api/listing/ozon-categories?${params}`, { noCache: true });
    if (current === sequence) columns.value = [...columns.value.slice(0, index), result.nodes || []];
  } finally {
    if (current === sequence) loading.value = false;
  }
}

async function search() {
  const current = ++sequence;
  const value = keyword.value.trim();
  if (!value) { matches.value = []; browse(); return; }
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/listing/ozon-categories?${new URLSearchParams({ keyword: value, limit: "200" })}`, { noCache: true });
    if (current === sequence) matches.value = Array.isArray(result) ? result : [];
  } finally {
    if (current === sequence) loading.value = false;
  }
}

function choose(path) {
  emit("update:modelValue", path);
  emit("change");
  visible.value = false;
}

function chooseNode(node, index) {
  if (node.has_children) browse(node.path, index + 1);
  else choose(node.path);
}

function onInput() {
  clearTimeout(timer);
  timer = setTimeout(search, 200);
}

onMounted(() => browse());
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <el-popover v-model:visible="visible" trigger="click" placement="bottom-start" :width="620">
    <template #reference>
      <el-button class="category-filter-trigger">{{ props.modelValue || "全部 Ozon 类目" }}</el-button>
    </template>
    <el-input v-model="keyword" clearable placeholder="输入中文或俄文类目名称" @input="onInput" />
    <div class="category-filter-actions">
      <el-button size="small" @click="choose('')">全部类目</el-button>
    </div>
    <div v-loading="loading" class="category-filter-list">
      <template v-if="keyword">
        <el-button v-for="item in matches" :key="item.ozon_category_id" text class="category-filter-item" @click="choose(item.path_zh || item.path_ru || item.name_zh || item.name_ru)">{{ item.path_zh || item.path_ru || item.name_zh || item.name_ru }}</el-button>
      </template>
      <div v-else v-for="(column, index) in columns" :key="index" class="category-filter-column">
        <el-button v-for="node in column" :key="node.key" text class="category-filter-item" @click="chooseNode(node, index)">{{ node.label }}{{ node.has_children ? " ›" : "" }}</el-button>
        <el-button v-if="index > 0 && column.length" text type="primary" class="category-filter-item" @click="choose(column[0].path.split(' / ').slice(0, -1).join(' / '))">选择此级类目</el-button>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.category-filter-trigger { width: 100%; justify-content: flex-start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.category-filter-actions { display: flex; gap: 6px; margin: 8px 0; }
.category-filter-list { display: flex; max-height: 300px; overflow: auto; border: 1px solid #e5eaf3; }
.category-filter-column { min-width: 180px; display: flex; flex-direction: column; align-items: stretch; border-right: 1px solid #e5eaf3; }
.category-filter-item { justify-content: flex-start; margin: 0 !important; padding: 6px 10px; white-space: normal; text-align: left; height: auto; }
</style>
