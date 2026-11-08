const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const identity=value=>clean(value).toLocaleLowerCase();
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
export function normalizeMaterialBindings(input=[]) {
 if(!Array.isArray(input)||input.length>50)fail('适用品牌最多 50 个，请重新选择');
 const grouped=new Map();
 for(const item of input){const brand=clean(item.brand);if(!brand||brand.length>128||!Array.isArray(item.models)||item.models.length>100)fail('请为适用资料选择有效的品牌和型号');const models=[...new Set(item.models.map(clean).filter(Boolean))];if(models.some(m=>m.length>191)||(!models.length&&!item.allModels))fail(`${brand}请勾选适用型号，或明确选择该品牌全部型号`);const key=identity(brand),old=grouped.get(key);grouped.set(key,{brand,models:[...new Set([...(old?.models||[]),...models])],allModels:Boolean(old?.allModels||item.allModels)});}
 return [...grouped.values()];
}
export function materialBindings(payload={}){return payload.bindings?.length?payload.bindings:payload.brand?[{brand:payload.brand,models:payload.model?[payload.model]:[],allModels:!payload.model}]:[];}
export function categoryKey(category={}){category||={};return category.key||category.ozon_category_id||(category.descriptionCategoryId&&category.typeId?`${category.descriptionCategoryId}:${category.typeId}`:'');}
export function materialMatches(record,{category,brand,model,fitments,keyword='',includeGeneral=true}={}){
 const p=record.payload||record;if(p.archived)return false;
 const key=categoryKey(category),own=categoryKey(p.listingCategory);if(key&&own&&own!==key)return false;
 const bindings=materialBindings(p),fits=fitments?.length?fitments:model?[{brand:brand||'',model}]:[];
 if(fits.length&&bindings.length&&!fits.some(f=>bindings.some(b=>identity(`${b.brand} ${f.model}`)===identity(f.model)||(!f.brand||identity(b.brand)===identity(f.brand))&&(b.allModels||b.models.some(m=>identity(m)===identity(f.model)||identity(`${b.brand} ${m}`)===identity(f.model))))))return false;
 if(brand&&!model&&!fits.length&&bindings.length&&!bindings.some(b=>identity(b.brand)===identity(brand)))return false;
 if(!includeGeneral&&!bindings.length)return false;
 const search=[p.name,p.label,p.notes,p.material,p.category,p.listingCategory?.name,...bindings.flatMap(b=>[b.brand,...b.models])].filter(Boolean).join(' ').toLocaleLowerCase();
 return search.includes(identity(keyword));
}
export function materialCoversFitments(record,fitments=[]){const bindings=materialBindings(record.payload||record);return !fitments.length||fitments.every(f=>bindings.some(b=>(!f.brand||identity(b.brand)===identity(f.brand))&&(b.allModels||b.models.some(m=>identity(m)===identity(f.model)||identity(`${b.brand} ${m}`)===identity(f.model)))));}
export function validateMaterialRefs(refs){if(refs===undefined)return;if(!Array.isArray(refs)||refs.length>12||refs.some(ref=>!ref||typeof ref.id!=='string'||!Number.isSafeInteger(ref.revision)||ref.revision<1||(ref.kind&&!['material','key_model'].includes(ref.kind))||(ref.imageIndex!==undefined&&(!Number.isInteger(ref.imageIndex)||ref.imageIndex<0||ref.imageIndex>7))))fail('生产资料引用无效，请从资料库重新选择');}
