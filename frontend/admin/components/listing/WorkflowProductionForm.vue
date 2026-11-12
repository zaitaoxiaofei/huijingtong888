<script setup>
import { computed, ref } from 'vue';
import WorkflowMaterialInput from './WorkflowMaterialInput.vue';
import WorkflowBrandModels from './WorkflowBrandModels.vue';
import WorkflowFactsHistory from './WorkflowFactsHistory.vue';
import WorkflowMaterialReferences from './WorkflowMaterialReferences.vue';
import WorkflowKeyPicker from './WorkflowKeyPicker.vue';
import { isWorkflowInput } from '../../../../src/shared/product-workflow-inputs.js';
import { workflowProductImageInput } from '../../utils/workflow-product-import.js';
const props=defineProps({definition:{type:Object,required:true},sharedValues:{type:Object,required:true},variants:{type:Array,required:true},productionMode:String,fitmentMode:String,busy:Boolean,keyLibraryRevision:Number});
const emit=defineEmits(['update:productionMode','update:fitmentMode','add','upload','manage-keys','import-files']);
const folderInput=ref(null);
const productInput=ref(null);
const expanded=ref([]);
const locked=computed(()=>props.busy||props.variants.some(v=>v.submissionStarted));
const inputs=computed(()=>props.definition.nodes.filter(n=>isWorkflowInput(n)&&n.inputGroup!=='listing-final'&&!['engineer','generated'].includes(n.valueSource)).map(n=>n.inputGroup==='fitment'?{...n,scope:props.fitmentMode==='individual'?'variant':'shared'}:n));
const common=computed(()=>inputs.value.filter(n=>n.scope==='shared'));
const perItem=computed(()=>inputs.value.filter(n=>n.scope!=='shared'));
const productNode=computed(()=>workflowProductImageInput(props.definition));
const primary=n=>n.required||['model','product','facts'].includes(n.id)||n.id===productNode.value?.id;
const extraCommon=computed(()=>common.value.filter(n=>!primary(n)&&n.id!=='key'));
const keyNode=computed(()=>common.value.find(n=>n.id==='key'));
const imageCount=computed(()=>props.definition.nodes.filter(n=>n.type==='image').length);
const showRows=computed(()=>props.variants);

