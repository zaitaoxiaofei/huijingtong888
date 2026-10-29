import mysql from 'mysql2/promise';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildOrderOutcomeSql } from '../src/services/order-outcome.js';
import { resolveInventoryTenantScope } from '../src/services/inventory-tenant-scope.js';
import { orderLogisticsSummarySql, profitRankingGroupCountSql } from '../src/services/order-report-query-sql.js';

// Compare on one consistent READ ONLY snapshot, without importing application
// startup, caches or schema initializers. Emit hashes/timings, never business rows.
const args=process.argv.slice(2), keys=new Set();
for(const arg of args){if(!/^--(database|mysql-admin-socket|tenant-id|baseline-source|candidate-source|from|to)=.+$/.test(arg)||keys.has(arg.split('=')[0]))throw Error('Unknown/duplicate argument');keys.add(arg.split('=')[0]);}
const option=name=>args.find(x=>x.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const database=option('database'),socketPath=option('mysql-admin-socket'),tenantId=option('tenant-id');
if(!/^[A-Za-z0-9_]+$/.test(database||'')||!socketPath?.startsWith('/')||!/^\d+$/.test(tenantId||''))throw Error('Explicit database, socket and numeric tenant required');
const connection=await mysql.createConnection({database,socketPath,user:'root',dateStrings:true,timezone:'Z'});
let serial=Promise.resolve(),measurements=[],variant='baseline';
function select(sql,params=[]){
 const text=sql.trim();
 if(!/^(SELECT|WITH)\s/i.test(text)||/;|\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|CALL|INTO|FOR UPDATE|LOCK IN SHARE MODE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\b/i.test(text))throw Error('Only read-only report SELECTs are permitted');
 const task=serial.then(async()=>{const t=performance.now();const [rows]=await connection.query(sql,params);measurements.push({variant,sql_sha256:hash(sql),ms:+(performance.now()-t).toFixed(2),rows:rows.length});return rows;});serial=task.catch(()=>{});return task;
}
const hash=value=>createHash('sha256').update(value).digest('hex');
function definition(source,name){const m=source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`,'m'));if(!m)throw Error('Missing checked-in function '+name);return m[0].replace(/^export /,'');}
function ranking(source,scope){
 const context=vm.createContext({Date,Map,Set,Number,String,Object,Array,Math,ensureMysqlCutoverEnabled(){},buildOrderOutcomeSql,profitRankingGroupCountSql,
  orderListTenantScopeMysql:async()=>scope,mysqlQuery:select,mysqlQueryOne:async(sql,params)=>(await select(sql,params))[0]});
 const names=['orderTenantPredicateMysql','normalizeMysqlDateTime','roundMoneyMysql','shanghaiDateKeyToUtcDateTimeMysql','profitTimestampUtcRangeMysql','profitOrderedAtUtcRangeMysql','terminalOrderLossSqlMysql','returnLossTotalSqlMysql','profitRankingMysql'];
 vm.runInContext(names.map(name=>definition(source,name)).join('\n'),context);return context;
}
const baselineLogistics=(where,ruleScope)=>`SELECT o.id,o.posting_number,o.tracking_number,raw.raw_json,
 GROUP_CONCAT(DISTINCT summary_rule.name ORDER BY summary_rule.name SEPARATOR ' / ') AS billing_logistics_rule_name
 FROM orders o LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number
 LEFT JOIN order_items summary_item ON summary_item.order_id=o.id
 LEFT JOIN logistics_fee_rules summary_rule ON summary_rule.id=summary_item.frozen_logistics_rule_id AND ${ruleScope}
 WHERE ${where} GROUP BY o.id`;
try{
 await connection.query("SET SESSION max_execution_time=20000");await connection.query("SET time_zone='+00:00'");await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
 const owned=await resolveInventoryTenantScope(tenantId,select),scope={id:owned.id,defaultTenant:owned.isDefault};
 const before=ranking(await readFile(option('baseline-source'),'utf8'),scope),after=ranking(await readFile(option('candidate-source'),'utf8'),scope);
 const results=[];
 for(const dimension of ['sku','shop','product']){
  const query={dimension,page:1,pageSize:10,from:option('from')||'',to:option('to')||''};
  variant='baseline';let t=performance.now();const original=await before.profitRankingMysql(query,tenantId);const oldMs=performance.now()-t;
  variant='candidate';t=performance.now();const optimized=await after.profitRankingMysql(query,tenantId);const newMs=performance.now()-t;
  const a=hash(JSON.stringify(original)),b=hash(JSON.stringify(optimized));if(a!==b)throw Error('Ranking result mismatch: '+dimension);
  results.push({label:'profit_'+dimension,baseline_ms:+oldMs.toFixed(2),candidate_ms:+newMs.toFixed(2),result_sha256:a,exact_match:true,total:original.total});
 }
 const dates=before.profitOrderedAtUtcRangeMysql('o',option('from')||'',option('to')||'');
 const predicate=before.orderTenantPredicateMysql('owned_shop',scope),where=`EXISTS (SELECT 1 FROM shops owned_shop WHERE owned_shop.id=o.shop_id AND ${predicate}) ${dates.whereSql}`,ruleScope=before.orderTenantPredicateMysql('summary_rule',scope);
 variant='baseline';let t=performance.now();const oldRows=await select(baselineLogistics(where,ruleScope),dates.params);const oldMs=performance.now()-t;
 variant='candidate';t=performance.now();const newRows=await select(orderLogisticsSummarySql(where,ruleScope),dates.params);const newMs=performance.now()-t;
 const sorted=rows=>JSON.stringify(rows.sort((a,b)=>a.id-b.id));const a=hash(sorted(oldRows)),b=hash(sorted(newRows));if(a!==b)throw Error('Logistics result mismatch');
 results.push({label:'order_logistics',baseline_ms:+oldMs.toFixed(2),candidate_ms:+newMs.toFixed(2),result_sha256:a,exact_match:true,rows:oldRows.length});
 console.log(JSON.stringify({mode:'consistent-read-only-snapshot',initialization_performed:false,serial_queries:true,results,measurements},null,2));
}catch(error){console.error('Read-only report comparison failed: '+String(error.code||error.name));process.exitCode=1;}finally{await connection.rollback();await connection.end();}
