// WB supplies dedicated directories only for these named characteristics.
export function wbAttributeDirectory(attribute = {}) {
  const name=String(attribute.name||'').split('/')[0].trim().toLowerCase();
  if(Number(attribute.charcID)===14177449||/^(цвет|color|颜色)$/.test(name))return 'colors';
  if(/^(пол|gender|性别)$/.test(name))return 'kinds';
  if(/^(страна производства|country of manufacture|生产国|生产国家|原产国)$/.test(name))return 'countries';
  if(/^(сезон|season|季节)$/.test(name))return 'seasons';
  if(/^(ставка ндс|vat|增值税税率|增值税率)$/.test(name))return 'vat';
  if([15000001,15004139].includes(Number(attribute.charcID))||/тн\s*вэд|tnved|feacn|hs编码|海关编码/i.test(name))return 'tnved';
  return null;
}
export function wbDirectoryOptions(data,kind){
 return [...new Set(data.map(item=>typeof item==='string'||typeof item==='number'?String(item):String(kind==='tnved'?item.tnved||item.code||'':item.name||item.value||'')).filter(Boolean))];
}

// Template choices and values already used in this shop are suggestions, not a closed official directory.
export function wbTemplateOptions(attribute={}) {
 const choices=attribute.options||attribute.values||attribute.enum||[];
 if(!Array.isArray(choices))return [];
 return choices.map(item=>typeof item==='string'?{value:item,label:item}:item&&typeof item==='object'?{value:String(item.value??item.name??''),label:String(item.label??item.name??item.value??'')}:null).filter(item=>item?.value);
}
