<script setup>
import {computed,defineAsyncComponent,provide,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import OrderWorkModeSwitch from '../../../orders/components/OrderWorkModeSwitch.vue';
const OrdersPage=defineAsyncComponent(()=>import('../../../orders/OrdersPage.vue'));
const InventorySupplyWorkspace=defineAsyncComponent(()=>import('../../components/inventory/InventorySupplyWorkspace.vue'));
const route=useRoute(),router=useRouter(),ordersPageRef=ref(null);
const mode=computed({get:()=>route.query.mode==='inventory'?'inventory':'print',set:value=>router.replace({query:{...route.query,mode:value==='inventory'?'inventory':undefined,product_id:value==='inventory'?route.query.product_id:undefined}})});
provide('orders-work-mode',{mode});
const printMounted=ref(mode.value==='print');
watch(mode,value=>{if(value==='print')printMounted.value=true;});
</script>
<template>
 <div class="orders-mode-page">

  <div class="orders-print-workspace" v-if="printMounted" v-show="mode==='print'"><OrdersPage ref="ordersPageRef"/></div>
  <InventorySupplyWorkspace v-if="mode==='inventory'" role="warehouse" :product-id="Number(route.query.product_id)||0" @clear-product="router.replace({query:{...route.query,product_id:undefined}})"><template #heading-actions><OrderWorkModeSwitch :mode="mode" @change="mode=$event"/></template></InventorySupplyWorkspace>
 </div>
</template>
<style scoped>
.orders-mode-page{display:grid;gap:18px;min-width:0}.orders-print-workspace{min-width:0;max-width:100%;overflow:hidden}
</style>
