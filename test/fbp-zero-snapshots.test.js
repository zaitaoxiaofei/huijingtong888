import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmedFbpZeroSnapshots} from '../src/shared/fbp-zero-snapshots.js';
const fbs={ozon_sku:'101',offer_id:'one',ozon_product_id:'201',stock_type:'fbs_virtual',present:50};
test('only returned classified FBS-only SKUs create explicit FBP-zero evidence',()=>{
 const rows=confirmedFbpZeroSnapshots([fbs,{...fbs,warehouse_id:'other'}]);assert.equal(rows.length,1);assert.equal(rows[0].available,0);assert.equal(rows[0].warehouse_id,'flow-confirmed-zero');assert.equal(rows[0].ozon_sku,'101');assert.equal(rows[0].offer_id,'one');assert.equal(fbs.present,50);
 assert.deepEqual(confirmedFbpZeroSnapshots([]),[]);assert.deepEqual(confirmedFbpZeroSnapshots([{...fbs,ozon_sku:''}]),[]);assert.deepEqual(confirmedFbpZeroSnapshots([{...fbs,ozon_sku:'__MISSING_SKU__:1'}]),[]);
});
test('an actual FBP row, unknown warehouse or another SKU cannot be treated as verified absence',()=>{
 assert.deepEqual(confirmedFbpZeroSnapshots([fbs,{...fbs,stock_type:'fbp_real',present:7}]),[]);
 assert.deepEqual(confirmedFbpZeroSnapshots([fbs,{...fbs,stock_type:'unknown'}]),[]);
 const rows=confirmedFbpZeroSnapshots([fbs,{...fbs,ozon_sku:'102',stock_type:'fbp_real',present:7}]);assert.deepEqual(rows.map(r=>r.ozon_sku),['101']);
});
