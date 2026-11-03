<script setup>
import {onBeforeUnmount,onMounted,reactive,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import InventoryProductRequestsDialog from '../../components/inventory/InventoryProductRequestsDialog.vue';
const route=useRoute(),router=useRouter(),data=reactive({people:[],suppliers:[],rules:[]});let alive=true,version=0;
async function loadDictionaries(){
 const scope=currentApiCacheScope(),read=++version;
 const result=await Promise.allSettled(['/api/people','/api/suppliers','/api/logistics-rules'].map(path=>apiClient.get(path)));
 if(!alive||read!==version||scope!==currentApiCacheScope())return;
 for(const [i,key]of ['people','suppliers','rules'].entries())if(result[i].status==='fulfilled')data[key]=Array.isArray(result[i].value)?result[i].value:[];
}
watch(currentApiCacheScope,()=>{data.people=[];data.suppliers=[];data.rules=[];void loadDictionaries();});
onMounted(loadDictionaries);onBeforeUnmount(()=>{alive=false;version++;});
</script>
<template><div class="page-stack"><div><el-button @click="router.push('/inventory/products')">返回商品库存</el-button></div><InventoryProductRequestsDialog embedded :request-id="Number(route.query.requestId)||0" :people="data.people" :suppliers="data.suppliers" :logistics-rules="data.rules"/></div></template>
