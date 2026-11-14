import test from 'node:test';import assert from 'node:assert/strict';
import {CONFIRMED_COSTS,planCostRepair} from '../scripts/repair-confirmed-order-costs.mjs';
const products=Object.entries(CONFIRMED_COSTS).map(([id,cost])=>({id:Number(id),tenant_id:1,active:1,purchase_cost:0,name:String(id)}));
const item={id:1,order_id:10,tenant_id:1,product_id:229,quantity:2,purchase_cost_cny:0,frozen_purchase_cost:0,estimated_profit:50,net_profit_cny:50,gross_profit_cny:55,profit_status:'estimated',is_locked:0,settlement_state:'pending'};
const scope={tenant_id:1,order_ids:[10],reference:'explicit user confirmation'};
test('confirmed inventory unit cost changes only the approved historical cost contribution',()=>{const p=planCostRepair(products,[item],scope);assert.equal(p.items[0].total,30);assert.equal(p.items[0].estimated_profit,20);assert.equal(p.items[0].gross_profit_cny,25);assert.equal(item.estimated_profit,50);assert.equal(p.hash.length,64);});
test('rejects foreign tenants, changed mappings, locked actuals, duplicate items and unreviewed costs',()=>{
 for(const patch of [{tenant_id:2},{product_id:999},{is_locked:1},{profit_status:'accrued'},{settlement_state:'accrued'},{purchase_cost_cny:8},{frozen_purchase_cost:2},{quantity:0}])assert.throws(()=>planCostRepair(products,[{...item,...patch}],scope));
 assert.throws(()=>planCostRepair(products,[item,item],scope));assert.throws(()=>planCostRepair(products,[item],{...scope,order_ids:[10,11]}));assert.throws(()=>planCostRepair(products.map((p,n)=>n? p:{...p,tenant_id:2}),[item],scope));
});
test('a refreshed plan detects concurrent input changes and preserves explicit zero fields',()=>{const p=planCostRepair(products,[item],scope);assert.notEqual(planCostRepair(products,[{...item,estimated_profit:51}],scope).hash,p.hash);const updated=planCostRepair(products,[{...item,purchase_cost_cny:30,frozen_purchase_cost:15}],scope);assert.equal(updated.items[0].delta,0);});
test('legacy NULL ownership requires the verified default enterprise',()=>{const legacy=products.map(p=>({...p,tenant_id:null}));assert.throws(()=>planCostRepair(legacy,[item],scope));assert.equal(planCostRepair(legacy,[{...item,tenant_id:null}],{...scope,default_tenant:true}).items.length,1);assert.throws(()=>planCostRepair(products.map(p=>({...p,tenant_id:2})),[item],{...scope,default_tenant:true}));});
