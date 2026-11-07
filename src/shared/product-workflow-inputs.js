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
    const dictionaryId=Number(item.dictionary_id||previous.dictionary_id||0);
    const multiple=Boolean(item.is_collection||previous.is_collection);
    const selected=previous.selected_values||previous.selectedValues||[];
    const ids=selected.map(x=>Number(x.dictionary_value_id||x.id)).filter(Boolean);
    merged.set(id,{
      id:`attr_${id}`,type:'attribute',attributeId:id,dictionaryId,multiple,
      label:item.name_zh||item.nameZh||previous.name_zh||item.name||previous.name||`属性 ${id}`,
      help:item.description||item.hint||'',platformRequired:Boolean(item.is_required||item.required||previous.required),required:false,valueSource:'user',scope:'variant',inputs:[],
      defaultValue:dictionaryId?(multiple?ids:ids[0]||''):(previous.value??''),
      options:dictionaryId?[...new Map([...(item.values||[]),...selected].filter(x=>Number(x.dictionary_value_id||x.id)).map(x=>[Number(x.dictionary_value_id||x.id),{id:Number(x.dictionary_value_id||x.id),label:x.display_value_zh||x.value_zh||x.name_zh||x.label||x.value||x.name||''}])).values()]:[]
    });
  }
  return [...merged.values()];
}
export function attributeSelectedValues(node,value) {
  if(node.dictionaryId) {
    return (Array.isArray(value)?value:[value]).filter(x=>x!==''&&x!==null&&x!==undefined).map(id=>{
      const option=node.options?.find(x=>Number(x.id)===Number(id));
      if(!option)throw new Error(`“${node.label}”的字典值未核实，请重新选择`);
      return {dictionary_value_id:Number(id),value:String(option.label)};
    });
  }
  return (Array.isArray(value)?value:[value]).filter(x=>String(x??'').trim()).map(x=>({value:String(x)}));
}
export function readableWorkflowValue(node,value) {
  if(node.type==='attribute'&&node.dictionaryId)return attributeSelectedValues(node,value).map(x=>x.value).join('、');
  return value;
}
export function workflowNodeForVariant(node,variant) {
  const override=variant.promptOverrides?.[node.id];
  return override?{...node,prompt:`${node.prompt}\n当前变体补充要求：${override}`} : node;
}
