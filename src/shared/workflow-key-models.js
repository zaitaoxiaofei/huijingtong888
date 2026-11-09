import {normalizeMoldDetails,isReviewedMold} from './key-mold-mapping.js';
import {normalizeMaterialBindings, materialCoversFitments} from './workflow-materials.js';
const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const keyModelIdentity=value=>clean(value).toLocaleLowerCase();
export function normalizeWorkflowKeyModel(input={}) {
  const brand=clean(input.brand),model=clean(input.model),label=clean(input.label),notes=clean(input.notes);
  const fail=message=>{throw Object.assign(new Error(message),{status:400});};
  if(!label||(!input.bindings&&(!brand||!model)))fail('请在钥匙适配库填写品牌、型号和钥匙类型');
  if(brand.length>128||model.length>191||label.length>100||notes.length>2000)fail('适配资料过长，请缩短品牌、型号、类型或说明');
  const images=Array.isArray(input.images)?[...new Set(input.images.filter(Boolean))]:[];
  if(!images.length||images.length>8||images.some(url=>typeof url!=='string'||url.length>3000||!/^https:\/\//i.test(url)))fail('请上传 1–8 张适配钥匙图片，不能嵌入文件或填写本地路径');
  return {...referenceMetadata(input),brand,model,label,notes,images,...(input.bindings?{bindings:normalizeMaterialBindings(input.bindings)}:{}),...(input.listingCategory?{listingCategory:normalizeMaterialCategory(input.listingCategory)}:{}),archived:Boolean(input.archived),name:[[brand,model].filter(Boolean).join(' '),label].filter(Boolean).join(' · ')};
}
export function matchingKeyModels(records,model,fitments=[]) {
  return records.filter(record=>!record.payload.archived&&isReviewedMold(record)&&(fitments.length?materialCoversFitments(record,fitments):keyModelIdentity(`${record.payload.brand} ${record.payload.model}`)===keyModelIdentity(model)));
}
export function applyKeyModel(values,record,count=8) {
  values.key=record.payload.images.slice(0,count);values.__keyModelId=record.id;values.__keyModelKind=record.kind||'key_model';values.__keyModelRevision=record.revision;
}

export function normalizeWorkflowMaterial(input={}) {
  const value=Object.fromEntries(['name','brand','model','material','category','notes'].map(key=>[key,clean(input[key])]));
  const images=Array.isArray(input.images)?[...new Set(input.images.filter(Boolean))]:[];
  if(!value.name||value.name.length>200||Object.values(value).some(v=>v.length>4000))throw Object.assign(new Error('请填写资料名称，说明不能超过 4000 字'),{status:400});
  if(!images.length&&!value.notes)throw Object.assign(new Error('请上传参考图片或填写资料说明'),{status:400});
  if(images.length>8||images.some(url=>typeof url!=='string'||url.length>3000||!/^https:\/\//i.test(url)))throw Object.assign(new Error('生产资料最多上传 8 张 HTTPS 图片'),{status:400});
  return {...referenceMetadata(input),...value,images,bindings:normalizeMaterialBindings(input.bindings||[]),listingCategory:normalizeMaterialCategory(input.listingCategory),role:['product','compatibility','style'].includes(input.role)?input.role:'style',archived:Boolean(input.archived)};
}

function normalizeMaterialCategory(input){
 if(!input)return null;
 const key=String(input.key||input.ozon_category_id||'');const [descriptionCategoryId,typeId]=key.split(':').map(Number);
 if(!Number.isSafeInteger(descriptionCategoryId)||!Number.isSafeInteger(typeId)||descriptionCategoryId<=0||typeId<=0||!String(input.name||'').trim())throw Object.assign(new Error('请从官方类目树选择完整商品类型，或选择通用资料'),{status:400});
 return {key,name:clean(input.name),descriptionCategoryId,typeId};
}

function referenceMetadata(input){const coreName=clean(input.coreName),searchTerms=clean(input.searchTerms);if(coreName.length>200||searchTerms.length>4000)throw Object.assign(new Error('核心品名最多200字，搜索词最多4000字'),{status:400});return {...normalizeMoldDetails(input),coreName,searchTerms,unresolvedBindings:Array.isArray(input.unresolvedBindings)?input.unresolvedBindings.map(r=>({brand:clean(r.brand),model:clean(r.model)})):[]};}
