import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {mysqlQuery,withMysqlTransaction,closeMysqlPool} from '../src/mysql-pool.js';
import {resolveInventoryTenantScope,inventoryTenantSql} from '../src/services/inventory-tenant-scope.js';
import {fetchOzonReturnObservations} from '../src/ozonClient.js';
import {storeOzonReturnObservations} from '../src/services/ozon-return-sync.js';
import {summarizeOzonReturns} from '../src/services/ozon-return-state.js';
const arg=name=>process.argv.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const input=arg('--input'),tenant=arg('--tenant-id'),apply=process.argv.includes('--apply');
if(!input||!tenant)throw Error('Explicit --input and --tenant-id required; default is read-only');
const raw=fs.readFileSync(input),manifest=JSON.parse(raw),sha=createHash('sha256').update(raw).digest('hex');
if(apply&&arg('--expected-input-sha256')!==sha)throw Error('Reviewed input SHA256 required for apply');
const ids=[...new Set((manifest.matches||[]).map(r=>Number(r.order?.id)))];
if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0)||String(manifest.scope?.tenant_id)!==String(tenant))throw Error('Invalid reviewed scope');
try{
 const scope=await resolveInventoryTenantScope(tenant);
 const orders=await mysqlQuery(`SELECT o.id,o.shop_id,o.posting_number FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id IN (${ids.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'s')} AND o.ordered_at>='2025-12-31 16:00:00' AND o.ordered_at<'2026-12-31 16:00:00'`,ids);
 if(orders.length!==ids.length)throw Error('Reviewed year or order ownership changed');
 const result={mode:apply?'apply':'dry-run',input_sha256:sha,orders:orders.length,shops:[],states:{},changes_financial_amounts:false};
 for(const shopId of [...new Set(orders.map(o=>o.shop_id))]){
  const guard=async()=>{const [shop]=await mysqlQuery(`SELECT * FROM shops WHERE id=? AND ${inventoryTenantSql(scope)} AND platform='ozon' AND status='active'`,[shopId]);if(!shop)throw Error('Shop ownership or status changed');return shop;};
  const shop=await guard(),fetched=await fetchOzonReturnObservations(shop,{beforeRequest:guard});
  const postings=new Set(orders.filter(o=>o.shop_id===shopId).map(o=>o.posting_number));
  const rows=fetched.rows.filter(r=>postings.has(r.posting_number));
  for(const posting of postings){const summary=summarizeOzonReturns(rows.filter(r=>r.posting_number===posting));const state=summary?.status||'not_returned_by_api';result.states[state]=(result.states[state]||0)+1;}
  const saved=apply?await withMysqlTransaction(c=>storeOzonReturnObservations(c,scope,shopId,rows)):null;
  result.shops.push({shop_id:shopId,complete:fetched.complete,records:rows.length,...saved});
 }
 console.log(JSON.stringify(result,null,2));
}finally{await closeMysqlPool();}
