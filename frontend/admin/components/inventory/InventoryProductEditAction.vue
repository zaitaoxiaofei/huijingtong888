<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {useAuthStore} from '../../stores/auth.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
const Editor=defineAsyncComponent(()=>import('./ProductCreateEditDialog.vue'));
const props=defineProps({productId:{type:Number,required:true}}),emit=defineEmits(['saved']);
const auth=useAuthStore(),canEdit=computed(()=>hasPermission(auth.user,'inventory.write'));
const visible=ref(false),busy=ref(false),product=ref(null),editor=ref(null),quick=ref(false),role=ref('included');
const options=reactive({people:[],suppliers:[],logistics:[]});let version=0,scope='';
function reset(){++version;visible.value=false;quick.value=false;product.value=null;busy.value=false;}
watch(()=>props.productId,reset);
window.addEventListener('erp:auth-scope-changed',reset);
onBeforeUnmount(()=>{reset();window.removeEventListener('erp:auth-scope-changed',reset);});
async function open(){
 if(!canEdit.value||busy.value)return;const token=++version,id=props.productId;scope=currentApiCacheScope();const requestScope=scope;busy.value=true;
 try{const [value,people,suppliers,logistics]=await Promise.all([apiClient.get(`/api/products/${id}`,{noCache:true}),apiClient.get('/api/people'),apiClient.get('/api/suppliers?paged=1&page=1&pageSize=100'),apiClient.get('/api/logistics-rules')]);
  if(token!==version||requestScope!==currentApiCacheScope()||id!==props.productId)return;
  product.value=value;options.people=Array.isArray(people)?people:[];options.suppliers=suppliers.rows||[];options.logistics=Array.isArray(logistics)?logistics:[];visible.value=true;
 }catch(e){if(token===version&&requestScope===currentApiCacheScope())ElMessage.error(e.message||'库存信息读取失败，请重试');}finally{if(token===version)busy.value=false;}
}
function saved(value){if(scope!==currentApiCacheScope())return;visible.value=false;emit('saved',value);}
async function addPart(value){const requestScope=scope,token=version;if(requestScope!==currentApiCacheScope())return;quick.value=false;try{const id=Number(value?.id||value?.product_id);if(!id)return;const part=await apiClient.get(`/api/products/${id}`,{noCache:true});if(token===version&&requestScope===currentApiCacheScope())editor.value?.addExternalComponentProduct(part,role.value);}catch(e){ElMessage.error(e.message);}}
</script>
<template>
 <el-button v-if="canEdit" plain size="small" class="inventory-product-edit-action" :loading="busy" @click.stop="open">编辑库存</el-button>
 <Editor v-if="visible" ref="editor" v-model:visible="visible" mode="edit" target="inventory" :edit-product-id="productId" :value="product" :people="options.people" :suppliers="options.suppliers" :logistics-rules="options.logistics" @saved="saved" @quick-create-component="value=>{role=value.role==='gift'?'gift':'included';quick=true;}"/>
 <Editor v-if="quick" v-model:visible="quick" mode="create" target="inventory" :people="options.people" :suppliers="options.suppliers" :logistics-rules="options.logistics" :create-context="{is_accessory:1}" @saved="value=>addPart(value.product)" @existing-selected="addPart"/>
</template>
