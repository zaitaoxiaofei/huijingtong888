<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { uploadListingMedia } from '../../api/tools/imageCropper.js';
import { applyKeyModel } from '../../../../src/shared/workflow-key-models.js';
import {isKeyMold,isReviewedMold} from '../../../../src/shared/key-mold-mapping.js';
import {materialCoversFitments} from '../../../../src/shared/workflow-materials.js';
import WorkflowMaterialLibrary from '../../components/listing/WorkflowMaterialLibrary.vue';
import WorkflowMaterialReferences from '../../components/listing/WorkflowMaterialReferences.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import WorkflowTemplateThumbnail from '../../components/listing/WorkflowTemplateThumbnail.vue';
import WorkflowProductionForm from '../../components/listing/WorkflowProductionForm.vue';
import OzonCategorySelect from '../../components/listing/OzonCategorySelect.vue';
import WorkflowMaterialInput from '../../components/listing/WorkflowMaterialInput.vue';
import WorkflowAttributeTable from '../../components/listing/WorkflowAttributeTable.vue';
import {starterWorkflow} from '../../../../src/shared/workflow-starter.js';
import WorkflowTemplateBuilder from '../../components/listing/WorkflowTemplateBuilder.vue';
import { keyCaseProductionWorkflow, withWorkflowFitmentMode } from '../../../../src/shared/key-case-production-workflow.js';
import { addDefaultWorkflowBindings } from '../../../../src/shared/product-workflow-bindings.js';
import WorkflowRunReview from '../../components/listing/WorkflowRunReview.vue';
import { createWorkflowNode, keyCaseWorkflow, validateWorkflow, validateWorkflowVariants } from '../../../../src/shared/product-workflow.js';
import { isWorkflowInput, workflowDefault, expandWorkflowVariants, refreshWorkflowCategory } from '../../../../src/shared/product-workflow-inputs.js';
import { planWorkflowProductImport } from '../../utils/workflow-product-import.js';

const productionName=ref('');
const shops=ref([]),productionMode=ref('batch'),fitmentMode=ref('shared');
const route=useRoute(),router=useRouter(),tab=ref(['materials','results','tasks'].includes(route.query.tab)?route.query.tab:'library'),templates=ref([]),runs=ref([]),jobs=ref([]),listingTemplates=ref([]);
const templateDocument=ref(null),definition=ref(blankWorkflow()),categoryId=ref(null),selectedCategoryKey=ref(''),selectedCategory=ref(null);
const keyModelChoices=ref([]),editorOpen=ref(false),templateSearch=ref('');
const templatePage=ref(1),templatePageSize=ref(12),templateTotal=ref(0),templateLoading=ref(false);let templateSequence=0,searchTimer;
const filteredTemplates=computed(()=>templates.value);
watch(templateSearch,()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{templatePage.value=1;loadTemplates().catch(e=>ElMessage.error(e.message));},300);});
const videoEnabled=computed(()=>definition.value.nodes.some(n=>n.type==='video'));
const keyLibraryOpen=ref(false),keyLibrarySeed=ref({}),keyLibraryRevision=ref(0),engineerArea=ref('images'),categoryExpanded=ref(false);
const busy=ref(false),busyLabel=ref(''),importInput=ref(null),productionOpen=ref(false);
const sharedValues=ref({}),variants=ref([]),runDocument=ref(null),reviewEditing=ref(false);
const pendingProductCount=computed(()=>variants.value.filter(row=>!row.submittedId).length);
let pollTimer,polling=false;
const clone=value=>JSON.parse(JSON.stringify(value));
const inputs=computed(()=>definition.value.nodes.filter(n=>isWorkflowInput(n)&&n.inputGroup!=='listing-final').map(n=>n.inputGroup==='fitment'?{...n,scope:fitmentMode.value==='individual'?'variant':'shared'}:n));
watch(fitmentMode,(mode)=>{for(const node of definition.value.nodes.filter(n=>n.inputGroup==='fitment')){if(mode==='individual'){for(const row of variants.value){for(const key of ['__fitments','__fitmentBindings','__keyModelId','__keyModelKind','__keyModelRevision'])if(sharedValues.value[key]!==undefined)row.values[key]??=clone(sharedValues.value[key]);}for(const row of variants.value)row.values[node.id]??=clone(sharedValues.value[node.id]??workflowDefault(node));}else sharedValues.value[node.id]??=clone(variants.value[0]?.values[node.id]??workflowDefault(node));}});
const sharedInputs=computed(()=>inputs.value.filter(n=>n.valueSource!=='engineer'&&n.valueSource!=='generated'&&n.scope==='shared'));
const variantInputs=computed(()=>inputs.value.filter(n=>n.valueSource!=='engineer'&&n.valueSource!=='generated'&&n.scope!=='shared'));
const category=computed(()=>definition.value.category||{});
const stateFor=id=>jobs.value.find(j=>j.run_id===id)||{};
const statusLabels={queued:'排队中',running:'后台生成中',awaiting_review:'待人工检查',ready:'检查完成',failed:'失败待处理',imported:'生产完成'};
const taskRows=computed(()=>runs.value.filter(r=>!r.draft_id));
const resultRows=computed(()=>runs.value.filter(r=>r.draft_id));
const currentJob=computed(()=>runDocument.value?.payload.draftId?{status:'imported'}:stateFor(runDocument.value?.id));
function blankWorkflow(){return starterWorkflow();}
const focusNode=ref('');
function navigateNode({mode,nodeId}){focusNode.value=nodeId;engineerArea.value=mode;}
async function action(work){if(busy.value)return;busy.value=true;try{await work();}catch(error){ElMessage.error(error.message||'操作失败');}finally{busy.value=false;busyLabel.value='';}}
async function loadTemplates(){const seq=++templateSequence;templateLoading.value=true;try{const params=new URLSearchParams({page:templatePage.value,pageSize:templatePageSize.value,keyword:templateSearch.value.trim()});const result=await apiClient.get(`/api/product-workflows/templates?${params}`,{noCache:true});if(seq!==templateSequence)return;templates.value=result.items||result;templateTotal.value=result.total??templates.value.length;templatePage.value=result.page||1;}finally{if(seq===templateSequence)templateLoading.value=false;}}
async function refreshLists(){const [,runRows,jobRows]=await Promise.all([loadTemplates(),apiClient.get('/api/product-workflows/runs',{noCache:true}),apiClient.get('/api/product-workflows/job-states',{noCache:true})]);runs.value=runRows;jobs.value=jobRows;}

