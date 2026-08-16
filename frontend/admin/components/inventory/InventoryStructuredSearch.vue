<script setup>
import { computed, onMounted, reactive, watch } from "vue";
import { ElMessage } from "element-plus";
import { loadInventoryNamingOptions, loadInventoryVehicleCatalog } from "../../utils/inventory-naming-options.js";

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
const vehicleState = reactive({ loading: false, failed: false });

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
    options[type] = await loadInventoryNamingOptions(params);
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
  if (visible && !optionState[type].loading && (optionState[type].failed || !options[type].length)) loadOption(type);
}

async function loadVehicleCatalog() {
  if (vehicleState.loading) return;
  vehicleState.loading = true;
  vehicleState.failed = false;
  try {
    vehicleCatalog.brands = await loadInventoryVehicleCatalog();
  } catch (error) {
    vehicleCatalog.brands = [];
    vehicleState.failed = true;
    console.warn("加载车型目录失败", error);
  } finally {
    vehicleState.loading = false;
  }
}

onMounted(async () => {
  const results = await Promise.allSettled([loadVehicleCatalog(), loadOption("category")]);
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
        <el-select :model-value="modelValue.vehicleBrand" filterable clearable :loading="vehicleState.loading" :no-data-text="vehicleState.failed ? '加载失败，请重新打开下拉重试' : '暂无品牌数据'" placeholder="全部品牌" @visible-change="(visible) => visible && (vehicleState.failed || !vehicleCatalog.brands.length) && loadVehicleCatalog()" @update:model-value="update('vehicleBrand', $event)">
          <el-option v-for="brand in vehicleBrandOptions" :key="brand.value" :label="brand.label" :value="brand.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="车型">
        <el-select :model-value="modelValue.vehicleModel" multiple filterable clearable collapse-tags :loading="vehicleState.loading" :disabled="!modelValue.vehicleBrand" :no-data-text="vehicleState.failed ? '车型目录加载失败' : '当前品牌暂无车型'" placeholder="全部车型" @update:model-value="update('vehicleModel', $event)">
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
.inventory-structured-search {
  display: grid;
  grid-template-columns: minmax(420px, 3fr) minmax(680px, 5fr);
  gap: 12px;
  padding: 12px;
  border: 1px solid #e7ebf2;
  border-radius: 12px;
  background: #f6f8fb;
}
.search-group {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 12px;
  min-width: 0;
  padding: 14px 16px 16px;
  border: 1px solid #e7ebf2;
  border-radius: 10px;
  background: var(--el-bg-color);
  box-shadow: 0 1px 2px rgb(31 45 61 / 4%);
}
.search-group--spec { grid-template-columns: repeat(5, minmax(120px, 1fr)); }
.search-group__title {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 24px;
  padding-bottom: 10px;
  border-bottom: 1px solid #eef1f6;
}
.search-group__title::before {
  width: 4px;
  height: 16px;
  border-radius: 4px;
  background: var(--el-color-primary);
  content: "";
}
.search-group__title strong { color: var(--el-text-color-primary); font-size: 14px; }
.search-group__title span { color: var(--el-text-color-secondary); font-size: 12px; }
.inventory-structured-search :deep(.el-form-item) { display: block; min-width: 0; margin: 0; }
.inventory-structured-search :deep(.el-form-item__label) {
  display: block;
  height: auto;
  margin-bottom: 6px;
  padding: 0;
  color: var(--el-text-color-regular);
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  text-align: left;
}
.inventory-structured-search :deep(.el-form-item__content) { display: block; width: 100%; line-height: normal; }
.inventory-structured-search :deep(.el-select), .inventory-structured-search :deep(.el-input) { width: 100%; }
.inventory-structured-search :deep(.el-select__wrapper),
.inventory-structured-search :deep(.el-input__wrapper) { min-height: 34px; border-radius: 7px; }
.inventory-structured-search.is-compact { grid-template-columns: 1fr; }
@media (max-width: 1360px) {
  .inventory-structured-search { grid-template-columns: 1fr; }
}
@media (max-width: 820px) {
  .search-group, .search-group--spec { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
}
@media (max-width: 520px) {
  .inventory-structured-search { padding: 8px; }
  .search-group, .search-group--spec { grid-template-columns: 1fr; padding: 12px; }
  .search-group__title { align-items: flex-start; flex-wrap: wrap; }
  .search-group__title span { width: 100%; padding-left: 13px; }
}
</style>
