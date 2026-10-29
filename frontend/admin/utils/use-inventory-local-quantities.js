import {ref,watch,onMounted,onBeforeUnmount,onActivated,onDeactivated} from 'vue';
import {apiClient,currentApiCacheScope} from './api.js';
// Current-page quantity projection only. Never fetch full procurement/FBP forecasts here.
export function useInventoryLocalQuantities(source){
 const rows=ref(new Map()),error=ref('');let version=0,controller,active=true,lastKey='',completed=0,running=false;
 const ids=()=>[...new Set((source()||[]).map(row=>Number(row.id)).filter(id=>Number.isSafeInteger(id)&&id>0))].sort((a,b)=>a-b);
 function stop(){++version;controller?.abort();running=false;}
 function clear(){stop();rows.value=new Map();lastKey='';completed=0;error.value='';}
 async function refresh(force=false){
  if(!active)return;
  const scope=currentApiCacheScope(),values=ids(),key=`${scope}:${values.join(',')}`;
  if(!force&&key===lastKey&&(running||Date.now()-completed<20000))return;
  stop();const token=version;controller=new AbortController();const signal=controller.signal;
  if(key!==lastKey)rows.value=new Map();lastKey=key;error.value='';running=true;
  try{for(let i=0;i<values.length;i+=20){
   const response=await apiClient.get(`/api/inventory-workflow?view=local&product_ids=${values.slice(i,i+20).join(',')}`,{noCache:true,signal});
   if(!active||token!==version||scope!==currentApiCacheScope())return;
   const next=new Map(rows.value);for(const row of response.rows||[])next.set(Number(row.product_id),row);rows.value=next;
  }completed=Date.now();}catch(e){if(token===version&&scope===currentApiCacheScope()&&e.name!=='AbortError')error.value=e.message||'库存数量待核对';}
  finally{if(token===version)running=false;}
 }
 watch(()=>ids().join(','),()=>refresh(),{immediate:true});
 onMounted(()=>{currentApiCacheScope();window.addEventListener('erp:auth-scope-changed',clear);});
 onActivated(()=>{active=true;void refresh();});onDeactivated(()=>{active=false;stop();});
 onBeforeUnmount(()=>{clear();window.removeEventListener('erp:auth-scope-changed',clear);});
 return{rows,error,refresh};
}
