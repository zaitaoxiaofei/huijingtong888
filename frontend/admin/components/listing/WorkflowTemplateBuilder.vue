<script setup>
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import WorkflowMaterialInput from './WorkflowMaterialInput.vue';
import { createWorkflowNode, WORKFLOW_TYPES } from '../../../../src/shared/product-workflow.js';
import { isWorkflowInput, workflowDefault } from '../../../../src/shared/product-workflow-inputs.js';
import { workflowTemplateFields, workflowNodeOutputs } from '../../../../src/shared/product-workflow-bindings.js';
const props=defineProps({definition:{type:Object,required:true},category:{type:Object,required:true}});
const emit=defineEmits(['upload']);
const fieldKey=ref('title'),selectedId=ref(''),search=ref(''),drag=ref(null);
const fields=computed(()=>workflowTemplateFields(props.category));
const coreGroups=[{label:'商品内容',keys:['title','tags','description','richContent','images']},{label:'价格与包装',keys:['price','weight','length','width','height']}];
const filteredFields=computed(()=>fields.value.filter(f=>f.key.startsWith('attribute_')&&f.label.toLowerCase().includes(search.value.toLowerCase())));
const fieldFor=key=>fields.value.find(f=>f.key===key);
const fieldSummary=key=>props.definition.bindings[key]?.sources.length?props.definition.bindings[key].sources.map(outputLabel).join(' ＋ '):'待配置来源／上架前补齐';
const field=computed(()=>fields.value.find(f=>f.key===fieldKey.value)||fields.value[0]);
const nodes=computed(()=>props.definition.nodes.filter(n=>n.type!=='listing'));
const selected=computed(()=>nodes.value.find(n=>n.id===selectedId.value));
const outputs=computed(()=>nodes.value.flatMap(workflowNodeOutputs));
const binding=computed(()=>props.definition.bindings[field.value.key]||{sources:[]});
const earlier=computed(()=>props.definition.nodes.slice(0,props.definition.nodes.findIndex(n=>n.id===selectedId.value)).filter(n=>selected.value?.type==='copy'?['field','attribute','copy'].includes(n.type):isWorkflowInput(n)||['image','copy','approval'].includes(n.type)));
const outputKey=o=>`${o.nodeId}:${o.output}`;
const outputLabel=ref=>outputs.value.find(o=>outputKey(o)===outputKey(ref))?.label||'已删除的节点';
const compatible=(output,target=field.value)=>target.kind==='rich'||target.kind==='images'?target.kind==='rich'||output.kind==='image':output.kind==='text';
function selectField(key){fieldKey.value=key;selectedId.value=props.definition.bindings[key]?.sources[0]?.nodeId||'';}
function insert(node){
  const index=isWorkflowInput(node)?props.definition.nodes.findIndex(n=>['image','copy','approval'].includes(n.type)):-1;
  props.definition.nodes.splice(index<0?props.definition.nodes.length:index,0,node);selectedId.value=node.id;
}
function create(type){
  const node=createWorkflowNode(type);node.label=type==='field'?'人工输入':type==='copy'?'文本生成':'图片生成';
  if(type==='field')Object.assign(node,{scope:'shared',valueSource:'engineer',required:false});
  if(type==='copy'){node.target='text';node.prompt='根据引用材料与已确认事实，生成这个节点所需的俄语文本。严格遵循具体要求，不编造信息。';}
  if(['image','copy'].includes(type))node.inputs=props.definition.nodes.filter(isWorkflowInput).filter(n=>n.valueSource!=='generated'&&(type!=='copy'||n.type!=='images')).map(n=>n.id);
  insert(node);
}
function manual(){
  const source=binding.value.sources.map(r=>props.definition.nodes.find(n=>n.id===r.nodeId)).find(n=>isWorkflowInput(n)&&n.valueSource!=='generated');
  if(source){selectedId.value=source.id;return;}
  const node=field.value.attribute?JSON.parse(JSON.stringify(field.value.attribute)):createWorkflowNode(field.value.kind==='images'?'images':'field');
  if(field.value.attribute)node.id=createWorkflowNode('field').id;
  Object.assign(node,{label:field.value.label,valueSource:'engineer',scope:'shared',required:false});
  if(node.type==='images')Object.assign(node,{valueSource:'user',defaultValue:['']});
  insert(node);bind(workflowNodeOutputs(node)[0]);
}
function bind(output,target=field.value){
  if(!output)return;
  if(!compatible(output,target))return ElMessage.warning(`“${target.label}”需要${target.kind==='images'?'图片':'文本'}来源；富文本可同时组合图片和文本`);
  const current=props.definition.bindings[target.key] ||= {sources:[]};
  if(!current.sources.some(o=>outputKey(o)===outputKey(output)))current.sources.push({nodeId:output.nodeId,output:output.output});
}
function removeBinding(index){binding.value.sources.splice(index,1);}
function moveBinding(index,direction){const next=index+direction;if(next<0||next>=binding.value.sources.length)return;const [item]=binding.value.sources.splice(index,1);binding.value.sources.splice(next,0,item);}
function start(event,payload){drag.value=payload;event.dataTransfer.setData('text/plain',JSON.stringify(payload));event.dataTransfer.effectAllowed='copy';}
function drop(event,target=field.value){event.preventDefault();const payload=drag.value;drag.value=null;if(payload?.type==='output')bind(payload.output,target);else if(payload?.type==='node')create(payload.nodeType);}
function dropInput(event){event.preventDefault();const payload=drag.value;drag.value=null;if(payload?.type!=='output'||!selected.value)return;const id=payload.output.nodeId;if(!earlier.value.some(n=>n.id===id))return ElMessage.warning('只能引用前面的节点，避免循环依赖');if(!selected.value.inputs.includes(id))selected.value.inputs.push(id);}
function removeNode(){const id=selected.value.id;for(const node of props.definition.nodes)node.inputs=node.inputs.filter(n=>n!==id);for(const value of Object.values(props.definition.bindings))value.sources=value.sources.filter(r=>r.nodeId!==id);props.definition.nodes=props.definition.nodes.filter(n=>n.id!==id);selectedId.value='';}
function duplicate(){const node=JSON.parse(JSON.stringify(selected.value));node.id=createWorkflowNode(node.type).id;node.label+=' 副本';props.definition.nodes.splice(props.definition.nodes.findIndex(n=>n.id===selected.value.id)+1,0,node);selectedId.value=node.id;}
function changeFormat(){const old=selected.value;const node=createWorkflowNode(old.manualFormat==='images'?'images':'field',old.id);Object.assign(node,{label:old.label,scope:old.scope,valueSource:old.valueSource,required:old.required});if(node.type==='images')node.defaultValue=workflowDefault(node);const index=props.definition.nodes.findIndex(n=>n.id===old.id);props.definition.nodes[index]=node;for(const value of Object.values(props.definition.bindings))for(const source of value.sources)if(source.nodeId===node.id)source.output=node.type==='images'?'image':'value';}
function slotsChanged(){const node=selected.value;node.slots=Array.from({length:node.count},(_,i)=>node.slots[i]||`第 ${i+1} 张图片用途`);node.defaultValue=Array.from({length:node.count},(_,i)=>node.defaultValue?.[i]||'');}
</script>
<template>
  <div class="binding-builder">
    <section class="builder-panel template-panel">
      <div class="section-head"><div><h3>上架模板字段</h3><p>按草稿箱的商品内容、售价与包装字段横向配置。常用字段始终显示；先保存模板，上架前补齐内容。</p></div><el-tag effect="plain">点击字段编辑，或拖入节点输出</el-tag></div>
      <div v-for="group in coreGroups" :key="group.label" class="field-group"><h4>{{ group.label }}</h4><div class="field-grid"><button v-for="key in group.keys" :key="key" class="template-field" :class="{active:fieldKey===key,unconfigured:!definition.bindings[key]?.sources.length}" @click="selectField(key)" @dragover.prevent @drop.stop="drop($event,fieldFor(key))"><strong>{{ fieldFor(key).label }}</strong><span>{{ fieldSummary(key) }}</span><small>{{ definition.bindings[key]?.sources.length?'已配置来源':'待配置' }}</small></button></div></div>
      <el-collapse class="extra-fields"><el-collapse-item :title="`其他类目属性（${fields.filter(f=>f.key.startsWith('attribute_')).length}）`" name="attributes"><el-input v-model="search" placeholder="搜索其他类目属性" clearable/><div class="field-grid"><button v-for="item in filteredFields" :key="item.key" class="template-field" :class="{active:fieldKey===item.key}" @click="selectField(item.key)" @dragover.prevent @drop.stop="drop($event,item)"><strong>{{ item.label }}</strong><small v-if="item.attribute?.platformRequired">平台上架必填</small><span>{{ fieldSummary(item.key) }}</span></button></div><el-empty v-if="!filteredFields.length" description="没有匹配的类目属性" :image-size="45"/></el-collapse-item></el-collapse>
    </section>
    <aside class="builder-panel sources-panel">
      <h3>添加来源节点</h3><p>只有三类来源，名称与用途自由定义</p>
      <button v-for="(label,type) in {field:'人工输入',copy:'AI 文本生成',image:'AI 图片生成'}" :key="type" class="source-type" draggable="true" @dragstart="start($event,{type:'node',nodeType:type})" @click="create(type)">{{ label }} ＋</button>

    </aside>
    <main class="builder-panel edit-panel" @dragover.prevent @drop="drop($event)">
      <div class="section-head"><div><h3>{{ field.label }}</h3><p>将右侧节点输出拖入这里，或直接选择；一个输出可多次复用</p></div><el-button @click="manual">人工填写／预填</el-button></div>
      <div class="binding-drop" @dragover.prevent @drop.stop="drop($event)">
        <p v-if="!binding.sources.length">拖入已有输出作为此字段的内容</p>
        <div v-for="(source,index) in binding.sources" :key="outputKey(source)" class="bound-source"><span>{{ index+1 }}. {{ outputLabel(source) }}</span><el-button text @click="selectedId=source.nodeId">编辑</el-button><el-button text :disabled="index===0" @click="moveBinding(index,-1)">↑</el-button><el-button text :disabled="index===binding.sources.length-1" @click="moveBinding(index,1)">↓</el-button><el-button text type="danger" @click="removeBinding(index)">移除</el-button></div>
      </div>
      <el-select :model-value="''" filterable placeholder="选择已有节点输出并绑定" @change="bind(outputs.find(o=>outputKey(o)===$event))"><el-option v-for="output in outputs.filter(o=>compatible(o))" :key="outputKey(output)" :label="output.label" :value="outputKey(output)"/></el-select>
      <el-alert v-if="field.kind==='rich'" title="可同时绑定多张图片与文本。生成后按绑定内容组装 JSON 富文本，无需手写 JSON。" type="info" :closable="false"/>
      <el-alert v-if="field.attribute?.dictionaryId" title="仅接受当前类目字典中的选项。AI 文本须精确匹配已有选项，无法匹配时需要人工修正。" type="info" :closable="false"/>
      <section v-if="selected" class="node-settings">
        <div class="section-head"><h3>编辑节点 · {{ selected.label }}</h3><el-tag>{{ ['field','attribute','images'].includes(selected.type)?'人工输入':selected.type==='copy'?'AI 文本生成':WORKFLOW_TYPES[selected.type] }}</el-tag></div>
        <label>节点名称<el-input v-model="selected.label" placeholder="例如：俄语标题、主图、材质特写"/></label>
        <template v-if="isWorkflowInput(selected)">
          <label v-if="selected.type!=='attribute'">输入格式<el-select :model-value="selected.type==='images'?'images':'text'" @change="selected.manualFormat=$event;changeFormat()"><el-option label="文本／数值" value="text"/><el-option label="上传图片" value="images"/></el-select></label>
          <label>谁提供材料<el-select v-model="selected.valueSource"><el-option label="工程师预填，后续直接复用" value="engineer"/><el-option label="使用流程时由用户填写／上传" value="user"/></el-select></label>
          <label v-if="selected.valueSource==='user'">填写范围<el-select v-model="selected.scope"><el-option label="本次生产共用（只填一次）" value="shared"/><el-option label="每件产品／每个变体分别填写" value="variant"/></el-select></label>
          <el-checkbox v-model="selected.required">本流程必须提供这项材料</el-checkbox>
          <template v-if="selected.type==='images'"><label>上传张数<el-input-number v-model="selected.count" :min="1" :max="8" @change="slotsChanged"/></label><label v-for="(_,i) in selected.slots" :key="i">第 {{ i+1 }} 张用途<el-input v-model="selected.slots[i]"/></label><label>图片用途<el-select v-model="selected.referenceRole"><el-option label="产品真实外观" value="product"/><el-option label="视觉参考" value="style"/><el-option label="适配对象参考" value="compatibility"/></el-select></label></template>
          <label>{{ selected.valueSource==='engineer'?'工程师固定内容':'使用者默认内容（可留空）' }}<WorkflowMaterialInput v-model="selected.defaultValue" :node="selected" :category="category" @options="selected.options=$event" @upload="(file,index)=>emit('upload',file,selected,index)"/></label>
          <label>填写说明<el-input v-model="selected.help"/></label>
        </template>
        <template v-if="['image','copy'].includes(selected.type)">
          <label class="input-drop" @dragover.prevent @drop.stop="dropInput($event)">输入材料／引用前序节点（也可拖入）<el-select v-model="selected.inputs" multiple filterable><el-option v-for="node in earlier" :key="node.id" :label="node.label" :value="node.id"/></el-select></label>
          <template v-if="selected.type==='copy'"><label>输出格式<el-select v-model="selected.target"><el-option label="通用文本（任意属性）" value="text"/><el-option label="标题" value="title"/><el-option label="标签列表" value="tags"/><el-option label="简介" value="description"/><el-option label="标题＋标签＋简介" value="bundle"/></el-select></label></template>
          <label v-if="selected.type==='image'">图片比例<el-select v-model="selected.ratio"><el-option v-for="ratio in ['3:4','1:1','4:5']" :key="ratio" :label="ratio" :value="ratio"/></el-select></label>
          <template v-if="selected.type==='image'"><label v-for="source in earlier.filter(n=>n.type==='images'&&n.count>1&&selected.inputs.includes(n.id))" :key="source.id">{{ source.label }} · 本张引用槽位<el-select :model-value="selected.referenceSlots?.[source.id]||[]" multiple placeholder="留空使用全部图片" @change="selected.referenceSlots||={};$event.length?selected.referenceSlots[source.id]=$event:delete selected.referenceSlots[source.id]"><el-option v-for="(slot,index) in source.slots" :key="index" :value="index" :label="slot"/></el-select></label></template>
          <label>生成提示词<el-input v-model="selected.prompt" type="textarea" :rows="6" placeholder="定义这个节点要生成什么，以及必须遵循的规则"/></label>
        </template>
        <template v-if="selected.type==='approval'"><p>兼容已有流程的人工确认节点。</p><el-select v-model="selected.inputs" multiple><el-option v-for="node in earlier.filter(n=>n.type==='image')" :key="node.id" :value="node.id" :label="node.label"/></el-select></template>
        <div class="section-head"><el-button @click="duplicate">复制节点</el-button><el-button plain type="danger" @click="removeNode">删除节点</el-button></div>
      </section>
      <el-empty v-else description="点击左侧添加节点，或选择右侧节点进行编辑"/>
    </main>
    <aside class="builder-panel outputs-panel"><h3>已有节点与输出</h3><p>拖到上方模板字段，或中间绑定区；可组合、排序、重复使用</p><el-empty v-if="!nodes.length" description="先添加一个来源节点"/>
      <article v-for="node in nodes" :key="node.id" class="output-node" :class="{active:selectedId===node.id}"><button class="output-name" @click="selectedId=node.id">{{ node.label }} <small>编辑</small></button><button v-for="output in workflowNodeOutputs(node)" :key="outputKey(output)" class="output-chip" draggable="true" @dragstart="start($event,{type:'output',output})" @click="bind(output)">{{ output.kind==='image'?'图片':'文本' }} · {{ output.label }} →</button><p v-if="!workflowNodeOutputs(node).length">辅助节点</p></article>
    </aside>
  </div>