onMounted(()=>{action(async()=>{await refreshLists();if(route.query.runId){runDocument.value=await apiClient.get('/api/product-workflows/runs?id='+encodeURIComponent(String(route.query.runId)),{noCache:true});tab.value='results';}listingTemplates.value=await apiClient.get('/api/listing/templates');shops.value=(await apiClient.get('/api/shops')).filter(s=>s.status!=='deleted');});pollTimer=setInterval(poll,4000);});
onUnmounted(()=>{clearInterval(pollTimer);clearTimeout(searchTimer);templateSequence++;});
async function poll(){if(polling||busy.value||reviewEditing.value||!['tasks','results'].includes(tab.value))return;polling=true;try{await refreshLists();if(runDocument.value)runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(runDocument.value.id)}`,{noCache:true});}catch{/* Explicit refresh reports failures; retain the last visible state on transient network errors. */}finally{polling=false;}}
function resetMaterials(){productionName.value=definition.value.name;productionMode.value='batch';fitmentMode.value='shared';sharedValues.value=Object.fromEntries(sharedInputs.value.map(n=>[n.id,workflowDefault(n)]));variants.value=[freshVariant(0)];}
function freshVariant(index){return {requestId:crypto.randomUUID(),submittedId:null,id:`v_${crypto.randomUUID().replaceAll('-','')}`,label:`产品 ${index+1}`,values:Object.fromEntries(variantInputs.value.map(n=>[n.id,workflowDefault(n)])),promptOverrides:{}};}
function addVariant(){if(variants.value.length>=20)return ElMessage.warning('每批最多 20 件产品／变体');variants.value.push(freshVariant(variants.value.length));}
function newTemplate(){editorOpen.value=false;templateDocument.value=null;definition.value=blankWorkflow();categoryId.value=null;selectedCategoryKey.value='';selectedCategory.value=null;tab.value='engineer';}
async function loadTemplate(id){const doc=await apiClient.get(`/api/product-workflows/templates?id=${encodeURIComponent(id)}`,{noCache:true});templateDocument.value=doc;definition.value=addDefaultWorkflowBindings(clone(doc.payload));for(const node of definition.value.nodes.filter(isWorkflowInput))node.valueSource||='user';definition.value.richContentEnabled??=true;categoryId.value=definition.value.nodes.find(n=>n.type==='listing')?.templateId||null;selectedCategoryKey.value=definition.value.category?`${category.value.descriptionCategoryId}:${category.value.typeId}`:'';selectedCategory.value=null;}
async function editTemplate(id){await action(async()=>{await loadTemplate(id);editorOpen.value=true;tab.value='engineer';if(category.value.templateId)await refreshCategoryFields();if(definition.value.starterSample&&!category.value.templateId)await prepareStarterCategory();});}
async function prepareStarterCategory(){const rows=await apiClient.get('/api/listing/ozon-categories?keyword='+encodeURIComponent('玩具')+'&limit=200',{noCache:true});const chosen=rows.find(r=>/宠物|猫|狗/.test([r.path_zh,r.category_name_zh,r.name_zh].filter(Boolean).join(' '))&&/玩具/.test([r.path_zh,r.category_name_zh,r.name_zh].filter(Boolean).join(' ')));if(chosen){selectedCategory.value=chosen;selectedCategoryKey.value=chosen.ozon_category_id;await attachCategory();}else{categoryExpanded.value=true;ElMessage.info('未找到已缓存的宠物玩具类目，请通过官方类目树选择后保存');}}
async function copyTemplate(id){await action(async()=>{await loadTemplate(id);templateDocument.value=null;definition.value.name+=' · 副本';definition.value.reviewMode='manual';if(category.value.templateId)await refreshCategoryFields();editorOpen.value=true;tab.value='engineer';ElMessage.info('已复制为新流程，原模板不会被修改');});}
async function createFromCategory(){await action(async()=>{templateDocument.value=null;definition.value=blankWorkflow();categoryId.value=null;await attachCategory();editorOpen.value=true;});}
function toggleVideo(enabled){if(enabled){const main=definition.value.nodes.find(n=>n.type==='image'&&n.role==='main');if(!main)return ElMessage.warning('请先配置一个主图生成节点');definition.value.nodes.push({...createWorkflowNode('video'),inputs:[main.id]});}else definition.value.nodes=definition.value.nodes.filter(n=>n.type!=='video');}
async function changeReviewMode(mode){if(mode==='automatic'){try{await ElMessageBox.confirm('仅对已经验证稳定的模板开启。后续任务将跳过主图及整套人工检查，自动生成待上架草稿，可能产生图片与文本调用费用；不会自动发布商品。','启用自动审批',{confirmButtonText:'启用自动审批',cancelButtonText:'保留人工检查',type:'warning'});}catch{return;}}definition.value.reviewMode=mode;}
const fileBatches=[];let importingFiles=false;
async function importProductFiles(files,options={}){
  if(busy.value&&!importingFiles)return ElMessage.warning('请等待当前操作完成后再上传图片');
  fileBatches.push({files:[...files],...options});if(importingFiles)return;
  importingFiles=true;try{while(fileBatches.length)await importProductBatch(fileBatches.shift());}finally{importingFiles=false;}
}
async function importProductBatch({files,rowId,slot=0}){await action(async()=>{
  if(variants.value.some(row=>row.submissionStarted))throw new Error('本批产品已开始提交，请新建一批生产后再添加图片');
  const {node,placements}=planWorkflowProductImport({definition:definition.value,variants:variants.value,files,rowId,slot});
  const failures=[];let imported=0;
  for(const placement of placements){
    const {file}=placement;busyLabel.value=`上传产品图片 ${imported+failures.length+1}/${placements.length} · ${file.name}`;
    try{
      const result=await uploadListingMedia(file,{source_module:'product_workflow',role:'product'});
      const url=result.publishUrl||result.url||result.previewUrl;if(!url)throw new Error('上传没有返回图片地址');
      const row=placement.rowId?variants.value.find(row=>row.id===placement.rowId):freshVariant(variants.value.length);
      if(!Array.isArray(row.values[node.id]))row.values[node.id]=Array(node.count).fill('');
      row.values[node.id][placement.slot]=url;
      if(!placement.rowId){row.label=file.name.replace(/\.[^.]+$/,'');variants.value.push(row);}
      else if(/^产品 \d+$/.test(row.label))row.label=file.name.replace(/\.[^.]+$/,'');
      imported++;
    }catch(error){failures.push(`${file.name}：${error.message||'上传失败'}`);}
  }
  if(imported)ElMessage.success(`已上传 ${imported} 张产品图，${productionMode.value==='variants'?'将合并为一份多变体草稿':`本批共 ${variants.value.length} 件产品，各自生成草稿`}`);
  if(failures.length)ElMessage.error({message:`${failures.length} 张图片上传失败，其他成功图片已保留，请重新上传失败图片。${failures.join('；')}`,duration:8000});
});}

async function useTemplate(id){await action(async()=>{await loadTemplate(id);if(!category.value.templateId){editorOpen.value=true;tab.value='engineer';categoryExpanded.value=true;ElMessage.info('请先为示例选择官方类目并保存，再开始生产');return;}resetMaterials();await loadDefaultKey();productionOpen.value=true;});}
async function loadDefaultKey(){if(!definition.value.defaultKeyModelId)return;try{const record=await apiClient.get(`/api/product-workflows/key-models?id=${encodeURIComponent(definition.value.defaultKeyModelId)}`,{noCache:true});if(record.payload.archived)throw new Error('默认适配资料已停用');if(!isReviewedMold(record))throw new Error('默认钥匙模具尚未核对');sharedValues.value.__fitments=(record.payload.bindings?.length?record.payload.bindings:[{brand:record.payload.brand,models:[record.payload.model]}]).flatMap(b=>(b.models||[]).filter(Boolean).map(model=>({brand:b.brand,model})));sharedValues.value.model=sharedValues.value.__fitments.map(f=>`${f.brand} ${f.model}`).join('；');applyKeyModel(sharedValues.value,record,definition.value.nodes.find(n=>n.id==='key')?.count||8);}catch(error){ElMessage.warning(`${error.message}，请重新选择适配资料或上传钥匙图`);}}
async function trialTemplate(){await action(async()=>{resetMaterials();await loadDefaultKey();productionOpen.value=true;});}
async function loadKeyChoices(){try{keyModelChoices.value=(await apiClient.get('/api/product-workflows/key-models',{noCache:true})).filter(isReviewedMold);}catch(error){ElMessage.error(error.message);}}
watch(engineerArea,area=>{if(area==='general'&&definition.value.preset==='key-case-production')loadKeyChoices();});
async function refreshCategoryFields(){const imported=await apiClient.get(`/api/product-workflows/category?id=${category.value.templateId}`,{noCache:true});refreshWorkflowCategory(definition.value,imported);}
async function attachCategory(){
  if(selectedCategory.value){
    const chosen=selectedCategory.value,key=chosen.ozon_category_id;
    const existing=listingTemplates.value.find(t=>t.ozon_category_id===key);
    if(existing)categoryId.value=Number(existing.id);
    else{
      const [descriptionId,typeId]=key.split(':').map(Number);
      const name=chosen.path_zh||chosen.category_name_zh||chosen.category_name||chosen.name_zh||chosen.path||chosen.name;
      if(!descriptionId||!typeId||!name)throw new Error('请从类目树选择一个完整的商品类型');
      const created=await apiClient.post('/api/listing/templates',{ozon_category_id:key,category_name:name,template_name:name,source_type:'product_workflow_category',editable_payload:{category_id:key,description_category_id:descriptionId,type_id:typeId,category_name:name}});
      categoryId.value=Number(created.id);listingTemplates.value.unshift({...created,ozon_category_id:key});
    }
  }
  if(!categoryId.value)throw new Error('请先搜索或按层级选择上架类目');
  const imported=await apiClient.get(`/api/product-workflows/category?id=${categoryId.value}`,{noCache:true});
  if(definition.value.category?.templateId&&(Number(definition.value.category.descriptionCategoryId)!==Number(imported.descriptionCategoryId)||Number(definition.value.category.typeId)!==Number(imported.typeId))){
    const oldAttrs=new Set(definition.value.nodes.filter(n=>n.type==='attribute').map(n=>n.id));
    definition.value.nodes=definition.value.nodes.filter(n=>!oldAttrs.has(n.id));
    for(const node of definition.value.nodes)node.inputs=node.inputs.filter(id=>!oldAttrs.has(id));
    definition.value.bindings={};
  }
  let listing=definition.value.nodes.find(n=>n.type==='listing');if(!listing){listing=createWorkflowNode('listing','listing');definition.value.nodes.unshift(listing);}
  listing.templateId=Number(categoryId.value);definition.value.category=imported;addDefaultWorkflowBindings(definition.value);
  categoryExpanded.value=false;
  ElMessage.success('模板字段已加载，可预填固定值或绑定图片、文本节点输出');
}
function uploadDefault(file,node,index){if(!Array.isArray(node.defaultValue))node.defaultValue=Array(node.count).fill('');upload(file,{[node.id]:node.defaultValue},node,index);}
async function saveTemplate(){await action(async()=>{if(!category.value.templateId)throw new Error('第一步请先导入上架类目模板');const payload=validateWorkflow(definition.value);templateDocument.value=await apiClient.post('/api/product-workflows/templates',{id:templateDocument.value?.id,revision:templateDocument.value?.revision,payload});await refreshLists();ElMessage.success('流程已保存，可在已有流程中使用');});}
function openStarter(){templateDocument.value=null;definition.value=starterWorkflow(null,{sample:true});categoryId.value=null;selectedCategoryKey.value='';selectedCategory.value=null;categoryExpanded.value=true;editorOpen.value=true;tab.value='engineer';engineerArea.value='images';ElMessage.info('示例结构已准备好，请先选择宠物玩具的官方上架类目');}
async function loadExample(){await action(async()=>{if(!category.value.templateId)throw new Error('请先导入本企业的类目模板');definition.value=keyCaseProductionWorkflow(clone(category.value));ElMessage.success('钥匙壳生产流程已配置。上传一套风格参考并保存，以后只需替换产品材料。');});}
function exportTemplate(){try{const payload=validateWorkflow(definition.value);const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}));const link=window.document.createElement('a');link.href=url;link.download=`${payload.name.replace(/[\\/:*?"<>|]/g,'-')}.workflow.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){ElMessage.error(error.message);}}
async function importTemplate(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;await action(async()=>{if(file.size>1024*1024)throw new Error('模板文件最多 1 MB');definition.value=addDefaultWorkflowBindings(validateWorkflow(JSON.parse(await file.text())));templateDocument.value=null;categoryId.value=null;selectedCategoryKey.value='';selectedCategory.value=null;const listing=definition.value.nodes.find(n=>n.type==='listing');listing.templateId=0;delete definition.value.category;delete definition.value.defaultKeyModelId;delete definition.value.materialSnapshots;definition.value.sharedMaterialRefs=[];for(const node of definition.value.nodes)delete node.materialRefs;definition.value.reviewMode='manual';editorOpen.value=true;tab.value='engineer';ElMessage.info('文件已导入，请先重新绑定本企业的上架类目模板');});}
function selectLibraryKey(record){const target=keyLibrarySeed.value.target;if(!target)return;if(!isKeyMold(record)||!record.payload.images?.length)return ElMessage.warning('请选择有图片的钥匙模具');if(!isReviewedMold(record))return ElMessage.warning('请先在资料预览中核对并确认适配关系');const fits=target.__fitments||[];if(!fits.length)return ElMessage.warning('请先填写本次产品的品牌和型号，再选择对应模具');if(!materialCoversFitments(record,fits))return ElMessage.warning('该模具未覆盖本次全部品牌型号，请核对后选择');applyKeyModel(target,record,definition.value.nodes.find(n=>n.id==='key')?.count||8);keyLibraryOpen.value=false;}
function openKeyLibrary(seed={}){keyLibrarySeed.value=seed;keyLibraryOpen.value=true;}
async function upload(file,target,node,index){if(!file)return;await action(async()=>{busyLabel.value='上传产品材料';const result=await uploadListingMedia(file,{source_module:'product_workflow',role:node.referenceRole||'product'});const url=result.publishUrl||result.url||result.previewUrl;if(!url)throw new Error('上传没有返回图片地址');if(node.id==='key')delete target.__keyModelId;target[node.id][index]=url;});}
async function submitProduction(){await action(async()=>{
  const snapshot=validateWorkflow({...withWorkflowFitmentMode(definition.value,fitmentMode.value),name:productionName.value.trim()});
  const batches=productionMode.value==='variants'?[variants.value]:variants.value.filter(v=>!v.submittedId).map(v=>[v]);
  if(!batches.length)throw new Error('本批产品已提交，请在生产任务中查看进度');
  for(const rows of batches)validateWorkflowVariants(snapshot,expandWorkflowVariants(snapshot,rows,sharedValues.value));
  for(const rows of batches){
    const first=rows[0];for(const row of rows)row.submissionStarted=true;busyLabel.value=`提交 ${first.label}`;
    const created=await apiClient.post('/api/product-workflows/runs',{requestId:first.requestId,payload:{definition:snapshot,templateId:templateDocument.value?.id||null,templateRevision:templateDocument.value?.revision||null,variants:clone(rows).map(row=>({...row,fitments:(fitmentMode.value==='shared'?sharedValues.value:row.values).__fitments||[],materialRefs:(fitmentMode.value==='shared'?sharedValues.value:row.values).__materialRefs||[],keyModelKind:(fitmentMode.value==='shared'?sharedValues.value:row.values).__keyModelKind||'key_model',keyModelId:(fitmentMode.value==='shared'?sharedValues.value:row.values).__keyModelId||null,keyModelRevision:(fitmentMode.value==='shared'?sharedValues.value:row.values).__keyModelRevision||null})),sharedValues:clone(sharedValues.value),outputs:{},draftId:null,productionMode:productionMode.value}});
    for(const row of rows)row.submittedId=created.id;
    runDocument.value=created;
  }
  productionOpen.value=false;tab.value='tasks';await refreshLists();ElMessage.success(productionMode.value==='batch'?'已按每件产品创建独立任务，模板与共用材料已复用':'已提交后台生产，可以关闭页面');
});}
async function openRun(id,completed=false){await action(async()=>{runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(id)}`,{noCache:true});tab.value=completed?'results':'tasks';});}
async function runAction(body){await action(async()=>{const state=runDocument.value.payload.outputs[body.variantId]?.[body.nodeId],node=runDocument.value.payload.definition.nodes.find(n=>n.id===body.nodeId);body.recoverOnly=body.action==='retry'&&(state?.status==='unknown'||node?.type==='image'&&state?.taskId&&!state.url&&state.failureKind!=='provider_confirmed');if(body.action==='retry'&&!body.recoverOnly){try{await ElMessageBox.confirm('重生成会清除依赖本节点的后续结果，并重新调用 AI。是否继续？','重生成',{type:'warning'});}catch{return;}}runDocument.value=await apiClient.post('/api/product-workflows/run-action',body);await refreshLists();});}
async function finishProduction(){await action(async()=>{try{await ElMessageBox.confirm('我已检查全部变体的套图、文案和属性，确认完成生产并生成上架草稿。','整套人工检查',{confirmButtonText:'确认完成',type:'info'});}catch{return;}if(runDocument.value.payload.draftImportStatus!=='unknown')runDocument.value=await apiClient.post('/api/product-workflows/run-action',{id:runDocument.value.id,action:'approve-all'});try{await apiClient.post('/api/product-workflows/import-draft',{id:runDocument.value.id});}finally{runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(runDocument.value.id)}`,{noCache:true});await refreshLists();}tab.value='results';ElMessage.success('生产完成，已生成草稿箱草稿；可预览编辑并选择店铺上架');});}
function openDraft(id){router.push({path:'/listing-automation',query:{draftId:id}});}
watch(tab,()=>{reviewEditing.value=false;});
</script>

<template>
  <div class="workflow-page" v-loading="busy" :element-loading-text="busyLabel||'正在保存'">
    <header class="page-heading"><h2>AI模板工作流</h2></header>
    <el-tabs v-model="tab">
      <el-tab-pane label="已有流程" name="library" class="workflow-library-pane">
        <div class="toolbar"><h3>选择流程开始生产</h3><el-button type="primary" @click="newTemplate">新建一个流程</el-button><el-button @click="importInput.click()">导入流程文件</el-button><el-button @click="openKeyLibrary()">企业生产资料库</el-button></div>
        <el-input v-model="templateSearch" class="template-search" clearable placeholder="搜索流程名称或上架类目"/><div class="flow-library" v-loading="templateLoading"><el-empty v-if="!templates.length&&!templateLoading&&templateSearch" description="没有匹配流程，请调整搜索条件"/><article v-if="!templateTotal&&!templateSearch&&!templateLoading" class="flow-card starter-card"><el-tag effect="plain">系统示例 · 可修改复用</el-tag><h3>宠物玩具图文模板</h3><p>1 张主图 ＋ 6 张详情图 ＋ 俄语标题、标签、简介</p><p>上传真实产品图，补充卖点；选择官方类目后即可保存到本企业。</p><el-button type="primary" @click="openStarter">配置示例模板</el-button></article><article v-for="item in filteredTemplates" :key="item.id" class="flow-card"><WorkflowTemplateThumbnail :url="item.preview_image"/><div class="toolbar"><h3>{{ item.name }}</h3><el-tag>v{{ item.revision }}</el-tag></div><p>{{ item.category_name||'已保存的品类工作流' }}</p><p>共用参考与分镜规则 · 每个变体独立产品图</p><div class="toolbar"><el-button type="primary" @click="useTemplate(item.id)">使用流程生产</el-button><el-button @click="editTemplate(item.id)">编辑流程</el-button><el-button @click="copyTemplate(item.id)">复制为新流程</el-button></div></article></div><PageFooterPagination :page="templatePage" :page-size="templatePageSize" :total="templateTotal" :page-sizes="[12,24,48]" :disabled="templateLoading" @update:page="templatePage=$event;loadTemplates().catch(e=>ElMessage.error(e.message))" @update:page-size="templatePageSize=$event;templatePage=1;loadTemplates().catch(e=>ElMessage.error(e.message))"/>
      </el-tab-pane>
      <el-tab-pane label="新建／编辑流程" name="engineer" class="workflow-engineer-pane">
        <div v-if="!editorOpen" class="template-start">
          <section class="create-template"><h3>创建新流程</h3><p>选择上架类目，自带主图、6 张详情图和俄语标题／标签／简介；可自由调整。</p><OzonCategorySelect v-model="selectedCategoryKey" :show-sync="false" placeholder="搜索类目，或按层级选择" @select="selectedCategory=$event"/><el-button type="primary" :disabled="!selectedCategoryKey" @click="createFromCategory">创建并配置</el-button><el-divider>或</el-divider><el-button @click="importInput.click()">导入流程文件</el-button></section>
          <section class="existing-templates"><div class="section-title"><h3>复用已有流程</h3><el-tag effect="plain">{{ templateTotal }} 个流程</el-tag></div><el-input v-model="templateSearch" clearable placeholder="搜索流程名称或类目，例如：钥匙壳、TPU"/><div class="existing-template-list" v-loading="templateLoading"><article v-for="item in filteredTemplates" :key="item.id"><WorkflowTemplateThumbnail :url="item.preview_image"/><div class="template-summary"><strong>{{ item.name }}</strong><p>{{ item.category_name||'已保存的品类工作流' }}</p></div><div><el-button @click="editTemplate(item.id)">编辑原流程</el-button><el-button type="primary" plain @click="copyTemplate(item.id)">复制为新流程</el-button></div></article><el-empty v-if="!filteredTemplates.length" description="没有匹配的流程，可在左侧创建或导入"/></div><PageFooterPagination :page="templatePage" :page-size="templatePageSize" :total="templateTotal" :page-sizes="[12,24,48]" :disabled="templateLoading" @update:page="templatePage=$event;loadTemplates().catch(e=>ElMessage.error(e.message))" @update:page-size="templatePageSize=$event;templatePage=1;loadTemplates().catch(e=>ElMessage.error(e.message))"/></section>
        </div>
        <div v-else class="engineer-workspace">
          <div class="engineer-toolbar"><el-button @click="editorOpen=false">返回模板库</el-button><el-input v-model="definition.name" placeholder="流程名称" aria-label="流程名称"/><el-button @click="openKeyLibrary()">生产资料库</el-button><el-dropdown @command="command=>command==='example'?loadExample():exportTemplate()"><el-button>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="example" :disabled="!category.templateId">套用钥匙壳流程</el-dropdown-item><el-dropdown-item command="export">导出流程文件</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button :disabled="!category.templateId" @click="trialTemplate">试用流程</el-button><el-button type="primary" @click="saveTemplate">保存流程</el-button></div>
          <div class="engineer-category"><template v-if="category.templateId&&!categoryExpanded"><span>上架类目</span><strong>{{ category.categoryName||category.name }}</strong><small>{{ category.attributes?.length||0 }} 项官方字段</small><el-button link @click="action(refreshCategoryFields)">刷新类目字段</el-button><el-button link @click="categoryExpanded=true">更换</el-button></template><template v-else><OzonCategorySelect v-model="selectedCategoryKey" :show-sync="false" :display-label="category.categoryName||category.name||''" placeholder="搜索类目，或按层级选择" @select="selectedCategory=$event"/><el-button type="primary" :disabled="!selectedCategoryKey" @click="action(attachCategory)">载入类目字段</el-button></template></div>
          <el-tabs v-if="category.templateId||definition.starterSample" v-model="engineerArea" class="engineer-areas">
            <el-tab-pane label="图片模板" name="images"/><el-tab-pane label="文案模板" name="text"/><el-tab-pane label="上架属性" name="fields"/><el-tab-pane label="风格与店铺" name="general"/>
          </el-tabs>
          <div v-if="category.templateId||definition.starterSample" class="engineer-body">
            <WorkflowAttributeTable v-if="engineerArea==='fields'" :definition="definition" :category="category" @navigate="navigateNode" @upload="uploadDefault"/><WorkflowTemplateBuilder v-else-if="engineerArea!=='general'" :definition="definition" :category="category" :mode="engineerArea" :focus-node="focusNode" @upload="uploadDefault"/>
            <div v-else class="general-settings"><el-form label-position="top"><el-form-item label="生产与检查"><div class="automation-settings"><el-checkbox :model-value="videoEnabled" @update:model-value="toggleVideo">用生成的主图自动生成上架视频</el-checkbox><el-radio-group :model-value="definition.reviewMode||'manual'" @update:model-value="changeReviewMode"><el-radio value="manual">人工检查后生成草稿</el-radio><el-radio value="automatic">自动审批并生成草稿</el-radio></el-radio-group><small>首次验证建议保留人工检查。自动审批不会发布商品，售价与包装参数仍在上架前填写。</small></div></el-form-item><WorkflowMaterialReferences :category="category" v-model="definition.sharedMaterialRefs" label="公共生产资料（所有图片与文案共用）"/><el-form-item label="全局风格提示词"><el-input v-model="definition.globalPrompt" type="textarea" :rows="6" placeholder="套图统一风格、语言与真实产品要求"/></el-form-item><template v-if="definition.preset==='key-case-production'"><el-form-item label="默认适配钥匙（选填）"><el-select v-model="definition.defaultKeyModelId" clearable filterable placeholder="固定做某个型号时选择，以后自动带入"><el-option v-for="record in keyModelChoices" :key="record.id" :value="record.id" :label="record.name"/></el-select></el-form-item><el-form-item v-for="node in definition.nodes.filter(n=>n.type==='field'&&['facts','packaging'].includes(n.id))" :key="node.id" :label="node.id==='facts'?'默认卖点（生产时可修改）':'默认包装说明（生产时可修改）'"><WorkflowMaterialInput v-model="node.defaultValue" compact :node="node" :category="category"/></el-form-item></template><el-form-item label="默认目标店铺"><el-select v-model="definition.shopIds" multiple filterable clearable placeholder="可留空，检查产出后再选店铺"><el-option v-for="shop in shops" :key="shop.id" :value="Number(shop.id)" :label="shop.name"/></el-select></el-form-item></el-form><el-alert title="主图和每张详情的参考图、提示词，在“主图 / 详情图模板”中分别配置。保存一次后，后续生产直接复用。" type="info" :closable="false"/></div>
          </div>
          <el-empty v-else description="先选择上架类目，载入官方字段后配置模板"/>
        </div>
      </el-tab-pane>
      <el-tab-pane :label="`生产任务／待人工检查${taskRows.length?' · '+taskRows.length:''}`" name="tasks">
        <div class="toolbar"><h3>后台生产与人工检查</h3><el-button @click="action(refreshLists)">刷新任务</el-button></div>
        <el-table :data="taskRows" empty-text="暂无生产任务，从已有流程开始生产"><el-table-column prop="category_name" label="类目" min-width="150" show-overflow-tooltip/><el-table-column prop="name" label="流程名称" min-width="200"/><el-table-column prop="brands" label="品牌" min-width="140"/><el-table-column prop="models" label="型号" min-width="180" show-overflow-tooltip/><el-table-column prop="product_label" label="产品／首个变体" min-width="150"/><el-table-column label="变体" width="80"><template #default="{row}">{{ row.variant_count||'—' }}</template></el-table-column><el-table-column label="状态" min-width="150"><template #default="{row}"><el-tag :type="stateFor(row.id).status==='failed'?'danger':stateFor(row.id).status==='awaiting_review'?'warning':'info'">{{ statusLabels[stateFor(row.id).status]||'待提交后台' }}</el-tag></template></el-table-column><el-table-column label="操作" min-width="200"><template #default="{row}"><el-button type="primary" text @click="openRun(row.id)">{{ stateFor(row.id).status==='awaiting_review'?'进入人工预览':'查看进度／处理' }}</el-button></template></el-table-column></el-table>
        <section v-if="runDocument&&!runDocument.payload.draftId" class="run-detail"><div class="toolbar"><el-button v-if="!stateFor(runDocument.id).status" @click="runAction({id:runDocument.id,action:'start'})">提交后台执行</el-button><el-tag>{{ statusLabels[currentJob.status]||'等待后台执行' }}</el-tag></div><WorkflowRunReview :record="runDocument" :job="currentJob" :busy="busy" @action="runAction" @finish="finishProduction" @open-draft="openDraft" @editing="reviewEditing=$event"/></section>
      </el-tab-pane>
      <el-tab-pane label="生产结果" name="results">
        <div class="toolbar"><h3>已完成的商品</h3><el-button @click="action(refreshLists)">刷新结果</el-button></div>
        <el-table :data="resultRows" empty-text="人工检查通过并完成生产后，商品会出现在这里"><el-table-column prop="category_name" label="类目" min-width="150" show-overflow-tooltip/><el-table-column prop="name" label="流程名称" min-width="200"/><el-table-column prop="brands" label="品牌" min-width="140"/><el-table-column prop="models" label="型号" min-width="180" show-overflow-tooltip/><el-table-column label="状态" min-width="150"><template #default>已生成草稿箱草稿</template></el-table-column><el-table-column label="操作" min-width="230"><template #default="{row}"><el-button text @click="openRun(row.id,true)">查看完整产出</el-button><el-button type="primary" @click="openDraft(row.draft_id)">预览并上架</el-button></template></el-table-column></el-table>
        <section v-if="runDocument?.payload.draftId" class="run-detail"><WorkflowRunReview :record="runDocument" :job="currentJob" @open-draft="openDraft"/></section>
      </el-tab-pane>
      <el-tab-pane label="企业生产资料库" name="materials"><WorkflowMaterialLibrary v-if="tab==='materials'" standalone/></el-tab-pane>
    </el-tabs>
    <el-dialog v-model="keyLibraryOpen" title="企业生产资料库" width="1100px" top="4vh" append-to-body><WorkflowMaterialLibrary v-if="keyLibraryOpen" :category="category" :seed="keyLibrarySeed" :selectable="Boolean(keyLibrarySeed.target)" @select="selectLibraryKey" @saved="keyLibraryRevision++;loadKeyChoices()"/></el-dialog>
    <input ref="importInput" type="file" accept=".json" hidden @change="importTemplate"/>
    <el-dialog v-model="productionOpen" :title="definition.name" width="900px" top="5vh" class="production-dialog" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
      <template #header><div><small>本次生产名称（可编辑，不修改原模板名称）</small><el-input v-model="productionName" :disabled="busy" placeholder="本次生产名称，可自定义" aria-label="本次生产名称" maxlength="180" style="max-width:650px"/></div></template>
      <WorkflowProductionForm v-if="productionOpen" :busy="busy" :key-library-revision="keyLibraryRevision" :definition="definition" :shared-values="sharedValues" :variants="variants" v-model:production-mode="productionMode" v-model:fitment-mode="fitmentMode" @add="addVariant" @import-files="importProductFiles" @upload="upload" @manage-keys="openKeyLibrary"/>
      <template #footer><el-button :disabled="busy" @click="productionOpen=false">取消</el-button><el-button type="primary" :loading="busy" @click="submitProduction">{{ productionMode==='variants'?`开始生成 · 1 份草稿 / ${variants.length} 个变体`:`开始生成 · ${pendingProductCount} 份草稿` }}</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.category-picker-row{display:flex;gap:12px;align-items:start;margin:18px 0}.category-picker-row>.ozon-category-select{flex:1;min-width:0;max-width:760px}.workflow-page{padding:20px;color:var(--el-text-color-primary)}h2,h3,h4{margin:0}p{color:var(--el-text-color-secondary);line-height:1.6}.page-heading,.toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px}.toolbar{justify-content:flex-start;margin:16px 0}.toolbar h3{margin-right:auto}.toolbar .el-select{width:310px;max-width:100%}.flow-library{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}.flow-card,.category-first{padding:20px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:8px}.flow-card{max-width:620px}.workflow-meta{display:grid;grid-template-columns:260px 1fr;gap:16px;margin-bottom:20px}.workflow-editor{display:grid;grid-template-columns:190px minmax(250px,1fr) minmax(260px,340px);gap:18px;align-items:start}.workflow-palette,.workflow-inspector{padding:16px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:8px}.workflow-palette{max-height:760px;overflow:auto}.workflow-palette h3:not(:first-child){margin-top:20px}.workflow-palette p{font-size:12px}.workflow-palette button{display:block;width:100%;margin-top:8px;text-align:left;padding:10px;border:1px solid var(--el-border-color-lighter);border-radius:6px;background:var(--el-fill-color-light);color:var(--el-text-color-primary);cursor:grab}.editor-areas{margin:16px 0}.editor-areas .el-radio-group{display:flex;flex-wrap:wrap}.workflow-canvas{padding:14px;max-height:760px;overflow:auto;min-height:400px;background:var(--el-fill-color-lighter);border-radius:8px}.workflow-editor>*{min-width:0}.category-root,.workflow-node{box-sizing:border-box;width:100%;padding:14px;background:var(--el-bg-color);border:1px solid var(--el-border-color);border-radius:8px;color:var(--el-text-color-primary);text-align:left}.category-root{border-color:var(--el-color-success)}small{display:block;color:var(--el-text-color-secondary);margin-top:5px}.workflow-node-wrap{display:flex;flex-direction:column;align-items:center}.workflow-arrow{padding:5px;color:var(--el-text-color-placeholder)}.workflow-node{display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:grab}.workflow-node.selected{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.workflow-inspector label,.variant-overrides label{display:block;margin:14px 0}.workflow-inspector .el-select,.workflow-inspector .el-input-number{width:100%;margin-top:6px}.workflow-inspector .el-input,.workflow-inspector .el-textarea{margin-top:6px}.workflow-inspector p{font-size:12px}.style-kit{margin-bottom:20px}.style-kit label{display:block;margin:18px 0}.style-kit label>strong{display:block;margin-bottom:12px}.shop-defaults{margin-top:20px}.shop-defaults .el-select{width:100%;max-width:600px}.production-mode{margin:20px 0}.production-mode .el-radio-group{margin-top:12px}.run-detail{margin-top:24px;padding-top:20px;border-top:1px solid var(--el-border-color-lighter)}.common-inputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:18px 0}.common-inputs label>div{margin-top:8px}.category-summary{margin:20px 0}em{font-size:12px;font-style:normal;color:var(--el-color-primary)}.variant-overrides{padding:18px;background:var(--el-fill-color-lighter);margin-top:16px;border-radius:8px}@media(max-width:1100px){.workflow-editor{grid-template-columns:170px 1fr}.workflow-inspector{grid-column:1/-1}.workflow-meta{grid-template-columns:1fr}}@media(max-width:650px){.workflow-page{padding:12px}.workflow-editor,.common-inputs{grid-template-columns:1fr}.workflow-palette{max-height:300px}.flow-library{grid-template-columns:1fr}}
.engineer-workspace{max-width:1600px;width:100%;margin-inline:auto;box-sizing:border-box;height:calc(100dvh - 350px);min-height:460px;display:flex;flex-direction:column;gap:10px}.engineer-toolbar{display:flex;align-items:center;gap:10px;flex-shrink:0}.engineer-toolbar>.el-input{max-width:360px;margin-right:auto}.engineer-toolbar>.el-button+.el-button{margin-left:0}.engineer-category{display:flex;align-items:center;gap:12px;flex-shrink:0;padding:10px 14px;background:var(--el-fill-color-light);border-radius:8px;min-height:28px}.engineer-category>span,.engineer-category>small{font-size:12px;color:var(--el-text-color-secondary)}.engineer-category>strong{font-size:13px}.engineer-category>.ozon-category-select{flex:1;min-width:0}.engineer-category>.el-button{margin-left:auto}.engineer-areas{flex-shrink:0}.engineer-areas :deep(.el-tabs__header){margin-bottom:0}.engineer-areas :deep(.el-tabs__content){display:none}.engineer-body{flex:1;min-height:0}.general-settings{height:100%;overflow:auto;max-width:900px;padding:12px;box-sizing:border-box}.general-settings .el-select{width:100%}@media(max-width:650px){.engineer-workspace{height:auto;min-height:0}.engineer-toolbar{flex-wrap:wrap}.engineer-toolbar>.el-input{max-width:none;flex-basis:100%}.engineer-category{flex-wrap:wrap}.engineer-body{min-height:500px}}
.template-start{max-width:1500px;margin:auto;display:grid;grid-template-columns:340px minmax(0,1fr);gap:24px;height:calc(100dvh - 330px);min-height:440px}.create-template,.existing-templates{border:1px solid var(--el-border-color-lighter);border-radius:10px;padding:24px;background:var(--el-bg-color);min-width:0}.create-template p,.existing-template-list p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.create-template>.el-button{display:block;width:100%;margin:16px 0 0}.existing-templates{display:flex;flex-direction:column;gap:16px}.section-title{display:flex;justify-content:space-between;align-items:center}.existing-template-list{overflow:auto;min-height:0}.existing-template-list article{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--el-border-color-lighter);padding:18px 0}.existing-template-list article>div:last-child{display:flex;flex-shrink:0}.template-search{max-width:460px;margin-bottom:20px}.automation-settings{display:grid;gap:12px}.automation-settings .el-radio-group{display:flex;flex-wrap:wrap}.automation-settings small{line-height:1.7}@media(max-width:1000px){.template-start{grid-template-columns:280px minmax(0,1fr)}.existing-template-list article{align-items:flex-start;flex-direction:column}}@media(max-width:650px){.template-start{height:auto;grid-template-columns:1fr}}
.flow-card>.template-thumbnail{float:left;margin:0 14px 10px 0}.existing-template-list .template-summary{flex:1;min-width:0}.workflow-page :deep(.el-pagination){flex-shrink:0;margin-top:16px;flex-wrap:wrap;row-gap:10px}.existing-template-list article{align-items:center}.existing-template-list .template-thumbnail{flex-shrink:0}@media(max-width:1000px){.existing-template-list article{flex-direction:row;flex-wrap:wrap}.existing-template-list article>div:last-child{margin-left:auto}}
.create-template,.existing-templates{min-height:0;box-sizing:border-box}.existing-templates{overflow:hidden}.existing-template-list{flex:1;min-height:0;overflow:auto}.existing-templates>.el-pagination{margin-top:0}@media(max-width:650px){.existing-template-list{max-height:55vh;flex:auto}}

