const key=value=>String(value||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Only platform dictionary options may become selections. With no exact option,
// clear the inherited source selection and let publication resolve the target.
export function retargetVariantVehicleAttributes(payload, vehicle, options = {}) {
  const next=structuredClone(payload);
  function attribute(a,id=Number(a?.attribute_id||a?.id)) {
    if(!a||![7204,7212].includes(id))return;
    const value=id===7204?vehicle.vehicle_brand:vehicle.vehicle_model;
    const match=(options[id]||[]).find(option=>Number(option.dictionary_value_id||option.id)>0&&(key(option.value)===key(value)||key(option.label)===key(value)));
    const selected=match?[{dictionary_value_id:Number(match.dictionary_value_id||match.id),value:match.value,label:match.label||match.value}]:[];
    a.value=selected.length?[match.value]:[];
    a.values=structuredClone(selected);a.selected_values=structuredClone(selected);
    if(a.selectedValues)a.selectedValues=structuredClone(selected);
    if(a.raw&&typeof a.raw==='object') {
      a.raw.value=structuredClone(a.value);a.raw.values=structuredClone(selected);a.raw.selected_values=structuredClone(selected);
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
