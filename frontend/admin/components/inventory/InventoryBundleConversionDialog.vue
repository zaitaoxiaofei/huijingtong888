<script setup>
import {ElDialog} from 'element-plus';
import {ref} from 'vue';
import MobileDialog from '../mobile/MobileDialog.vue';
import InventoryBundleConversion from './InventoryBundleConversion.vue';
defineProps({modelValue:Boolean,productId:Number,mobile:Boolean});
const emit=defineEmits(['update:modelValue','saved','busy']);
const panel=ref(null),state=ref({canSave:false,busy:false,retrying:false,label:'确认组装'});
function saved(result){emit('saved',result);emit('update:modelValue',false);}
function updateState(value){state.value=value;emit('busy',value.busy);}
</script>
<template>
 <component :is="mobile?MobileDialog:ElDialog" v-if="modelValue" :model-value="modelValue" title="库存转换 · 套装组装 / 拆包" width="min(1280px,96vw)" class="inventory-bundle-conversion-dialog" append-to-body :close-on-click-modal="false" :show-close="!state.busy" :close-on-press-escape="!state.busy" @update:model-value="emit('update:modelValue',$event)">
  <InventoryBundleConversion ref="panel" :product-id="productId" form-open external-actions @state="updateState" @saved="saved"/>
  <template #footer><el-button :disabled="state.busy" @click="emit('update:modelValue',false)">取消</el-button><el-button type="primary" :loading="state.busy" :disabled="!state.canSave&&!state.retrying" @click="panel?.save()">{{state.label}}</el-button></template>
 </component>
</template>
<style scoped>
:global(.inventory-bundle-conversion-dialog:not(.mobile-dialog)){display:flex;flex-direction:column;max-height:90vh;margin-top:5vh;margin-bottom:5vh}:global(.inventory-bundle-conversion-dialog:not(.mobile-dialog)>.el-dialog__header),:global(.inventory-bundle-conversion-dialog:not(.mobile-dialog)>.el-dialog__footer){flex:none}:global(.inventory-bundle-conversion-dialog:not(.mobile-dialog)>.el-dialog__body){flex:1;overflow:auto;min-height:0}
</style>
