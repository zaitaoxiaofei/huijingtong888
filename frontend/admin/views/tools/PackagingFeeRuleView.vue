<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { isPlatformAdmin } from "../../../../src/shared/permissions.js";
import { useAuthStore } from "../../stores/auth";
import { apiClient } from "../../utils/api";

const auth = useAuthStore();
const canEdit = computed(() => isPlatformAdmin(auth.user));
const loading = ref(false), saving = ref(false);
const rule = reactive({ low_sale_threshold_cny: 50, low_fee_cny: 0.5, high_fee_cny: 1 });
async function load() {
  loading.value = true;
  try { Object.assign(rule, await apiClient.get("/api/settings/packaging-fee-rule", { noCache: true })); }
  catch (error) { ElMessage.error(error.message || "包装费规则加载失败"); }
  finally { loading.value = false; }
}
async function save() {
  if (!canEdit.value) return;
  saving.value = true;
  try {
    const saved = await apiClient.post("/api/settings/packaging-fee-rule", {
      low_sale_threshold_cny: Number(rule.low_sale_threshold_cny), low_fee_cny: Number(rule.low_fee_cny), high_fee_cny: Number(rule.high_fee_cny)
    });
    Object.assign(rule, saved);
    ElMessage.success("包装费规则已保存");
  } catch (error) { ElMessage.error(error.message || "包装费规则保存失败"); }
  finally { saving.value = false; }
}
onMounted(load);
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="page-card">
    <template #header>
      <div class="page-card-header">
        <div><strong>包装费规则</strong><span>平台统一维护包装费，企业使用相同口径。</span></div>
        <div class="rule-actions"><el-button @click="load">刷新</el-button><el-button v-if="canEdit" type="primary" :loading="saving" @click="save">保存规则</el-button></div>
      </div>
    </template>
    <el-form label-width="180px" class="packaging-form" :disabled="!canEdit">
      <el-form-item label="销售额阈值 CNY"><el-input-number v-model="rule.low_sale_threshold_cny" :min="0" :precision="2" :step="1" controls-position="right" /></el-form-item>
      <el-form-item label="低档包装费 CNY"><el-input-number v-model="rule.low_fee_cny" :min="0" :precision="2" :step="0.1" controls-position="right" /></el-form-item>
      <el-form-item label="高档包装费 CNY"><el-input-number v-model="rule.high_fee_cny" :min="0" :precision="2" :step="0.1" controls-position="right" /></el-form-item>
    </el-form>
    <p>销售额不超过 CNY {{ Number(rule.low_sale_threshold_cny).toFixed(2) }} 时，包装费为 CNY {{ Number(rule.low_fee_cny).toFixed(2) }}；超过时为 CNY {{ Number(rule.high_fee_cny).toFixed(2) }}。</p>
    <p class="muted-text">{{ canEdit ? "保存不触发历史利润重算。" : "当前为只读，调整共用规则请联系平台管理员。" }}</p>
  </el-card>
</template>

<style scoped>
.packaging-form{max-width:720px}.rule-actions{display:flex;gap:10px}.muted-text{color:var(--el-text-color-secondary)}
@media (max-width: 767px) {
  .packaging-form :deep(.el-form-item) { display: block; }
  .packaging-form :deep(.el-form-item__label) { width: auto !important; height: auto; text-align: left; }
  .packaging-form :deep(.el-form-item__content) { margin-left: 0 !important; }
}
</style>
