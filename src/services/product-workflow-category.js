import { keyModelIdentity } from '../shared/workflow-key-models.js';
import { categoryAttributeNodes, expandWorkflowVariants } from '../shared/product-workflow-inputs.js';
import { validateWorkflow, validateWorkflowVariants, workflowError } from '../shared/product-workflow.js';

export async function productWorkflowCategory(id,session,services) {
  const template=await services.listingCategoryTemplateDetail(Number(id),session);
  const editable=template.editable_payload||{};
  const [categoryFromKey,typeFromKey]=String(template.ozon_category_id||editable.ozon_category_id||'').split(':');
  const descriptionCategoryId=Number(template.description_category_id||editable.description_category_id||categoryFromKey);
  const typeId=Number(template.type_id||editable.type_id||typeFromKey);
  if(!descriptionCategoryId||!typeId)throw workflowError('这个类目模板缺少有效的 Ozon 类目与商品类型，请先在操作箱维护类目模板');
  const schema=await services.listingOzonCategoryAttributes({description_category_id:descriptionCategoryId,type_id:typeId,language:'ZH_HANS',value_limit:40},session);
  const attributes=categoryAttributeNodes(template,schema);
  return {templateId:Number(id),name:template.template_name||template.category_name,categoryName:template.category_name||template.template_name,descriptionCategoryId,typeId,attributes};
}
export async function prepareProductWorkflowRun(payload,session,services,store=null) {
  const definition=validateWorkflow(payload.definition);
  const listing=definition.nodes.find(n=>n.type==='listing');
  const category=await productWorkflowCategory(listing.templateId,session,services);
  for(const node of definition.nodes.filter(n=>n.type==='attribute')) {
    const actual=category.attributes.find(a=>a.attributeId===node.attributeId);
    if(!actual)throw workflowError(`“${node.label}”不属于当前类目，请重新导入类目模板`);
    if(Number(node.dictionaryId)!==Number(actual.dictionaryId)||Boolean(node.multiple)!==Boolean(actual.multiple))throw workflowError(`“${node.label}”的类目属性定义已变化，请重新导入`);
    // Platform-required fields are checked by the listing editor, not by image production.
    node.platformRequired=actual.platformRequired;
  }
  definition.category=category;
  const variants=expandWorkflowVariants(definition,payload.variants,payload.sharedValues||{});
  for(const node of definition.nodes.filter(n=>n.type==='attribute'&&n.dictionaryId)) {
    const selectedIds=[...new Set(variants.flatMap(v=>[v.values[node.id]].flat()).filter(v=>v!==''&&v!=null).map(Number))];
    const verified=new Map(category.attributes.find(a=>a.attributeId===node.attributeId).options.map(o=>[Number(o.id),o]));
    for(const id of selectedIds.filter(id=>!verified.has(id))) {
      const hint=node.options?.find(o=>Number(o.id)===id)?.label;
      if(!hint)throw workflowError(`“${node.label}”的选项未核实，请从类目下拉列表重新选择`);
      const rows=await services.listingOzonAttributeValues({description_category_id:category.descriptionCategoryId,type_id:category.typeId,attribute_id:node.attributeId,keyword:hint,limit:2000},session);
      const actual=rows.find(row=>Number(row.dictionary_value_id||row.id)===id);
      if(!actual)throw workflowError(`“${node.label}”的选项不在当前类目字典范围内，请重新选择`);
      verified.set(id,{id,label:actual.display_value_zh||actual.value_zh||actual.label||actual.value||actual.name});
    }
    node.options=[...verified.values()];
    category.attributes.find(a=>a.attributeId===node.attributeId).options=node.options;
  }
  for(const variant of variants)if(variant.keyModelId){
    if(!store)throw workflowError('钥匙适配库暂不可用，请重试或手动上传适配图');
    const record=await store.get('key_model',String(variant.keyModelId),session),profile=record.payload;
    if(variant.keyModelRevision&&Number(variant.keyModelRevision)!==record.revision)throw workflowError(`${variant.label}的钥匙适配资料已更新，请重新选择后提交`);
    if(profile.archived||keyModelIdentity(`${profile.brand} ${profile.model}`)!==keyModelIdentity(variant.values.model))throw workflowError(`${variant.label}的钥匙适配资料与型号不一致或已停用，请重新选择`);
    if(!definition.nodes.some(n=>n.id==='key'&&n.type==='images'))throw workflowError('当前流程未配置适配钥匙图片输入');
    variant.values.key=profile.images.slice(0,definition.nodes.find(n=>n.id==='key').count);variant.keyModelRevision=record.revision;
  }
  validateWorkflow(definition);
  validateWorkflowVariants(definition,variants);
  const template=await services.listingCategoryTemplateDetail(listing.templateId,session);
  const listingSnapshot=Object.fromEntries(['id','template_name','category_name','ozon_category_id','description_category_id','type_id','attributes','category_attributes','required_attributes','editable_payload'].filter(key=>template[key]!==undefined).map(key=>[key,template[key]]));
  return {...payload,definition,variants,listingSnapshot,outputs:{},draftId:null,executionMode:'background'};
}
