import { workflowNodeSkipped } from './workflow-conditions.js';
import {validateMaterialRefs, normalizeMaterialBindings} from './workflow-materials.js';
import { validateWorkflowBindings, applyWorkflowBindings } from './product-workflow-bindings.js';
import { attributeSelectedValues, readableWorkflowValue } from './product-workflow-inputs.js';
// Portable workflow format. Node types and dependencies are independent of product category.
export const WORKFLOW_TYPES = {
  field: "产品字段", attribute: "类目属性", images: "参考图片", image: "图片生成", approval: "人工确认",
  video: "主图视频", copy: "文案生成", listing: "类目模板", price: "售价", package: "包装参数"
};
const clone = value => JSON.parse(JSON.stringify(value));
export function workflowError(message) { return Object.assign(new Error(message), { status: 400 }); }

export function validateWorkflow(value) {
  if (!value || value.schemaVersion !== 1 || !String(value.name || "").trim()) throw workflowError("请填写模板名称，或导入 schemaVersion 为 1 的工作流文件");
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 80) throw workflowError("模板需要 1–80 个节点");
  if(typeof value.globalPrompt!=="string")throw workflowError("全局提示词必须为文本");
  if(value.currencyCode&&!['CNY','RUB','USD','EUR','KZT','BYN'].includes(value.currencyCode))throw workflowError('请选择有效的计价币种');
  if(value.reviewMode&&!['manual','automatic'].includes(value.reviewMode))throw workflowError('请选择人工检查或自动检查模式');
  for(const refs of [value.sharedMaterialRefs,...value.nodes.map(n=>n.materialRefs)])validateMaterialRefs(refs);
  const seen = new Map();
  for (const node of value.nodes) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(node.id) || ["constructor","prototype","__proto__"].includes(node.id) || seen.has(node.id)) throw workflowError("节点标识无效或重复，请重新添加该节点");
    if (!WORKFLOW_TYPES[node.type] || !String(node.label || "").trim()) throw workflowError("节点类型或名称无效");
    if (!Array.isArray(node.inputs) || node.inputs.some(id => !seen.has(id))) throw workflowError(`${node.label}只能引用排在前面的节点；请调整顺序或输入引用`);
    if (["image", "copy"].includes(node.type) && node.imageMode!=='material' && !String(node.prompt || "").trim()) throw workflowError(`${node.label}缺少提示词，请在节点设置填写`);
    if(node.imageMode&&!['generate','material'].includes(node.imageMode))throw workflowError(`${node.label}的图片来源无效`);
    if(node.type==='image'&&node.imageMode==='material'&&node.materialRefs?.length!==1)throw workflowError(`${node.label}请从资料库选择一张成品图`);
    if(node.requiresInput&&(node.type!=='image'||node.role==='main'||!seen.has(node.requiresInput)||seen.get(node.requiresInput).type!=='images'))throw workflowError(`${node.label}的可选图片依赖无效`);
    if(node.inputFormat&&!['text','number','images'].includes(node.inputFormat))throw workflowError(`${node.label}的输入格式无效`);
    if (node.type === "images" && (!Number.isInteger(node.count) || node.count < 1 || node.count > 8 || !Array.isArray(node.slots) || node.slots.length !== node.count || node.slots.some(x => !String(x).trim()))) throw workflowError(`${node.label}需要为每张参考图填写用途（1–8 张）`);
    if (node.type === "image" && !["1:1", "3:4", "4:5"].includes(node.ratio)) throw workflowError(`${node.label}请选择有效图片比例`);
    if (node.type === "image" && node.imageMode!=='material' && !node.inputs.some(id => ["images", "image", "approval"].includes(seen.get(id).type))) throw workflowError(`${node.label}需要引用产品图片或已确认图片`);
    if(node.copyRules!==undefined&&(node.type!=='copy'||typeof node.copyRules!=='string'||node.copyRules.length>20000))throw workflowError('文案通用规则须为不超过20000字符的文本');
    if(node.type==='video'&&(node.inputs.length!==1||seen.get(node.inputs[0])?.type!=='image'||seen.get(node.inputs[0])?.role!=='main'))throw workflowError(`${node.label}需要引用本流程生成的主图`);
    if (node.type === "approval" && (!node.inputs.length || node.inputs.some(id => !["image", "approval"].includes(seen.get(id).type)))) throw workflowError(`${node.label}需要引用待确认的图片生成节点`);
    if (node.type === "price" && (!Number.isFinite(Number(node.value)) || Number(node.value) <= 0)) throw workflowError(`${node.label}请填写大于零的售价`);
    if (node.type === "package" && ["weight", "length", "width", "height"].some(k => !Number.isFinite(Number(node[k])) || Number(node[k]) <= 0)) throw workflowError(`${node.label}请填写大于零的克重和厘米尺寸`);
    if (node.type === "listing" && !Number.isSafeInteger(Number(node.templateId))) throw workflowError(`${node.label}的类目模板标识无效`);
    if(node.type==="copy"&&!["bundle","title","tags","description","text"].includes(node.target))throw workflowError(`${node.label}的文案输出类型无效`);
    if(node.valueSource&&!['engineer','user','generated'].includes(node.valueSource))throw workflowError(`${node.label}的值来源无效`);
    if(node.valueSource==='generated'&&(node.type!=='attribute'||node.dictionaryId||!['title','tags','description','richContent'].includes(node.generatedTarget)))throw workflowError(`${node.label}请选择有效的生成结果映射；字典属性须从类目选项中填写`);
    if(node.fallbackInput&&(!seen.has(node.fallbackInput)||seen.get(node.fallbackInput).type!=='images'||node.type!=='images'))throw workflowError(`${node.label}的图片复用来源无效`);
    if(node.referenceSlots)for(const [id,slots] of Object.entries(node.referenceSlots)){
      const source=seen.get(id);if(!node.inputs.includes(id)||source?.type!=='images'||!Array.isArray(slots)||!slots.length||slots.some(index=>!Number.isInteger(index)||index<0||index>=source.count))throw workflowError(`${node.label}的参考图片槽位无效，请重新选择`);
    }
    if(node.scope&&!['shared','variant'].includes(node.scope))throw workflowError(`${node.label}的填写范围无效`);
    if(node.type==='attribute'&&(!Number.isSafeInteger(Number(node.attributeId))||Number(node.attributeId)<=0))throw workflowError(`${node.label}缺少有效的类目属性标识`);
    seen.set(node.id, node);
  }
  if (value.nodes.filter(n => n.type === "listing").length !== 1) throw workflowError("工作流需要且只能有一个类目模板节点");
  for (const type of ["price", "package"]) if (value.nodes.filter(n => n.type === type).length > 1) throw workflowError(`${WORKFLOW_TYPES[type]}节点只能有一个`);
  if(value.bindings){validateWorkflowBindings(value);return clone(value);}
  if (!value.nodes.some(n => n.type === "image" && n.role === "main") || value.nodes.filter(n => n.type === "image" && n.role === "main").length !== 1) throw workflowError("工作流需要且只能有一个主图生成节点");
  if (!value.nodes.some(n => n.type === "copy")) throw workflowError("工作流需要文案生成节点");
  return clone(value);
}

