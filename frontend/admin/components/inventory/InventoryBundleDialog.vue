<script setup>
import MobileDialog from '../mobile/MobileDialog.vue';
import InventoryBundleDetails from './InventoryBundleDetails.vue';
import {ref} from 'vue';
defineProps({modelValue:Boolean,productId:Number,editable:Boolean,mobile:Boolean});
const emit=defineEmits(['update:modelValue','saved']);
const state=ref({canSave:false,busy:false,retrying:false}),panel=ref(null);
function saved(result){emit('saved',result);emit('update:modelValue',false);}
</script>
<template>
 <component :is="mobile?MobileDialog:'el-dialog'" :model-value="modelValue" :title="editable?'更新套装子库存':'套装库存明细'" width="min(800px,94vw)" class="inventory-bundle-dialog" append-to-body :close-on-click-modal="false" :show-close="!state.busy" :close-on-press-escape="!state.busy" @update:model-value="emit('update:modelValue',$event)">
  <InventoryBundleDetails v-if="modelValue" ref="panel" :product-id="productId" :editable="editable" external-actions @state="state=$event" @saved="saved" @cancel="emit('update:modelValue',false)"/>
  <template #footer><el-button :disabled="state.busy" @click="emit('update:modelValue',false)">{{editable?'取消':'关闭'}}</el-button><el-button v-if="editable" type="primary" :disabled="!state.canSave&&!state.retrying" :loading="state.busy" @click="panel?.save()">{{state.retrying?'重试确认':'一次确认更新所有子库存'}}</el-button></template>
 </component>
</template>
<style scoped>
:global(.inventory-bundle-dialog:not(.mobile-dialog)){display:flex;flex-direction:column;max-height:90vh;margin-top:5vh;margin-bottom:5vh}:global(.inventory-bundle-dialog:not(.mobile-dialog)>.el-dialog__header),:global(.inventory-bundle-dialog:not(.mobile-dialog)>.el-dialog__footer){flex:none}:global(.inventory-bundle-dialog:not(.mobile-dialog)>.el-dialog__body){flex:1;overflow:auto;min-height:0}
</style>
