<script setup>
import { computed, onMounted, reactive, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  compact: { type: Boolean, default: false }
});
const emit = defineEmits(["update:modelValue", "change"]);
const optionTypes = ["category", "accessory", "color", "material", "process"];
const dependentOptionTypes = optionTypes.filter((type) => type !== "category");
const options = reactive(Object.fromEntries(optionTypes.map((type) => [type, []])));
const optionState = reactive(Object.fromEntries(optionTypes.map((type) => [type, { loading: false, failed: false }])));
const vehicleCatalog = reactive({ brands: [] });

const vehicleBrandOptions = computed(() => vehicleCatalog.brands.map((brand) => ({ value: brand.name, label: brand.label || [brand.nameZh, brand.name].filter(Boolean).join(" ") })));
const vehicleModelOptions = computed(() => {
  const brand = vehicleCatalog.brands.find((item) => item.name === props.modelValue.vehicleBrand);
  return Array.isArray(brand?.models) ? brand.models : [];
});

function update(key, value) {
  if (key === "inventoryCategory" && Array.from(String(value || "").trim()).length > 7) {
    ElMessage.warning("核心品名最多 7 个字");
    return;
  }
  const next = { ...props.modelValue, [key]: value ?? "" };
  if (key === "vehicleBrand") next.vehicleModel = [];
  emit("update:modelValue", next);
  emit("change");
}

async function loadOption(type) {
  const category = type === "category" ? "" : String(props.modelValue.inventoryCategory || "").trim();
  if (type === "accessory" && !category) {
    options.accessory = [];
    optionState.accessory.failed = false;
    return;
  }
  optionState[type].loading = true;
  optionState[type].failed = false;
  try {
    const params = new URLSearchParams({ type });
    if (category) params.set("category", category);
    const brand = String(props.modelValue.vehicleBrand || "").trim();
    const fitmentType = String(props.modelValue.fitmentType || "").trim();
    const vehicleModels = Array.isArray(props.modelValue.vehicleModel) ? props.modelValue.vehicleModel : [];
    if (brand) params.set("brand", brand);
    if (fitmentType) params.set("fitment_type", fitmentType);
    if (vehicleModels.length === 1) params.set("vehicle_model", vehicleModels[0]);
    const result = await apiClient.get(`/api/inventory-product-naming/options?${params}`, {
      noCache: true,
      routeScoped: false
    });
    options[type] = Array.isArray(result?.rows) ? result.rows : [];
  } catch (error) {
    options[type] = [];
    optionState[type].failed = true;
    console.warn(`加载库存命名选项失败: ${type}`, error);
  } finally {
    optionState[type].loading = false;
  }
}

function optionLabel(item) {
  const count = Number(item?.linked_product_count ?? item?.usage_count ?? 0);
  return count > 0 ? `${item.label} · ${count}` : item.label;
}

function noDataText(type) {
  if (optionState[type].failed) return "加载失败，请重新打开下拉重试";
  if (type === "accessory" && !props.modelValue.inventoryCategory) return "请先选择核心品名";
  return "暂无可选项";
}

function retryOption(type, visible) {
  if (visible && (optionState[type].failed || !options[type].length)) loadOption(type);
}

async function loadVehicleCatalog() {
  const result = await apiClient.get("/api/ai-variant-lab/vehicle-catalog", {
    noCache: true,
    routeScoped: false
  });
  vehicleCatalog.brands = Array.isArray(result?.brands) ? result.brands : [];
}

onMounted(async () => {
  const results = await Promise.allSettled([loadVehicleCatalog(), loadOption("category"), ...dependentOptionTypes.map(loadOption)]);
  if (results.every((result) => result.status === "rejected") || optionState.category.failed) {
    ElMessage.warning("核心品名加载失败，请重新打开下拉重试");
  }
});

watch(() => props.modelValue.inventoryCategory, async (category, previousCategory) => {
  if (category === previousCategory) return;
  if (props.modelValue.accessoryName) update("accessoryName", "");
  await Promise.allSettled(dependentOptionTypes.map(loadOption));
});