export function createWorkflowNode(type, id = `n_${globalThis.crypto.randomUUID().replaceAll("-", "")}`) {
  const base = { id, type, label: WORKFLOW_TYPES[type], inputs: [] };
  if (type === "field" || type === "attribute") Object.assign(base, { scope:"variant", required: true, defaultValue: "", help: "请填写已核实的产品信息" });
  if (type === "images") Object.assign(base, { scope:"variant", count: 1, required: true, slots: ["产品白底图"], referenceRole: "product" });
  if (type === "image") Object.assign(base, { role: "detail", ratio: "3:4", prompt: "基于输入图片和已确认事实生成一张电商详情图，保持产品真实外观。" });
  if (type === "video") Object.assign(base,{label:"主图视频"});
  if (type === "copy") Object.assign(base, { target: "bundle", prompt: "生成准确自然的俄语标题、标签和描述；只使用已确认产品事实，不编造卖点。" });
  if (type === "listing") Object.assign(base, { templateId: 0 });
  if (type === "price") Object.assign(base, { value: 990 });
  if (type === "package") Object.assign(base, { weight: 50, length: 10, width: 8, height: 3 });
  return base;
}

export function keyCaseWorkflow() {
  const field = (id,label,defaultValue="") => ({ ...createWorkflowNode("field",id), scope:id==='color'?'variant':'shared', label, defaultValue });
  const images = { ...createWorkflowNode("images","product"), label:"变体产品主图",count:1,slots:["当前变体的真实产品主图"] };
  const key = { ...createWorkflowNode("images","key"),scope:"shared",label:"适配钥匙图",referenceRole:"compatibility",slots:["全商品共同适配的钥匙外形"] };
  const style = { ...createWorkflowNode("images","style"),scope:"shared",label:"视觉参考",required:false,referenceRole:"style",slots:["整套共用的版式与风格参考"] };
  const facts=["name","brand","model","material","color","facts"];
  const main={...createWorkflowNode("image","main"),label:"主图",role:"main",inputs:[...facts,"product","key","style"],prompt:"产品位于视觉中心，手机缩略图仍清晰。参考视觉图的构图与信息层级，明确展示已确认适配型号；只适配上传的钥匙，不扩大适配范围。"};
  const approval={...createWorkflowNode("approval","approve"),label:"确认主图",inputs:["main"]};
  const shots=[['适配特写','突出适配钥匙外形和按键，清晰说明仅适配已确认型号。'],['手持场景','展示自然手持使用场景；不标注未经确认的尺寸。'],['材质特写','展示已确认材质与真实局部质感，不添加未经确认的性能承诺。'],['覆盖防护','展示真实包覆部位，不编造跌落测试或防护等级。'],['按键贴合','展示按键与开孔贴合，保持产品真实结构。'],['购买须知','清晰展示适配确认要点与包装数量；仅使用已确认事实。']];
  return {schemaVersion:1,name:"TPU 汽车钥匙壳",globalPrompt:"整套统一背景、光线和字体。保持产品形状、颜色、按键、开孔和数量。图片文案使用自然俄语，不添加平台标志。不得编造适配、材质、信号性能或认证。",nodes:[{...createWorkflowNode("listing","listing")},field("name","产品名称","汽车钥匙保护壳"),field("brand","品牌"),field("model","适配型号"),field("material","材质","TPU"),field("color","颜色"),field("facts","已核实卖点与包装数量"),images,key,style,main,approval,...shots.map(([label,prompt],i)=>({...createWorkflowNode("image",`detail_${i+1}`),label,inputs:[...facts,"product","key","approve"],prompt})),{...createWorkflowNode("copy","copy"),inputs:facts}]};
}

