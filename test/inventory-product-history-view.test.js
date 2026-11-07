import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryHistoryFieldLabel,inventoryHistoryValue} from '../frontend/admin/utils/inventory-product-history.js';

test('inventory history labels and values keep missing, cleared, false and stable component identities distinct',()=>{
 assert.equal(inventoryHistoryFieldLabel('inventory_number'),'库存编号');
 assert.equal(inventoryHistoryFieldLabel('name'),'商品名称');
 assert.equal(inventoryHistoryValue('name',undefined),'未留存');
 assert.equal(inventoryHistoryValue('name',''),'未填写');
 assert.equal(inventoryHistoryValue('is_accessory',0),'否');
 assert.equal(inventoryHistoryValue('is_consumable',1),'是');
 assert.equal(inventoryHistoryValue('vehicle_models_json','["T7","T8"]'),'T7、T8');
 assert.equal(inventoryHistoryValue('fitment_type','universal'),'通用');
 assert.equal(inventoryHistoryValue('product_quantity',0),'0');
 assert.equal(inventoryHistoryValue('components',[{product_id:200,quantity:2,component_role:'gift'}]),'关联商品 #200 × 2（赠品）');
});