</template>
<style scoped>
.binding-builder{display:grid;grid-template-columns:minmax(190px,240px) minmax(320px,1fr) minmax(210px,280px);gap:16px;align-items:start}.builder-panel{min-width:0;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-bg-color);padding:18px}.builder-panel h3{margin:0;font-size:15px}.builder-panel p{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.source-type,.template-field,.output-chip,.output-name{box-sizing:border-box;display:block;width:100%;text-align:left;color:var(--el-text-color-primary);background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:6px;padding:10px;margin-top:10px;cursor:pointer}.source-type,.output-chip{cursor:grab}.template-panel{grid-column:1/-1}.field-group+.field-group{margin-top:18px}.field-group h4{font-size:13px;margin:0 0 8px;color:var(--el-text-color-secondary)}.field-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.field-grid .template-field{margin-top:0;min-height:104px;display:flex;flex-direction:column}.field-grid .template-field span{flex:1;overflow-wrap:anywhere}.field-grid .template-field small{margin-top:8px;color:var(--el-color-success)}.field-grid .template-field.unconfigured small{color:var(--el-text-color-placeholder)}.extra-fields{margin-top:18px}.extra-fields .el-input{max-width:380px;margin:8px 0 14px}.template-field.active,.output-node.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.template-field strong,.template-field span,.template-field small{display:block;line-height:1.5}.template-field span{font-size:12px;color:var(--el-text-color-secondary);margin-top:5px}.template-field small{font-size:11px;color:var(--el-color-warning)}.section-title{margin:24px 0 12px!important}.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 14px}.section-head p{margin-bottom:0}.binding-drop{border:1px dashed var(--el-color-primary);border-radius:8px;padding:12px;min-height:70px;margin-bottom:14px;background:var(--el-color-primary-light-9)}.bound-source{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding:6px 0}.bound-source span{flex:1;min-width:100px;font-size:13px}.bound-source .el-button+.el-button{margin-left:0}.node-settings{margin-top:25px;border-top:1px solid var(--el-border-color-lighter);padding-top:20px}.node-settings label{display:block;margin:16px 0;font-size:13px}.node-settings label>.el-input,.node-settings label>.el-select,.node-settings label>.el-textarea{margin-top:8px}.el-select{width:100%}.el-alert{margin-top:15px}.output-node{border:1px solid var(--el-border-color-lighter);padding:10px;border-radius:8px;margin-top:14px}.output-name{background:transparent;border:0;font-weight:600;padding:0;margin:0}.output-name small{font-weight:400;float:right;color:var(--el-color-primary)}.output-chip{font-size:12px;line-height:1.5}.outputs-panel{max-height:940px;overflow:auto}.input-drop{padding:12px;border:1px dashed var(--el-border-color);border-radius:8px}@media(max-width:1100px){.field-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.binding-builder{grid-template-columns:190px minmax(0,1fr)}.outputs-panel{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}}@media(max-width:650px){.field-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.binding-builder{grid-template-columns:1fr}.outputs-panel{display:block}}
</style>