export function validateWorkflowVariants(definition, variants) {
  if (!Array.isArray(variants) || !variants.length || variants.length > 20) throw workflowError("请提交 1–20 个变体");
  const keys = new Set();
  for (const variant of variants) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(variant.id) || ["constructor","prototype","__proto__"].includes(variant.id) || keys.has(variant.id)) throw workflowError("变体标识重复或无效");
    keys.add(variant.id);validateMaterialRefs(variant.materialRefs);if(variant.fitments)normalizeMaterialBindings(variant.fitments.map(f=>({brand:f.brand,models:[f.model]})));
    for (const node of definition.nodes) {
      const input=variant.values?.[node.id];
      if (["field","attribute"].includes(node.type) && node.valueSource!=="generated" && node.required && (!String(input ?? "").trim()||Array.isArray(input)&&!input.length)) throw workflowError(`${variant.label}缺少“${node.label}”，请在商品公共资料或变体材料区填写`);
      if(node.inputFormat==='number'&&input!==''&&input!==undefined&&input!==null&&(!['string','number'].includes(typeof input)||!String(input).trim()||!Number.isFinite(Number(input))))throw workflowError(`${variant.label}的“${node.label}”必须填写数字`);
      if(node.type==='attribute')attributeSelectedValues(node,input);
      if (node.type === "images") {
        if (!Array.isArray(input) || input.length > node.count) throw workflowError(`${variant.label}的“${node.label}”图片数量无效`);
        if (node.required && (input.length !== node.count || input.some(x => !x))) throw workflowError(`${variant.label}的“${node.label}”需要按顺序上传 ${node.count} 张图片`);
        for (const url of input.filter(Boolean)) if (!/^(https?:\/\/|\/api\/|\/uploads\/)/i.test(String(url)) || /[\r\n]/.test(url)) throw workflowError("参考图地址无效，请重新上传图片");
      }
    }
    for(const [id,prompt] of Object.entries(variant.promptOverrides||{}))if(!definition.nodes.some(n=>n.id===id&&['image','copy'].includes(n.type))||typeof prompt!=='string'||prompt.length>20000)throw workflowError(`${variant.label}的分镜补充要求无效`);
  }
  return clone(variants);
}

