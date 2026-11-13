<script setup>
import {computed,defineAsyncComponent} from 'vue';
import {useRoute,useRouter} from 'vue-router';
const Workspace=defineAsyncComponent(()=>import('../../components/inventory/InventorySupplyWorkspace.vue'));
const LegacyReceiving=defineAsyncComponent(()=>import('../procurement/PurchaseListView.vue'));
const route=useRoute(),router=useRouter();
// Preserve existing notification, order and filtered record links in the original editor.
const legacy=computed(()=>Object.keys(route.query).some(key=>!['product_id'].includes(key)));
function clearProduct(){router.replace({query:{...route.query,product_id:undefined}});}
</script>
<template>
 <div class="page-stack">
  <template v-if="legacy"><div><el-button @click="router.push('/purchase-list')">返回收货工作平台</el-button></div><LegacyReceiving/></template>
  <Workspace v-else entry="inventory" :product-id="Number(route.query.product_id)||0" @clear-product="clearProduct"/>
 </div>
</template>
