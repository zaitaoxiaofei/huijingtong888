import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiCreditLedger} from '../src/services/ai-credit-ledger.js';
import {handleAiCreditRoute} from '../src/server/routes/aiCredits.js';
import {authorizeApiRequest} from '../src/server/authorization.js';
const admin={personId:9,platform_role:'super_admin'};
const member={personId:8,roles:['operations'],tenant:{id:2,slug:'customer-a'}};

test('platform account reads require a current platform grant and bind every customer data query to the requested enterprise',async()=>{
 const queries=[];let granted=true;
 const ledger=createAiCreditLedger({transaction:async run=>run({execute:async(sql,params)=>{
  queries.push({sql,params});
  if(sql.includes('FROM platform_grants'))return [granted?[{person_id:9}]:[]];
  if(sql==='SELECT id FROM tenants WHERE id = ?')return [[{id:42}]];
  if(sql.includes('FROM ai_credit_accounts'))return [[{tenant_id:42,status:'active',available_points:500,frozen_points:0}]];
  if(sql.includes('FROM ai_credit_entries'))return [[{id:8,kind:'recharge',available_delta:500,entry_key:'recharge:receipt-1'}]];
  throw new Error('Unexpected query: '+sql);
 }})});
 await assert.rejects(ledger.platformAccount(member,{tenantId:42}),{code:'AI_CREDIT_FORBIDDEN'});
 assert.equal(queries.length,0);
 granted=false;await assert.rejects(ledger.platformAccount(admin,{tenantId:42}),{code:'AI_CREDIT_FORBIDDEN'});
 assert.ok(!queries.some(q=>q.sql.includes('FROM ai_credit_accounts')));
 granted=true;queries.length=0;
 const result=await ledger.platformAccount(admin,{tenantId:42,before:123,limit:10});
 assert.equal(result.wallet.available_points,500);assert.equal(result.entries.length,1);
 for(const q of queries.filter(q=>/FROM ai_credit_(accounts|entries)/.test(q.sql)))assert.equal(q.params[0],42);
 assert.deepEqual(queries.find(q=>q.sql.includes('FROM ai_credit_entries')).params,[42,123]);
 assert.ok(!queries.some(q=>/INSERT|UPDATE|DELETE/.test(q.sql)));
 await assert.rejects(ledger.platformAccount(admin,{tenantId:42,limit:101}),{code:'AI_CREDIT_INVALID'});
});

test('platform account HTTP path is exact, no-store, and unavailable to enterprise administrators',async()=>{
 const parts=['api','platform','ai-credits','accounts','42'];
 assert.equal(authorizeApiRequest({method:'GET',_session:member},parts).allowed,false);
 assert.equal(authorizeApiRequest({method:'GET',_session:admin},parts).allowed,true);
 let args;const headers={};
 const request={req:{method:'GET',_session:admin},res:{setHeader:(k,v)=>headers[k]=v},parts,url:new URL('http://localhost:8788/api/platform/ai-credits/accounts/42?tenantId=1&before=100'),ledger:{platformAccount:async(...value)=>{args=value;return {wallet:{tenant_id:42},entries:[]};}},json(){}};
 assert.equal(await handleAiCreditRoute(request),true);assert.equal(args[0],admin);assert.equal(args[1].tenantId,'42');assert.equal(args[1].before,'100');assert.equal(headers['Cache-Control'],'no-store');
 assert.equal(await handleAiCreditRoute({...request,parts:[...parts,'extra']}),false);
});
