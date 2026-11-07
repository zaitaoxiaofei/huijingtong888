<script setup>
import {computed,defineAsyncComponent,ref,watch,onBeforeUnmount} from 'vue';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
const History=defineAsyncComponent(()=>import('./InventoryProductHistoryDialog.vue'));
const props=defineProps({productId:{type:Number,required:true},mobile:Boolean});
const auth=useAuthStore(),visible=ref(false),canRead=computed(()=>hasPermission(auth.user,'inventory.read'));
function close(){visible.value=false;}
watch(()=>props.productId,close);
window.addEventListener('erp:auth-scope-changed',close);
onBeforeUnmount(()=>window.removeEventListener('erp:auth-scope-changed',close));
</script>
<template>
 <el-button v-if="canRead&&productId>0" plain size="small" class="inventory-product-history-action" @click.stop="visible=true">历史版本</el-button>
 <History v-if="visible&&canRead" v-model="visible" :product-id="productId" :mobile="mobile"/>
</template>
