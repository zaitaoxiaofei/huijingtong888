<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElDialog} from 'element-plus';
import MobileDialog from '../mobile/MobileDialog.vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {inventoryHistoryFieldLabel as fieldLabel,inventoryHistoryValue as valueText} from '../../utils/inventory-product-history.js';
const props=defineProps({modelValue:Boolean,productId:{type:Number,required:true},mobile:Boolean});
const emit=defineEmits(['update:modelValue']);
const visible=computed({get:()=>props.modelValue,set:value=>emit('update:modelValue',value)});
const data=ref(null),page=ref(1),loading=ref(false),error=ref(''),pageSize=20;
let version=0,controller,disposed=false;
const time=value=>value?shanghaiDateTimeText(value,{assumeUtcWhenNaive:true}):'时间未留存';
const pages=computed(()=>Math.max(1,Math.ceil(Number(data.value?.total||0)/pageSize)));
async function load(next=page.value){
 controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope(),id=props.productId;
 data.value=null;error.value='';loading.value=true;page.value=next;
 try{
  const result=await apiClient.get(`/api/products/${id}/edit-history?page=${next}&pageSize=${pageSize}`,{noCache:true,signal:controller.signal});
  if(!disposed&&token===version&&scope===currentApiCacheScope()&&id===props.productId){data.value=result;page.value=Number(result.page)||next;}
 }catch(e){if(token===version&&scope===currentApiCacheScope()&&e.name!=='AbortError')error.value=e.message||'库存历史读取失败，请重试';}
 finally{if(token===version)loading.value=false;}
}
function reset(){++version;controller?.abort();data.value=null;error.value='';loading.value=false;page.value=1;}
function scopeChanged(){reset();visible.value=false;}
watch(()=>[props.modelValue,props.productId],()=>{reset();if(props.modelValue&&props.productId>0)void load(1);},{immediate:true});
window.addEventListener('erp:auth-scope-changed',scopeChanged);
onBeforeUnmount(()=>{disposed=true;reset();window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <component :is="mobile?MobileDialog:ElDialog" v-model="visible" title="库存历史版本" width="min(960px,96vw)" append-to-body :close-on-click-modal="false" class="inventory-history-dialog">
  <section class="inventory-history" :class="{'is-mobile':mobile}" v-loading="loading">
   <div v-if="error" class="inventory-history-error" role="alert"><el-alert :title="error" type="error" :closable="false"/><el-button plain @click="load()">重试读取</el-button></div>
   <template v-if="data">
    <header class="inventory-history-current"><small>当前库存编号</small><strong>{{data.current?.inventory_number||'尚未编号'}}</strong><span>{{data.current?.name||'名称未填写'}}</span><small>同组修改资料保留编号；核心品名或品牌改组才生成新号，商品关联保持不变。</small></header>
    <p class="inventory-history-notice">{{data.history_notice||'此前未保存完整版本的资料，只能查看已留存的旧编号和旧名称。旧编号与旧名称分别留存，不代表同一次修改。'}}</p>
    <section class="inventory-history-aliases" aria-label="历史编号和名称">
     <div><h3>历史库存编号</h3><ul v-if="data.number_aliases?.length"><li v-for="alias in data.number_aliases" :key="alias.number"><b>{{alias.number}}</b><small>留存时间 {{time(alias.recorded_at)}}</small></li></ul><p v-else>暂无已留存的旧编号</p></div>
     <div><h3>历史名称</h3><ul v-if="data.name_aliases?.length"><li v-for="alias in data.name_aliases" :key="alias.name"><span>{{alias.name}}</span><small>留存时间 {{time(alias.recorded_at)}}{{alias.active===false||alias.active===0?' · 已停用':''}}</small></li></ul><p v-else>暂无已留存的旧名称</p></div>
    </section>
    <section aria-label="资料修改版本" class="inventory-history-versions">
     <h3>资料修改记录 <small>共 {{data.total||0}} 次</small></h3>
     <p v-if="!data.rows?.length">暂无已留存的资料修改版本，历史别名可在上方查看。</p>
     <details v-for="(record,index) in data.rows||[]" :key="record.id" class="inventory-history-version">
      <summary><strong>版本 {{Number(data.total)-(page-1)*pageSize-index}}</strong><span>{{time(record.recorded_at)}}</span><span>{{record.actor?.name||'操作人未留存'}}</span><small>{{record.source_label||'库存资料编辑'}}</small><span class="inventory-history-fields">{{record.unavailable?'历史快照不完整':(record.changed_fields||[]).map(fieldLabel).join('、')}} <b>{{record.unavailable?'查看说明':'查看变更'}}</b></span></summary>
      <p v-if="record.unavailable">该条历史快照不完整，无法展示修改前后资料。</p>
      <div v-else class="inventory-history-diff"><div class="inventory-history-diff-head"><span>资料</span><span>修改前</span><span>修改后</span></div><div v-for="key in record.changed_fields||[]" :key="key" class="inventory-history-diff-row"><b>{{fieldLabel(key)}}</b><span>{{valueText(key,record.before?.[key])}}</span><span>{{valueText(key,record.after?.[key])}}</span></div></div>
     </details>
    </section>
   </template>
  </section>
  <template #footer><div class="inventory-history-footer"><div v-if="data&&pages>1" class="inventory-history-pagination" aria-label="历史版本分页"><el-button plain :disabled="loading||page<=1" @click="load(page-1)">上一页</el-button><span>{{page}} / {{pages}} 页</span><el-button plain :disabled="loading||page>=pages" @click="load(page+1)">下一页</el-button></div><el-button @click="visible=false">关闭</el-button></div></template>
 </component>
</template>
<style scoped>
.inventory-history{display:grid;gap:16px;min-height:110px;min-width:0;color:var(--el-text-color-primary)}.inventory-history-current{display:grid;gap:7px;padding:14px;border:1px solid var(--el-border-color);border-radius:10px;background:var(--el-fill-color-light)}.inventory-history-current strong{font-size:20px}.inventory-history small,.inventory-history-notice{color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.inventory-history span,.inventory-history b{overflow-wrap:anywhere}.inventory-history-notice{margin:0}.inventory-history h3{font-size:14px;margin:0 0 10px}.inventory-history h3 small{font-weight:normal;margin-left:8px}.inventory-history-aliases{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.inventory-history-aliases>div{border:1px solid var(--el-border-color);border-radius:8px;padding:12px;min-width:0}.inventory-history-aliases ul{list-style:none;padding:0;margin:0;max-height:220px;overflow-y:auto}.inventory-history-aliases li{display:grid;gap:4px;padding:8px 0;border-bottom:1px solid var(--el-border-color-lighter)}.inventory-history-aliases li:last-child{border-bottom:0}.inventory-history p{line-height:1.6;font-size:13px}.inventory-history-version{border:1px solid var(--el-border-color);border-radius:8px;margin-top:8px;padding:12px;min-width:0}.inventory-history-version summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:13px}.inventory-history-fields{flex-basis:100%;font-size:12px;color:var(--el-text-color-secondary)}.inventory-history-fields b{margin-left:8px;color:var(--el-color-primary)}.inventory-history-diff{margin-top:12px}.inventory-history-diff-head,.inventory-history-diff-row{display:grid;grid-template-columns:minmax(90px,.6fr) minmax(0,1fr) minmax(0,1fr);gap:12px;padding:9px;border-bottom:1px solid var(--el-border-color-lighter);font-size:12px;line-height:1.6}.inventory-history-diff-head{background:var(--el-fill-color-light);font-weight:600}.inventory-history-footer,.inventory-history-pagination{display:flex;align-items:center;gap:8px}.inventory-history-footer{justify-content:flex-end}.inventory-history-pagination{margin-right:auto;font-size:12px}.inventory-history-pagination .el-button{margin:0}.inventory-history-error{display:grid;gap:10px;justify-items:start}.is-mobile .inventory-history-aliases{grid-template-columns:minmax(0,1fr)}.is-mobile .inventory-history-version{padding:10px}.is-mobile .inventory-history-diff-head,.is-mobile .inventory-history-diff-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;padding:9px 0}.is-mobile .inventory-history-diff-row>b{grid-column:1/-1}.is-mobile .inventory-history-diff-head>span:first-child{display:none}
</style>
