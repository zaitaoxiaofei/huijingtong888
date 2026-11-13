import {wbListingPrice} from './wb-listing-prices.js';
import {wbListingVariants,wbVariantPayload} from './wb-listing-variants.js';
const clean = value => String(value ?? '').trim();
function validateOne(payload = {}, attributes = []) {
  const card = payload.card || {}, errors = [], dimensions = card.dimensions || {};
  if (!Number.isSafeInteger(Number(payload.subject_id || card.subjectID)) || Number(payload.subject_id || card.subjectID) <= 0) errors.push('商品类目：请选择 WB 类目，再加载该类目的必填属性。');
  if (!clean(card.title) || clean(card.title).length > 60) errors.push('商品标题：请填写 1–60 个字符。');
  if (!clean(card.vendorCode) || clean(card.vendorCode).length > 72) errors.push('商家货号：请填写 1–72 个字符，用于核对发布结果。');
  for (const [key, label] of Object.entries({length:'包装长',width:'包装宽',height:'包装高',weightBrutto:'包装重量'})) {
    if (!Number.isFinite(Number(dimensions[key])) || Number(dimensions[key]) <= 0) errors.push(`${label}：请在包装信息中填写大于零的数值；尺寸单位 cm，重量单位 kg。`);
    if (key !== 'weightBrutto' && !Number.isInteger(Number(dimensions[key]))) errors.push(`${label}：WB 包装尺寸使用整数厘米，请向上取整。`);
  }
  if(attributes.some(a=>a.required&&a.existNamedField&&Number(a.charcID)===14177446)&&!clean(card.brand))errors.push('品牌：当前类目要求填写品牌，请在变体行补全。');
  const sizes = card.sizes || [], barcodes = new Set();
  if (!sizes.length || sizes.length > 30) errors.push('规格：请填写 1–30 个规格。');
  for (const [index,size] of sizes.entries()) {
    if(size.old_price!==undefined&&size.old_price!==null&&size.old_price!==''){try{if(!Number.isSafeInteger(Number(size.old_price))||Number(size.old_price)<=0)throw Error('划线价须为大于零的整数。');const computed=wbListingPrice(Number(size.price),1,Number(size.old_price)/Number(size.price));if(!computed.exact)errors.push(`规格 ${index+1}：WB 使用整数百分比折扣，当前折扣后为 ${computed.effective_price}，请调整划线价。`);}catch(e){errors.push(`规格 ${index+1}：${e.message}`);}}
    if (!clean(size.techSize)) errors.push(`规格 ${index+1}：请填写规格名称；无尺码商品填写 0。`);
    if (!Number.isInteger(Number(size.price)) || Number(size.price) <= 0) errors.push(`规格 ${index+1}：请填写大于零的整数售价（店铺币种）。`);
    if (!Array.isArray(size.skus) || !size.skus.length) errors.push(`规格 ${index+1}：请填写条码，或点击生成条码。`);
    for (const sku of size.skus || []) { if (!/^\d{8,30}$/.test(clean(sku)) || barcodes.has(clean(sku))) errors.push(`规格 ${index+1}：条码应为 8–30 位数字，且不能重复。`); barcodes.add(clean(sku)); }
  }
  const values = card.characteristics || [], ids = new Set(attributes.map(a=>Number(a.charcID)));
  for (const value of values) {
    const attribute = attributes.find(a=>Number(a.charcID)===Number(value.id));
    if (!ids.has(Number(value.id))) errors.push('类目属性已变化：请重新加载属性，删除不属于当前类目的值。');
    else if (Number(attribute.charcType) === 4) { if (typeof value.value !== 'number' || !Number.isFinite(value.value)) errors.push(`${attribute.name}：请填写一个有效数值。`); }
    else if (!Array.isArray(value.value) || value.value.some(v=>typeof v !== 'string' || !v.trim()) || (attribute.maxCount>0 && value.value.length>attribute.maxCount)) errors.push(`${attribute.name}：请按该属性要求填写文本值，最多 ${attribute.maxCount||'平台允许的'} 项。`);
  }
  for (const attribute of attributes.filter(a=>a.required&&!a.existNamedField&&Number(a.charcType)!==0)) {
    const value = values.find(v=>Number(v.id)===Number(attribute.charcID))?.value;
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) errors.push(`类目必填属性：${attribute.name}，请在商品表格的对应属性列补全。`);
  }
  if (!Array.isArray(payload.images) || !payload.images.length || payload.images.length > 30) errors.push('商品图片：请选择 1–30 张图片，第一张为主图。');
  for (const image of payload.images || []) { try { const url=new URL(image);if(url.protocol!=='https:'||url.username||url.password||!(/\.(jpe?g|png|webp|gif|bmp)$/i.test(url.pathname)))throw Error(); } catch { errors.push('商品图片：请使用无需登录、以图片扩展名结尾的 HTTPS 直链。');break; } }
  if(payload.video_url){try{if(typeof payload.video_url!=='string')throw Error();const url=new URL(payload.video_url);if(url.protocol!=='https:'||url.username||url.password||!(/\.(mp4|mov)$/i.test(url.pathname)))throw Error();}catch{errors.push('商品视频：请使用有效的 HTTPS MP4 或 MOV 视频地址。');}}
  return {ok:!errors.length,errors};
}

