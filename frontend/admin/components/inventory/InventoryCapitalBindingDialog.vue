<script setup>
import {defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
const Editor=defineAsyncComponent(()=>import('./ProductCreateEditDialog.vue'));
const props=defineProps({row:{type:Object,required:true},initialCreate:Boolean,mobile:Boolean}),emit=defineEmits(['close','saved']);
const create=ref(false),selected=ref(null),rows=ref([]),loading=ref(false),saving=ref(false),error=ref('');
const options=reactive({people:[],suppliers:[],logistics:[]});let version=0,alive=true;const scope=currentApiCacheScope();
const current=()=>alive&&scope===currentApiCacheScope();
onBeforeUnmount(()=>{alive=false;version++});
async function search(query=''){
 const token=++version;loading.value=true;
 try{const data=await apiClient.get('/api/products?'+new URLSearchParams({paged:'1',page:'1',pageSize:'30',query}),{noCache:true});if(token===version&&current())rows.value=data.rows||[];}
 catch(e){if(current())error.value=e.message;}finally{if(token===version)loading.value=false;}
}
async function startCreate(){
 if(!props.row.online_product_id||!current())return;
 loading.value=true;error.value='';
 try{const [people,suppliers,logistics]=await Promise.all([apiClient.get('/api/people'),apiClient.get('/api/suppliers?paged=1&page=1&pageSize=100'),apiClient.get('/api/logistics-rules')]);if(!current())return;options.people=Array.isArray(people)?people:[];options.suppliers=suppliers.rows||[];options.logistics=Array.isArray(logistics)?logistics:[];create.value=true;}
 catch(e){if(current())error.value=e.message;}finally{loading.value=false;}
}
async function bind(){
 if(!selected.value||!current()||saving.value)return;saving.value=true;error.value='';
 try{await apiClient.post('/api/online-products/bind',{online_product_id:Number(props.row.online_product_id),ozon_sku:String(props.row.ozon_sku),product_id:Number(selected.value)});if(!current())return;ElMessage.success('已绑定库存，请核对数量和成本');emit('saved');emit('close');}
 catch(e){if(current())error.value=e.message;}finally{saving.value=false;}
}
function created(){if(!current())return;create.value=false;emit('saved');emit('close');}
onMounted(()=>{if(props.initialCreate&&props.row.online_product_id)startCreate();else search();});
</script>
<template>
 <el-dialog :model-value="true" title="绑定或创建库存" width="640px" append-to-body @close="emit('close')">
  <p>{{row.shop_name}} · 平台SKU {{row.ozon_sku}}</p>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <template v-if="row.online_product_id">
   <p>已有商品请选择正确库存；没有对应商品时创建库存，继续沿用建品审批，通过后绑定本SKU。</p>
   <el-select v-model="selected" filterable remote :remote-method="search" :loading="loading" placeholder="搜索库存ID、名称或货号" style="width:100%" aria-label="选择绑定库存">
    <el-option v-for="product in rows" :key="product.id" :value="Number(product.id)" :label="`${product.inventory_number||product.id} · ${product.name}`"/>
   </el-select>
  </template>
  <template v-else><p>未找到该店铺及SKU唯一对应的在线商品，无法安全确定绑定对象。请先在该店铺在线商品中核对SKU，再绑定或创建库存。</p><router-link :to="{path:'/online-products',query:{shopId:String(row.shop_id),status:'all'}}" @click="emit('close')">打开该店铺在线商品</router-link></template>
  <template #footer><el-button @click="emit('close')">关闭</el-button><el-button v-if="row.online_product_id" :disabled="loading||saving" @click="startCreate">创建库存并绑定</el-button><el-button v-if="row.online_product_id" type="primary" :disabled="!selected||loading" :loading="saving" @click="bind">绑定所选库存</el-button></template>
 </el-dialog>
 <Editor v-if="create" v-model:visible="create" mode="create" target="inventory" :mobile="mobile" :people="options.people" :suppliers="options.suppliers" :logistics-rules="options.logistics" :create-endpoint="'/api/online-products/create-product'" :create-context="{online_product_id:Number(row.online_product_id),ozon_sku:String(row.ozon_sku)}" @saved="created" @submitted="created" @existing-selected="product=>{selected=Number(product.id);create=false;}"/>
</template>
