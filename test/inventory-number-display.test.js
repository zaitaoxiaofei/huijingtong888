import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryNumberTitle } from '../frontend/admin/utils/inventory-number.js';
test('only a zero core or brand in a three-part number is marked pending review',()=>{
  for(const value of ['0-2-1','1-0-8','0-0-1']) assert.match(inventoryNumberTitle(value),/待核对.*旧号仍可搜索/);
  for(const value of ['1-1-1','1-2-1','1-10-1','0-2','P-200']) assert.doesNotMatch(inventoryNumberTitle(value),/待核对/);
  assert.match(inventoryNumberTitle('1-1-1'),/变更后会重新发号/);
  assert.match(inventoryNumberTitle(null),/补齐核心品名、汽车品牌与适配资料/);
});
