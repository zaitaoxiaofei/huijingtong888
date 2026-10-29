<script setup>
import {onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({rows:{type:Array,default:()=>[]},productId:Number,orderOverview:Object,maxHeight:{default:420}});
const table=ref(null),details=reactive({});let version=0;
const key=row=>`${row.shop_id}:${row.ozon_sku}:${row.warehouse_id||row.warehouse_name||''}`;
const current=row=>props.orderOverview?.shopId===Number(row.shop_id)&&props.orderOverview?.skus?.includes(String(row.ozon_sku));
function clear(){++version;for(const k of Object.keys(details))delete details[k];}
watch(()=>props.productId,clear);
onMounted(()=>{currentApiCacheScope();window.addEventListener('erp:auth-scope-changed',clear);});
onBeforeUnmount(()=>{clear();window.removeEventListener('erp:auth-scope-changed',clear);});
async function load(row){
 const scope=currentApiCacheScope(),k=key(row),token=version,id=props.productId;
 if(details[k]?.loading||details[k]?.data)return;
 details[k]={loading:true,error:'',data:null};
 try{const data=await apiClient.get(`/api/inventory-workflow?view=sku&product_id=${id}&shop_id=${row.shop_id}&ozon_sku=${encodeURIComponent(row.ozon_sku)}`,{noCache:true});if(token===version&&scope===currentApiCacheScope()&&id===props.productId)details[k]={loading:false,data,error:''};}
 catch(e){if(token===version&&scope===currentApiCacheScope())details[k]={loading:false,data:null,error:e.message||'组成暂不可用'};}
}
function expand(row,expanded){if(expanded.some(item=>key(item)===key(row)))void load(row);}
</script>
<template>
 <el-table ref="table" :data="rows" :row-key="key" :max-height="maxHeight" :row-class-name="({row})=>current(row)?'current-fbp-sku':''" empty-text="暂无有库存的FBP SKU；未同步项请先核对" @expand-change="expand">
  <el-table-column type="expand"><template #default="{row}">
   <section class="fbp-composition" v-loading="details[key(row)]?.loading" aria-label="SKU库存组成">
    <p v-if="details[key(row)]?.error">{{details[key(row)].error}} <el-button link @click="load(row)">重试读取组成</el-button></p>
    <template v-else-if="details[key(row)]?.data">
     <strong>{{({direct:'直接绑定',bundle:'套装包含',recipe:'SKU配方包含'})[details[key(row)].data.source]}}</strong>
     <p v-if="details[key(row)].data.root">绑定库存：{{details[key(row)].data.root.inventory_number}} · {{details[key(row)].data.root.name}}</p>
     <p>下列数量是每套SKU包含的库存单位；仅高亮当前查看的库存，不把整套数量重复算入每个子产品。</p>
     <div v-for="part in details[key(row)].data.components" :key="part.product_id" class="fbp-component" :class="{'is-current':part.current}">
      <ProductImagePreview :src="part.image_url" size="portrait" /><div><strong>{{part.name}}</strong><p>库存 {{part.inventory_number||part.product_id}} · 每套 {{part.quantity}} {{part.stock_unit||'份'}}</p><el-tag v-if="part.current" size="small">当前查看库存</el-tag></div>
     </div>
    </template>
   </section>
  </template></el-table-column>
  <el-table-column label="图片" width="88"><template #default="{row}"><ProductImagePreview :src="row.image_url||(row.root_product_id?`/api/products/${row.root_product_id}/image?thumb=1`:'')" size="portrait" /></template></el-table-column>
  <el-table-column prop="shop_name" label="店铺" min-width="120" />
  <el-table-column label="Ozon SKU" min-width="150"><template #default="{row}">{{row.ozon_sku}}<el-tag v-if="current(row)" size="small">本单 SKU</el-tag></template></el-table-column>
  <el-table-column label="商品规格与组成" min-width="230"><template #default="{row}"><div>{{row.product_name||'商品名称待同步'}}</div><el-button link type="primary" @click="table.toggleRowExpansion(row)">查看库存组成</el-button></template></el-table-column>
  <el-table-column prop="warehouse_name" label="FBP仓库" min-width="110" />
  <el-table-column label="库存／可售（套）" width="130"><template #default="{row}">{{row.present??'待同步'}} / {{row.available??'待同步'}}</template></el-table-column>
  <el-table-column prop="per_set_quantity" label="每套含当前库存" width="125" />
  <el-table-column label="折算当前库存" width="115"><template #default="{row}">{{row.inventory_quantity??'待同步'}}</template></el-table-column>
  <el-table-column label="同步时间（北京）" min-width="175"><template #default="{row}">{{row.synced_at?shanghaiDateTimeText(row.synced_at):'待同步'}}</template></el-table-column>
 </el-table>
</template>
<style scoped>
.fbp-composition{min-height:80px;padding:12px 22px}.fbp-composition>p{font-size:12px;color:var(--el-text-color-secondary)}.fbp-component{display:flex;align-items:center;gap:12px;padding:10px;margin:6px 0;border:1px solid var(--el-border-color-lighter);border-radius:8px}.fbp-component.is-current{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-5)}.fbp-component p{margin:6px 0}
</style>
