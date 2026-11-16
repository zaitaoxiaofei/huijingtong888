<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../../stores/auth";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { canAccessPage } from "../../../../src/shared/permissions.js";

import {canReviewFinance} from "../../../../src/shared/finance-submissions.js";
const aiPolicy=ref(null),aiCompany=ref(''),aiMonth=ref(''),aiReason=ref(''),aiSaving=ref(false);
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
    if(canReviewFinance(auth.user)){const data=await apiClient.get("/api/finance-center/ai-cost-policy",{noCache:true});if(token===generation){aiPolicy.value=data.policy;aiCompany.value=data.policy?String(data.policy.company_id):'';aiMonth.value=data.policy?.effective_month||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()).slice(0,7);}}
  } catch (error) { if (token === generation) ElMessage.error(error.message); }
  finally { if (token === generation) loading.value = false; }
}
async function saveAiPolicy(){const token=generation;try{await ElMessageBox.confirm('归属设置会影响起始月份后的经营净利润；固定订阅费用仍单独记账，不重复计费。','确认AI成本归属');if(token!==generation)return;aiSaving.value=true;await apiClient.post('/api/finance-center/ai-cost-policy',{company_id:Number(aiCompany.value),effective_month:aiMonth.value,fallback_from:aiPolicy.value?.fallback_from,fallback_to:aiPolicy.value?.fallback_to,fallback_amount:Number(aiPolicy.value?.fallback_amount||0),expected_revision:Number(aiPolicy.value?.revision||0),reason:aiReason.value});if(token!==generation)return;aiReason.value='';emit('saved');await load();}catch(e){if(!['cancel','close'].includes(e))ElMessage.error(e.message||'保存失败');}finally{if(token===generation)aiSaving.value=false;}}
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
    <section v-if="canReviewFinance(auth.user)" class="company-form"><h3>系统图片按量费用归属</h3><p>固定GPT订阅在费用中单独录入；这里按调用量计入选定公司的经营成本。</p><el-select v-model="aiCompany" placeholder="选择承担公司" :disabled="aiSaving"><el-option v-for="c in companies" :key="c.id" :value="String(c.id)" :label="c.name"/></el-select><el-date-picker v-model="aiMonth" type="month" value-format="YYYY-MM" :clearable="false" :disabled="aiSaving"/><el-input v-model="aiReason" placeholder="填写调整原因，至少4字" maxlength="500" :disabled="aiSaving"/><el-button type="primary" :loading="aiSaving" :disabled="!aiCompany||aiReason.trim().length<4" @click="saveAiPolicy">保存AI归属</el-button></section>
    <el-form v-if="form" class="company-form" label-position="top" @submit.prevent="save"><h3>{{ form.id ? '编辑公司' : '新增公司' }}</h3><el-form-item label="公司全称" required><el-input v-model="form.name" maxlength="255" placeholder="与报销、工资表抬头一致" /></el-form-item><el-form-item label="统一社会信用代码"><el-input v-model="form.tax_number" maxlength="64" placeholder="选填" /></el-form-item><div class="form-actions"><el-button :disabled="saving" @click="form=null">取消</el-button><el-button type="primary" :loading="saving" native-type="submit">保存公司</el-button></div></el-form>
  </section>
</template>
<style scoped>
.company-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.company-toolbar p{margin:0;color:var(--el-text-color-secondary);font-size:13px}.company-form{margin-top:24px;padding-top:20px;border-top:1px solid var(--el-border-color-lighter)}.company-form h3{margin:0 0 18px;font-size:15px;font-weight:600}.form-actions{display:flex;justify-content:flex-end;gap:10px}
</style>
