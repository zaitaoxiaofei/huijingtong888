<script setup>
import {computed,defineAsyncComponent,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
const OrdersPage=defineAsyncComponent(()=>import('../../../orders/OrdersPage.vue'));
const InventorySupplyWorkspace=defineAsyncComponent(()=>import('../../components/inventory/InventorySupplyWorkspace.vue'));
const route=useRoute(),router=useRouter(),ordersPageRef=ref(null);
const mode=computed({get:()=>route.query.mode==='inventory'?'inventory':'print',set:value=>router.replace({query:{...route.query,mode:value==='inventory'?'inventory':undefined,product_id:value==='inventory'?route.query.product_id:undefined}})});
const printMounted=ref(mode.value==='print');
watch(mode,value=>{if(value==='print')printMounted.value=true;});
</script>
<template>
 <div class="orders-mode-page">
  <div class="orders-mode-toolbar"><el-radio-group v-model="mode" aria-label="订单工作模式"><el-radio-button value="print">打印与日常发货</el-radio-button><el-radio-button value="inventory">库存管理</el-radio-button></el-radio-group><span>{{mode==='print'?'按订单处理打印、打包和发货':'按库存检查缺口、采购进度、到货验收与实物核对'}}</span></div>
  <div v-if="printMounted" v-show="mode==='print'"><OrdersPage ref="ordersPageRef"/></div>
  <InventorySupplyWorkspace v-if="mode==='inventory'" role="warehouse" :product-id="Number(route.query.product_id)||0" @clear-product="router.replace({query:{...route.query,product_id:undefined}})"/>
 </div>
</template>
<style scoped>
.orders-mode-page{display:grid;gap:18px;min-width:0}.orders-mode-toolbar{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px 18px;border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-bg-color-overlay)}.orders-mode-toolbar>span{font-size:12px;color:var(--el-text-color-secondary)}
</style>
