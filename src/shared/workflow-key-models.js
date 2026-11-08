const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const keyModelIdentity=value=>clean(value).toLocaleLowerCase();
export function normalizeWorkflowKeyModel(input={}) {
  const brand=clean(input.brand),model=clean(input.model),label=clean(input.label),notes=clean(input.notes);
  const fail=message=>{throw Object.assign(new Error(message),{status:400});};
  if(!brand||!model||!label)fail('请在钥匙适配库填写品牌、型号和钥匙类型');
  if(brand.length>128||model.length>191||label.length>100||notes.length>2000)fail('适配资料过长，请缩短品牌、型号、类型或说明');
  const images=Array.isArray(input.images)?[...new Set(input.images.filter(Boolean))]:[];
  if(!images.length||images.length>8||images.some(url=>typeof url!=='string'||url.length>3000||!/^https:\/\//i.test(url)))fail('请上传 1–8 张适配钥匙图片，不能嵌入文件或填写本地路径');
  return {brand,model,label,notes,images,archived:Boolean(input.archived),name:`${brand} ${model} · ${label}`};
}
export function matchingKeyModels(records,model) {
  return records.filter(record=>!record.payload.archived&&keyModelIdentity(`${record.payload.brand} ${record.payload.model}`)===keyModelIdentity(model));
}
export function applyKeyModel(values,record,count=8) {
  values.key=record.payload.images.slice(0,count);values.__keyModelId=record.id;values.__keyModelRevision=record.revision;
}
