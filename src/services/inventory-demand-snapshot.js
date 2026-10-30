// A read model only: never used to reserve stock, post receipts or write costs.
export const INVENTORY_DEMAND_SNAPSHOT_VERSION = 'demand-v3';
export const INVENTORY_DEMAND_SNAPSHOT_SCHEMA = `CREATE TABLE IF NOT EXISTS inventory_demand_snapshots (
  tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  version VARCHAR(32) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  calculated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

let queue=Promise.resolve(),queued=0;
export async function waitForInventoryDemandJobs(){let current;do{current=queue;await current;}while(current!==queue);}
export function limitInventoryDemandQueries(query){
  let active=0;const waiting=[];
  return async(...args)=>{
    if(active<2)active++;else await new Promise(resolve=>waiting.push(resolve));
    try{return await query(...args);}
    finally{const next=waiting.shift();if(next)next();else active--;}
  };
}
function enqueue(work){
  if(queued>=16)throw new Error('需求核算任务较多，请稍后重新核算');
  queued++;
  const result=queue.then(work);
  queue=result.catch(()=>{}).finally(()=>queued--);
  return result;
}

// Persist quantities, not cached personnel identities or application detail.
export function inventoryDemandSummary(value){
  return {...value,requests:[],applications:[],opportunities:[],
    demands:(value.demands||[]).map(({requests,...demand})=>({...demand,requests:[]})),
    fbp:value.fbp?{...value.fbp,rows:[]}:value.fbp};
}

export function createInventoryDemandSnapshot({query,calculate,products,revision,now=Date.now}){
  const entries=new Map();
  async function load(tenantId){
    if(!Number.isSafeInteger(Number(tenantId))||Number(tenantId)<=0)throw new Error('当前企业无效，无法读取库存需求');
    const key=Number(tenantId);let entry=entries.get(key);
    if(entry)return entry.loading?entry.loading:entry;
    // Do not retain a growing collection of inactive enterprises in memory.
    if(entries.size>=8){const old=[...entries].find(([,e])=>!e.pending&&!e.loading);if(old)entries.delete(old[0]);}
    entry={rows:null,at:null,epoch:null,attempt:0,pending:null,error:null};entries.set(key,entry);
    entry.loading=(async()=>{
      const rows=await query('SELECT version,payload_json,calculated_at FROM inventory_demand_snapshots WHERE tenant_id=?',[key]);
      if(rows[0]?.version===INVENTORY_DEMAND_SNAPSHOT_VERSION){
        let payload;try{payload=JSON.parse(rows[0].payload_json);}catch{payload={};}
        if(Array.isArray(payload.rows)&&payload.rows.every(r=>Number.isSafeInteger(Number(r.product_id)))){
          entry.rows=payload.rows.map(inventoryDemandSummary);entry.at=new Date(rows[0].calculated_at).toISOString();
        }
      }
      return entry;
    })();
    try{return await entry.loading;}
    catch(error){entries.delete(key);if(error.code==='ER_NO_SUCH_TABLE')throw Object.assign(new Error('库存需求快照表 inventory_demand_snapshots 尚未初始化，请管理员执行本版本配套数据库初始化后重试'),{statusCode:503});throw error;}
    finally{entry.loading=null;}
  }
  function refresh(entry,tenantId){
    if(entry.pending)return;
    entry.attempt=now();entry.error=null;
    try{
      entry.pending=enqueue(async()=>{
        entry.attempt=now();const epoch=revision();entry.runningEpoch=epoch;const ids=(await products(tenantId)).map(r=>Number(r.product_id));
        const rows=(await calculate(ids,tenantId,{fresh:true})).map(inventoryDemandSummary),at=new Date(now()).toISOString();
        await query(`INSERT INTO inventory_demand_snapshots(tenant_id,version,payload_json,calculated_at) VALUES(?,?,?,?)
          ON DUPLICATE KEY UPDATE version=VALUES(version),payload_json=VALUES(payload_json),calculated_at=VALUES(calculated_at)`,
          [Number(tenantId),INVENTORY_DEMAND_SNAPSHOT_VERSION,JSON.stringify({rows}),at.slice(0,23).replace('T',' ')]);
        entry.rows=rows;entry.at=at;entry.epoch=epoch;
      }).catch(()=>{entry.error='后台核算失败，已保留上次成功结果，可点击重新核算重试';}).finally(()=>{entry.pending=null;entry.runningEpoch=null;if(entry.refreshAgain){entry.refreshAgain=false;refresh(entry,tenantId);}});
    }catch(error){entry.error=error.message;}
  }
  return async function read(tenantId,{fresh=false,productIds=[]}={}){
    const entry=await load(tenantId),have=entry.rows!==null;
    const covered=new Set(entry.rows?.map(r=>Number(r.product_id)));
    const missing=productIds.some(id=>!covered.has(Number(id)));
    const stale=!have||missing||entry.epoch!==revision()||now()-Date.parse(entry.at)>300000;
    // Automatic changes coalesce for at most one refresh/minute per active tenant.
    // Manual reconciliation bypasses this delay but shares any in-flight job.
    if(fresh&&entry.pending&&entry.runningEpoch!=null&&entry.runningEpoch!==revision())entry.refreshAgain=true;
    if(fresh||(stale&&!entry.pending&&(entry.attempt===0||now()-entry.attempt>=60000)))refresh(entry,tenantId);
    return{rows:entry.rows||[],snapshot:{status:entry.pending?(have?'updating':'warming'):entry.error?'error':stale?'stale':'ready',
      available:have,incomplete:missing,calculated_at:entry.at,stale,refreshing:!!entry.pending,error:entry.error}};
  };
}
