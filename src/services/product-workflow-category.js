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
export async function prepareProductWorkflowRun(payload,session,services) {
  const definition=validateWorkflow(payload.definition);
  const listing=definition.nodes.find(n=>n.type==='listing');
  const category=await productWorkflowCategory(listing.templateId,session,services);
  for(const node of definition.nodes.filter(n=>n.type==='attribute')) {
    const actual=category.attributes.find(a=>a.attributeId===node.attributeId);
    if(!actual)throw workflowError(`“${node.label}”不属于当前类目，请重新导入类目模板`);
    if(Number(node.dictionaryId)!==Number(actual.dictionaryId)||Boolean(node.multiple)!==Boolean(actual.multiple))throw workflowError(`“${node.label}”的类目属性定义已变化，请重新导入`);
    node.required=Boolean(node.required||actual.required);
  }
  // Generated description and tags are supplied by copy nodes. Other required category inputs must be exposed or fixed by the engineer.
  const missing=category.attributes.filter(a=>a.required&&![4191,23171].includes(a.attributeId)&&!definition.nodes.some(n=>n.type==='attribute'&&Number(n.attributeId)===a.attributeId));
  if(missing.length)throw workflowError(`类目模板仍有必填属性未配置：${missing.map(a=>a.label).join('、')}。请在新建／编辑流程中添加这些属性节点并设置默认值或交给运营填写。`);
  definition.category=category;
  const variants=expandWorkflowVariants(definition,payload.variants,payload.sharedValues||{});
  validateWorkflowVariants(definition,variants);
  const template=await services.listingCategoryTemplateDetail(listing.templateId,session);
  const listingSnapshot=Object.fromEntries(['id','template_name','category_name','ozon_category_id','description_category_id','type_id','attributes','category_attributes','required_attributes','editable_payload'].filter(key=>template[key]!==undefined).map(key=>[key,template[key]]));
  return {...payload,definition,variants,listingSnapshot,outputs:{},draftId:null,executionMode:'background'};
}
