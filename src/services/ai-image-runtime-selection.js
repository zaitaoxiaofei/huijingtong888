let cursor=0;
const unavailable=()=>Object.assign(new Error('保存的服务商生图任务所属通道当前不可用，请恢复原通道后继续拉回；不能换通道重复生图'),{status:503});

// Match fission's explicit runtime dispatch for callers without their own queue dispatcher.
// Return a server-side runtime only; never store its credentials in task input/output JSON.
export async function resolveWorkflowImageRuntime(payload,loadPool) {
  const explicit=payload.imageRuntimeConfig||payload.runtimeConfig;
  if(explicit)return explicit;
  const channels=await loadPool();
  const jobs=payload.providerJob?.jobs;
  const saved=Array.isArray(jobs)?jobs.find(job=>job?.jobId):payload.providerJob;
  if(saved?.jobId) {
    const matches=channels.filter(channel=>saved.channelId?channel.channelId===saved.channelId:
      channel.provider===saved.provider&&saved.endpoint&&String(saved.endpoint).startsWith(String(channel.baseUrl).replace(/\/$/,'')+'/'));
    if(matches.length!==1)throw unavailable();
    return matches[0];
  }
  if(!channels.length)throw Object.assign(new Error('没有可用的图片通道，请检查图片通道池配置'),{status:503});
  const weights=channels.map(channel=>Math.max(1,Math.min(100,Math.round(Number(channel.weight)||1))));
  let slot=cursor++%weights.reduce((sum,weight)=>sum+weight,0);
  for(let i=0;i<channels.length;i++){if(slot<weights[i])return channels[i];slot-=weights[i];}
}
