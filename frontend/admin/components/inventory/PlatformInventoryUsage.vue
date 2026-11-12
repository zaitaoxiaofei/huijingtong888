<script setup>
import { ref,watch,onBeforeUnmount } from 'vue';
import { apiClient,currentApiCacheScope } from '../../utils/api.js';
import MarketplaceBadge from '../MarketplaceBadge.vue';
const props=defineProps({productId:{type:Number,required:true}}),rows=ref([]),error=ref('');
let version=0;
async function load(){const current=++version,scope=currentApiCacheScope();rows.value=[];error.value='';if(!props.productId)return;try{const value=await apiClient.get(`/api/wb/inventory-usage?product_id=${props.productId}`,{noCache:true});if(current===version&&scope===currentApiCacheScope())rows.value=value.rows||[];}catch{if(current===version&&scope===currentApiCacheScope())error.value='平台用量暂未读取成功，请刷新后核对。';}}
watch(()=>props.productId,load,{immediate:true});onBeforeUnmount(()=>{version++;});
</script>
<template><section v-if="rows.some(row=>row.platform==='wb')"><h3>平台库存用量</h3><p>来自本地订单库存登记，实物库存仍共用一套。已交接订单取消不代表实物已退回，需核对后登记收货。</p><el-table :data="rows" border><el-table-column label="平台" width="100"><template #default="{row}"><MarketplaceBadge :platform="row.platform"/></template></el-table-column><el-table-column prop="reserved_qty" label="待发订单占用"/><el-table-column prop="transport_qty" label="运输中"/><el-table-column prop="delivered_qty" label="已签收出库"/><el-table-column prop="cancelled_pending_review_qty" label="取消待核对"/></el-table><small v-if="error">{{error}}</small></section></template>
