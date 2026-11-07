import {PRODUCT_IDENTITY_FIELDS} from '../../../src/shared/product-edit-history.js';

const labels=new Map(PRODUCT_IDENTITY_FIELDS.map(field=>[field.key,field.label]));
export const inventoryHistoryFieldLabel=key=>labels.get(key)||(key==='components'?'套装组成':key);

export function inventoryHistoryValue(key,value){
 if(value===undefined)return '未留存';
 if(value===null||value==='')return '未填写';
 if(['is_accessory','is_consumable'].includes(key))return Number(value)?'是':'否';
 if(key==='fitment_type')return {universal:'通用',specific:'专用',unknown:'待核对'}[value]||String(value);
 if(key==='components'&&Array.isArray(value))return value.length?value.map(part=>`关联商品 #${part.product_id} × ${part.quantity}${part.component_role==='gift'?'（赠品）':''}`).join('；'):'无组成件';
 if(key==='vehicle_models_json'&&typeof value==='string'){
  try{return inventoryHistoryValue(key,JSON.parse(value));}catch{return value;}
 }
 if(Array.isArray(value))return value.length?value.map(item=>typeof item==='object'?JSON.stringify(item):String(item)).join('、'):'未填写';
 return typeof value==='object'?JSON.stringify(value):String(value);
}
