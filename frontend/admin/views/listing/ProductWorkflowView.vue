<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { uploadListingMedia } from '../../api/tools/imageCropper.js';
import WorkflowMaterialInput from '../../components/listing/WorkflowMaterialInput.vue';
import WorkflowTemplateBuilder from '../../components/listing/WorkflowTemplateBuilder.vue';
import { keyCaseProductionWorkflow, withWorkflowFitmentMode } from '../../../../src/shared/key-case-production-workflow.js';
import { addDefaultWorkflowBindings } from '../../../../src/shared/product-workflow-bindings.js';
import WorkflowRunReview from '../../components/listing/WorkflowRunReview.vue';
import { createWorkflowNode, keyCaseWorkflow, validateWorkflow, validateWorkflowVariants } from '../../../../src/shared/product-workflow.js';
import { isWorkflowInput, workflowDefault, expandWorkflowVariants } from '../../../../src/shared/product-workflow-inputs.js';

const shops=ref([]),productionMode=ref('single'),fitmentMode=ref('shared');
const router=useRouter(),tab=ref('library'),templates=ref([]),runs=ref([]),jobs=ref([]),listingTemplates=ref([]);
const templateDocument=ref(null),definition=ref(blankWorkflow()),categoryId=ref(null);
const busy=ref(false),busyLabel=ref(''),importInput=ref(null),productionOpen=ref(false);
const sharedValues=ref({}),variants=ref([]),runDocument=ref(null),reviewEditing=ref(false),expandedVariant=ref('');
let pollTimer,polling=false;
const clone=value=>JSON.parse(JSON.stringify(value));
const inputs=computed(()=>definition.value.nodes.filter(n=>isWorkflowInput(n)&&n.inputGroup!=='listing-final').map(n=>n.inputGroup==='fitment'?{...n,scope:fitmentMode.value==='individual'?'variant':'shared'}:n));
const fixedStyles=computed(()=>definition.value.nodes.filter(n=>n.type==='images'&&n.valueSource==='engineer'&&n.referenceRole==='style'));
const essential=n=>n.required||['name','key','model','product'].includes(n.id);
const essentialSharedInputs=computed(()=>sharedInputs.value.filter(essential));
const otherSharedInputs=computed(()=>sharedInputs.value.filter(n=>!essential(n)));
const visibleVariantInputs=computed(()=>variantInputs.value.filter(essential));
const otherVariantInputs=computed(()=>variantInputs.value.filter(n=>!essential(n)));
watch(fitmentMode,(mode)=>{for(const node of definition.value.nodes.filter(n=>n.inputGroup==='fitment')){if(mode==='individual'){for(const row of variants.value)row.values[node.id]??=clone(sharedValues.value[node.id]??workflowDefault(node));}else sharedValues.value[node.id]??=clone(variants.value[0]?.values[node.id]??workflowDefault(node));}});
const sharedInputs=computed(()=>inputs.value.filter(n=>n.valueSource!=='engineer'&&n.valueSource!=='generated'&&n.scope==='shared'));
const variantInputs=computed(()=>inputs.value.filter(n=>n.valueSource!=='engineer'&&n.valueSource!=='generated'&&n.scope!=='shared'));
const category=computed(()=>definition.value.category||{});
const executableNodes=computed(()=>definition.value.nodes.filter(n=>['image','copy'].includes(n.type)));
const stateFor=id=>jobs.value.find(j=>j.run_id===id)||{};
const statusLabels={queued:'排队中',running:'后台生成中',awaiting_review:'待人工检查',ready:'检查完成',failed:'失败待处理',imported:'生产完成'};
const taskRows=computed(()=>runs.value.filter(r=>!r.draft_id));
const resultRows=computed(()=>runs.value.filter(r=>r.draft_id));
const currentJob=computed(()=>runDocument.value?.payload.draftId?{status:'imported'}:stateFor(runDocument.value?.id));
function blankWorkflow(){return {schemaVersion:1,name:'新产品流程',globalPrompt:'保持真实产品外观，套图风格一致，只使用已确认事实。',richContentEnabled:true,nodes:[],bindings:{},shopIds:[]};}
async function action(work){if(busy.value)return;busy.value=true;try{await work();}catch(error){ElMessage.error(error.message||'操作失败');}finally{busy.value=false;busyLabel.value='';}}
async function refreshLists(){const values=await Promise.all([apiClient.get('/api/product-workflows/templates',{noCache:true}),apiClient.get('/api/product-workflows/runs',{noCache:true}),apiClient.get('/api/product-workflows/job-states',{noCache:true})]);[templates.value,runs.value,jobs.value]=values;}
onMounted(()=>{action(async()=>{await refreshLists();listingTemplates.value=await apiClient.get('/api/listing/templates');shops.value=(await apiClient.get('/api/shops')).filter(s=>s.status!=='deleted');});pollTimer=setInterval(poll,4000);});
onUnmounted(()=>clearInterval(pollTimer));
async function poll(){if(polling||busy.value||reviewEditing.value||!['tasks','results'].includes(tab.value))return;polling=true;try{await refreshLists();if(runDocument.value)runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(runDocument.value.id)}`,{noCache:true});}catch{/* Explicit refresh reports failures; retain the last visible state on transient network errors. */}finally{polling=false;}}
function resetMaterials(){fitmentMode.value='shared';sharedValues.value=Object.fromEntries(sharedInputs.value.map(n=>[n.id,workflowDefault(n)]));variants.value=[freshVariant(0)];}
function freshVariant(index){return {requestId:crypto.randomUUID(),submittedId:null,id:`v_${crypto.randomUUID().replaceAll('-','')}`,label:`产品 ${index+1}`,values:Object.fromEntries(variantInputs.value.map(n=>[n.id,workflowDefault(n)])),promptOverrides:{}};}
function addVariant(){if(variants.value.length>=20)return ElMessage.warning('每批最多 20 件产品／变体');variants.value.push(freshVariant(variants.value.length));}
function newTemplate(){templateDocument.value=null;definition.value=blankWorkflow();categoryId.value=null;tab.value='engineer';}
async function loadTemplate(id){const doc=await apiClient.get(`/api/product-workflows/templates?id=${encodeURIComponent(id)}`,{noCache:true});templateDocument.value=doc;definition.value=addDefaultWorkflowBindings(clone(doc.payload));for(const node of definition.value.nodes.filter(isWorkflowInput))node.valueSource||='user';definition.value.richContentEnabled??=true;categoryId.value=definition.value.nodes.find(n=>n.type==='listing')?.templateId||null;}
async function editTemplate(id){await action(async()=>{await loadTemplate(id);tab.value='engineer';});}
async function useTemplate(id){await action(async()=>{await loadTemplate(id);if(!category.value.templateId)await attachCategory();productionMode.value='single';resetMaterials();productionOpen.value=true;});}
async function attachCategory(){
  if(!categoryId.value)throw new Error('请先选择现有上架类目模板');
  const imported=await apiClient.get(`/api/product-workflows/category?id=${categoryId.value}`,{noCache:true});
  if(definition.value.category?.templateId&&(Number(definition.value.category.descriptionCategoryId)!==Number(imported.descriptionCategoryId)||Number(definition.value.category.typeId)!==Number(imported.typeId))){
    const oldAttrs=new Set(definition.value.nodes.filter(n=>n.type==='attribute').map(n=>n.id));
    definition.value.nodes=definition.value.nodes.filter(n=>!oldAttrs.has(n.id));
    for(const node of definition.value.nodes)node.inputs=node.inputs.filter(id=>!oldAttrs.has(id));
    definition.value.bindings={};
  }
  let listing=definition.value.nodes.find(n=>n.type==='listing');if(!listing){listing=createWorkflowNode('listing','listing');definition.value.nodes.unshift(listing);}
  listing.templateId=Number(categoryId.value);definition.value.category=imported;addDefaultWorkflowBindings(definition.value);
  ElMessage.success('模板字段已加载，可预填固定值或绑定图片、文本节点输出');
}
function uploadDefault(file,node,index){if(!Array.isArray(node.defaultValue))node.defaultValue=Array(node.count).fill('');upload(file,{[node.id]:node.defaultValue},node,index);}
async function saveTemplate(){await action(async()=>{if(!category.value.templateId)throw new Error('第一步请先导入上架类目模板');const payload=validateWorkflow(definition.value);templateDocument.value=await apiClient.post('/api/product-workflows/templates',{id:templateDocument.value?.id,revision:templateDocument.value?.revision,payload});await refreshLists();ElMessage.success('流程已保存，可在已有流程中使用');});}
async function loadExample(){await action(async()=>{if(!category.value.templateId)throw new Error('请先导入本企业的类目模板');definition.value=keyCaseProductionWorkflow(clone(category.value));ElMessage.success('钥匙壳生产流程已配置。上传一套风格参考并保存，以后只需替换产品材料。');});}
function exportTemplate(){try{const payload=validateWorkflow(definition.value);const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}));const link=window.document.createElement('a');link.href=url;link.download=`${payload.name.replace(/[\\/:*?"<>|]/g,'-')}.workflow.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){ElMessage.error(error.message);}}
async function importTemplate(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;await action(async()=>{if(file.size>1024*1024)throw new Error('模板文件最多 1 MB');definition.value=addDefaultWorkflowBindings(validateWorkflow(JSON.parse(await file.text())));templateDocument.value=null;categoryId.value=null;const listing=definition.value.nodes.find(n=>n.type==='listing');listing.templateId=0;tab.value='engineer';ElMessage.info('文件已导入，请先重新绑定本企业的上架类目模板');});}
async function upload(file,target,node,index){if(!file)return;await action(async()=>{busyLabel.value='上传产品材料';const result=await uploadListingMedia(file,{source_module:'product_workflow',role:node.referenceRole||'product'});const url=result.publishUrl||result.url||result.previewUrl;if(!url)throw new Error('上传没有返回图片地址');target[node.id][index]=url;});}
async function submitProduction(){await action(async()=>{
  const snapshot=validateWorkflow(withWorkflowFitmentMode(definition.value,fitmentMode.value));
  const batches=productionMode.value==='batch'?variants.value.filter(v=>!v.submittedId).map(v=>[v]):[productionMode.value==='single'?[variants.value[0]]:variants.value];
  for(const rows of batches)validateWorkflowVariants(snapshot,expandWorkflowVariants(snapshot,rows,sharedValues.value));
  for(const rows of batches){
    const first=rows[0];for(const row of rows)row.submissionStarted=true;busyLabel.value=`提交 ${first.label}`;
    const created=await apiClient.post('/api/product-workflows/runs',{requestId:first.requestId,payload:{definition:snapshot,templateId:templateDocument.value?.id||null,templateRevision:templateDocument.value?.revision||null,variants:clone(rows),sharedValues:clone(sharedValues.value),outputs:{},draftId:null,productionMode:productionMode.value}});
    for(const row of rows)row.submittedId=created.id;
    runDocument.value=created;
  }
  productionOpen.value=false;tab.value='tasks';await refreshLists();ElMessage.success(productionMode.value==='batch'?'已按每件产品创建独立任务，模板与共用材料已复用':'已提交后台生产，可以关闭页面');
});}
async function openRun(id,completed=false){await action(async()=>{runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(id)}`,{noCache:true});tab.value=completed?'results':'tasks';});}
async function runAction(body){await action(async()=>{if(body.action==='retry'&&runDocument.value.payload.outputs[body.variantId]?.[body.nodeId]?.status!=='unknown'){try{await ElMessageBox.confirm('重生成会清除依赖本节点的后续结果，并重新调用 AI。是否继续？','重生成',{type:'warning'});}catch{return;}}runDocument.value=await apiClient.post('/api/product-workflows/run-action',body);await refreshLists();});}
async function finishProduction(){await action(async()=>{try{await ElMessageBox.confirm('我已检查全部变体的套图、文案和属性，确认完成生产并生成上架草稿。','整套人工检查',{confirmButtonText:'确认完成',type:'info'});}catch{return;}if(runDocument.value.payload.draftImportStatus!=='unknown')runDocument.value=await apiClient.post('/api/product-workflows/run-action',{id:runDocument.value.id,action:'approve-all'});try{await apiClient.post('/api/product-workflows/import-draft',{id:runDocument.value.id});}finally{runDocument.value=await apiClient.get(`/api/product-workflows/runs?id=${encodeURIComponent(runDocument.value.id)}`,{noCache:true});await refreshLists();}tab.value='results';ElMessage.success('生产完成，已生成操作箱草稿；可预览编辑并选择店铺上架');});}
function openDraft(id){router.push({path:'/listing-automation',query:{draftId:id}});}
watch(tab,()=>{reviewEditing.value=false;});
</script>

<template>
  <div class="workflow-page" v-loading="busy" :element-loading-text="busyLabel||'正在保存'">
    <header class="page-heading"><div><h2>产品模板工作流</h2><p>先定类目，再配置变体与套图规则；提交后台生产，人工检查后上架。</p></div><el-tag effect="plain">流程可复用 · 支持多变体</el-tag></header>
    <el-tabs v-model="tab">
      <el-tab-pane label="已有流程" name="library">
        <div class="toolbar"><h3>选择流程开始生产</h3><el-button type="primary" @click="newTemplate">新建一个流程</el-button><el-button @click="importInput.click()">导入流程文件</el-button></div>
        <el-empty v-if="!templates.length" description="还没有产品流程，先导入类目模板创建第一个流程"><el-button type="primary" @click="newTemplate">创建第一个流程</el-button></el-empty>
        <div class="flow-library"><article v-for="item in templates" :key="item.id" class="flow-card"><div class="toolbar"><h3>{{ item.name }}</h3><el-tag>v{{ item.revision }}</el-tag></div><p>{{ item.category_name||'已保存的品类工作流' }}</p><p>共用参考与分镜规则 · 每个变体独立产品图</p><div class="toolbar"><el-button type="primary" @click="useTemplate(item.id)">使用流程生产</el-button><el-button @click="editTemplate(item.id)">编辑流程</el-button></div></article></div>
      </el-tab-pane>
      <el-tab-pane label="新建／编辑流程" name="engineer">
        <section class="category-first"><div><h3>第一步 · 导入上架类目模板</h3><p>沿用操作箱已有类目与属性定义，直接使用已有类目字段和字典选项，将人工输入、文本或图片节点输出绑定到对应字段。</p></div><div class="toolbar"><el-select v-model="categoryId" filterable placeholder="选择现有上架类目模板"><el-option v-for="item in listingTemplates" :key="item.id" :label="item.template_name||item.category_name" :value="Number(item.id)"/></el-select><el-button type="primary" :disabled="!categoryId" @click="action(attachCategory)">{{ category.templateId?'重新导入类目':'导入类目模板' }}</el-button></div><el-tag v-if="category.templateId" type="success">已绑定：{{ category.categoryName||category.name }}</el-tag></section>
        <template v-if="category.templateId">
          <div class="toolbar"><h3>第二步 · 创建来源节点，绑定模板字段</h3><el-button @click="loadExample">一键配置钥匙壳生产流程</el-button><el-button @click="exportTemplate">导出 JSON</el-button><el-button type="primary" @click="saveTemplate">保存流程</el-button><el-button @click="resetMaterials();productionOpen=true">试用当前流程</el-button></div>
          <div class="workflow-meta"><el-input v-model="definition.name" placeholder="流程名称"/><el-input v-model="definition.globalPrompt" type="textarea" :rows="2" placeholder="全局提示词：统一风格、语言和产品保真要求"/></div>
          <section v-if="definition.preset==='key-case-production'" class="category-first style-kit"><h3>钥匙壳风格模板 · 设置一次，后续复用</h3><p>上传主图风格参考；详情参考可选，逐张对应五个分镜。后续生成使用当前产品与适配钥匙，参考图只控制视觉风格。</p><label v-for="node in fixedStyles" :key="node.id"><strong>{{ node.label }}{{ node.required?'（必填）':'（可选）' }}</strong><WorkflowMaterialInput v-model="node.defaultValue" :node="node" :category="category" @upload="(file,index)=>uploadDefault(file,node,index)"/></label><p>参考图上传后点击“保存流程”。未确认的材质、品牌、价格和尺寸会留给本次资料或上架前补齐。</p></section>
          <WorkflowTemplateBuilder :definition="definition" :category="category" @upload="uploadDefault"/>
          <section class="category-first shop-defaults"><h3>第三步 · 店铺配置</h3><p>保存默认目标店铺。生成草稿后进入店铺配置，确认后再上架。</p><el-select v-model="definition.shopIds" multiple filterable clearable placeholder="选择一个或多个目标店铺（可稍后选择）"><el-option v-for="shop in shops" :key="shop.id" :value="Number(shop.id)" :label="shop.name"/></el-select></section>
        </template>
      </el-tab-pane>
      <el-tab-pane :label="`生产任务／待人工检查${taskRows.length?' · '+taskRows.length:''}`" name="tasks">
        <div class="toolbar"><h3>后台生产与人工检查</h3><el-button @click="action(refreshLists)">刷新任务</el-button></div>
        <el-table :data="taskRows" empty-text="暂无生产任务，从已有流程开始生产"><el-table-column prop="name" label="流程" min-width="180"/><el-table-column prop="product_label" label="产品／首个变体" min-width="150"/><el-table-column label="变体" width="80"><template #default="{row}">{{ row.variant_count||'—' }}</template></el-table-column><el-table-column label="状态" min-width="150"><template #default="{row}"><el-tag :type="stateFor(row.id).status==='failed'?'danger':stateFor(row.id).status==='awaiting_review'?'warning':'info'">{{ statusLabels[stateFor(row.id).status]||'待提交后台' }}</el-tag></template></el-table-column><el-table-column label="操作" min-width="200"><template #default="{row}"><el-button type="primary" text @click="openRun(row.id)">{{ stateFor(row.id).status==='awaiting_review'?'进入人工预览':'查看进度／处理' }}</el-button></template></el-table-column></el-table>
        <section v-if="runDocument&&!runDocument.payload.draftId" class="run-detail"><div class="toolbar"><el-button v-if="!stateFor(runDocument.id).status" @click="runAction({id:runDocument.id,action:'start'})">提交后台执行</el-button><el-tag>{{ statusLabels[currentJob.status]||'等待后台执行' }}</el-tag></div><WorkflowRunReview :record="runDocument" :job="currentJob" :busy="busy" @action="runAction" @finish="finishProduction" @open-draft="openDraft" @editing="reviewEditing=$event"/></section>
      </el-tab-pane>
      <el-tab-pane label="生产结果" name="results">
        <div class="toolbar"><h3>已完成的商品</h3><el-button @click="action(refreshLists)">刷新结果</el-button></div>
        <el-table :data="resultRows" empty-text="人工检查通过并完成生产后，商品会出现在这里"><el-table-column prop="name" label="流程" min-width="180"/><el-table-column label="状态" min-width="150"><template #default>已生成操作箱草稿</template></el-table-column><el-table-column label="操作" min-width="230"><template #default="{row}"><el-button text @click="openRun(row.id,true)">查看完整产出</el-button><el-button type="primary" @click="openDraft(row.draft_id)">预览并上架</el-button></template></el-table-column></el-table>
        <section v-if="runDocument?.payload.draftId" class="run-detail"><WorkflowRunReview :record="runDocument" :job="currentJob" @open-draft="openDraft"/></section>
      </el-tab-pane>
    </el-tabs>
    <input ref="importInput" type="file" accept=".json" hidden @change="importTemplate"/>
    <el-dialog v-model="productionOpen" :title="`使用流程：${definition.name}`" width="1160px" class="production-dialog" :close-on-click-modal="false">
      <template v-if="productionOpen"><el-steps :active="1" simple><el-step title="已绑定类目"/><el-step title="公共资料与变体"/><el-step title="后台生成"/><el-step title="人工预览与上架"/></el-steps><p class="category-summary">上架类目：{{ category.categoryName||category.name }} · 默认一个变体，可快速添加多个</p>
        <div class="production-mode"><h3>生产模式</h3><el-radio-group v-model="productionMode" :disabled="variants.some(v=>v.submissionStarted)"><el-radio-button value="single">单件生产</el-radio-button><el-radio-button value="batch">批量生产 · 每件独立任务</el-radio-button><el-radio-button value="variants">同一商品 · 多变体</el-radio-button></el-radio-group><p>{{ productionMode==='batch'?'每一行独立复用此模板，生成一条生产任务和一份上架草稿。':productionMode==='variants'?'多行变体合并为一条生产任务和同一份多变体草稿。':'一套资料生成一条任务和一份草稿。' }}</p></div><div v-if="definition.preset==='key-case-production'" class="production-mode"><h3>适配资料模式</h3><el-radio-group v-model="fitmentMode" :disabled="variants.some(v=>v.submissionStarted)"><el-radio-button value="shared">同一车型／钥匙 · 共用适配资料</el-radio-button><el-radio-button value="individual">更换车型／钥匙 · 每件分别提供</el-radio-button></el-radio-group><p>钥匙外形、按键数量与型号必须一致；更换车型时填写该产品自己的型号并上传新的适配钥匙图。</p></div><h3>共用材料 · 整批只填写一次</h3><div class="common-inputs"><label v-for="node in essentialSharedInputs" :key="node.id">{{ node.label }} <em v-if="node.required">必填</em><WorkflowMaterialInput v-model="sharedValues[node.id]" :node="node" :category="category" :disabled="variants.some(v=>v.submissionStarted)" @options="node.options=$event" @upload="(file,index)=>upload(file,sharedValues,node,index)"/></label></div>
        <el-collapse v-if="otherSharedInputs.length"><el-collapse-item title="其他产品属性（可按实际补充）" name="other-inputs"><div class="common-inputs"><label v-for="node in otherSharedInputs" :key="node.id">{{ node.label }}<WorkflowMaterialInput v-model="sharedValues[node.id]" :node="node" :category="category" :disabled="variants.some(v=>v.submissionStarted)" @options="node.options=$event" @upload="(file,index)=>upload(file,sharedValues,node,index)"/></label></div></el-collapse-item></el-collapse>
        <div class="toolbar"><h3>{{ productionMode==='variants'?'变体资料':'产品资料' }}</h3><el-button v-if="productionMode!=='single'" @click="addVariant">＋ 添加{{ productionMode==='variants'?'变体':'产品' }}</el-button><el-tag>{{ productionMode==='single'?'1 件产品':variants.length+(productionMode==='batch'?' 条独立任务':' 个变体') }}</el-tag></div>
        <el-table :data="productionMode==='single'?variants.slice(0,1):variants" border><el-table-column label="产品／变体" width="170" fixed><template #default="{row}"><el-input v-model="row.label" :disabled="Boolean(row.submissionStarted)" placeholder="产品／变体名称"/><small v-if="row.submittedId">已提交 {{ row.submittedId.slice(0,8) }}</small></template></el-table-column><el-table-column v-for="node in visibleVariantInputs" :key="node.id" :label="node.label+(node.required?' *':'')" :width="node.type==='images'?240:190"><template #default="{row}"><WorkflowMaterialInput v-model="row.values[node.id]" :node="node" :category="category" :disabled="Boolean(row.submissionStarted)" @options="node.options=$event" @upload="(file,index)=>upload(file,row.values,node,index)"/></template></el-table-column><el-table-column label="操作" width="100"><template #default="{row,$index}"><el-button v-if="variants.length>1&&!row.submissionStarted" text type="danger" @click="variants.splice($index,1)">删除</el-button><el-button text @click="expandedVariant=expandedVariant===row.id?'':row.id">特殊要求</el-button></template></el-table-column></el-table>
        <section v-for="variant in variants.filter(v=>v.id===expandedVariant)" :key="variant.id" class="variant-overrides"><h4>{{ variant.label }} · 属性与可选补充要求</h4><label v-for="node in otherVariantInputs" :key="node.id">{{ node.label }}<WorkflowMaterialInput v-model="variant.values[node.id]" :node="node" :category="category" :disabled="Boolean(variant.submissionStarted)" @options="node.options=$event" @upload="(file,index)=>upload(file,variant.values,node,index)"/></label><p>留空即遵循模板。这里只补充该变体的差异要求，不修改共用模板。</p><label v-for="node in executableNodes" :key="node.id">{{ node.label }}<el-input v-model="variant.promptOverrides[node.id]" type="textarea" :rows="2" placeholder="可选，例如该变体需要额外突出红色包边"/></label></section>
        <p>提交后后台自动执行，可以离开页面。各任务分别生成与检查，确认后生成待上架草稿；售价、包装重量与长宽高在操作箱最后填写。提交中断时再次提交会复用原任务，已提交的行不会重复创建。</p>
      </template><template #footer><el-button @click="productionOpen=false">稍后提交</el-button><el-button type="primary" :loading="busy" @click="submitProduction">{{ productionMode==='batch'?'批量创建生产任务':'提交后台生产' }}</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.workflow-page{padding:20px;color:var(--el-text-color-primary)}h2,h3,h4{margin:0}p{color:var(--el-text-color-secondary);line-height:1.6}.page-heading,.toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px}.toolbar{justify-content:flex-start;margin:16px 0}.toolbar h3{margin-right:auto}.toolbar .el-select{width:310px;max-width:100%}.flow-library{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}.flow-card,.category-first{padding:20px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:8px}.flow-card{max-width:620px}.workflow-meta{display:grid;grid-template-columns:260px 1fr;gap:16px;margin-bottom:20px}.workflow-editor{display:grid;grid-template-columns:190px minmax(250px,1fr) minmax(260px,340px);gap:18px;align-items:start}.workflow-palette,.workflow-inspector{padding:16px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:8px}.workflow-palette{max-height:760px;overflow:auto}.workflow-palette h3:not(:first-child){margin-top:20px}.workflow-palette p{font-size:12px}.workflow-palette button{display:block;width:100%;margin-top:8px;text-align:left;padding:10px;border:1px solid var(--el-border-color-lighter);border-radius:6px;background:var(--el-fill-color-light);color:var(--el-text-color-primary);cursor:grab}.editor-areas{margin:16px 0}.editor-areas .el-radio-group{display:flex;flex-wrap:wrap}.workflow-canvas{padding:14px;max-height:760px;overflow:auto;min-height:400px;background:var(--el-fill-color-lighter);border-radius:8px}.workflow-editor>*{min-width:0}.category-root,.workflow-node{box-sizing:border-box;width:100%;padding:14px;background:var(--el-bg-color);border:1px solid var(--el-border-color);border-radius:8px;color:var(--el-text-color-primary);text-align:left}.category-root{border-color:var(--el-color-success)}small{display:block;color:var(--el-text-color-secondary);margin-top:5px}.workflow-node-wrap{display:flex;flex-direction:column;align-items:center}.workflow-arrow{padding:5px;color:var(--el-text-color-placeholder)}.workflow-node{display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:grab}.workflow-node.selected{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.workflow-inspector label,.variant-overrides label{display:block;margin:14px 0}.workflow-inspector .el-select,.workflow-inspector .el-input-number{width:100%;margin-top:6px}.workflow-inspector .el-input,.workflow-inspector .el-textarea{margin-top:6px}.workflow-inspector p{font-size:12px}.style-kit{margin-bottom:20px}.style-kit label{display:block;margin:18px 0}.style-kit label>strong{display:block;margin-bottom:12px}.shop-defaults{margin-top:20px}.shop-defaults .el-select{width:100%;max-width:600px}.production-mode{margin:20px 0}.production-mode .el-radio-group{margin-top:12px}.run-detail{margin-top:24px;padding-top:20px;border-top:1px solid var(--el-border-color-lighter)}.common-inputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:18px 0}.common-inputs label>div{margin-top:8px}.category-summary{margin:20px 0}em{font-size:12px;font-style:normal;color:var(--el-color-primary)}.variant-overrides{padding:18px;background:var(--el-fill-color-lighter);margin-top:16px;border-radius:8px}@media(max-width:1100px){.workflow-editor{grid-template-columns:170px 1fr}.workflow-inspector{grid-column:1/-1}.workflow-meta{grid-template-columns:1fr}}@media(max-width:650px){.workflow-page{padding:12px}.workflow-editor,.common-inputs{grid-template-columns:1fr}.workflow-palette{max-height:300px}.flow-library{grid-template-columns:1fr}}
</style>
<style>
.production-dialog{max-width:calc(100vw - 24px)}
</style>
