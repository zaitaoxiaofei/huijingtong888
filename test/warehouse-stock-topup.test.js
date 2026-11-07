import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStockTopup, stockTopupRecipients } from '../src/services/warehouse-stock-topup.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
const valid={order_id:1,product_id:10,quantity:2,request_key:'12345678-1234-1234-1234-123456789012'};
test('topup validates explicit physical pieces and stable retry identity; client tenant and authority are ignored',()=>{
 assert.equal(validateStockTopup({...valid,tenant_id:3,person_id:99}).quantity,2);
 for(const quantity of [0,-1,1.5,1000001,NaN]) assert.throws(()=>validateStockTopup({...valid,quantity}),/整数件/);
 assert.throws(()=>validateStockTopup({...valid,request_key:''}),/提醒标识/);
});
test('recipients include enterprise owners/admins and buyers once, never ordinary historical auto-owners or platform identity alone',()=>{
 const rows=[{id:1,tenant_slug:'a',tenant_role:'owner',business_roles_json:'[]'},
 {id:2,tenant_slug:'a',tenant_role:'member',business_roles_json:'["procurement"]'},
 {id:3,tenant_slug:'default',tenant_role:'owner',role:'packing',business_roles_json:null},
 {id:4,tenant_slug:'a',tenant_role:'member',role:'admin',business_roles_json:'[]'},
 {id:2,tenant_slug:'a',tenant_role:'member',business_roles_json:'["procurement"]'}];
 assert.deepEqual(stockTopupRecipients(rows),[1,2]);
});
test('only the exact new route is opened, with warehouse or inventory authority and enterprise context',()=>{
 const parts=['api','procurement','stock-topups'];
 for(const role of ['packing','procurement']){const session={personId:1,roles:[role],tenant:{id:2,slug:'a',role:'member'}};
 assert.equal(authorizeApiRequest({method:'POST',_session:session},parts).allowed,true);
 assert.equal(tenantIsolationDecision(session,parts,'POST').allowed,true);}
 assert.equal(authorizeApiRequest({method:'POST',_session:{personId:1,roles:['analytics'],tenant:{id:2,slug:'a',role:'member'}}},parts).allowed,false);
 assert.equal(tenantIsolationDecision({personId:1,roles:['packing']},parts,'POST').allowed,false);
});
