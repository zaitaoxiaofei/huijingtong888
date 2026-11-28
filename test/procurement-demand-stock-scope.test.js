import test from 'node:test';
import assert from 'node:assert/strict';
import {procurementDemandStockIds} from '../src/services/procurement-demand-composition.js';
test('generic parts include finished ancestor kits without expanding every sibling part family',()=>{
 const edges=[[100,1],[100,2],[200,1],[200,3],[300,3],[400,4],[500,200]].map(([product_id,component_product_id])=>({product_id,component_product_id}));
 assert.deepEqual(procurementDemandStockIds([100,1,2],edges,[200,300,400,500]),[100,1,2,200,500]);
 assert.deepEqual(procurementDemandStockIds([100,1,2],edges,[]),[100,1,2]);
});