export function wbListingCard(payload) {
  const card=payload.card;
  return {vendorCode:clean(card.vendorCode),title:clean(card.title),brand:clean(card.brand),description:clean(card.description),
    dimensions:Object.fromEntries(['length','width','height','weightBrutto'].map(k=>[k,Number(card.dimensions[k])])),
    characteristics:card.characteristics||[],sizes:card.sizes.map(s=>({...(s.chrtID?{chrtID:Number(s.chrtID)}:{}),techSize:clean(s.techSize),...(s.wbSize?{wbSize:clean(s.wbSize)}:{}),price:Number(s.price),skus:s.skus.map(clean)})),
    ...(card.documents?{documents:card.documents}:{}),...(typeof card.kizMarked==='boolean'?{kizMarked:card.kizMarked}:{})};
}

export function wbListingValidation(payload={},attributes=[]){
 const variants=wbListingVariants(payload),errors=[],vendors=new Set(),barcodes=new Set();
 if(!variants.length||variants.length>30)errors.push('商品变体：请保留 1–30 行变体。');
 if(payload.strategy&&!['grouped','independent'].includes(payload.strategy))errors.push('变体策略：请选择合并或独立商品。');
 for(const [index,row] of variants.entries()){
  const prefix=variants.length>1?`变体 ${index+1}：`:'';
  errors.push(...validateOne(wbVariantPayload(payload,row),attributes).errors.map(e=>prefix+e));
  const vendor=clean(row.card?.vendorCode);if(vendors.has(vendor))errors.push(prefix+'商家货号重复，请重新生成。');vendors.add(vendor);
  for(const size of row.card?.sizes||[])for(const code of size.skus||[]){if(barcodes.has(clean(code)))errors.push(prefix+'条码与其他规格或变体重复，请核对。');barcodes.add(clean(code));}
  if(index>0&&payload.strategy!=='independent'){
   if(clean(row.card?.brand)!==clean(variants[0].card?.brand))errors.push(prefix+'合并商品品牌必须相同，请使用同首行或选择独立商品。');
   for(const attribute of attributes.filter(a=>a.isVariable!==true&&!a.existNamedField&&Number(a.charcType)!==0)){
    const value=r=>{const v=r.card?.characteristics?.find(c=>Number(c.id)===Number(attribute.charcID))?.value;return JSON.stringify(Array.isArray(v)?[...v].sort():v);};
    if(value(row)!==value(variants[0]))errors.push(prefix+`${attribute.name} 不允许作为变体差异，请使用该属性列的“同首行”统一填写，或改为独立商品。`);
   }
  }
 }
 return {ok:!errors.length,errors};
}
