import {materialBindings} from './workflow-materials.js';
const key=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
export function resolveCatalogBindings(bindings,brands=[]){
 if(!Array.isArray(bindings))throw Object.assign(new Error('品牌型号绑定格式无效，请重新选择系统目录'),{status:400});
 const resolved=new Map(),unresolved=[];
 for(const binding of bindings||[]){
  const own=brands.find(b=>key(b.name)===key(binding.brand)||(binding.brandKey&&key(b.key)===key(binding.brandKey)));
  if(!own&&!(binding.models||[]).length){unresolved.push({brand:binding.brand,model:''});continue;}
  if(own&&!(binding.models||[]).length&&!binding.allModels){resolved.set(own.name,{brand:own.name,brandKey:own.key||key(own.name),models:[],modelIds:[],allModels:false});continue;}
  if(binding.allModels&&own){resolved.set(own.name,{brand:own.name,brandKey:own.key||key(own.name),models:[],modelIds:[],allModels:true});continue;}
  for(let i=0;i<(binding.models||[]).length;i++){
   const name=binding.models[i],id=binding.modelIds?.[i];
   const candidates=brands.flatMap(b=>b.models.filter(m=>id?(own&&b===own&&Number(m.id)===Number(id)):key(`${b.name} ${m.name}`)===key(`${binding.brand} ${name}`)||(b===own&&(key(m.name)===key(name)||(m.aliases||[]).some(a=>key(a)===key(name))))).map(m=>({b,m})));
   if(candidates.length!==1){unresolved.push({brand:binding.brand,model:name});continue;}
   const {b,m}=candidates[0],row=resolved.get(b.name)||{brand:b.name,brandKey:b.key||key(b.name),models:[],modelIds:[],allModels:false};if(!row.modelIds.includes(Number(m.id))){row.models.push(m.name);row.modelIds.push(Number(m.id));}resolved.set(b.name,row);
  }
 }
 return {bindings:[...resolved.values()],unresolved};
}
export function bindMaterialToCatalog(record,brands){const result=resolveCatalogBindings(materialBindings(record.payload),brands);return {...record,payload:{...record.payload,bindings:result.bindings,brand:result.bindings[0]?.brand||'',model:result.bindings[0]?.models[0]||'',unresolvedBindings:[...(record.payload.unresolvedBindings||[]),...result.unresolved]}};}
export function requireCatalogBindings(bindings,brands){const result=resolveCatalogBindings(bindings,brands);if(result.unresolved.length)throw Object.assign(new Error('品牌型号未绑定系统目录：'+result.unresolved.map(r=>`${r.brand} ${r.model}`).join('、')+'。请从系统目录选择，缺少时先新增型号。'),{status:400});return result.bindings;}
