<script setup>
import { computed, ref, watch } from "vue";
import { Search } from "@element-plus/icons-vue";
import { availableQuickTargets, parseQuickTargets, quickTargetHistory, vehicleTargetKey } from "../../utils/ai-variant-quick-targets.js";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  brands: { type: Array, default: () => [] },
  history: { type: Array, default: () => [] },
  sourceValue: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" }
});
const emit = defineEmits(["update:modelValue", "reload"]);
const keyword = ref("");
const activeBrand = ref("");
const filteredBrands = computed(() => {
  const search = vehicleTargetKey(keyword.value);
  return props.brands.map(brand => ({
    ...brand,
    models: (brand.models || []).filter(model => !search || vehicleTargetKey(`${brand.name} ${model.fullName} ${model.label || model.name || ""}`).includes(search))
  })).filter(brand => brand.models.length);
});
const currentBrand = computed(() => filteredBrands.value.find(brand => brand.name === activeBrand.value) || filteredBrands.value[0]);
const selectedKeys = computed(() => new Set(props.modelValue.map(vehicleTargetKey)));
const freshTargets = computed(() => availableQuickTargets(currentBrand.value?.models || [], props.sourceValue, props.history));
watch(() => props.brands, () => { activeBrand.value = ""; keyword.value = ""; });

function isSource(target) { return Boolean(props.sourceValue && vehicleTargetKey(target) === vehicleTargetKey(props.sourceValue)); }
function toggle(target, checked) {
  if (isSource(target)) return;
  emit("update:modelValue", checked ? parseQuickTargets([...props.modelValue, target]) : props.modelValue.filter(value => vehicleTargetKey(value) !== vehicleTargetKey(target)));
}
function selectFresh() { emit("update:modelValue", parseQuickTargets([...props.modelValue, ...freshTargets.value])); }
function historyFor(target) { return quickTargetHistory(target, props.history); }
function statusLabel(status) { return { completed: "已裂变", in_progress: "处理中", failed: "历史失败" }[status] || ""; }
function statusType(status) { return { completed: "success", in_progress: "warning", failed: "danger" }[status] || "info"; }
</script>

<template>
  <section class="quick-vehicle-picker" v-loading="loading" aria-label="车型库快速选择">
    <div class="picker-heading">
      <strong>从车型库勾选</strong>
      <span>复用 AI 裂变车型库 · 历史标记仅对应当前案例</span>
    </div>
    <div class="picker-toolbar">
      <el-input v-model="keyword" :prefix-icon="Search" clearable placeholder="搜索品牌或车型" aria-label="搜索品牌或车型" />
      <el-button size="small" :disabled="!freshTargets.length || loading" @click="selectFresh">勾选当前品牌未裂变车型</el-button>
    </div>
    <div v-if="error" class="picker-error" role="alert">
      <span>{{ error }}</span><el-button link type="primary" @click="emit('reload')">重新加载</el-button>
    </div>
    <div v-else-if="filteredBrands.length" class="picker-grid">
      <nav class="brand-list" aria-label="汽车品牌">
        <button v-for="brand in filteredBrands" :key="brand.name" type="button" :class="{ active: currentBrand?.name === brand.name }" :aria-pressed="currentBrand?.name === brand.name" @click="activeBrand = brand.name">
          <span>{{ brand.name }}</span><small>{{ brand.models.length }}</small>
        </button>
      </nav>
      <div class="model-list" :aria-label="`${currentBrand?.name || ''} 车型`">
        <el-checkbox v-for="model in currentBrand?.models || []" :key="model.fullName" :model-value="selectedKeys.has(vehicleTargetKey(model.fullName))" :disabled="isSource(model.fullName)" @change="checked => toggle(model.fullName, checked)">
          <span class="model-label">{{ model.fullName }}</span>
          <el-tag v-if="isSource(model.fullName)" size="small" type="info" effect="plain">母车型</el-tag>
          <el-tag v-else-if="historyFor(model.fullName)" size="small" :type="statusType(historyFor(model.fullName).status)" effect="plain">{{ statusLabel(historyFor(model.fullName).status) }}</el-tag>
        </el-checkbox>
      </div>
    </div>
    <div v-else-if="!loading" class="picker-empty">{{ keyword ? "未找到匹配车型，可切换关键词或手工补充。" : "车型库暂无车型，可先在 AI 裂变中维护，或手工补充。" }}</div>
    <p class="picker-hint">已裂变车型可勾选重新生成；批量勾选会跳过母车型、已裂变及处理中的车型。</p>
  </section>
</template>

<style scoped>
.quick-vehicle-picker { border: 1px solid var(--erp-border); border-radius: 8px; padding: 12px; color: var(--erp-text-main); background: var(--erp-surface); }
.picker-heading, .picker-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.picker-heading span, .picker-hint, .picker-empty { color: var(--erp-text-regular); font-size: 12px; }
.picker-toolbar { margin: 10px 0; }
.picker-toolbar .el-input { flex: 1; min-width: 170px; }
.picker-grid { display: grid; grid-template-columns: 148px minmax(0, 1fr); min-height: 180px; max-height: 250px; border: 1px solid var(--erp-border-light); border-radius: 6px; overflow: hidden; }
.brand-list { overflow-y: auto; padding: 6px; border-right: 1px solid var(--erp-border-light); background: var(--erp-surface-alt); }
.brand-list button { display: flex; justify-content: space-between; gap: 6px; width: 100%; border: 0; border-radius: 4px; padding: 8px; cursor: pointer; text-align: left; color: var(--erp-text-main); background: transparent; }
.brand-list button:hover, .brand-list button.active { color: var(--erp-primary); background: var(--erp-primary-soft); }
.brand-list small { color: var(--erp-text-regular); }
.model-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: 8px; padding: 10px; overflow-y: auto; }
.model-list :deep(.el-checkbox) { min-height: 42px; height: auto; margin: 0; padding: 8px; border: 1px solid var(--erp-border); border-radius: 6px; align-items: flex-start; }
.model-list :deep(.el-checkbox__label) { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; min-width: 0; white-space: normal; }
.model-label { overflow-wrap: anywhere; }
.picker-error { display: flex; gap: 8px; align-items: center; color: var(--erp-danger, #f56c6c); }
.picker-hint { margin: 10px 0 0; line-height: 1.5; }
.picker-empty { padding: 24px 4px; }
@media (max-width: 700px) { .picker-grid { grid-template-columns: 106px minmax(0, 1fr); } .model-list { grid-template-columns: 1fr; } }
</style>