watch(
  () => [
    props.modelValue.vehicleBrand,
    props.modelValue.fitmentType,
    Array.isArray(props.modelValue.vehicleModel) ? props.modelValue.vehicleModel.join("|") : ""
  ],
  async (nextContext, previousContext) => {
    if (nextContext.join("|") === previousContext.join("|")) return;
    await Promise.allSettled(["color", "material", "process"].map(loadOption));
  }
);
</script>

<template>
  <div class="inventory-structured-search" :class="{ 'is-compact': compact }">
    <div class="search-group search-group--identity">
      <div class="search-group__title"><strong>产品身份</strong><span>汽车品牌和车型不选表示不限制搜索条件</span></div>
      <el-form-item label="核心品名">
        <el-select :model-value="modelValue.inventoryCategory" filterable clearable :loading="optionState.category.loading" :no-data-text="noDataText('category')" placeholder="输入或选择核心品名" @visible-change="retryOption('category', $event)" @update:model-value="update('inventoryCategory', $event)">
          <el-option v-for="item in options.category" :key="item.id || item.value" :label="optionLabel(item)" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="汽车品牌">
        <el-select :model-value="modelValue.vehicleBrand" filterable clearable placeholder="全部品牌" @update:model-value="update('vehicleBrand', $event)">
          <el-option v-for="brand in vehicleBrandOptions" :key="brand.value" :label="brand.label" :value="brand.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="车型">
        <el-select :model-value="modelValue.vehicleModel" multiple filterable clearable collapse-tags :disabled="!modelValue.vehicleBrand" placeholder="全部车型" @update:model-value="update('vehicleModel', $event)">
          <el-option v-for="model in vehicleModelOptions" :key="model.id || model.name" :label="model.label || model.name" :value="model.name" />
        </el-select>
      </el-form-item>
    </div>
    <div class="search-group search-group--spec">
      <div class="search-group__title"><strong>规格属性</strong><span>未选择表示不限制</span></div>
      <el-form-item label="颜色">
        <el-select :model-value="modelValue.color" filterable clearable :loading="optionState.color.loading" :no-data-text="noDataText('color')" placeholder="全部颜色" @visible-change="retryOption('color', $event)" @update:model-value="update('color', $event)">
          <el-option v-for="item in options.color" :key="item.value" :label="optionLabel(item)" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="款式">
        <el-select :model-value="modelValue.accessoryName" filterable clearable :loading="optionState.accessory.loading" :no-data-text="noDataText('accessory')" :disabled="!modelValue.inventoryCategory" placeholder="选择款式" @visible-change="retryOption('accessory', $event)" @update:model-value="update('accessoryName', $event)">
          <el-option v-for="item in options.accessory" :key="item.value" :label="optionLabel(item)" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="材质">
        <el-select :model-value="modelValue.material" multiple filterable clearable collapse-tags :loading="optionState.material.loading" :no-data-text="noDataText('material')" placeholder="全部材质" @visible-change="retryOption('material', $event)" @update:model-value="update('material', $event)">
          <el-option v-for="item in options.material" :key="item.value" :label="optionLabel(item)" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="工艺">
        <el-select :model-value="modelValue.process" filterable clearable :loading="optionState.process.loading" :no-data-text="noDataText('process')" placeholder="全部工艺" @visible-change="retryOption('process', $event)" @update:model-value="update('process', $event)">
          <el-option v-for="item in options.process" :key="item.value" :label="optionLabel(item)" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="产品名称">
        <el-input :model-value="modelValue.productName" clearable placeholder="补充名称关键词" @update:model-value="update('productName', $event)" />
      </el-form-item>
    </div>
  </div>
</template>

<style scoped>
.inventory-structured-search { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-fill-color-extra-light); }
.search-group { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 10px 14px; }
.search-group--spec { grid-template-columns: repeat(5, minmax(150px, 1fr)); }
.search-group__title { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 10px; }
.search-group__title span { color: var(--el-text-color-secondary); font-size: 12px; }
.inventory-structured-search :deep(.el-form-item) { margin: 0; }
.inventory-structured-search :deep(.el-select), .inventory-structured-search :deep(.el-input) { width: 100%; }
@media (max-width: 1100px) { .search-group, .search-group--spec { grid-template-columns: repeat(2, minmax(160px, 1fr)); } }
</style>