export function workflowInputContext(definition, variant, node, results) {
  const byId = new Map(definition.nodes.map(n => [n.id,n]));
  const refs = [], facts = {}, visited=new Set();
  function visit(id) {
    if(visited.has(id)) return; visited.add(id);
    const source=byId.get(id);
    if(["field","attribute"].includes(source.type)) {if(source.valueSource!=="generated")facts[source.label]=readableWorkflowValue(source,variant.values[id]);}
    else if(source.type==="images") (variant.values[id]||[]).forEach((url,i)=>{if(url&&(!node.referenceSlots?.[source.id]||node.referenceSlots[source.id].includes(i)))refs.push({url,role:source.referenceRole,label:source.slots[i]});});
    else if(source.type==="image") {
      if(!results[id]?.url) throw workflowError(`请先完成“${source.label}”`);
      refs.push({url:results[id].url,role:"approved_visual",label:source.label});
    } else if(source.type==="approval") {
      if(!results[id]?.approved) throw workflowError(`请先完成“${source.label}”人工确认`);
      source.inputs.forEach(visit);
    } else if(source.type==="copy") {
      if(!results[id]?.text) throw workflowError(`请先完成“${source.label}”`);
      facts[source.label]=results[id].text;
    }
  }
  node.inputs.forEach(visit);
  for(const ref of [...(definition.sharedMaterialRefs||[]),...(node.materialRefs||[]),...(variant.materialRefs||[])]) {
    const record=definition.materialSnapshots?.[ref.id];
    if(!record)throw workflowError('生产资料未加载，请重新提交任务');
    facts[`参考资料：${record.name}`]=[record.brand,record.model,record.material,record.category,record.notes].filter(Boolean).join('；');
    if(node.type!=='copy')record.images.forEach((url,i)=>refs.push({url,role:record.role,label:`${record.name} · ${i+1}`}));
  }
  return {facts,refs};
}

