import test from 'node:test';
import assert from 'node:assert/strict';
import {postFbpPhysicalShipment} from '../src/services/fbp-physical-shipment.js';
const scope={id:2,isDefault:false};
function fixture({physical=17,fbs=4,review=false,parts=[{product_id:10,name:'子库存',inventory_number:'2-23-1',quantity:1}],prior=[]}={}){
 const calls=[],writes=[],stocks=new Map(parts.map(p=>[p.product_id,physical]));
 const query=async(sql,args)=>{calls.push({sql,args});if(sql.includes('SELECT product_id,source_type'))return [...stocks].map(([product_id,quantity_delta])=>({product_id,quantity_delta,source_type:'opening_stock'}));if(sql.includes('FROM inventory_movements'))return prior;return[{id:args?.[0]}];};
 const coverage=async()=>{const m=new Map([[1,{needs_fulfillment:true,stock_location:'LOCAL',items:parts.map(p=>({product_id:p.product_id,quantity:fbs,quantity_needs_review:review}))}]]);m.inventory_stocks=[...stocks].map(([product_id,ledger])=>({product_id,ledger,open_deducted:0}));return m;};
 const post=async(part,qty,ref)=>{writes.push({id:part.product_id,qty,ref});stocks.set(part.product_id,stocks.get(part.product_id)+qty);return writes.length;};
 return {calls,writes,stocks,ship:(n,record={id:7,product_id:10})=>postFbpPhysicalShipment(query,scope,record,n,post,{parts:async()=>parts,coverage})};
}
test('confirmed shipment cannot take physical units needed by FBS; shortage posts nothing',async()=>{
 const f=fixture();await assert.rejects(f.ship(15),/须优先保障FBS 4 件，可发仓 13 件/);assert.equal(f.writes.length,0);assert.equal(f.stocks.get(10),17);
});
test('a successful physical shipment reduces only actual remaining stock and later shipments recheck it',async()=>{
 const f=fixture();await f.ship(10);assert.equal(f.stocks.get(10),7);await assert.rejects(f.ship(5,{id:8,product_id:10}),/可发仓 3 件/);assert.deepEqual(f.writes,[{id:10,qty:-10,ref:'fbp_transfer:7:outbound'}]);
});
test('virtual bundles post each physical child, and any insufficient child prevents all writes',async()=>{
 const parts=[{product_id:10,name:'A',quantity:2},{product_id:11,name:'B',quantity:1}];const f=fixture({physical:10,fbs:4,parts});
 await assert.rejects(f.ship(4,{id:7,product_id:99}),/本次需 8 件/);assert.equal(f.writes.length,0);
 await f.ship(3,{id:7,product_id:99});assert.deepEqual(f.writes.map(w=>[w.id,w.qty]),[[10,-6],[11,-3]]);assert.ok(f.writes.every(w=>w.ref.includes(':component:')));
});
test('unknown order quantities reject dispatch, and same-source retries do not post twice',async()=>{
 const review=fixture({review:true});await assert.rejects(review.ship(1),/FBS订单需求待核对/);assert.equal(review.writes.length,0);
 const retry=fixture({prior:[{id:1,quantity_delta:-3}]});await retry.ship(3);assert.equal(retry.writes.length,0);
 await assert.rejects(retry.ship(4),/数量不同/);
});
