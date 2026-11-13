const parse=value=>typeof value==='string'?JSON.parse(value):value;
const urls=values=>(Array.isArray(values)?values:[]).map(value=>typeof value==='string'?value:value?.url||value?.src||'').filter(Boolean);
// Read only the current frozen draft content. Never merge historical source_raw
// images, Ozon category IDs, prices or dictionary values into WB defaults.
export function wbListingSource(draft) {
  const template=parse(draft.template_payload||draft.template_payload_json)||{},editable=template.editable_payload||{},variant=(editable.variants||template.variants||[])[0]||{};
  const owns=urls(variant.images).length||variant.images_manually_edited||variant.image_edit_intent==='manual';
  const effective=Array.isArray(draft.effective_images)?draft.effective_images:owns?urls(variant.images):urls(editable.images).length?urls(editable.images):urls(template.images).length?urls(template.images):urls(parse(draft.source_images_json)||draft.source_images);
  const manual=parse(draft.manual_facts||draft.manual_facts_json)||{};
  const result={source_draft_id:draft.id,source_code:draft.internal_code,subject_id:null,images:[...effective],video_url:urls(Object.hasOwn(variant,'video_urls')?variant.video_urls:Object.hasOwn(editable,'video_urls')?editable.video_urls:template.video_urls)[0]||'',
    card:{vendorCode:draft.internal_code||'',title:variant.title||variant.name||editable.title||draft.product_name||'',description:editable.description||template.description||manual.description||'',brand:'',
      dimensions:{length:Math.ceil(Number(draft.length_cm))||null,width:Math.ceil(Number(draft.width_cm))||null,height:Math.ceil(Number(draft.height_cm))||null,weightBrutto:Number(draft.weight_g)>0?Number(draft.weight_g)/1000:null},
      characteristics:[],sizes:[{techSize:'0',price:null,skus:[]}]}};
  const variants=editable.variants||template.variants||[];
  if(variants.length>1)result.variants=variants.map((v,index)=>{
    const card=structuredClone(result.card);card.vendorCode=String(v.offer_id||v.vendorCode||(index===0?draft.internal_code: String(draft.internal_code||'')+'-V'+(index+1))||'');card.title=v.title||v.name||card.title;card.description=v.description||card.description;
    return {source_draft_id:draft.id,card,images:index===0?[...effective]:urls(v.images),video_url:urls(Object.hasOwn(v,'video_urls')?v.video_urls:[])[0]||''};
  });
  if(result.variants){result.card=result.variants[0].card;result.images=result.variants[0].images;result.video_url=result.variants[0].video_url;}
  return result;
}
