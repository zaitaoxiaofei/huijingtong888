<script setup>
import { computed, ref } from 'vue';
import WorkflowMaterialInput from './WorkflowMaterialInput.vue';
import WorkflowBrandModels from './WorkflowBrandModels.vue';
import WorkflowFactsHistory from './WorkflowFactsHistory.vue';
import WorkflowMaterialReferences from './WorkflowMaterialReferences.vue';
import WorkflowKeyPicker from './WorkflowKeyPicker.vue';
import { isWorkflowInput } from '../../../../src/shared/product-workflow-inputs.js';
const props=defineProps({definition:{type:Object,required:true},sharedValues:{type:Object,required:true},variants:{type:Array,required:true},productionMode:String,fitmentMode:String,busy:Boolean,keyLibraryRevision:Number});
const emit=defineEmits(['update:productionMode','update:fitmentMode','add','upload','manage-keys','import-files']);
const folderInput=ref(null);
const expanded=ref([]);
const locked=computed(()=>props.busy||props.variants.some(v=>v.submissionStarted));
const inputs=computed(()=>props.definition.nodes.filter(n=>isWorkflowInput(n)&&n.inputGroup!=='listing-final'&&!['engineer','generated'].includes(n.valueSource)).map(n=>n.inputGroup==='fitment'?{...n,scope:props.fitmentMode==='individual'?'variant':'shared'}:n));
const common=computed(()=>inputs.value.filter(n=>n.scope==='shared'));
const perItem=computed(()=>inputs.value.filter(n=>n.scope!=='shared'));
const primary=n=>n.required||['model','product','facts'].includes(n.id);
const extraCommon=computed(()=>common.value.filter(n=>!primary(n)&&n.id!=='key'));
const keyNode=computed(()=>common.value.find(n=>n.id==='key'));
const imageCount=computed(()=>props.definition.nodes.filter(n=>n.type==='image').length);
const showRows=computed(()=>props.productionMode==='single'?props.variants.slice(0,1):props.variants);

