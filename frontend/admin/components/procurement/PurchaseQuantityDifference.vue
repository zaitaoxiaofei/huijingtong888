<script setup>
defineProps({row:{type:Object,required:true},disabled:Boolean,allowCorrection:{type:Boolean,default:true}});
const emit=defineEmits(['correct','change']);
</script>
<template>
 <div class="purchase-quantity-difference">
  <el-select v-model="row.difference_kind" placeholder="请选择数量差异处理" :disabled="disabled" :aria-label="`批次 ${row.id} 数量差异处理`" @change="emit('change')">
   <el-option label="分批到货，余量继续待到货" value="partial"/>
   <el-option label="原采购总数录错，先更正采购记录" value="correction"/>
  </el-select>
  <template v-if="row.difference_kind==='partial'"><small>本次 {{row.actual}} 件，剩余 {{Number(row.quantity)-Number(row.actual)}} 件继续采购待到货；采购总数和金额不变。</small><el-input v-model="row.reason" maxlength="100" placeholder="如部分到货、验货不合格" :disabled="disabled" :aria-label="`批次 ${row.id} 数量差异原因`" @input="emit('change')"/></template>
  <template v-else-if="row.difference_kind==='correction'"><small>先按采购凭证核对总数和金额，并填写更正原因，再登记本次到货或入库。</small><el-button v-if="allowCorrection" type="warning" plain :disabled="disabled" @click="emit('correct',row)">核对并更正采购记录</el-button><small v-else>请联系采购人员更正，当前不提交此批次。</small></template>
 </div>
</template>
<style scoped>
.purchase-quantity-difference{display:grid;gap:8px}.purchase-quantity-difference small{color:var(--el-text-color-secondary);line-height:1.6}.purchase-quantity-difference .el-button{justify-self:start;margin:0}
</style>
