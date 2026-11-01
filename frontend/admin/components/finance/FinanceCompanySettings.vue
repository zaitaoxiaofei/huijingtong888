<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../../stores/auth";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { canAccessPage } from "../../../../src/shared/permissions.js";

const emit = defineEmits(["saved"]);
const auth = useAuthStore();
const companies = ref([]), loading = ref(false), saving = ref(false), form = ref(null);
let generation = 0;
async function load() {
  const token = ++generation;
  if (!canAccessPage(auth.user, "/finance-center")) return;
  loading.value = true;
  try {
    const response = await apiClient.get("/api/finance-center/companies", { noCache: true });
    if (token === generation) companies.value = response.companies || [];
  } catch (error) { if (token === generation) ElMessage.error(error.message); }
  finally { if (token === generation) loading.value = false; }
}
function edit(row = {}) { form.value = { ...row, name: row.name || "", tax_number: row.tax_number || "" }; }
async function save() {
  if (!form.value?.name?.trim()) return ElMessage.warning("请填写公司全称");
  const token = generation;
  saving.value = true;
  try {
    // Preserve existing bank/taxpayer fields while editing just these two fields.
    await apiClient.post("/api/finance-center/companies", { ...form.value, name: form.value.name.trim() });
    if (token !== generation) return;
    saving.value = false; form.value = null; emit("saved"); await load();
  } catch (error) { if (token === generation) ElMessage.error(error.message); }
  finally { if (token === generation) saving.value = false; }
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, canAccessPage(auth.user, "/finance-center"), currentApiCacheScope()], () => {
  generation++; saving.value = false; companies.value = []; form.value = null; load();
}, { immediate: true });
onBeforeUnmount(() => generation++);
</script>
<template>
  <section class="company-settings">
    <div class="company-toolbar"><p>报销与工资表使用这里的公司全称。</p><el-button :disabled="saving" @click="edit()">新增公司</el-button></div>
    <el-table v-loading="loading" :data="companies" empty-text="暂无公司，请先添加"><el-table-column prop="name" label="公司全称" min-width="210" /><el-table-column prop="tax_number" label="统一社会信用代码" min-width="165" /><el-table-column width="70"><template #default="{row}"><el-button link type="primary" :disabled="saving" @click="edit(row)">编辑</el-button></template></el-table-column></el-table>
    <el-form v-if="form" class="company-form" label-position="top" @submit.prevent="save"><h3>{{ form.id ? '编辑公司' : '新增公司' }}</h3><el-form-item label="公司全称" required><el-input v-model="form.name" maxlength="255" placeholder="与报销、工资表抬头一致" /></el-form-item><el-form-item label="统一社会信用代码"><el-input v-model="form.tax_number" maxlength="64" placeholder="选填" /></el-form-item><div class="form-actions"><el-button :disabled="saving" @click="form=null">取消</el-button><el-button type="primary" :loading="saving" native-type="submit">保存公司</el-button></div></el-form>
  </section>
</template>
<style scoped>
.company-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.company-toolbar p{margin:0;color:var(--el-text-color-secondary);font-size:13px}.company-form{margin-top:24px;padding-top:20px;border-top:1px solid var(--el-border-color-lighter)}.company-form h3{margin:0 0 18px;font-size:15px;font-weight:600}.form-actions{display:flex;justify-content:flex-end;gap:10px}
</style>
