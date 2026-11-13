export function wbKnownNumber(value){
 if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!value.trim()))return null;
 const number=Number(value);return Number.isFinite(number)?number:null;
}

export function wbOnlineStatus(row){
 const status=row.online_status||(row.card?._wb_archived?'archived':'unknown');
 return ({active:'商品库',in_catalog:'商品库',published:'已上架',archived:'WB 回收站',unknown:'未返回状态'})[status]||'未返回状态';
}

export const wbOnlineSizes=row=>Array.isArray(row.card?.sizes)?row.card.sizes:[];
export const wbOnlineSizeLabel=size=>size.techSize&&String(size.techSize)!=='0'?String(size.techSize):'通用';
export const wbOnlineMapping=(row,size)=>size.chrtID?(row.mappings||[]).find(item=>item.ozon_sku===`WB-${size.chrtID}`||Number(item.chrt_id)===Number(size.chrtID)):undefined;
export const wbOnlineSizePrice=(row,size)=>size.chrtID?(row.price_info?.sizes||[]).find(item=>Number(item.chrt_id)===Number(size.chrtID))||null:null;
export function wbOnlineWeightGrams(row){
 const kilograms=wbKnownNumber(row.card?.dimensions?.weightBrutto);
 return kilograms===null?null:Math.round(kilograms*1000);
}

export function wbLocalInventoryPackage(row){
 const dimensions=row.card?.dimensions||{},positive=value=>{const number=wbKnownNumber(value);return number!==null&&number>0?number:null;};
 return {length_cm:positive(dimensions.length),width_cm:positive(dimensions.width),height_cm:positive(dimensions.height),package_weight_g:positive(wbOnlineWeightGrams(row))};
}
