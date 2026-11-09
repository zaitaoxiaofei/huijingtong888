// Shared by generation, manual edits and the template editor.
export const WORKFLOW_COPY_RULES={
 title:'生成一个自然俄语商品标题，最多200字符。以准确产品核心词开头，随后明确本次确认的适配品牌和型号，再选择最关键的真实属性或卖点。适配对象的品牌不能当作产品的制造品牌。不要用泛泛的风格名称替代车型，不沿用参考图的品牌型号，不堆砌无关关键词或促销词。',
 tags:'生成相关俄语话题标签数组，最多30个；每个以#开头，仅用字母、数字、下划线，多词用_连接，包含#在内最多25个字符。每个标签是精炼搜索话题，不能写成整句描述。优先补充已确认人群、使用场景、款式及卖点，不机械重复已有品牌、品类属性，不虚构热搜词或适配范围。',
 description:'生成聚焦当前产品的自然俄语描述，最多6000字符。首段说明产品核心词和已确认适配品牌型号，随后自然融入已生成标题及标签对应的语义，解释真实属性、卖点、人群、场景和包装。不直接粘贴#标签，不堆砌关键词，不扩大车型范围，不编造材质、认证、信号测试或原厂授权。'
};
export function normalizeWorkflowTags(tags){
 if(!Array.isArray(tags)||!tags.length||tags.some(t=>typeof t!=='string'||!t.trim()))throw new Error('标签必须为非空文本列表');
 const normalized=[...new Set(tags.map(tag=>'#'+tag.normalize('NFKC').trim().replace(/^#+/,'').replace(/[^\p{L}\p{N}_]+/gu,'_').replace(/_+/g,'_').replace(/^_|_$/g,'')))];
 if(normalized.length>30||normalized.some(tag=>[...tag].length>25||!/^#[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*$/u.test(tag)))throw new Error('每个标签须以#开头、多词用_连接，包含#最多25字符，最多30个；请缩短标签');
 return normalized;
}
const identity=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function validateWorkflowCopy(target,value,fitments=[]){
 if(target==='tags')return normalizeWorkflowTags(value);
 if(!['title','description'].includes(target))return value;
 if(typeof value!=='string'||!value.trim())throw new Error('文案不能为空');
 if([...value].length>(target==='title'?200:6000))throw new Error(target==='title'?'标题最多200字符，请减少本批适配型号或精简文案':'描述最多6000字符');
 const text=identity(value),missing=fitments.filter(f=>![f.brand,f.model].filter(Boolean).every(v=>text.includes(identity(v))));
 if(missing.length)throw new Error(`文案缺少已确认适配品牌型号：${missing.map(f=>[f.brand,f.model].filter(Boolean).join(' ')).join('、')}；请在文本节点补齐`);
 return value.trim();
}
