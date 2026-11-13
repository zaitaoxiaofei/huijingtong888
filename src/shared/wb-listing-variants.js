const clone=value=>JSON.parse(JSON.stringify(value));
export function wbListingVariants(payload={}){
 return Array.isArray(payload.variants)?payload.variants:[{card:payload.card||{},images:payload.images||[],video_url:payload.video_url||'',...(payload.source_draft_id?{source_draft_id:payload.source_draft_id}:{})}];
}
export function wbVariantPayload(payload,row){return {...payload,...row,variants:undefined};}
export function wbNewVariant(first={},vendorCode=''){
 const card=clone(first.card||{});delete card.nmID;delete card.imtID;
 return {card:{...card,vendorCode,sizes:[{techSize:'0',price:card.sizes?.[0]?.price??null,skus:[]}],characteristics:[]},images:[],video_url:''};
}
export function wbGeneratedVendorCode({brand='',subjectId,shopId,index,random}){
 const token=String(brand).replace(/[^a-zA-Z0-9]/g,'').slice(0,12)||'SKU';
 return `${token}-WB${subjectId}-${shopId||'NEW'}-V${String(index+1).padStart(3,'0')}-${random}`.slice(0,72);
}
export function wbApplyCommon(rows,values,attributes){
 const common=new Set(attributes.filter(a=>a.isVariable!==true).map(a=>Number(a.charcID)));
 for(const row of rows){row.card.characteristics=[...(row.card.characteristics||[]).filter(v=>!common.has(Number(v.id))),...clone(values)];}
}
