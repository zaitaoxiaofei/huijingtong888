import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryCapitalReviewMatches,inventoryCapitalReviewItems} from '../src/shared/inventory-capital-review.js';
test('review categories retain overlapping issues without claiming missing cost is confirmed free',()=>{
 const row={product_id:1,cost_missing:'1',unit_cost:0,unclassified_movements:4,availability_unknown:true,physical_quantity:-2};
 assert.equal(inventoryCapitalReviewMatches(row,'cost'),true);
 assert.equal(inventoryCapitalReviewMatches(row,'binding'),false);
 const items=inventoryCapitalReviewItems(row);assert.equal(items.length,3);
 assert.match(items[0].detail,/不能直接认定为免费/);assert.match(items[1].detail,/4条/);assert.match(items[2].detail,/-2件/);
 assert.deepEqual(inventoryCapitalReviewItems({product_id:2,cost_missing:'0',unclassified_movements:0}),[]);
 assert.equal(inventoryCapitalReviewMatches({},'anything'),false);
});
test('unmapped records identify binding and missing cost separately',()=>{
 assert.deepEqual(inventoryCapitalReviewItems({product_id:null,cost_missing:true}).map(x=>x.key),['cost','binding']);
});