function setOptions(node,options){const original=props.definition.nodes.find(n=>n.id===node.id);if(original)original.options=options;}
function add(){if(props.productionMode==='single')emit('update:productionMode','batch');emit('add');}
function fitmentBindings(values){if(values.__fitmentBindings)return values.__fitmentBindings;const fits=values.__fitments?.length?values.__fitments:values.model?[{brand:String(values.model).split(' ')[0],model:String(values.model).split(' ').slice(1).join(' ')}]:[];return fits.reduce((rows,f)=>{let b=rows.find(b=>b.brand===f.brand);if(!b){b={brand:f.brand,models:[]};rows.push(b);}b.models.push(f.model);return rows;},[]);}
function setFitments(values,bindings){const fits=bindings.flatMap(b=>b.models.map(model=>({brand:b.brand,model})));const text=fits.map(f=>`${f.brand} ${f.model}`).join('；');setModel(values,'model',text);values.__fitments=fits;values.__fitmentBindings=bindings;}
function setModel(target,id,value){const previous=target[id];target[id]=value;if(previous&&previous!==value&&Array.isArray(target.key))target.key=target.key.map(()=>'');if(previous!==value)delete target.__keyModelId;}
function label(node){return ({facts:'卖点与包装说明',model:'品牌与型号',vehicle_brand:'适配品牌（上架属性）',vehicle_model:'适配型号（上架属性）',brand:'商品品牌（上架属性）',key:'适配钥匙图片'})[node.id]||node.label;}
</script>
<template>
  <div class="production-form">
    <div class="production-summary"><strong>上传产品资料，生成一套上架图文</strong><span>模板已设好风格 · {{ imageCount }} 张图片{{ definition.nodes.some(n=>n.type==='copy')?' ＋ 商品文案':'' }}</span></div>
    <section v-if="common.some(primary)||keyNode" class="production-section">
      <h3><span class="step-number">1</span>填写产品信息</h3>
      <div class="production-fields">
        <div v-for="node in common.filter(n=>primary(n)&&n.id!=='key')" :key="node.id" class="production-field">
          <WorkflowBrandModels v-if="node.id==='model'&&node.type==='field'" :model-value="fitmentBindings(sharedValues)" :disabled="locked" @update:model-value="setFitments(sharedValues,$event)"/>
          <template v-else><WorkflowFactsHistory v-if="node.id==='facts'" :disabled="locked" @choose="sharedValues[node.id]=$event"/><label>{{ label(node) }} <em v-if="node.required">*</em></label><WorkflowMaterialInput v-model="sharedValues[node.id]" compact :node="node" :category="definition.category" :disabled="locked" @options="setOptions(node,$event)" @upload="(file,index)=>emit('upload',file,sharedValues,node,index)"/></template>
        </div>
      </div>
      <WorkflowKeyPicker v-if="keyNode" :category="definition.category" :values="sharedValues" :node="keyNode" :disabled="locked" :refresh="keyLibraryRevision" @upload="(file,index)=>emit('upload',file,sharedValues,keyNode,index)" @manage="emit('manage-keys',$event)"/>
      <el-collapse><el-collapse-item title="补充引用企业生产资料（选填）" name="materials"><WorkflowMaterialReferences v-model="sharedValues.__materialRefs" :category="definition.category" :fitments="sharedValues.__fitments||[]" :disabled="locked" label="本次生产共用资料"/></el-collapse-item></el-collapse>
    </section>
    <section class="production-section">
      <input ref="folderInput" type="file" multiple webkitdirectory hidden @change="emit('import-files',$event.target.files);$event.target.value=''"/><div class="section-heading"><h3><span class="step-number">{{ common.some(primary)||keyNode?2:1 }}</span>上传产品图片</h3><div><el-button :disabled="locked" @click="folderInput.click()">从文件夹导入</el-button><el-button :disabled="busy||variants.length>=20" @click="add">＋ 再加一件</el-button></div></div>
      <div v-if="showRows.length>1" class="batch-options"><el-checkbox v-if="definition.nodes.some(n=>n.inputGroup==='fitment')" :model-value="fitmentMode==='shared'" :disabled="locked" @update:model-value="emit('update:fitmentMode',$event?'shared':'individual')">这些产品使用同一型号</el-checkbox><span>{{ productionMode==='variants'?'生成一份多款商品草稿':'每件独立生成，互不影响' }}</span></div>
      <el-upload drag multiple accept="image/jpeg,image/png,image/webp" :auto-upload="false" :show-file-list="false" :disabled="locked" :on-change="file=>emit('import-files',[file.raw])" class="batch-drop"><div>将产品图拖到这里，或点击批量选择图片</div><small>每张图片新建一件产品；同一产品补充角度请上传到对应产品卡片。</small></el-upload><div class="product-cards"><article v-for="(row,index) in showRows" :key="row.id" class="product-card">
        <div class="product-card-heading"><strong>产品 {{ index+1 }}</strong><el-input v-if="showRows.length>1" v-model="row.label" :disabled="busy||Boolean(row.submissionStarted)" placeholder="例如：仅壳、挂绳款" aria-label="产品备注名称"/><el-button v-if="showRows.length>1&&!row.submissionStarted" link type="danger" @click="variants.splice(variants.indexOf(row),1)">移除</el-button></div>
        <div v-for="node in perItem.filter(n=>primary(n)&&n.id!=='key')" :key="node.id" class="production-field">
          <WorkflowBrandModels v-if="node.id==='model'&&node.type==='field'" :model-value="fitmentBindings(row.values)" :disabled="busy||Boolean(row.submissionStarted)" @update:model-value="setFitments(row.values,$event)"/>
          <template v-else><WorkflowFactsHistory v-if="node.id==='facts'" :disabled="locked" @choose="row.values[node.id]=$event"/><label v-if="node.type!=='images'">{{ label(node) }} <em v-if="node.required">*</em></label><WorkflowMaterialInput v-model="row.values[node.id]" compact :node="node" :category="definition.category" :disabled="busy||Boolean(row.submissionStarted)" @options="setOptions(node,$event)" @upload="(file,slot)=>emit('upload',file,row.values,node,slot)"/></template>
        </div>
        <WorkflowKeyPicker v-if="perItem.some(n=>n.id==='key')" :category="definition.category" :values="row.values" :node="perItem.find(n=>n.id==='key')" :disabled="busy||Boolean(row.submissionStarted)" :refresh="keyLibraryRevision" @upload="(file,slot)=>emit('upload',file,row.values,perItem.find(n=>n.id==='key'),slot)" @manage="emit('manage-keys',$event)"/><el-collapse><el-collapse-item title="这件产品的补充资料与特殊要求" :name="row.id"><div v-for="node in perItem.filter(n=>!primary(n)&&n.id!=='key')" :key="node.id" class="production-field"><label>{{ label(node) }}</label><WorkflowMaterialInput v-model="row.values[node.id]" compact :node="node" :category="definition.category" :disabled="busy||Boolean(row.submissionStarted)" @options="setOptions(node,$event)" @upload="(file,slot)=>emit('upload',file,row.values,node,slot)"/></div><div v-for="node in definition.nodes.filter(n=>['image','copy'].includes(n.type))" :key="node.id" class="production-field"><label>{{ node.label }}</label><el-input v-model="row.promptOverrides[node.id]" :disabled="busy||Boolean(row.submissionStarted)" placeholder="选填，只写这件产品的差异要求"/></div></el-collapse-item></el-collapse>
      </article></div>
    </section>
    <el-collapse v-model="expanded" class="advanced-production"><el-collapse-item title="更多设置：其他属性、批量与多款商品" name="advanced"><div v-for="node in extraCommon" :key="node.id" class="production-field"><label>{{ label(node) }}</label><WorkflowMaterialInput v-model="sharedValues[node.id]" compact :node="node" :category="definition.category" :disabled="locked" @options="setOptions(node,$event)" @upload="(file,index)=>emit('upload',file,sharedValues,node,index)"/></div><el-checkbox v-if="showRows.length>1" :model-value="productionMode==='variants'" :disabled="locked" @update:model-value="emit('update:productionMode',$event?'variants':'batch')">合并为一份多款商品草稿</el-checkbox><p>不勾选时，每件产品生成独立任务和草稿。</p></el-collapse-item></el-collapse>
    <div class="production-note">{{ definition.reviewMode==='automatic'?'本模板已启用自动审批，生成完会自动进入待上架草稿。':'生成后先检查图片和文案。' }}上架前填写售价、包装重量和尺寸，最后选择店铺上架。生成期间可以离开页面。</div>
  </div>
