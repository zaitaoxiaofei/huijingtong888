// Jobs hold member identity, never access tokens. Every tick restores current authority.
export function createWbPublishWorker({query,restore,platform,intervalMs=15000,onError=()=>{}}){
 let timer=null,running=false,stopped=true;
 async function tick(){if(running||stopped)return;running=true;try{
  const [job]=await query("SELECT id,tenant_id,person_id FROM wb_publish_jobs WHERE status IN ('queued','processing') AND next_run_at<=UTC_TIMESTAMP() AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP()) ORDER BY next_run_at,id LIMIT 1",[]);
  if(!job)return;
  try{const session=await restore(String(job.tenant_id),job.person_id);const service=await platform(session,'operations');await service.runPublishJob(job.tenant_id,{job_id:job.id});}
  catch{await query("UPDATE wb_publish_jobs SET status='paused',message='任务授权或接口暂不可用，请检查企业成员、订阅与店铺授权后继续核对' WHERE id=? AND tenant_id=? AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP())",[job.id,job.tenant_id]);}
 }catch(error){onError(error);}finally{running=false;}}
 return {start(){if(!stopped)return;stopped=false;timer=setInterval(()=>void tick(),intervalMs);timer.unref?.();},stop(){stopped=true;clearInterval(timer);},tick:async()=>{const previous=stopped;stopped=false;try{await tick();}finally{stopped=previous;}}};
}
export async function startWbPublishWorker(){
 const {mysqlQuery}=await import('../mysql-pool.js');const {restoreBusinessTaskSession}=await import('./business-task-tenant.js');const {wbPlatform}=await import('./wb-platform.js');
 const worker=createWbPublishWorker({query:mysqlQuery,restore:restoreBusinessTaskSession,platform:wbPlatform,onError:()=>console.warn('[wb-publish] worker tick failed; queued jobs retained')});worker.start();return worker;
}
