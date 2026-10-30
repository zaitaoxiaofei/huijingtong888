<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({product:{type:Object,required:true}});
const data=ref(null),loading=ref(false),error=ref('');let version=0,loadedAt=0;
const count=computed(()=>Number(data.value?.product?.component_count??props.product.component_count??0));
const accessory=computed(()=>Number(data.value?.product?.is_accessory??props.product.is_accessory??0)!==0);
const label=computed(()=>count.value>0?'套装':accessory.value?'配件':'单品');
function reset(){++version;data.value=null;error.value='';loading.value=false;loadedAt=0;}
async function load(){
 if(loading.value||(data.value&&Date.now()-loadedAt<30000))return;
 const scope=currentApiCacheScope(),token=++version,id=Number(props.product.id);if(!id)return;
 loading.value=true;error.value='';
 try{const r=await apiClient.get(`/api/inventory-workflow/details?node=composition&product_id=${id}`,{noCache:true});if(token===version&&scope===currentApiCacheScope()){data.value=r;loadedAt=Date.now();}}
 catch(e){if(token===version&&scope===currentApiCacheScope())error.value=e.message||'子产品组成读取失败';}finally{if(token===version)loading.value=false;}
}
watch(()=>[props.product.id,props.product.updated_at,props.product.component_count],reset);
window.addEventListener('erp:auth-scope-changed',reset);
onBeforeUnmount(()=>{++version;window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <el-popover placement="right" trigger="hover" :show-after="300" :width="430" @show="load">
  <template #reference><el-tag size="small" :type="count?'warning':accessory?'success':'info'" effect="light" class="composition-badge" @click.stop>{{label}}<span v-if="count"> · {{count}} 子产品</span></el-tag></template>
  <div class="composition-preview"><strong>{{product.name||'库存商品'}} · {{label}}</strong><p v-if="loading">正在读取子产品组成…</p><template v-else-if="error"><p>{{error}}</p><el-button size="small" @click="load">重试</el-button></template><template v-else-if="data"><el-alert v-if="data.incomplete" title="组成有缺失或不可访问的子产品，请管理员核对；未隐藏成空套装。" type="warning" :closable="false"/><div v-for="row in data.rows" :key="row.id" class="composition-child"><ProductImagePreview :src="row.image_url"/><div class="composition-child-copy"><strong>{{row.name}}</strong><small>库存 {{row.inventory_number||row.id}}</small><small>组成数量 {{Number(row.quantity)}} {{row.stock_unit||'件'}}<span v-if="!row.active"> · 已停用</span></small></div></div><p v-if="!data.rows.length&&!data.incomplete">当前没有子产品组成。{{accessory?'这是独立配件库存。':'这是独立单品库存。'}}</p></template></div>
 </el-popover>
</template>
<style scoped>
.composition-badge{cursor:help;max-width:100%}.composition-preview{font-size:13px;max-height:450px;overflow:auto;line-height:1.6}.composition-child{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--el-border-color-lighter)}.composition-child-copy{min-width:0;display:grid;gap:5px}.composition-child small{color:var(--el-text-color-secondary);font-size:12px}.composition-child strong{overflow-wrap:anywhere}
.composition-child :deep(.erp-image-preview){width:64px;height:84px;flex:0 0 64px;border-radius:6px;overflow:hidden;background:var(--el-fill-color-light)}.composition-child :deep(.erp-image-preview__image),.composition-child :deep(.erp-image-preview__empty){width:100%;height:100%;display:flex;align-items:center;justify-content:center}
</style>
