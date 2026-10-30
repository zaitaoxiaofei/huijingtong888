import test from 'node:test';import assert from 'node:assert/strict';
import {loadFbpSafetyProjections} from '../src/services/fbp-safety-projection.js';
test('batch FBP warnings use bounded snapshot queries, expanding each SKU to physical units once',async()=>{
 const products=Array.from({length:40},(_,i)=>({id:i+1,production_lead_days:7,warehouse_logistics_days:2}));
 const rows=products.map(p=>({inventory_product_id:p.id,shop_id:20,ozon_sku:'SKU-'+p.id,per_set_quantity:2}));
 const calls=[];const q=async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('mapped.*'))return rows;
  if(sql.includes('FROM ozon_stock_snapshots'))return rows.map(r=>({...r,present:8,available:5,reserved:3,synced_at:'2026-10-30 00:00:00'}));
  if(sql.startsWith('SELECT o.shop_id'))return rows.map(r=>({...r,quantity:14}));
  if(sql.startsWith('SELECT f.shop_id'))return rows.map(r=>({...r,quantity:2}));
  if(sql.startsWith('SELECT i.shop_id'))return [];
  throw Error('Unexpected query '+sql);
 };
 const result=await loadFbpSafetyProjections(q,products,{id:2,isDefault:false},()=>({}));assert.equal(calls.length,5);assert.equal(result.size,40);
 const value=result.get(1);assert.equal(value.skus.length,1);assert.equal(value.skus[0].available,5);assert.equal(value.skus[0].fbp_target,16);assert.equal(value.skus[0].per_set_quantity,2);assert.equal(value.skus[0].in_transit,2);
 assert.ok(calls.find(c=>c.sql.startsWith('SELECT o.shop_id')).sql.includes("raw.query_stock_location IN ('FBP','OGR')"));
});
