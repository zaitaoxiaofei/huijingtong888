import { ref,watch,onBeforeUnmount,onMounted } from 'vue';
import { apiClient,currentApiCacheScope } from './api.js';
export function useInventoryWorkflows(source,idsForRow){
 const states=ref(new Map()),error=ref('');let version=0,controller;
 async function refresh(){
  const token=++version,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();const signal=controller.signal;
  states.value=new Map();error.value='';
  const ids=[...new Set((source()||[]).flatMap(idsForRow).map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
  try{for(let i=0;i<ids.length;i+=20){
   const result=await apiClient.get(`/api/inventory-workflow?view=status&product_ids=${ids.slice(i,i+20).join(',')}`,{noCache:true,signal});
   if(token!==version||scope!==currentApiCacheScope())return;
   const next=new Map(states.value);for(const row of result.rows||[])next.set(Number(row.product_id),row);states.value=next;
  }}catch(e){if(token===version&&scope===currentApiCacheScope()&&e.name!=='AbortError')error.value=e.message;}
 }
 watch(source,refresh,{immediate:true});
 function clearScope(){++version;controller?.abort();states.value=new Map();error.value='';}
 onMounted(()=>window.addEventListener('erp:auth-scope-changed',clearScope));
 onBeforeUnmount(()=>{clearScope();window.removeEventListener('erp:auth-scope-changed',clearScope);});
 function forIds(values){
  const ids=[...new Set(values.map(Number).filter(id=>id>0))],rows=ids.map(id=>states.value.get(id));
  const sorted=rows.filter(Boolean).sort((a,b)=>['danger','warning','unknown','opportunity','success'].indexOf(a.overall)-['danger','warning','unknown','opportunity','success'].indexOf(b.overall));
  if(rows.some(row=>!row)&&!['danger','warning'].includes(sorted[0]?.overall))return null;
  return sorted[0]||null;
 }
 return{states,error,forIds,refresh};
}
