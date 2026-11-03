import {computed,onActivated,onBeforeUnmount,onDeactivated,onMounted,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../utils/api.js';
import {useAuthStore} from '../stores/auth.js';
import {hasPermission} from '../../../src/shared/permissions.js';

export function useInventoryRequestSummary(){
 const auth=useAuthStore(),pending=ref(0),enabled=computed(()=>Boolean(auth.user?.tenant?.id&&auth.user.tenant.access_allowed!==false)&&(hasPermission(auth.user,'inventory.write')||hasPermission(auth.user,'inventory.review')));
 let active=false,alive=true,timer=0,scheduled=0,version=0;
 async function refresh(){
  if(!alive||!active||!enabled.value)return;
  const scope=currentApiCacheScope(),read=++version;
  try{const result=await apiClient.get('/api/inventory-product-requests?summary=1',{noCache:true});if(alive&&active&&scope===currentApiCacheScope()&&read===version)pending.value=Number(result.pending_count||0);}catch{}
 }
 function queue(){window.clearTimeout(scheduled);scheduled=window.setTimeout(refresh,150);}
 function start(){if(active)return;active=true;void refresh();timer=window.setInterval(()=>{if(document.visibilityState!=='hidden')void refresh();},60000);}
 function stop(){active=false;version++;window.clearInterval(timer);window.clearTimeout(scheduled);}
 watch(()=>`${currentApiCacheScope()}:${enabled.value}`,()=>{pending.value=0;version++;if(active)void refresh();});
 onMounted(()=>{window.addEventListener('erp:system-notification',queue);window.addEventListener('erp:inventory-product-requests-changed',queue);window.addEventListener('focus',queue);start();});
 onActivated(start);onDeactivated(stop);
 onBeforeUnmount(()=>{alive=false;stop();window.removeEventListener('erp:system-notification',queue);window.removeEventListener('erp:inventory-product-requests-changed',queue);window.removeEventListener('focus',queue);});
 return {pending,enabled,refresh};
}
