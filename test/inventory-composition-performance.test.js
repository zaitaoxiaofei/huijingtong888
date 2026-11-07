import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInventoryComposition} from '../src/services/inventory-composition.js';
import {physicalInventoryComponents} from '../src/shared/inventory-composition.js';
test('one scoped composition read reuses physical trees and reverse kit indexes for all visible inventory',async()=>{
 let reads=0;const products=Array.from({length:900},(_,i)=>({get id(){reads++;return i+1;},active:1,name:'stock-'+i}));
 const edges=Array.from({length:250},(_,i)=>[{product_id:i+651,component_product_id:i%100+1,quantity:2},{product_id:i+651,component_product_id:(i+1)%100+1,quantity:1}]).flat();
 let queries=0;const query=async sql=>{queries++;return sql.includes('FROM products p')?products:edges;};
 const graph=await loadInventoryComposition(query,{id:2,isDefault:false});
 for(let id=1;id<=100;id++){
  const expected=edges.filter(e=>e.component_product_id===id).map(e=>({id:e.product_id,quantity:e.quantity}));
  assert.deepEqual(graph.affected(id).map(p=>({id:p.id,quantity:p.per_set_quantity})),expected);
 }
 assert.equal(queries,2);assert.ok(reads<12000,`request rebuilt product maps: ${reads} identity reads`);
 const before=reads;assert.equal(graph.components(651),graph.components(651));for(let i=0;i<100;i++)graph.affected(i+1);assert.equal(reads,before,'warm request lookup must not rebuild a graph');
 assert.deepEqual(graph.affected(1,[651]).map(p=>p.id),[651]);
});
test('fresh scoped graphs preserve current ratios, unknown ownership, inactive components and cycles',async()=>{
 const products=[{id:1,active:1},{id:2,active:1},{id:3,active:1},{id:4,active:0}],edges=[{product_id:1,component_product_id:2,quantity:2},{product_id:2,component_product_id:3,quantity:3}];
 const query=async sql=>sql.includes('FROM products p')?products:edges;
 const a=await loadInventoryComposition(query,{id:2,isDefault:false});assert.equal(a.components(1)[0].per_set_quantity,6);
 edges[0]={...edges[0],quantity:4};const b=await loadInventoryComposition(query,{id:2,isDefault:false});assert.equal(b.components(1)[0].per_set_quantity,12);
 for(const invalid of [[...edges,{product_id:3,component_product_id:1,quantity:1}],[{product_id:1,component_product_id:4,quantity:1}],[{product_id:1,component_product_id:99,quantity:1}]]){
  const graph=await loadInventoryComposition(async sql=>sql.includes('FROM products p')?products:invalid,{id:2,isDefault:false});
  assert.throws(()=>graph.components(1),{statusCode:409});assert.deepEqual(graph.affected(3),[]);
 }
 assert.deepEqual(b.components(1),physicalInventoryComponents(1,products,edges));
});
