import { normalizeWorkflowTags,validateWorkflowCopy } from './workflow-copy-rules.js';
import { workflowNodeSkipped } from './workflow-conditions.js';
import { attributeSelectedValues, isWorkflowInput, readableWorkflowValue } from './product-workflow-inputs.js';

const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const clone=value=>JSON.parse(JSON.stringify(value));
export const WORKFLOW_TEMPLATE_FIELDS=[
  {key:'title',label:'标题',kind:'text'}, {key:'tags',label:'#产品标签',kind:'text'},
  {key:'description',label:'简介',kind:'text'}, {key:'images',label:'主图／详情图',kind:'images'},
  {key:'richContent',label:'富文本（JSON富内容）',kind:'rich'},
  {key:'price',label:'售价（人民币／CNY）',kind:'number'}, {key:'old_price',label:'划线价（人民币／CNY）',kind:'number'}, {key:'weight',label:'包装重量／克重（g）',kind:'number'},
  {key:'length',label:'包装长（cm）',kind:'number'}, {key:'width',label:'包装宽（cm）',kind:'number'}, {key:'height',label:'包装高（cm）',kind:'number'}
];
export function workflowTemplateFields(category={},currencyCode='CNY') {
  const aliases={4191:'description',23171:'tags',11254:'richContent'};
  return [...WORKFLOW_TEMPLATE_FIELDS.map(field=>({...field,...(['price','old_price'].includes(field.key)&&currencyCode!=='CNY'?{label:field.label.replace('人民币／CNY',currencyCode)}:{}),attribute:category.attributes?.find(a=>aliases[a.attributeId]===field.key)})),
    ...(category.attributes||[]).filter(a=>!aliases[a.attributeId]).map(a=>({key:`attribute_${a.attributeId}`,label:a.label,kind:a.inputFormat==='number'&&!a.dictionaryId?'number':'text',attribute:a}))];
}
export function workflowNodeOutputs(node) {
  if(node.type==='image'||node.type==='images')return [{nodeId:node.id,output:'image',kind:'image',label:node.label}];
  if(isWorkflowInput(node)&&node.valueSource!=='generated')return [{nodeId:node.id,output:'value',kind:'text',label:node.label}];
  if(node.type==='copy')return (node.target==='bundle'?['title','tags','description']:[node.target]).map(output=>({nodeId:node.id,output,kind:'text',label:node.target==='bundle'?`${node.label} · ${{title:'标题',tags:'标签',description:'简介'}[output]}`:node.label}));
  return [];
}
export function validateWorkflowBindings(definition) {
  if(!definition.bindings||typeof definition.bindings!=='object'||Array.isArray(definition.bindings))fail('模板字段绑定格式无效');
  const fields=workflowTemplateFields(definition.category,definition.currencyCode||'CNY'),allowed=new Map(fields.map(f=>[f.key,f]));
  for(const [key,binding] of Object.entries(definition.bindings)) {
    const field=allowed.get(key);
    if(!field)fail(`模板字段 ${key} 不属于当前类目，请重新绑定`);
    if(!Array.isArray(binding.sources)||binding.sources.length>80)fail(`“${field.label}”的输出来源无效`);
    for(const ref of binding.sources) {
      const node=definition.nodes.find(n=>n.id===ref.nodeId),output=node&&workflowNodeOutputs(node).find(o=>o.output===ref.output);
      if(!output)fail(`“${field.label}”引用的节点输出不存在，请重新绑定`);
      if(field.kind==='images'&&output.kind!=='image'||!['images','rich'].includes(field.kind)&&output.kind==='image')fail(`“${field.label}”的字段类型与“${node.label}”不匹配`);
    }
    if(field.attribute?.dictionaryId&&binding.sources.length>1&&!field.attribute.multiple)fail(`“${field.label}”只能选择一个字典值来源`);
  }
  if(definition.shopIds&&(!Array.isArray(definition.shopIds)||definition.shopIds.length>100||definition.shopIds.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<=0)))fail('请选择有效的目标店铺');
}
function sourceValue(definition,variant,results,ref) {
  const node=definition.nodes.find(n=>n.id===ref.nodeId);
  if(workflowNodeSkipped(node,variant))return '';
  if(isWorkflowInput(node))return node.type==='images'?(variant.values[node.id]||[]):readableWorkflowValue(node,variant.values[node.id]);
  const state=results[node.id];
  if(!state?.approved)fail(`${variant.label}的“${node.label}”尚未检查通过`);
  if(node.type==='image'?!state.url:state.text?.[ref.output]==null)fail(`${variant.label}的“${node.label}”尚未返回所绑定的输出`);
  return node.type==='image'?state.url:state.text?.[ref.output];
}
export function composeWorkflowRichContent(title,text,images) {
  return JSON.stringify({content:[{widgetName:'raShowcase',type:'billboard',blocks:(images.length?images:['']).map((url,i)=>({
    imgLink:'',...(url?{img:{src:url,srcMobile:url,alt:title,position:'width_full',positionMobile:'width_full',widthMobile:1024,heightMobile:1536}}:{}),
    ...(i===0?{title:{items:[{type:'text',content:title}],size:'size4',align:'left',color:'color1'},text:{items:[{type:'text',content:text}],size:'size2',align:'left',color:'color1'}}:{})
  }))}],version:0.3});
}
export function resolveWorkflowBindings(definition,variant,results) {
  const values={};
  for(const field of workflowTemplateFields(definition.category,definition.currencyCode||'CNY')) {
    const sources=definition.bindings[field.key]?.sources||[];
    if(!sources.length)continue;
    const resolved=sources.map(ref=>({ref,value:sourceValue(definition,variant,results,ref),kind:workflowNodeOutputs(definition.nodes.find(n=>n.id===ref.nodeId)).find(o=>o.output===ref.output).kind}));
    if(field.kind==='rich') {
      const images=resolved.filter(v=>v.kind==='image').flatMap(v=>[v.value].flat()).filter(Boolean);
      const text=resolved.filter(v=>v.kind==='text').flatMap(v=>[v.value].flat()).filter(v=>v!==''&&v!=null).join('\n\n');
      values[field.key]={images,text};
    }else if(field.kind==='images')values[field.key]=resolved.flatMap(v=>[v.value].flat()).filter(Boolean);
    else if(field.attribute?.dictionaryId) {
      // AI output must exactly match an actual category option; never fabricate dictionary IDs.
      const selected=resolved.flatMap(v=>[v.value].flat()).filter(v=>v!==''&&v!=null).map(value=>{
        const option=field.attribute.options?.find(o=>String(o.id)===String(value)||o.label===String(value));
        if(!option)fail(`${variant.label}的“${field.label}”不在类目选项中，请编辑对应文本结果或改用人工选择`);
        return option.id;
      });
      values[field.key]=selected;
    }else if(field.key==='tags')values[field.key]=resolved.flatMap(v=>Array.isArray(v.value)?v.value:String(v.value||'').split(/[\s,，;；]+/)).filter(Boolean);
    else {
      const value=resolved.flatMap(v=>[v.value].flat()).filter(v=>v!==''&&v!=null).join('\n');
      if(field.kind==='number'&&value!==''&&(!Number.isFinite(Number(value))||(field.key==='old_price'?Number(value)<0:['price','weight','length','width','height'].includes(field.key)&&Number(value)<=0)))fail(`${variant.label}的“${field.label}”${field.key==='old_price'?'应为零或正数':field.key.startsWith('attribute_')?'须填写有效数字':'应大于零'}，请检查来源节点`);
      values[field.key]=field.kind==='number'&&value!==''?Number(value):value;
    }
  }
  if(values.old_price>0&&values.price>0&&values.old_price<=values.price)fail('划线价必须大于售价；不使用划线价时可留空或填0');
  if(values.tags?.length)values.tags=normalizeWorkflowTags(values.tags);
  for(const key of ['title','description'])if(values[key])values[key]=validateWorkflowCopy(key,values[key],variant.fitments||[]);
  return values;
}
export function applyWorkflowBindings(definition,variant,results,baseAttributes={}) {
  const resolved=resolveWorkflowBindings(definition,variant,results);
  const {title='',description='',tags=[],images=[]}=resolved;
  const dynamic_attributes=clone(baseAttributes);
  const rich=resolved.richContent;
  const richContent=rich?composeWorkflowRichContent(title,rich.text,rich.images):'';
  for(const field of workflowTemplateFields(definition.category,definition.currencyCode||'CNY')) {
    if(!field.attribute||!(field.key in resolved))continue;
    const raw=field.kind==='rich'?richContent:resolved[field.key];
    const selected=attributeSelectedValues(field.attribute,raw);
    dynamic_attributes[field.attribute.attributeId]={attribute_id:field.attribute.attributeId,name:field.label,dictionary_id:field.attribute.dictionaryId||0,values:selected,selected_values:selected,value:field.attribute.multiple?selected.map(v=>v.dictionary_value_id||v.value):selected[0]?.dictionary_value_id||selected[0]?.value||''};
  }
  // Content fields are part of the listing payload even when absent from the schema's current page.
  for(const [id,value] of [[4191,description],[23171,tags.join(' ')],[11254,richContent]]) {
    if(value)dynamic_attributes[id]={attribute_id:id,values:[{value}],selected_values:[{value}],value};
    else delete dynamic_attributes[id];
  }
  return {title,name:title,description,tags,hashtags:tags,main_tags:tags,dynamic_attributes,
    rich_content_json:richContent,rich_content:richContent,images:images.map((url,i)=>({url,role:i?'detail':'main',sort_order:i+1})),primary_image:images[0]||'',
    ...(resolved.price?{price:String(resolved.price),price_value:String(resolved.price)}:{}),currency_code:definition.currencyCode||'CNY',currency:definition.currencyCode||'CNY',
    ...('old_price' in resolved&&resolved.old_price!==''?{old_price:String(resolved.old_price||0)}:{}),
    ...(resolved.weight?{weight:resolved.weight,weight_g:resolved.weight,weight_unit:'g'}:{}),
    ...Object.fromEntries(['length','width','height'].filter(k=>resolved[k]).flatMap(k=>[[`${k}_mm`,resolved[k]*10],[k==='length'?'depth':k,resolved[k]*10]])),dimension_unit:'mm'};
}
// Upgrade older saved workflows without changing a running task's frozen definition.
export function addDefaultWorkflowBindings(definition) {
  if(definition.bindings){
    for(const key of ['price','old_price'])for(const ref of definition.bindings[key]?.sources||[]){const node=definition.nodes.find(n=>n.id===ref.nodeId);if(node&&/^(?:售价|划线价)(?:[（(](?:RUB|CNY|人民币[／/]CNY)[）)])?$/.test(node.label))node.label=workflowTemplateFields({},definition.currencyCode||'CNY').find(f=>f.key===key).label;}
    return definition;
  }
  const ref=(nodeId,output)=>({nodeId,output});
  const bindings={};
  const imageNodes=definition.nodes.filter(n=>n.type==='image').sort((a,b)=>Number(b.role==='main')-Number(a.role==='main'));
  if(imageNodes.length)bindings.images={sources:imageNodes.map(n=>ref(n.id,'image'))};
  for(const key of ['title','tags','description']) {
    const node=definition.nodes.findLast(n=>n.type==='copy'&&(n.target==='bundle'||n.target===key));
    if(node)bindings[key]={sources:[ref(node.id,key)]};
  }
  if(definition.richContentEnabled!==false&&bindings.description&&imageNodes.length)bindings.richContent={sources:[ref(imageNodes[0].id,'image'),...bindings.description.sources]};
  for(const node of definition.nodes.filter(n=>n.type==='attribute')) {
    const key={4191:'description',23171:'tags',11254:'richContent'}[node.attributeId]||`attribute_${node.attributeId}`;
    if(node.valueSource==='generated'){if(bindings[node.generatedTarget])bindings[key]=clone(bindings[node.generatedTarget]);continue;}
    bindings[key]={sources:[ref(node.id,'value')]};
  }
  for(const node of definition.nodes.filter(n=>n.type==='price'||n.type==='package')) {
    const fields=node.type==='price'?{price:node.value}:{weight:node.weight,length:node.length,width:node.width,height:node.height};
    for(const [key,value] of Object.entries(fields)) {
      const input={id:`fixed_${key}`,type:'field',label:WORKFLOW_TEMPLATE_FIELDS.find(f=>f.key===key).label,inputs:[],scope:'shared',valueSource:'engineer',required:false,defaultValue:String(value)};
      while(definition.nodes.some(n=>n.id===input.id))input.id+='_fixed';
      definition.nodes.push(input);bindings[key]={sources:[ref(input.id,'value')]};
    }
  }
  definition.nodes=definition.nodes.filter(n=>!['price','package'].includes(n.type));
  definition.bindings=bindings;
  return definition;
}
