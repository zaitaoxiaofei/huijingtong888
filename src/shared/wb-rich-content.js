// Local authoring format, deliberately separate from Ozon JSON and WB card API fields.
const invalid=message=>Object.assign(new Error(message),{statusCode:400});
export function wbRichContent(value) {
 if(value===undefined||value===null)return {version:1,blocks:[]};
 if(value.version!==1||!Array.isArray(value.blocks)||value.blocks.length>10)throw invalid('WB 图文素材最多 10 个区块，请检查内容。');
 return {version:1,blocks:value.blocks.map(block=>{
  if(!block||!['image','text'].includes(block.type))throw invalid('图文素材请选择图片或文本区块。');
  if(block.type==='text'){if(typeof block.text!=='string'||block.text.length>6000)throw invalid('文本区块最多 6000 字符。');return {type:'text',text:block.text};}
  const url=String(block.url||'');if(url){let u;try{u=new URL(url);}catch{throw invalid('图片区块请使用 HTTPS 图片地址。');}if(u.protocol!=='https:'||u.username||u.password)throw invalid('图片区块请使用 HTTPS 图片地址。');}
  return {type:'image',url};
 })};
}
export function wbRichFromProduct(images=[],description='') {
 return wbRichContent({version:1,blocks:[...(description?[{type:'text',text:String(description).slice(0,6000)}]:[]),...images.slice(0,description?9:10).map(url=>({type:'image',url}))]});
}
