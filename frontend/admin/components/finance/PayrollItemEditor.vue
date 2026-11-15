<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import { normalizePayrollEntry, PAYROLL_EMPLOYER_FIELDS, PAYROLL_EMPLOYEE_FIELDS } from "../../../../src/shared/payroll-entry.js";
const props = defineProps({ modelValue: Boolean, row: { type: Object, default: null }, companies: { type: Array, default: () => [] }, companyId: { type: String, default: "all" }, month: { type: String, required: true }, copy: Boolean });
const emit = defineEmits(["update:modelValue", "saved"]);
const form = reactive({}), saving = ref(false);
let generation = 0;
const editing = computed(() => Boolean(props.row?.id && !props.copy));
const parts = (fields, values) => values && fields.every(([key]) => values[key] != null) ? Object.fromEntries(fields.map(([key]) => [key, Number(values[key])])) : null;
watch(() => props.modelValue, open => {
  generation++; saving.value = false;
  if (!open) return;
  const row = props.row;
  Object.assign(form, { company_id: String(row?.company_id || (props.companyId !== "all" ? props.companyId : props.companies[0]?.id || "")), month: row?.month || props.month,
    person_name: row?.person_name || "", department: row?.department || "", base: Number(row?.base || 0), tax: Number(row?.tax || 0), employer: Number(row?.employer || 0), employee: Number(row?.employee || 0), confirmation: row?.confirmation || "",
    employer_items: row ? parts(PAYROLL_EMPLOYER_FIELDS, row.employer_items) : Object.fromEntries(PAYROLL_EMPLOYER_FIELDS.map(([key])=>[key,0])),
    employee_items: row ? parts(PAYROLL_EMPLOYEE_FIELDS, row.employee_items) : Object.fromEntries(PAYROLL_EMPLOYEE_FIELDS.map(([key])=>[key,0])) });
}, { immediate: true });
const cents = value => Math.round(Number(value || 0) * 100);
const total = side => form[side + '_items'] ? Object.values(form[side + '_items']).reduce((sum,value)=>sum+cents(value),0)/100 : Number(form[side] || 0);
const net = computed(() => (cents(form.base)-cents(total('employee'))-cents(form.tax))/100);
const cost = computed(() => (cents(form.base)+cents(total('employer')))/100);
const money = value => Number(value || 0).toFixed(2);
async function save() {
  let entry;
  try { if (!form.company_id) throw Error("请选择归属公司"); entry = normalizePayrollEntry(form); } catch (error) { ElMessage.warning(error.message); return; }
  const token = generation; saving.value = true;
  try {
    const result = await apiClient.post('/api/finance-submissions/payroll-item', { ...entry, company_id: Number(form.company_id), item_id: editing.value ? props.row.id : null, expected_revision: editing.value ? props.row.revision : undefined });
    if (token !== generation) return;
    emit('saved',{...result,month:entry.month,company_id:Number(form.company_id)}); emit('update:modelValue',false);
    ElMessage.success(result.status === 'approved' ? '工资明细已保存，原工资费用已同步' : '工资明细已保存，审批通过后计入账单');
  } catch(error) { if (token === generation) ElMessage.error(error.message || '保存工资明细失败'); }
  finally { if (token === generation) saving.value=false; }
}
</script>
<template>
  <el-dialog :model-value="modelValue" :title="editing ? '编辑工资明细' : copy ? '复制新增工资明细' : '新增工资明细'" width="min(96vw, 920px)" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" destroy-on-close @update:model-value="emit('update:modelValue',$event)">
    <el-form label-position="top" @submit.prevent="save">
      <div class="payroll-entry-grid">
        <el-form-item label="归属公司"><el-select v-model="form.company_id" :disabled="editing || saving" aria-label="明细归属公司"><el-option v-for="company in companies" :key="company.id" :value="String(company.id)" :label="company.name" /></el-select></el-form-item>
        <el-form-item label="工资月份"><el-date-picker v-model="form.month" type="month" value-format="YYYY-MM" :clearable="false" :disabled="editing || saving" aria-label="明细工资月份" /></el-form-item>
        <el-form-item label="员工姓名"><el-input v-model="form.person_name" maxlength="128" :disabled="saving" aria-label="员工姓名" /></el-form-item>
        <el-form-item label="部门"><el-input v-model="form.department" maxlength="128" :disabled="saving" aria-label="员工部门" /></el-form-item>
        <el-form-item label="基本工资（元）"><el-input-number v-model="form.base" :min="0" :max="100000000" :precision="2" :disabled="saving" aria-label="基本工资" /></el-form-item>
        <el-form-item label="个税（元）"><el-input-number v-model="form.tax" :min="0" :max="100000000" :precision="2" :disabled="saving" aria-label="工资个税" /></el-form-item>
      </div>
      <section v-for="side in ['employer','employee']" :key="side" class="contribution-entry">
        <h3>{{ side === 'employer' ? '公司承担缴费' : '个人扣缴费用' }} · 合计 ¥{{ money(total(side)) }}</h3>
        <div v-if="form[side+'_items']" class="payroll-entry-grid contribution-grid"><el-form-item v-for="[key,label] in side === 'employer' ? PAYROLL_EMPLOYER_FIELDS : PAYROLL_EMPLOYEE_FIELDS" :key="key" :label="label"><el-input-number v-model="form[side+'_items'][key]" :min="0" :max="100000000" :precision="2" :disabled="saving" :aria-label="(side === 'employer' ? '单位' : '个人') + label" /></el-form-item></div>
        <el-form-item v-else label="旧记录未保存分项，按原合计编辑（元）"><el-input-number v-model="form[side]" :min="0" :max="100000000" :precision="2" :disabled="saving" :aria-label="side === 'employer' ? '单位缴费合计' : '个人缴费合计'" /></el-form-item>
      </section>
      <div class="entry-totals"><span>员工实发工资：<strong>¥{{ money(net) }}</strong></span><span>公司人工总支出：<strong>¥{{ money(cost) }}</strong></span></div>
      <p class="entry-note">实发工资 = 基本工资 − 个人缴费 − 个税；公司总支出 = 基本工资 + 公司缴费。已审批月份保存后同步原工资费用，累计已发金额保持不变。</p>
      <p v-if="editing && Number(row?.paid_amount || 0) > net" class="entry-note overpaid">当前已发 ¥{{ money(row.paid_amount) }} 超过修改后的实发工资，请单独核对发放记录。</p>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="emit('update:modelValue',false)">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存工资明细</el-button></template>
  </el-dialog>
</template>
<style scoped>
.payroll-entry-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.payroll-entry-grid :deep(.el-select),.payroll-entry-grid :deep(.el-date-editor),.payroll-entry-grid :deep(.el-input-number){width:100%}.contribution-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.contribution-entry{border-top:1px solid var(--el-border-color-light);padding-top:8px}.contribution-entry h3{font-size:14px}.entry-totals{display:flex;gap:24px;flex-wrap:wrap;font-size:15px}.entry-note{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.overpaid{color:var(--el-color-warning)}@media(max-width:600px){.payroll-entry-grid,.contribution-grid{grid-template-columns:1fr}}
</style>
