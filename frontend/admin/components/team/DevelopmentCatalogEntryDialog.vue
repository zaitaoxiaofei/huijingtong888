<script setup>
import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { invalidateInventoryNamingOptions, invalidateInventoryVehicleCatalog } from "../../utils/inventory-naming-options.js";

const props = defineProps({ kind: { type: String, default: "model" }, brand: { type: String, default: "" }, brands: { type: Array, default: () => [] } });
const emit = defineEmits(["close", "saved"]);
const saving = ref(false);
const form = reactive({ category: "", brand: props.brand, model: "" });
const title = computed(() => ({ category: "新增开发类目", brand: "新增汽车品牌", model: "新增车型" })[props.kind]);
async function save() {
  const brand = form.brand.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
  if (props.kind === "category" && !form.category.trim()) return ElMessage.warning("请填写开发类目（核心品名）");
  if (props.kind !== "category" && !brand) return ElMessage.warning("请选择或填写汽车品牌");
  if (props.kind === "model" && !form.model.trim()) return ElMessage.warning("请填写品牌下的具体车型");
  saving.value = true;
  try {
    if (props.kind === "category") {
      const result = await apiClient.post("/api/inventory-product-naming/options", { option_type: "category", value: form.category.trim() });
      invalidateInventoryNamingOptions();
      ElMessage.success(result.status === "pending" ? "类目已提交审核，请经理或管理员在库存建品的标准选项中审核，通过后可选择" : "类目已保存，可以在坐标表选择");
      emit("saved", { kind: "category", value: result.value, pending: result.status === "pending" });
    } else {
      const result = await apiClient.post("/api/ai-variant-lab/vehicle-catalog", { brand, model: form.model.trim() });
      invalidateInventoryVehicleCatalog();
      ElMessage.success(props.kind === "brand" && !form.model.trim() ? "品牌已保存，可继续为该品牌添加车型" : "品牌和车型已保存，可以在坐标表选择");
      emit("saved", { kind: props.kind, brand: result.brand || brand, model: result.model || form.model.trim() });
    }
  } catch (error) { ElMessage.error(error.message || "目录保存失败，请重试"); }
  finally { saving.value = false; }
}
</script>

<template>
  <el-dialog :model-value="true" :title="title" width="min(520px,94vw)" append-to-body align-center :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <el-form label-position="top" @submit.prevent="save">
      <template v-if="kind === 'category'"><el-form-item label="开发类目（核心品名）" required><el-input v-model="form.category" maxlength="7" show-word-limit placeholder="例如：门槛条" /></el-form-item><p class="catalog-hint">复用库存标准类目，最多 7 个字。经理或管理员添加后即可使用，其他有建品权限的人员提交后需审核。</p></template>
      <template v-else><el-form-item label="汽车品牌（英文大写）" required><el-select v-if="kind === 'model'" v-model="form.brand" filterable placeholder="选择所属品牌" style="width:100%"><el-option v-for="item in brands" :key="item.name" :label="item.name" :value="item.name" /></el-select><el-input v-else v-model="form.brand" maxlength="128" placeholder="例如：PROTON" @blur="form.brand=form.brand.trim().toUpperCase()" /></el-form-item><el-form-item :label="kind === 'brand' ? '首个车型（选填）' : '具体车型'" :required="kind === 'model'"><el-input v-model="form.model" maxlength="191" placeholder="例如：X70" /></el-form-item><p class="catalog-hint">品牌会统一保存为英文大写。车型保留原名称；请确认所属品牌，品牌名中不要混入车型。已有记录会复用，不会新建重复车型。</p></template>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="emit('close')">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存到目录</el-button></template>
  </el-dialog>
</template>

<style scoped>.catalog-hint{font-size:13px;color:#64748b;line-height:1.8}</style>