</template>
<style scoped>
.production-summary{display:grid;gap:8px;padding-bottom:20px}.production-summary strong{font-size:18px}.production-summary span,.batch-options span{color:var(--el-text-color-secondary);font-size:13px}.production-section{padding:20px 0;border-top:1px solid var(--el-border-color-lighter)}h3{display:flex;gap:10px;align-items:center;margin:0 0 18px;font-size:16px}.step-number{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-size:13px}.production-fields{display:grid;gap:18px}.production-field{display:grid;gap:8px;margin-bottom:14px}.production-field:last-child{margin-bottom:0}.production-field>label{font-size:14px}.production-field em{color:var(--el-color-danger);font-style:normal}.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.section-heading h3{margin:0}.batch-drop{margin-bottom:16px}.batch-drop small{display:block;margin-top:8px;color:var(--el-text-color-secondary)}.product-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}.product-card{padding:18px;border:1px solid var(--el-border-color-lighter);border-radius:10px;min-width:0;background:var(--el-bg-color)}.product-card-heading{display:flex;align-items:center;gap:12px;margin-bottom:16px}.product-card-heading .el-input{flex:1;min-width:0}.product-card-heading strong{white-space:nowrap}.product-card-heading>.el-button{margin-left:auto}.batch-options{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}.production-note{padding:16px;background:var(--el-fill-color-light);border-radius:8px;color:var(--el-text-color-secondary);font-size:13px;line-height:1.8;margin-top:18px}.supplement{margin-top:18px}.supplement p,.advanced-production p{font-size:13px;color:var(--el-text-color-secondary)}:deep(.el-collapse){border-top:0;border-bottom:0}:deep(.el-collapse-item__header){font-size:13px}:deep(.el-collapse-item__wrap){border-bottom:0}.advanced-production{margin-top:4px}
</style>
