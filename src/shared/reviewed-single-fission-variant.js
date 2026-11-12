// Rebuild a reviewed single-product draft from its current canonical fields,
// never from a source SKU. Images/prices come from the reviewed draft itself.
export function restoreReviewedSingleFissionVariant(payload, {offerId, title, canonical, images}) {
  if(!offerId||!title||!canonical||!Array.isArray(images)||!images.length)throw Error('Reviewed current offer, title, canonical fields and images required');
  const frame=structuredClone(canonical),variant={offer_id:offerId,offerId,sku:'',title,name:title};
  for(const key of ['description','attributes','category_attributes','dynamic_attributes','dynamicAttributes','dimensions','logistics','color','material','currency_code','video_urls','video_cover_urls','rich_content_json','richContentJson','rich_content','tags','hashtags','main_tags'])if(Object.hasOwn(frame,key))variant[key]=structuredClone(frame[key]);
  variant.images=structuredClone(images);variant.images_manually_edited=true;variant.image_edit_intent='manual';
  if(frame.price&&typeof frame.price==='object'){
    variant.price=frame.price.value??frame.price.price;
    if(Object.hasOwn(frame.price,'old_price'))variant.old_price=frame.price.old_price;
    if(frame.price.currency_code)variant.currency_code=frame.price.currency_code;
  }else if(Object.hasOwn(frame,'price'))variant.price=frame.price;
  const next=structuredClone(payload);
  function owner(value,isRoot=false){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value.variants)||isRoot&&!value.editable_payload){
      value.variants=[structuredClone(variant)];
      if(Object.hasOwn(value,'sku'))value.sku='';
      value.offer_id=offerId;
      if(Object.hasOwn(value,'offerId'))value.offerId=offerId;
    }
    if(value.editable_payload)owner(value.editable_payload,true);
    if(value.user_facts)owner(value.user_facts);
  }
  owner(next,true);return next;
}