export function buildWorkflowDraft(definition, variants, outputs, baseTemplate, runId) {
  const listNode=definition.nodes.find(n=>n.type==="listing");
  if(!Number(listNode?.templateId)) throw workflowError("请在类目模板节点选择现有上架模板，再新建生产任务");
  const imageNodes=definition.nodes.filter(n=>n.type==="image").sort((a,b)=>(a.role==="main"?-1:b.role==="main"?1:0));
  const copyNodes=definition.nodes.filter(n=>n.type==="copy");
  const price=definition.nodes.find(n=>n.type==="price");
  const pack=definition.nodes.find(n=>n.type==="package");
  const rows=variants.map((variant,i)=>{
    const result=outputs[variant.id]||{};
    for(const node of definition.nodes.filter(n=>["image","copy","video","approval"].includes(n.type))){
      if(workflowNodeSkipped(node,variant))continue;
      if(["image","copy","video"].includes(node.type)&&!result[node.id]?.approved)throw workflowError(`${variant.label}的“${node.label}”尚未检查通过`);
      workflowInputContext(definition,variant,node,result);
      if(node.type==="approval"&&!result[node.id]?.approved)throw workflowError(`${variant.label}的“${node.label}”尚未人工确认`);
    }
    const videoUrls=definition.nodes.filter(n=>n.type==='video').map(n=>{if(!result[n.id]?.url)throw workflowError(`${n.label}缺少视频结果`);return result[n.id].url;});
    const videoFields={video_urls:videoUrls,video_cover_urls:videoUrls};
    if(definition.bindings) {
      const mapped=applyWorkflowBindings(definition,variant,result);
      return {...mapped,...videoFields,offer_id:`WF-${runId.slice(0,8)}-${i+1}`,sku:`WF-${runId.slice(0,8)}-${i+1}`,images_manually_edited:true,image_edit_intent:'manual',workflow_variant_id:variant.id,workflow_facts:clone(variant.values)};
    }
    const images=imageNodes.filter(n=>!workflowNodeSkipped(n,variant)).map(n=>{if(!result[n.id]?.url || !result[n.id]?.approved) throw workflowError(`${variant.label}的“${n.label}”尚未检查通过`); return result[n.id].url;});
    const copy={};
    for(const n of copyNodes){if(!result[n.id]?.approved || !result[n.id]?.text)throw workflowError(`${variant.label}的“${n.label}”尚未检查通过`);Object.assign(copy,result[n.id].text);}
    if(!String(copy.title||"").trim() || !String(copy.description||"").trim() || !Array.isArray(copy.tags) || !copy.tags.length)throw workflowError(`${variant.label}缺少标题、标签或描述，请检查文案节点输出`);
    const dimensions=pack?{weight:Number(pack.weight),weight_g:Number(pack.weight),depth:Number(pack.length)*10,width:Number(pack.width)*10,height:Number(pack.height)*10,length_mm:Number(pack.length)*10,width_mm:Number(pack.width)*10,height_mm:Number(pack.height)*10,weight_unit:"g",dimension_unit:"mm"}:{};
    const attributes=(baseTemplate.editable_payload?.variants?.[0]?.dynamic_attributes)||{};
    const dynamic_attributes=clone(attributes);
    if(definition.richContentEnabled===false)delete dynamic_attributes[11254];
    const richContent=JSON.stringify({content:[{widgetName:"raShowcase",type:"billboard",blocks:[{imgLink:"",img:{src:images[0],srcMobile:images[0],alt:copy.title,position:"width_full",positionMobile:"width_full",widthMobile:1024,heightMobile:1536},title:{items:[{type:"text",content:copy.title}],size:"size4",align:"left",color:"color1"},text:{items:[{type:"text",content:copy.description}],size:"size2",align:"left",color:"color1"}}]}],version:0.3});
    for(const node of definition.nodes.filter(n=>n.type==='attribute')) {
      const generated={...copy,tags:copy.tags.join(" "),richContent};
      const values=attributeSelectedValues(node,node.valueSource==='generated'?generated[node.generatedTarget]:variant.values[node.id]);
      dynamic_attributes[node.attributeId]={attribute_id:Number(node.attributeId),name:node.label,dictionary_id:Number(node.dictionaryId||0),values,selected_values:values,value:node.multiple?values.map(x=>x.dictionary_value_id||x.value):values[0]?.dictionary_value_id||values[0]?.value||''};
    }
    for(const [id,value] of [[4191,copy.description],[23171,copy.tags.join(" ")],...(definition.richContentEnabled!==false?[[11254,richContent]]:[])]){if(!definition.nodes.some(n=>n.type==='attribute'&&Number(n.attributeId)===id))dynamic_attributes[id]={attribute_id:id,values:[{value}],selected_values:[{value}],value};}
    return {...dimensions,...videoFields,offer_id:`WF-${runId.slice(0,8)}-${i+1}`,sku:`WF-${runId.slice(0,8)}-${i+1}`,title:copy.title,name:copy.title,description:copy.description,...(definition.richContentEnabled!==false?{rich_content_json:richContent,rich_content:richContent}:{}),tags:copy.tags,hashtags:copy.tags,main_tags:copy.tags,dynamic_attributes,images:images.map((url,index)=>({url,role:index?"detail":"main",sort_order:index+1})),primary_image:images[0],images_manually_edited:true,image_edit_intent:"manual",...(price?{price:String(price.value),price_value:String(price.value)}:{}),workflow_variant_id:variant.id,workflow_facts:clone(variant.values)};
  });
  const cleanBase=clone(baseTemplate);
  const editable=clone(baseTemplate.editable_payload||{});
  if(definition.bindings){
    // A category template may have been saved from a different SKU; only explicit bindings carry facts.
    for(const target of [cleanBase,editable])for(const key of ['source_raw','sourceRaw','attributes','category_attributes','required_attributes','dimensions','logistics','sku','offer_id','price','price_value','priceValue','sale_price','salePrice','cost_price','costPrice','old_price','oldPrice','min_price','minPrice','weight','weight_g','weightG','length_cm','width_cm','height_cm','length_mm','width_mm','height_mm','depth','width','height'])delete target[key];
    cleanBase.attributes=Object.values(rows[0].dynamic_attributes);
    editable.attributes=clone(cleanBase.attributes);
    if(definition.deferCommercialInputs)editable.pending_listing_fields=[['售价','price'],['包装重量','weight_g'],['包装长','length_mm'],['包装宽','width_mm'],['包装高','height_mm']].filter(([,key])=>rows.some(row=>!Number(row[key]))).map(([label])=>label);
  }
  // Never inherit image sets or variant identity from the category template.
  const payload={...cleanBase,...(definition.bindings?{currency_code:rows[0].currency_code||'CNY'}:{}),title:rows[0].title,description:rows[0].description,video_urls:rows[0].video_urls,video_cover_urls:rows[0].video_cover_urls,images:rows[0].images,editable_payload:{...editable,...(definition.bindings?{...(rows[0].price!==undefined||rows[0].old_price!==undefined?{price:{value:Number(rows[0].price||0),old_price:Number(rows[0].old_price||0),currency_code:rows[0].currency_code||'CNY'}}:{}),currency_code:rows[0].currency_code||'CNY'}:{}),title:rows[0].title,description:rows[0].description,video_urls:rows[0].video_urls,video_cover_urls:rows[0].video_cover_urls,rich_content_json:rows[0].rich_content_json||"",rich_content:rows[0].rich_content||"",tags:rows[0].tags,workflow_target_shop_ids:clone(definition.shopIds||[]),images:rows[0].images,variants:rows}};
  return {template_id:Number(listNode.templateId),product_name:rows[0].title,internal_code:`WF-${runId}`,template_payload:payload,source_images:rows[0].images.map(x=>x.url),sale_price:Number(rows[0].price||price?.value||0),...(definition.bindings?{weight_g:Number(rows[0].weight_g||0),length_cm:Number(rows[0].length_mm||0)/10,width_cm:Number(rows[0].width_mm||0)/10,height_cm:Number(rows[0].height_mm||0)/10}:{}),...(pack?{weight_g:Number(pack.weight),length_cm:Number(pack.length),width_cm:Number(pack.width),height_cm:Number(pack.height)}:{}),development_type:"new",ai_payload:{source:"product_workflow",workflow_run_id:runId,definition:clone(definition)},manual_facts:{workflow_run_id:runId,variants:clone(variants)}};
}
