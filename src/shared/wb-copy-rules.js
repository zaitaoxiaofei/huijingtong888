export const WB_COPY_RULES={title:'生成自然俄语商品标题，最多60字符，准确产品核心词开头，并保留已确认适配品牌型号。不能把汽车品牌当作保护套制造品牌，不添加促销、授权、无关品牌或关键词。',description:'生成自然俄语商品描述，最多2000字符，聚焦已确认产品核心词、适配品牌型号、属性、用途、卖点和包装。不得粘贴#标签、堆砌搜索词、添加链接、编造材质或授权。不输出HTML或Ozon JSON。'};
export function validateWbCopy(target,value){
 if(!['title','description'].includes(target)||typeof value!=='string'||!value.trim())throw Error('WB 文案须为有效标题或描述');
 if([...value].length>(target==='title'?60:2000))throw Error(target==='title'?'WB 标题最多60字符，请精简文案或拆分适配型号':'WB 描述请控制在2000字符以内，并按实际类目限制核对');
 if(/#[\p{L}\p{N}_]+/u.test(value)||/<[^>]+>/.test(value))throw Error('WB 文案请使用自然文本，不含话题标签或HTML');
 return value.trim();
}
