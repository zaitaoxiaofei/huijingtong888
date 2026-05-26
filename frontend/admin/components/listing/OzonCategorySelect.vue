<script setup>
import { onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const props = defineProps({
  modelValue: { type: String, default: "" },
  shopId: { type: [String, Number], default: "" },
  fullRefresh: { type: Boolean, default: true },
  placeholder: { type: String, default: "搜索 Ozon 真实类目 / 中文名 / 俄文名 / ID" }
});

const emit = defineEmits(["update:modelValue", "select", "sync"]);

const categories = ref([]);
const loading = ref(false);
const syncing = ref(false);
const keyword = ref("");
const selectedValue = ref(props.modelValue || "");

watch(() => props.modelValue, (value) => {
  selectedValue.value = value || "";
});

onMounted(() => {
  loadCategories("");
});

async function loadCategories(query = "") {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (query) params.set("keyword", query);
    params.set("limit", "80");
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
      ? `类目缓存已刷新：类目 ${result.categories || 0}，属性 ${result.attributes || 0}`
      : `已同步 ${result.saved || 0} 个 Ozon 类目`);
  } finally {
    syncing.value = false;
  }
}

function onChange(value) {
  const item = categories.value.find((category) => category.ozon_category_id === value);
  emit("update:modelValue", value || "");
  if (item) emit("select", item);
}
</script>

<template>
  <div class="ozon-category-select">
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
        :label="category.label"
        :value="category.ozon_category_id"
      >
        <div class="category-option">
          <span>{{ category.label }}</span>
          <small>{{ category.subLabel }}</small>
        </div>
      </el-option>
    </el-select>
    <el-button :icon="Refresh" :loading="syncing" @click="syncCategories">{{ fullRefresh ? "刷新缓存" : "同步类目" }}</el-button>
  </div>
</template>

<style scoped>
.ozon-category-select {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
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