function setOptions(node,options){const original=props.definition.nodes.find(n=>n.id===node.id);if(original)original.options=options;}
function importFiles(files,options){if(!locked.value&&files?.length)emit('import-files',[...files],options);}
function fitmentBindings(values){if(values.__fitmentBindings)return values.__fitmentBindings;const fits=values.__fitments?.length?values.__fitments:values.model?[{brand:String(values.model).split(' ')[0],model:String(values.model).split(' ').slice(1).join(' ')}]:[];return fits.reduce((rows,f)=>{let b=rows.find(b=>b.brand===f.brand);if(!b){b={brand:f.brand,models:[]};rows.push(b);}b.models.push(f.model);return rows;},[]);}
function setFitments(values,bindings){const fits=bindings.flatMap(b=>b.models.map((model,i)=>({brand:b.brand,model,...(b.modelIds?.[i]?{modelId:b.modelIds[i]}:{})})));const text=fits.map(f=>`${f.brand} ${f.model}`).join('；');setModel(values,'model',text);values.__fitments=fits;values.__fitmentBindings=bindings;}
function setModel(target,id,value){const previous=target[id];target[id]=value;if(previous&&previous!==value&&Array.isArray(target.key))target.key=target.key.map(()=>'');if(previous!==value)delete target.__keyModelId;}
function label(node){return ({facts:'卖点与包装说明',model:'品牌与型号',vehicle_brand:'适配品牌（上架属性）',vehicle_model:'适配型号（上架属性）',brand:'商品品牌（上架属性）',key:'适配钥匙图片'})[node.id]||node.label;}
</script>
<template>
  <div class="production-form">
    <div class="production-summary"><strong>批量上传产品，一次生成多个草稿</strong><span>每件 {{ imageCount }} 张图片{{ definition.nodes.some(n=>n.type==='copy')?' ＋ 商品文案':'' }}</span></div>
    <section v-if="common.some(primary)||keyNode" class="production-section">
      <h3><span class="step-number">1</span>填写产品信息</h3>
      <div class="production-fields">
        <div v-for="node in common.filter(n=>primary(n)&&n.id!=='key')" :key="node.id" class="production-field">
          <WorkflowBrandModels v-if="node.id==='model'&&node.type==='field'" :model-value="fitmentBindings(sharedValues)" :disabled="locked" @update:model-value="setFitments(sharedValues,$event)"/>
          <template v-else><div class="field-heading"><label>{{ label(node) }} <em v-if="node.required">*</em></label><WorkflowFactsHistory v-if="node.id==='facts'" :disabled="locked" @choose="sharedValues[node.id]=$event"/></div><WorkflowMaterialInput v-model="sharedValues[node.id]" compact dense :node="node" :category="definition.category" :disabled="locked" @options="setOptions(node,$event)" @upload="(file,index)=>emit('upload',file,sharedValues,node,index)"/></template>
        </div>
      </div>
      <WorkflowKeyPicker v-if="keyNode" dense :category="definition.category" :values="sharedValues" :node="keyNode" :disabled="locked" :refresh="keyLibraryRevision" @upload="(file,index)=>emit('upload',file,sharedValues,keyNode,index)" @manage="emit('manage-keys',$event)"/>
      <el-collapse><el-collapse-item title="补充引用企业生产资料（选填）" name="materials"><WorkflowMaterialReferences v-model="sharedValues.__materialRefs" :category="definition.category" :fitments="sharedValues.__fitments||[]" :disabled="locked" label="本次生产共用资料"/></el-collapse-item></el-collapse>
    </section>
    <section class="production-section">
      <input ref="folderInput" type="file" accept="image/jpeg,image/png,image/webp" multiple webkitdirectory hidden :disabled="locked" @change="importFiles($event.target.files);$event.target.value=''"/><input ref="productInput" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden :disabled="locked" aria-label="批量选择产品图片" @change="importFiles($event.target.files);$event.target.value=''"/><div class="section-heading"><h3><span class="step-number">{{ common.some(primary)||keyNode?2:1 }}</span>上传产品图片</h3><div><el-button :disabled="locked||!productNode" @click="folderInput.click()">从文件夹导入</el-button><el-button :disabled="locked||variants.length>=20" @click="emit('add')">＋ 添加产品 / 变体</el-button></div></div>
      <div v-if="showRows.length>1" class="batch-options"><el-checkbox v-if="definition.nodes.some(n=>n.inputGroup==='fitment')" :model-value="fitmentMode==='shared'" :disabled="locked" @update:model-value="emit('update:fitmentMode',$event?'shared':'individual')">这些产品使用同一型号</el-checkbox><span>{{ productionMode==='variants'?`本次生成 1 份草稿，包含 ${showRows.length} 个变体`:`本次生成 ${showRows.length} 份独立草稿` }}</span></div>
      <div v-if="productNode" class="batch-drop" :class="{'is-disabled':locked}" role="button" :tabindex="locked?-1:0" :aria-disabled="locked" @click="!locked&&productInput.click()" @keydown.enter.prevent="!locked&&productInput.click()" @keydown.space.prevent="!locked&&productInput.click()" @dragover.prevent @drop.prevent.stop="importFiles($event.dataTransfer.files)"><strong>拖入多张产品图，或点击批量上传</strong><small>每张主图新建一件，最多 20 件；背面、细节图放在同行补充位。</small></div><div class="product-cards" tabindex="0" aria-label="产品与变体列表"><article v-for="(row,index) in showRows" :key="row.id" class="product-card product-row">
        <div class="product-row-main">
        <div class="product-card-heading"><strong>产品 {{ index+1 }}</strong><el-input v-model="row.label" size="small" :disabled="busy||Boolean(row.submissionStarted)" placeholder="备注名称" aria-label="产品备注名称"/></div>
        <div class="product-row-fields"><div v-for="node in perItem.filter(n=>primary(n)&&n.id!=='key')" :key="node.id" class="production-field" :class="{'is-media':node.type==='images','is-fitment':node.id==='model'&&node.type==='field'}">
          <WorkflowBrandModels v-if="node.id==='model'&&node.type==='field'" :model-value="fitmentBindings(row.values)" :disabled="busy||Boolean(row.submissionStarted)" @update:model-value="setFitments(row.values,$event)"/>
          <template v-else><div v-if="node.type!=='images'" class="field-heading"><label>{{ label(node) }} <em v-if="node.required">*</em></label><WorkflowFactsHistory v-if="node.id==='facts'" :disabled="locked" @choose="row.values[node.id]=$event"/></div><WorkflowMaterialInput v-model="row.values[node.id]" compact dense :node="node" :category="definition.category" :multiple-products="!locked&&node.id===productNode?.id" :disabled="busy||Boolean(row.submissionStarted)" @options="setOptions(node,$event)" @upload="(file,slot)=>emit('upload',file,row.values,node,slot)" @upload-files="files=>importFiles(files,{rowId:row.id})"/></template>
        </div>
        <WorkflowKeyPicker v-if="perItem.some(n=>n.id==='key')" dense :category="definition.category" :values="row.values" :node="perItem.find(n=>n.id==='key')" :disabled="busy||Boolean(row.submissionStarted)" :refresh="keyLibraryRevision" @upload="(file,slot)=>emit('upload',file,row.values,perItem.find(n=>n.id==='key'),slot)" @manage="emit('manage-keys',$event)"/></div>
        <div class="product-row-actions"><el-button v-if="showRows.length>1&&!row.submissionStarted" :disabled="busy" size="small" link type="danger" @click="variants.splice(variants.indexOf(row),1)">移除</el-button><span v-if="row.submissionStarted" class="submitted-hint">{{ row.submittedId?'已提交':'提交待确认' }}</span></div>
        </div>
        <details class="product-details"><summary>补充资料</summary><div class="product-details-fields"><div v-for="node in perItem.filter(n=>!primary(n)&&n.id!=='key')" :key="node.id" class="production-field"><label>{{ label(node) }}</label><WorkflowMaterialInput v-model="row.values[node.id]" compact dense :node="node" :category="definition.category" :disabled="busy||Boolean(row.submissionStarted)" @options="setOptions(node,$event)" @upload="(file,slot)=>emit('upload',file,row.values,node,slot)"/></div><div v-for="node in definition.nodes.filter(n=>['image','copy'].includes(n.type))" :key="node.id" class="production-field"><label>{{ node.label }}</label><el-input v-model="row.promptOverrides[node.id]" :disabled="busy||Boolean(row.submissionStarted)" placeholder="选填，只写这件产品的差异要求"/></div></div></details>
      </article></div>
    </section>
    <el-collapse v-model="expanded" class="advanced-production"><el-collapse-item title="更多设置：草稿合并与其他属性" name="advanced"><div class="draft-grouping"><el-checkbox :model-value="productionMode==='variants'" :disabled="locked" @update:model-value="emit('update:productionMode',$event?'variants':'batch')">将本批产品合并为一份多变体草稿</el-checkbox><small>默认每件产品单独生成草稿；仅在这些款式属于同一商品时勾选。</small></div><div v-for="node in extraCommon" :key="node.id" class="production-field"><label>{{ label(node) }}</label><WorkflowMaterialInput v-model="sharedValues[node.id]" compact :node="node" :category="definition.category" :disabled="locked" @options="setOptions(node,$event)" @upload="(file,index)=>emit('upload',file,sharedValues,node,index)"/></div></el-collapse-item></el-collapse>
    <div class="production-note">{{ definition.reviewMode==='automatic'?'自动审批通过后进入待上架草稿。':'生成后检查图片与文案。' }}上架前补齐售价与包装信息；生成期间可离开页面。</div>
  </div>
