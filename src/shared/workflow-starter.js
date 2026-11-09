import {createWorkflowNode} from './product-workflow.js';
import {addDefaultWorkflowBindings} from './product-workflow-bindings.js';
export function starterWorkflow(category=null,{sample=false}={}) {
 const input=(id,label)=>({...createWorkflowNode('field',id),label,scope:'shared',required:id==='name',valueSource:'user'});
 const nodes=[{...createWorkflowNode('listing','listing'),templateId:Number(category?.templateId||0)},input('name','产品名称'),input('facts','已确认卖点与包装内容'),{...createWorkflowNode('images','product'),label:'产品主图',valueSource:'user',scope:'variant'}, {...createWorkflowNode('images','style'),label:'整套风格参考',scope:'shared',valueSource:'engineer',required:false,referenceRole:'style',defaultValue:['']}];
 nodes.push({...createWorkflowNode('image','main'),role:'main',label:'主图',inputs:['name','facts','product','style'],prompt:'产品置于视觉中心，手机缩略图清晰。保持上传产品的形状、颜色、数量和结构；只使用已确认卖点，图片文字使用自然俄语。'});
 const shots=['产品外观','使用场景','细节展示','核心卖点','使用说明','包装展示'];
 shots.forEach((topic,i)=>nodes.push({...createWorkflowNode('image',`detail_${i+1}`),label:`详情图 ${i+1} · ${topic}`,inputs:['name','facts','product','style','main'],prompt:`围绕“${topic}”生成一张俄语电商详情图，与主图风格统一。只展示真实产品和已确认信息；缺少包装、尺寸、性能等事实时不编造。`}));
 for(const [target,label] of [['title','俄语标题'],['tags','俄语标签'],['description','俄语简介']])nodes.push({...createWorkflowNode('copy',`copy_${target}`),target,label,inputs:['name','facts',...(target==='description'?['copy_title','copy_tags']:[])],prompt:'聚焦本次产品的核心品名、真实属性、使用人群与已确认卖点。'});
 const d={schemaVersion:1,name:sample?'示例｜宠物玩具图文模板':'新产品流程',globalPrompt:'保持真实产品外观，套图背景、光线、字体一致。图片及商品文案使用自然俄语，不编造材质、性能、认证或包装。',richContentEnabled:true,reviewMode:'manual',nodes,shopIds:[],...(category?{category}:{}),...(sample?{starterSample:true}: {})};
 addDefaultWorkflowBindings(d);
 d.bindings.richContent={sources:[...d.bindings.images.sources,...d.bindings.description.sources]};
 for(const key of ['price','weight','length','width','height']){const n={...createWorkflowNode('field',`input_${key}`),label:({price:'售价（RUB）',weight:'包装重量（g）',length:'包装长（cm）',width:'包装宽（cm）',height:'包装高（cm）'})[key],scope:'shared',valueSource:'user',inputFormat:'number',required:false};d.nodes.splice(1,0,n);d.bindings[key]={sources:[{nodeId:n.id,output:'value'}]};}
 return d;
}
