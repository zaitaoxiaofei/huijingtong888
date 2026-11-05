<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';

const props=defineProps({modelValue:Boolean,productId:Number,orderId:{type:Number,default:0}});
const emit=defineEmits(['update:modelValue','saved']);
const auth=useAuthStore(),rows=ref([]),loading=ref(false),saving=ref(0),error=ref(''),name=ref('');
const visible=computed({get:()=>props.modelValue,set:value=>emit('update:modelValue',value)});
const canEdit=computed(()=>['orders.manage','packing','procurement','inventory.write'].some(permission=>hasPermission(auth.user,permission)));
let version=0,controller,disposed=false;
const current=(token,scope)=>!disposed&&token===version&&scope===currentApiCacheScope()&&visible.value;

async function load(){
 controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();
 loading.value=true;error.value='';rows.value=[];
 try{
  const result=await apiClient.get(`/api/inventory-workflow/demand-details?product_id=${props.productId}`,{noCache:true,signal:controller.signal});
  if(!current(token,scope))return;
  name.value=result.product?.name||'';
  const unique=new Map();
  for(const row of result.orders||[]){
   const id=Number(row.order_id);if(!id||unique.has(id)||(props.orderId&&id!==props.orderId))continue;
   unique.set(id,{...row,draft:String(row.manual_note||''),original:String(row.manual_note||'')});
  }
  rows.value=[...unique.values()];
 }catch(e){if(current(token,scope)&&e.name!=='AbortError')error.value=e.message||'订单备注读取失败，请重试';}
 finally{if(token===version)loading.value=false;}
}

async function save(row){
 if(saving.value||loading.value||!canEdit.value)return;
 const note=row.draft.trim();if(note===row.original)return;
 const token=version,scope=currentApiCacheScope();saving.value=Number(row.order_id);error.value='';
 try{
  const result=await apiClient.post('/api/inventory-workflow/node-action',{
   action:'order-note',product_id:props.productId,id:row.order_id,note,expected_note:row.original,
   preserve_mark:true,...(!note?{clear_note:true}:{})
  });
  if(!current(token,scope))return;
  row.original=note;row.draft=note;row.manual_note=note;
  const detail={scope,orderId:Number(row.order_id),note,...(result.mark_type!=null?{markType:result.mark_type}:{})};
  window.dispatchEvent(new CustomEvent('erp:order-collaboration-note-saved',{detail}));
  emit('saved',detail);ElMessage.success(note?'订单人工备注已保存':'订单人工备注已清空');
 }catch(e){if(current(token,scope))error.value=e.message||'备注保存失败，请重试';}
 finally{if(token===version)saving.value=0;}
}

function closeScope(){++version;controller?.abort();rows.value=[];saving.value=0;visible.value=false;}
watch([()=>props.modelValue,()=>props.productId,()=>props.orderId],()=>{if(props.modelValue)void load();else{++version;controller?.abort();rows.value=[];saving.value=0;}},{immediate:true});
window.addEventListener('erp:auth-scope-changed',closeScope);
onBeforeUnmount(()=>{disposed=true;++version;controller?.abort();window.removeEventListener('erp:auth-scope-changed',closeScope);});
</script>

<template>
 <el-dialog v-model="visible" title="关联订单人工备注" width="min(980px,96vw)" append-to-body :show-close="!saving" :close-on-click-modal="false" :close-on-press-escape="!saving">
  <section v-loading="loading" class="procurement-order-notes">
   <p>{{name}} · 当前待履约的关联 FBS 订单。备注同步显示在对应订单的采购信息和标记中，原有标记颜色保留。</p>
   <el-alert v-if="error" type="warning" :closable="false" :title="error"/>
   <el-button v-if="error&&!rows.length" :disabled="!!saving" @click="load">重新读取</el-button>
   <el-table :data="rows" row-key="order_id" border max-height="520" empty-text="当前没有关联的待履约 FBS 订单">
    <el-table-column label="订单 / 店铺" min-width="210"><template #default="{row}"><strong>{{row.posting_number}}</strong><small>{{row.shop_name}}</small></template></el-table-column>
    <el-table-column label="人工协作备注" min-width="360"><template #default="{row}"><el-input v-model="row.draft" type="textarea" :rows="2" maxlength="1000" show-word-limit :disabled="!!saving||!canEdit" :aria-label="`订单 ${row.posting_number} 人工备注`" placeholder="例如：门槛条去掉部分字体，打包前核对"/></template></el-table-column>
    <el-table-column v-if="canEdit" label="操作" width="115"><template #default="{row}"><el-button size="small" plain :loading="saving===Number(row.order_id)" :disabled="!!saving||row.draft.trim()===row.original" @click="save(row)">{{row.draft.trim()?'保存备注':'清空备注'}}</el-button></template></el-table-column>
   </el-table>
  </section>
  <template #footer><el-button :disabled="!!saving" @click="visible=false">关闭</el-button></template>
 </el-dialog>
</template>

<style scoped>
.procurement-order-notes{display:grid;gap:12px;min-height:130px}.procurement-order-notes p{margin:0;font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.procurement-order-notes small{display:block;margin-top:7px;color:var(--el-text-color-secondary)}
</style>
