// WB supplies dedicated directories only for these named characteristics.
export function wbAttributeDirectory(attribute = {}) {
  const name=String(attribute.name||'').split('/')[0].trim().toLowerCase();
  if(Number(attribute.charcID)===14177449||/^(цвет|color|颜色)$/.test(name))return 'colors';
  if(/^(пол|gender|性别)$/.test(name))return 'kinds';
  if(/^(страна производства|country of manufacture|生产国|生产国家|原产国)$/.test(name))return 'countries';
  if(/^(сезон|season|季节)$/.test(name))return 'seasons';
  if(/^(ставка ндс|vat|增值税税率|增值税率)$/.test(name))return 'vat';
  if(/тнвэд|tnved|feacn|海关编码/i.test(name))return 'tnved';
  return null;
}
export function wbDirectoryOptions(data,kind){
 return [...new Set(data.map(item=>typeof item==='string'||typeof item==='number'?String(item):String(kind==='tnved'?item.tnved||item.code||'':item.name||item.value||'')).filter(Boolean))];
}
