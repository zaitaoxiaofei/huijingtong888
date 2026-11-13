import {wbListingVariants,wbGeneratedVendorCode} from '../../../src/shared/wb-listing-variants.js';

export function wbDraftTemplate(draft,{regenerateVendorCodes=true}={}){
 const payload=JSON.parse(JSON.stringify(draft.payload)),shopId=draft.target_shop_id||draft.shop_id||null;
 const variants=wbListingVariants(payload);
 for(const [index,row] of variants.entries()){
  delete row.card.nmID;delete row.card.imtID;
  if(regenerateVendorCodes)row.card.vendorCode=wbGeneratedVendorCode({brand:row.card.brand,subjectId:payload.subject_id,shopId,index,random:crypto.randomUUID().replaceAll('-','').slice(0,10).toUpperCase()});
  for(const size of row.card.sizes||[]){delete size.chrtID;size.skus=[];}
 }
 Object.assign(payload,{variants,card:variants[0].card,images:variants[0].images||[],video_url:variants[0].video_url||''});
 return {template_source_id:Number(draft.id||draft.template_source_id)||null,target_shop_id:shopId,payload};
}
