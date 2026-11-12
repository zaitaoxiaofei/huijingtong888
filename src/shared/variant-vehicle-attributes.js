const key=value=>String(value||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Only platform dictionary options may become selections. With no exact option,
// clear the inherited source selection and let publication resolve the target.
export function retargetVariantVehicleAttributes(payload, vehicle, options = {}) {
  const next=structuredClone(payload);
  function attribute(a,id=Number(a?.attribute_id||a?.id)) {
    if(!a||![7204,7212].includes(id))return;
    const value=id===7204?vehicle.vehicle_brand:vehicle.vehicle_model;
    const previous=[...(Array.isArray(a.values)?a.values:[]),...(Array.isArray(a.selected_values)?a.selected_values:[])];
    const selected=previous.find(option=>Number(option?.dictionary_value_id||option?.id)>0&&key(option.value)===key(value));
    const scalarValues=Array.isArray(a.value)?a.value:[a.value];
    if(selected&&previous.every(option=>key(option.value)===key(value))&&scalarValues.every(text=>!text||key(text)===key(value)||Number(text)===Number(selected.dictionary_value_id||selected.id)))return;
    const match=(options[id]||[]).find(option=>Number(option.dictionary_value_id||option.id)>0&&(key(option.value)===key(value)||key(option.label)===key(value)));
    const replacement=match?[{dictionary_value_id:Number(match.dictionary_value_id||match.id),value:match.value,label:match.label||match.value}]:[];
    a.value=replacement.length?[match.value]:[];
    a.values=structuredClone(replacement);a.selected_values=structuredClone(replacement);
    if(a.selectedValues)a.selectedValues=structuredClone(replacement);
    if(a.raw&&typeof a.raw==='object') {
      a.raw.value=structuredClone(a.value);a.raw.values=structuredClone(replacement);a.raw.selected_values=structuredClone(replacement);
    }
  }
  function owner(v){
    if(!v||typeof v!=='object')return;
    for(const name of ['attributes','category_attributes'])if(Array.isArray(v[name]))v[name].forEach(a=>attribute(a));
    for(const name of ['dynamic_attributes','dynamicAttributes'])if(v[name])for(const[id,a]of Object.entries(v[name]))attribute(a,Number(a?.attribute_id||a?.id||id));
    if(v.editable_payload)owner(v.editable_payload);
    if(v.user_facts)owner(v.user_facts);
    if(Array.isArray(v.variants))v.variants.forEach(owner);
  }
  if(Array.isArray(next))next.forEach(a=>attribute(a));else owner(next);
  return next;
}
