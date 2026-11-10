// Category metadata comes from the existing listing template/schema, never from a product-family dictionary.
const clone=value=>JSON.parse(JSON.stringify(value));
export const isWorkflowInput=node=>['field','attribute','images'].includes(node.type);
export function workflowDefault(node) {
  return node.type==='images'?(Array.isArray(node.defaultValue)?clone(node.defaultValue):Array(node.count).fill('')):clone(node.defaultValue??(node.multiple?[]:''));
}
export function expandWorkflowVariants(definition,variants,shared={}) {
  return variants.map(variant=>{
    const values=Object.fromEntries(definition.nodes.filter(isWorkflowInput).map(node=>[
      node.id,node.valueSource==='engineer'?workflowDefault(node):node.scope==='shared'?(shared[node.id]??variant.values?.[node.id]??workflowDefault(node)):(variant.values?.[node.id]??workflowDefault(node))
    ]));
    for(const node of definition.nodes.filter(n=>n.type==='images'&&n.fallbackInput))if(!values[node.id]?.some(Boolean))values[node.id]=clone(values[node.fallbackInput]||[]);
    return {...clone(variant),values};
  });
}
// Keep the platform value separate from its operator-facing label. Fresh translated
// options win over stale selected-value snapshots with the same dictionary ID.
export function workflowDictionaryOptions(options=[], previous=[], attributeId=0) {
  const result=new Map();
  for(const row of [...previous,...options]) {
    const id=Number(row.dictionary_value_id||row.id);if(!id)continue;
    const old=result.get(id),raw=String(row.value??row.name??row.label??old?.value??'');
    const labels=[row.display_value_zh,row.displayValueZh,row.value_zh,row.name_zh,row.label,old?.label].filter(Boolean).map(String);
    let label=labels.find(v=>/[\u3400-\u9fff]/u.test(v))||labels[0]||raw;
    if(Number(attributeId)===4389&&/^(?:china|китай)$/iu.test(label.trim()))label='中国';
    result.set(id,{id,label,value:raw||old?.value||label});
  }
  return [...result.values()];
}
export function refreshWorkflowCategory(definition,category) {
  if(definition.category&&(Number(definition.category.descriptionCategoryId)!==Number(category.descriptionCategoryId)||Number(definition.category.typeId)!==Number(category.typeId)))throw new Error('类目已改变，请通过更换类目重新配置');
  const previous=definition.category;
  definition.category=clone(category);
  for(const node of definition.nodes.filter(n=>n.type==='attribute')) {
    const actual=category.attributes.find(a=>Number(a.attributeId)===Number(node.attributeId));
    if(!actual)continue; // Do not discard authored nodes or bindings on refresh.
    if(!node.label||node.label===previous?.attributes?.find(a=>Number(a.attributeId)===Number(node.attributeId))?.label)node.label=actual.label;
    node.platformRequired=actual.platformRequired;
    if(Number(node.dictionaryId)===Number(actual.dictionaryId))node.options=workflowDictionaryOptions(actual.options,node.options,node.attributeId);
  }
  return definition;
}
export function categoryAttributeNodes(template,schema=[]) {
  const editable=template.editable_payload||{};
  const dynamic=Object.entries(editable.variants?.[0]?.dynamic_attributes||{}).map(([id,value])=>({...value,attribute_id:Number(value.attribute_id||id)}));
  const saved=[...(template.attributes||[]),...(template.category_attributes||[]),...(editable.attributes||[]),...(editable.category_attributes||[]),...dynamic];
  const byId=new Map(saved.map(a=>[Number(a.attribute_id||a.id),a]));
  const merged=new Map();
  for(const item of [...saved,...schema]) {
    const id=Number(item.attribute_id||item.id);
    if(!id)continue;
    const previous=byId.get(id)||{};
    const dictionaryId=Number(item.dictionary_id??previous.dictionary_id??0);
    const multiple=Boolean(item.is_collection??previous.is_collection??false);
    const selected=previous.selected_values||previous.selectedValues||[];
    const ids=selected.map(x=>Number(x.dictionary_value_id||x.id)).filter(Boolean);
    merged.set(id,{
      id:`attr_${id}`,type:'attribute',attributeId:id,dictionaryId,multiple,
      label:item.name_zh||item.nameZh||previous.name_zh||item.name||previous.name||`属性 ${id}`,
      help:item.description||item.hint||'',inputFormat:/^(?:integer|decimal|number|float|double)$/i.test(String(item.attribute_type||item.value_type||item.type||''))?'number':'text',platformRequired:Boolean(item.is_required??item.required??previous.required??false),required:false,valueSource:'user',scope:'variant',inputs:[],
      defaultValue:dictionaryId?(multiple?ids:ids[0]||''):(previous.value??(multiple?selected.map(x=>x.value).filter(x=>x!=null):selected[0]?.value??'')),
      options:dictionaryId?workflowDictionaryOptions(item.values||[],selected,id):[]
    });
  }
  return [...merged.values()];
}
export function attributeSelectedValues(node,value) {
  if(node.dictionaryId) {
    return (Array.isArray(value)?value:[value]).filter(x=>x!==''&&x!==null&&x!==undefined).map(id=>{
      const option=node.options?.find(x=>Number(x.id)===Number(id));
      if(!option)throw new Error(`“${node.label}”的字典值未核实，请重新选择`);
      return {dictionary_value_id:Number(id),value:String(option.value??option.label)};
    });
  }
  return (Array.isArray(value)?value:[value]).filter(x=>String(x??'').trim()).map(x=>({value:String(x)}));
}
export function readableWorkflowValue(node,value) {
  if(node.type==='attribute'&&node.dictionaryId)return attributeSelectedValues(node,value).map(x=>node.options.find(o=>Number(o.id)===Number(x.dictionary_value_id))?.label||x.value).join('、');
  return value;
}
export function workflowNodeForVariant(node,variant) {
  const override=variant.promptOverrides?.[node.id];
  return override?{...node,prompt:`${node.prompt}\n当前变体补充要求：${override}`} : node;
}
