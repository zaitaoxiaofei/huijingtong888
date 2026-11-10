import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {claimTenantTrial} from '../src/services/tenant-trial-eligibility.js';
import {isTrialPlan} from '../src/shared/subscription-plan-features.js';
const source=readFileSync(new URL('../src/services/tenants.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end)).replace('export ','');
test('platform direct plan changes share the one-trial marker and preserve it after a paid upgrade',async()=>{
 const plans=[{code:'trial_1d',duration_days:1,subscription_status:'trial',account_limit:1,shop_limit:2},{code:'trial_7d',duration_days:7,subscription_status:'trial',account_limit:1,shop_limit:2},{code:'monthly',duration_days:30,subscription_status:'active',account_limit:1,shop_limit:2}];
 let tenant={id:42,slug:'customer',plan_code:'unactivated',subscription_status:'unactivated',feature_flags_json:null}, queue=Promise.resolve();
 const connection={execute:async(sql,params)=>{
  if(sql.startsWith('SELECT id, slug'))return [[structuredClone(tenant)]];
  if(sql.startsWith('SELECT id FROM tenant_subscription_vouchers'))return [[]];
  if(sql.startsWith('UPDATE tenants SET feature_flags_json')){tenant.feature_flags_json={...tenant.feature_flags_json,beta_trial_used:true};return [{affectedRows:1}];}
  if(sql.startsWith('UPDATE tenants SET plan_code')){Object.assign(tenant,{plan_code:params[0],subscription_status:params[1],subscription_expires_at:params[2]});return [{affectedRows:1}];}
  throw Error('Unexpected SQL');
 }};
 const fn=vm.runInNewContext(extract('export async function setTenantSubscriptionMysql(', 'export async function listTenantPlansMysql(')+';setTenantSubscriptionMysql',{
 ensureTenantSchemaMysql:async()=>{},text:v=>String(v||''),mysqlQuery:async(_sql,params)=>plans.filter(p=>p.code===params[0]),tenantLifecycle:()=>({retention_due:false}),tenantPlanMemberLimit:p=>p.account_limit-1,claimTenantTrial,
 withMysqlTransaction:async action=>{const previous=queue;let release;queue=new Promise(r=>{release=r;});await previous;const before=structuredClone(tenant);try{return await action(connection);}catch(e){tenant=before;throw e;}finally{release();}}
 });
 const results=await Promise.allSettled([fn(42,{plan_code:'trial_1d'}),fn(42,{plan_code:'trial_7d'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 await fn(42,{plan_code:'monthly'});assert.equal(tenant.feature_flags_json.beta_trial_used,true);
 await assert.rejects(fn(42,{plan_code:'trial_7d'}),/已使用体验/);
});
test('platform creation stamps a new trial enterprise in the same insert',async()=>{
 let inserted;
 const plan={code:'trial_7d',duration_days:7,subscription_status:'trial',account_limit:1,shop_limit:2};
 const fn=vm.runInNewContext(extract('export async function createTenantMysql(', 'function generateTenantActivationCode(')+';createTenantMysql',{
 ensureTenantSchemaMysql:async()=>{},text:v=>String(v||''),mysqlQuery:async()=>[plan],tenantPlanMemberLimit:p=>p.account_limit-1,isTrialPlan,generateTenantActivationCode:()=> 'test-code',hashTenantActivationCode:()=> 'hash',
 withMysqlTransaction:async action=>action({execute:async(sql,params)=>{if(sql.startsWith('INSERT INTO tenants'))inserted={sql,params};return [{insertId:42}];}})
 });
 await fn({name:'Customer',slug:'customer',plan_code:'trial_7d'});
 assert.match(inserted.sql,/JSON_OBJECT\('beta_trial_used', \?\)/);assert.equal(inserted.params.at(-1),1);
});
