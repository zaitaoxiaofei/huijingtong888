// Browser-local messages identify this installed extension, never another PC's heartbeat.
export function createTrafficBrowserBridge({host=window,onInstance=()=>{},timeoutMs=12000}){
 let instanceId='',capabilities={},epoch=0,pending=null,stopped=false;
 const post=data=>host.postMessage(data,host.location.origin);
 function cancel(){if(pending)pending.finish(null);}
 function receive(event){
  if(stopped||event.source!==host||event.origin!==host.location.origin)return;
  const data=event.data||{};
  if(data.type==='BAODAN_ANALYTICS_PLUGIN_INSTANCE'){
   const next=String(data.pluginInstanceId||'');if(!/^[0-9A-Za-z_-]{1,128}$/.test(next))return;
   if(capabilities.collector===true&&data.capabilities?.collector!==true)return;
   if(capabilities.browserInstance===true&&data.capabilities?.browserInstance!==true)return;
   if(next!==instanceId){cancel();epoch++;instanceId=next;capabilities=data.capabilities||{};onInstance({instanceId,capabilities,version:data.pluginVersion||''});}
  }
  if(data.type==='BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT'&&pending&&data.requestId===pending.id&&(data.pluginInstanceId===instanceId||(!capabilities.collector&&!data.pluginInstanceId)))pending.finish(data.result||null);
 }
 function start(){host.addEventListener('message',receive);post({type:'BAODAN_ANALYTICS_PLUGIN_INSTANCE_REQUEST'});}
 async function check(expectedStoreId=''){
  cancel();if(!instanceId)throw new Error('本机插件未连接，请确认插件已启用后重新识别');
  if(!expectedStoreId&&!capabilities.storeDiscovery)throw new Error('此版本插件请先选择一家店铺，再点击识别；新版插件支持直接识别当前店铺');
  const ticket=epoch;
  const result=await new Promise(resolve=>{const id=`${Date.now()}-${Math.random().toString(36).slice(2)}`;let timer;
   const finish=value=>{host.clearTimeout(timer);if(pending?.id===id)pending=null;resolve(value);};pending={id,finish};timer=host.setTimeout(()=>finish(null),timeoutMs);
   post({type:'BAODAN_ANALYTICS_PLUGIN_CHECK_STORE',requestId:id,expectedStoreId,pluginInstanceId:instanceId});
  });
  if(stopped||ticket!==epoch)return null;
  if(!result)throw new Error('本机插件识别超时，请打开对应Ozon分析页后重试');
  return {...result,pluginInstanceId:instanceId};
 }
 function wake(expectedStoreId){if(instanceId&&expectedStoreId)post({type:'BAODAN_ANALYTICS_PLUGIN_WAKE',expectedStoreId,pluginInstanceId:instanceId});}
 function stop(){stopped=true;cancel();host.removeEventListener('message',receive);}
 return {start,check,wake,stop,get instanceId(){return instanceId;}};
}