</template>
<style scoped>
.production-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:8px;flex-wrap:wrap}.production-summary strong{font-size:15px}.production-summary span,.batch-options span{color:var(--el-text-color-secondary);font-size:12px}
.production-section{padding:10px 0;border-top:1px solid var(--el-border-color-lighter)}h3{display:flex;gap:8px;align-items:center;margin:0 0 10px;font-size:14px}.step-number{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-size:12px}
.production-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;margin-bottom:10px}.production-field{display:grid;gap:5px;min-width:0;margin-bottom:10px}.production-field:last-child{margin-bottom:0}.production-field>label,.field-heading label{font-size:13px}.production-field em{color:var(--el-color-danger);font-style:normal}.field-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px}
.production-fields :deep(.brand-models){grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.production-fields :deep(.binding-caption){flex-wrap:wrap;gap:4px;margin-bottom:4px}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.section-heading h3{margin:0}.section-heading>div{display:flex;gap:8px}.section-heading .el-button+.el-button{margin-left:0}
.batch-options{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;flex-wrap:wrap}
.batch-drop{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 12px;margin-bottom:8px;text-align:center;border:1px dashed var(--el-border-color);border-radius:6px;cursor:pointer;background:var(--el-fill-color-blank)}.batch-drop small{color:var(--el-text-color-secondary);font-size:12px}.batch-drop strong{font-size:13px;font-weight:500}.batch-drop:hover,.batch-drop:focus-visible{border-color:var(--el-color-primary)}.batch-drop.is-disabled{cursor:not-allowed;opacity:.6}
.product-cards{display:flex;flex-direction:column;gap:6px;max-height:clamp(260px,46vh,540px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border:1px solid var(--el-border-color-lighter);border-radius:6px;padding:6px;box-sizing:border-box}.product-cards:focus-visible{outline:2px solid var(--el-color-primary)}
.product-card{position:relative;flex:none;padding:8px;border-bottom:1px solid var(--el-border-color-lighter);min-width:0;background:var(--el-bg-color)}.product-card:last-child{border-bottom:0}.product-row-main{display:grid;grid-template-columns:150px minmax(0,1fr) 68px;gap:14px;align-items:start}
.product-card-heading{display:grid;gap:8px;padding-top:4px;min-width:0}.product-card-heading strong{font-size:13px;white-space:nowrap}.product-card-heading .el-input{width:100%;min-width:0}
.product-row-fields{display:flex;align-items:flex-start;gap:10px 16px;flex-wrap:wrap;min-width:0}.product-row-fields>.production-field{flex:1 1 180px;margin:0}.product-row-fields>.is-media{flex:0 1 auto;max-width:100%}.product-row-fields>.is-fitment{flex-basis:100%}.product-row-fields>.key-picker{flex:1 1 280px;min-width:0}
.product-row-actions{display:flex;justify-content:flex-end;min-height:24px;padding-top:3px}.submitted-hint{font-size:12px;color:var(--el-text-color-secondary)}
.product-details>summary{position:absolute;right:8px;top:49px;font-size:12px;color:var(--el-color-primary);cursor:pointer;line-height:24px;white-space:nowrap}.product-details-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;border-top:1px solid var(--el-border-color-lighter);padding-top:10px;margin-top:10px}.product-details-fields>.production-field{margin:0}
.production-note{padding:6px 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6;margin-top:4px}:deep(.el-collapse){border-top:0;border-bottom:0}:deep(.el-collapse-item__header){height:32px;line-height:32px;font-size:12px}:deep(.el-collapse-item__wrap){border-bottom:0}.advanced-production{margin-top:0}.draft-grouping{margin-bottom:10px}.draft-grouping small{display:block;color:var(--el-text-color-secondary);line-height:1.6;font-size:12px}
@media(max-width:700px){.production-fields{grid-template-columns:1fr}.product-row-main{grid-template-columns:120px minmax(0,1fr) 64px;gap:8px}.product-details-fields{grid-template-columns:1fr}.batch-drop{justify-content:flex-start;text-align:left}}
@media(max-width:650px){.production-fields :deep(.brand-models){grid-template-columns:1fr}}
@media(max-width:500px){.production-summary span{display:none}.section-heading{align-items:flex-start;flex-wrap:wrap}.section-heading>div{flex-wrap:wrap}.product-row-main{grid-template-columns:minmax(0,1fr) 68px}.product-card-heading{grid-column:1;display:flex;align-items:center}.product-card-heading .el-input{flex:1}.product-row-fields{grid-column:1/-1;grid-row:2}.product-row-actions{grid-column:2;grid-row:1}.product-details>summary{position:static;text-align:right;margin-top:6px}.product-cards{max-height:50vh}.production-fields{gap:8px}}
</style>
