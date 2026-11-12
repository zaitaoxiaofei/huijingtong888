<script setup>
import {onMounted,onBeforeUnmount,ref} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import WbCategorySelect from '../../components/listing/WbCategorySelect.vue';
import WbListingEditor from '../../components/listing/WbListingEditor.vue';
const shops=ref([]),schema=ref(null),busy=ref(false),drafts=ref([]),drawer=ref(false),editor=ref(null),context=ref(null),generation=ref(0),catalogGeneration=ref(0);let categorySequence=0;
const time=v=>shanghaiDateTimeText(v,{assumeUtcWhenNaive:true});
async function loadDrafts(){const scope=currentApiCacheScope();const r=await apiClient.get('/api/wb/workbench-drafts',{noCache:true});if(scope===currentApiCacheScope())drafts.value=r.rows||[];}
async function choose(category,refresh=false,restored=null){
 if(!restored&&!refresh&&schema.value&&Number(category.subjectID)!==Number(schema.value.subject_id)&&editor.value?.getPayload()?.card.characteristics?.length){try{await ElMessageBox.confirm('更换类目会清空当前类目属性。标题、图片、包装和价格保留，请按新类目重新填写属性。','更换产品类目',{type:'warning'});}catch{return;}}
 const requestId=++categorySequence,scope=currentApiCacheScope();busy.value=true;
 const previous=restored|| (editor.value?editor.value.getContext():context.value);
 try{
  const r=await apiClient.get(`/api/wb/catalog/schema?subject_id=${category.subjectID}&category_name=${encodeURIComponent(category.subjectName||schema.value?.category_name||'')}${previous?.target_shop_id||previous?.shop_id?`&shop_id=${previous.target_shop_id||previous.shop_id}`:''}${refresh?'&refresh=1':''}`,{noCache:true});if(scope!==currentApiCacheScope()||requestId!==categorySequence)return;
  if(previous?.payload){const p=JSON.parse(JSON.stringify(previous.payload));const same=Number(p.subject_id)===Number(r.subject_id);p.subject_id=r.subject_id;p.template_id=Number(r.template_id);const ids=new Set(r.attributes.map(a=>Number(a.charcID)));p.card.characteristics=same?(p.card.characteristics||[]).filter(a=>ids.has(Number(a.id))):JSON.parse(JSON.stringify(r.defaults?.characteristics||[]));context.value={...previous,payload:p};}
  else context.value=null;
  schema.value=r;generation.value++;
 }catch(e){if(requestId===categorySequence)ElMessage.error(e.message);}finally{if(requestId===categorySequence)busy.value=false;}
}
async function openDraft(row){await choose({subjectID:row.payload.subject_id},false,row);drawer.value=false;}
async function newProduct(){if(editor.value){try{await ElMessageBox.confirm('创建另一款商品前，请确认当前修改已保存。','新建商品');}catch{return;}}context.value=null;generation.value++;}
async function bootstrap(){const scope=currentApiCacheScope();try{const s=await apiClient.get('/api/wb/shops',{noCache:true});if(scope!==currentApiCacheScope())return;shops.value=s.filter(s=>s.status==='active');await loadDrafts();}catch(e){ElMessage.error(e.message);}}
function reset(){categorySequence++;catalogGeneration.value++;schema.value=null;context.value=null;drafts.value=[];shops.value=[];drawer.value=false;bootstrap();}
onMounted(()=>{bootstrap();window.addEventListener('erp:auth-scope-changed',reset);});onBeforeUnmount(()=>{categorySequence++;window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <div class="copy-page">
  <section class="copy-header"><strong class="platform-title">WB 商品上架</strong><div class="header-actions"><el-button @click="drawer=true;loadDrafts()">打开草稿</el-button><el-button @click="newProduct">新建商品</el-button><el-button :disabled="!schema||busy" @click="editor?.preview()">预览与校验</el-button><el-button :disabled="!schema||busy" @click="editor?.saveDraft()">保存草稿</el-button><el-button type="danger" :disabled="!schema||busy" @click="editor?.reviewSubmission()">提交 WB</el-button></div></section>
  <div class="copy-layout"><main class="main-column"><section class="copy-card">
   <el-form label-width="116px" class="copy-form"><section class="editor-block"><h3>主要信息</h3><div class="form-shell"><el-form-item label="产品类目" required><WbCategorySelect :key="catalogGeneration" :subject-id="Number(schema?.subject_id)||null" :display-label="schema?.category_name||''" :disabled="busy" @select="choose"/></el-form-item><el-form-item label="类目模板"><div class="template-status"><span v-if="schema">{{schema.category_name}} · 已自动匹配 {{schema.attributes.length}} 项字段</span><span v-else>选择类目后自动读取对应模板和字段</span><el-button v-if="schema" link type="primary" :loading="busy" @click="choose({subjectID:schema.subject_id},true)">同步 WB 字段</el-button></div></el-form-item><el-alert v-if="schema?.cache?.stale" :title="schema.cache.message" type="warning" :closable="false"/></div></section></el-form>
   <div v-if="!schema" class="empty-category">请先选择产品类目，系统会自动获取对应 WB 模板。填写商品内容后再选择上架店铺。</div>
   <WbListingEditor v-else :key="generation" ref="editor" :shop-id="Number(context?.shop_id)||null" :shops="shops" :schema="schema" :templates="[{id:Number(schema.template_id),subject_id:schema.subject_id,attributes:schema.attributes,defaults:schema.defaults,name:schema.category_name}]" :draft="context" @saved="loadDrafts" @shop-changed="choose({subjectID:schema.subject_id},true)"/>
  </section></main></div>
  <el-drawer v-if="drawer" :model-value="true" title="WB 商品草稿" size="min(1000px,95vw)" @close="drawer=false"><el-table :data="drafts" border stripe><el-table-column prop="vendor_code" label="货号" width="180"/><el-table-column label="商品"><template #default="{row}">{{row.payload.card.title}}</template></el-table-column><el-table-column prop="shop_name" label="店铺"/><el-table-column label="售价" width="110"><template #default="{row}">¥ {{row.payload.card.sizes[0]?.price??'待填写'}}</template></el-table-column><el-table-column label="更新（北京）" width="170"><template #default="{row}">{{time(row.updated_at)}}</template></el-table-column><el-table-column width="80"><template #default="{row}"><el-button link type="primary" @click="openDraft(row)">编辑</el-button></template></el-table-column></el-table></el-drawer>
 </div>
</template>
<style scoped>
.copy-page{display:flex;flex-direction:column;gap:0;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--erp-detail-surface,#fff)}.copy-header{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 24px;margin:-16px -16px 0;background:var(--erp-detail-surface,rgba(255,255,255,.98));border-bottom:1px solid var(--erp-detail-border-light,#eef0f5)}.platform-title{font-size:14px}.header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.header-actions .el-button{margin-left:0;height:32px;border-radius:6px}.copy-layout{display:block}.main-column{display:flex;flex-direction:column;gap:0}.copy-card{background:var(--erp-detail-surface,#fff);border:0;border-radius:0;padding:0 24px 32px}.copy-form{display:flex;flex-direction:column}.editor-block{padding:28px 0 14px}.editor-block h3{margin:0 0 22px;font-size:18px;line-height:1.2;text-align:center;font-weight:700;color:var(--erp-detail-text-main,#111827)}.form-shell{max-width:760px;margin:0 auto}.form-shell :deep(.el-form-item){margin-bottom:18px}.form-shell :deep(.el-form-item__label){justify-content:flex-end;color:var(--erp-detail-text-main,#1f2937);font-size:13px}.template-status{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.empty-category{padding:80px 20px;text-align:center;color:var(--el-text-color-secondary)}@media(max-width:800px){.copy-header{position:static;flex-wrap:wrap;margin:0}.copy-card{padding:0 12px 24px}}
</style>
