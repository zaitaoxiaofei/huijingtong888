import { WORKFLOW_COPY_RULES } from './workflow-copy-rules.js';
import { createWorkflowNode, keyCaseWorkflow, validateWorkflow } from './product-workflow.js';
import { addDefaultWorkflowBindings, WORKFLOW_TEMPLATE_FIELDS } from './product-workflow-bindings.js';

const clone=value=>JSON.parse(JSON.stringify(value));
export const KEY_CASE_DETAIL_SHOTS=[
  {label:'适配钥匙与按键特写',prompt:'第一张详情必须以适配的原钥匙为主视觉，占画面主要面积。清楚呈现钥匙轮廓、实际按键数量、图标和排布，帮助买家逐一核对。当前钥匙壳只作角落或背景小比例陪衬。若原始产品图内嵌钥匙卡片，只使用卡片里的原钥匙作为兼容依据。不要把钥匙壳放大到抢占原钥匙视觉。提醒购买前核对形状和按键。'},
  {label:'材质外观与卖点特写',prompt:'放大当前款式真实表面纹路、亮面板和包边细节，并辅以小比例完整产品。只能呈现已确认材质和卖点；未给出材质时写碳纹外观，不写真碳纤维、TPU或其他成分。保持纹路比例和真实结构。'},
  {label:'日常防护与正常操作',prompt:'展示自然手持钥匙、准备操作车辆的日常使用场景，突出包覆防护与按键位置。只表达已确认的日常防护与保留按键操作，不声称提升车辆性能、增强信号、零衰减或经过防摔测试。不得遮蔽或改变按键。'},
  {label:'对应车型使用场景',prompt:'展示当前钥匙壳和对应车型的使用场景，准确使用用户给出的型号与适配钥匙。若提供了真实车辆参考，按参考呈现车辆；否则使用不带车型识别标志的车门或车内局部背景，不捏造精确车型外观，不放其他品牌标志。'},
  {label:'高端礼盒包装',prompt:'突出用户确认的礼盒包装与赠礼场景，当前款式钥匙壳小比例展示。按已确认包装或参考呈现礼盒，不能把场景道具写成实际配件；不增加其他款式的挂扣、钥匙、赠品或盒内组件。若包装资料未确认，不宣传包含礼盒。'}
];
// Category IDs and dictionary choices are supplied by the owned category template, never invented here.
export function keyCaseProductionWorkflow(category) {
  const definition=keyCaseWorkflow();definition.name='汽车钥匙壳 · 风格复用与批量上架';definition.preset='key-case-production';definition.deferCommercialInputs=true;definition.category=clone(category);definition.shopIds=[];
  definition.globalPrompt+=' 每张图只表达当前分镜指定主题，不把全部商品资料重复排入每张图；不得出现 SKU、字段名或流程说明等内部术语。适配钥匙的按键图标严格按真实原图保留。礼盒只按已确认包装展示，不自行添加缎带、蝴蝶结或赠品。';
  definition.nodes.find(n=>n.type==='listing').templateId=Number(category.templateId);
  for(const node of definition.nodes.filter(n=>n.type==='field')){node.valueSource='user';node.required=['model','facts'].includes(node.id);if(node.id!=='name')node.defaultValue='';}
  definition.nodes.find(n=>n.id==='facts').label='已确认卖点与包装内容';
  const mapAttribute=(id,attributeId,scope)=>{
    const actual=category.attributes.find(a=>Number(a.attributeId)===attributeId);if(!actual)return;
    const index=definition.nodes.findIndex(n=>n.id===id);
    const node={...clone(actual),id,scope,valueSource:'user',required:false,defaultValue:actual.multiple?[]:''};
    if(index>=0)definition.nodes[index]=node;else definition.nodes.splice(definition.nodes.findIndex(n=>n.id==='main'),0,node);
    return node;
  };
  mapAttribute('brand',85,'shared');mapAttribute('material',7199,'shared');mapAttribute('color',10096,'variant');
  mapAttribute('vehicle_brand',7204,'shared');mapAttribute('vehicle_model',7212,'shared');
  const type=mapAttribute('product_type',8229,'shared');if(type){type.valueSource='engineer';type.defaultValue=clone(category.attributes.find(a=>Number(a.attributeId)===8229).defaultValue??'');}
  for(const id of ['model','key','vehicle_brand','vehicle_model']){const node=definition.nodes.find(n=>n.id===id);if(node)node.inputGroup='fitment';}
  const key=definition.nodes.find(n=>n.id==='key');key.valueSource='user';key.required=false;delete key.fallbackInput;key.help='选填：上传优先；未上传按品牌型号匹配企业模具。没有匹配则隐藏裸钥匙并跳过适配对照详情';key.slots=['适配钥匙图片（选填）'];
  const product=definition.nodes.find(n=>n.id==='product');product.valueSource='user';product.slots=['当前款式的真实钥匙壳产品主图，禁止用其他款式代替'];
  const style=definition.nodes.find(n=>n.id==='style');Object.assign(style,{valueSource:'engineer',required:true,defaultValue:[''],label:'固定风格参考 · 主图',slots:['上传一次后保存：只借鉴版式、色彩和文字层级，不复制商品或型号']});
  const packaging={...createWorkflowNode('field','packaging'),label:'已确认包装说明',valueSource:'user',scope:'shared',required:false,defaultValue:''};
  const vehicle={...createWorkflowNode('images','vehicle_photo'),label:'真实车型场景参考（可选）',valueSource:'user',scope:'shared',inputGroup:'fitment',required:false,slots:['对应车型车辆或车内实拍；没有时使用中性汽车局部背景'],referenceRole:'vehicle'};
  definition.nodes.splice(definition.nodes.findIndex(n=>n.id==='main'),0,packaging,vehicle);
  const details={...createWorkflowNode('images','style_details'),valueSource:'engineer',scope:'shared',required:false,referenceRole:'style',label:'固定风格参考 · 详情套图',count:KEY_CASE_DETAIL_SHOTS.length,slots:KEY_CASE_DETAIL_SHOTS.map(shot=>shot.label+'参考（可选）'),defaultValue:Array(KEY_CASE_DETAIL_SHOTS.length).fill('')};
  definition.nodes.splice(definition.nodes.findIndex(n=>n.id==='main'),0,details);
  const factIds=definition.nodes.filter(n=>['field','attribute'].includes(n.type)).map(n=>n.id);
  const main=definition.nodes.find(n=>n.id==='main');main.inputs=[...factIds,'product','key','style'];
  main.prompt+=' 当前产品图是外观事实依据；适配钥匙图只用于说明适配轮廓，不得生成其他按键数量或其他钥匙型号。风格参考中的旧商品、颜色、适配车型、logo和卖点不能继承。';
  for(let i=0;i<KEY_CASE_DETAIL_SHOTS.length;i++){
    const shot=definition.nodes.find(n=>n.id===`detail_${i+1}`);shot.inputs=[...factIds,'product','key','style','style_details','approve'];shot.referenceSlots={style_details:[i]};shot.label=KEY_CASE_DETAIL_SHOTS[i].label;if(i===0)shot.requiresInput='key';shot.prompt=KEY_CASE_DETAIL_SHOTS[i].prompt;if(i===3)shot.inputs.push('vehicle_photo');
    shot.prompt+=' 使用本张对应的详情参考版式，保持主图的字体和产品保真，使用统一黑银、深蓝与米色的信息层级；场景明暗跟随本张参考。当前款式的形状、颜色、包边、挂扣和按键以真实产品图为准；只写用户已确认卖点。';
  }
  definition.nodes=definition.nodes.filter(n=>n.id!=='copy'&&n.id!=='detail_6');
  for(const [target,label] of [['title','俄语标题'],['tags','俄语标签'],['description','俄语简介']])definition.nodes.push({...createWorkflowNode('copy',`copy_${target}`),target,label,prompt:WORKFLOW_COPY_RULES[target],inputs:[...factIds,...(target==='description'?['copy_title','copy_tags']:[])]});
  addDefaultWorkflowBindings(definition);
  if(category.attributes.some(a=>Number(a.attributeId)===9048))definition.bindings.attribute_9048={sources:[{nodeId:'model',output:'value'}]};
  if(category.attributes.some(a=>Number(a.attributeId)===4180))definition.bindings.attribute_4180={sources:[{nodeId:'copy_title',output:'title'}]};
  for(const key of ['price','weight','length','width','height']){
    const node={...createWorkflowNode('field',`input_${key}`),label:WORKFLOW_TEMPLATE_FIELDS.find(f=>f.key===key).label,inputGroup:'listing-final',valueSource:'user',scope:'shared',required:false,defaultValue:'',help:'可由工程师固定预填，或本次生产填写。上架前需按实际产品核实。'};
    definition.nodes.splice(1,0,node);definition.bindings[key]={sources:[{nodeId:node.id,output:'value'}]};
  }
  return validateWorkflow(definition);
}
// Same-car styles share fitment. A batch of different cars keeps each row's key and model independent.
export function withWorkflowFitmentMode(definition,mode='shared') {
  const result=clone(definition);
  for(const node of result.nodes.filter(n=>n.inputGroup==='fitment'))node.scope=mode==='individual'?'variant':'shared';
  return result;
}