/* Match other ERP lists: only the result region scrolls. */
.workflow-page{height:100%;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}
.workflow-page>.page-heading{flex:none}
.workflow-page :deep(> .el-tabs){flex:1;min-height:0;display:flex;flex-direction:column}
.workflow-page :deep(> .el-tabs > .el-tabs__header){flex:none}
.workflow-page :deep(> .el-tabs > .el-tabs__content){flex:1;min-height:0;overflow:auto}
.workflow-page :deep(.workflow-engineer-pane){height:100%;min-height:0;overflow:auto}
.workflow-page :deep(.workflow-library-pane){height:100%;display:flex;flex-direction:column;overflow:hidden}
.workflow-library-pane>.toolbar,.workflow-library-pane>.template-search,.workflow-library-pane>.erp-footer-pagination{flex:none}
.flow-library{flex:1;min-height:0;overflow:auto;align-content:start}
.workflow-library-pane>.erp-footer-pagination{margin-top:0}
.template-start{height:100%;min-height:0}
.existing-templates>.section-title,.existing-templates>.el-input,.existing-templates>.erp-footer-pagination{flex:none}
@media(max-width:650px){.template-start{height:100%;grid-template-columns:1fr;grid-template-rows:auto minmax(240px,1fr);overflow:auto}.existing-template-list{max-height:none;flex:1}.create-template,.existing-templates{padding:12px}.workflow-page>.page-heading{margin-bottom:8px}.flow-library{grid-template-columns:1fr}}
</style>
<style>
.production-dialog{max-width:calc(100vw - 24px)}.production-dialog .el-dialog__body{max-height:calc(90vh - 160px);overflow:auto}.production-dialog .el-dialog__footer{border-top:1px solid var(--el-border-color-lighter);padding-top:16px}
</style>
