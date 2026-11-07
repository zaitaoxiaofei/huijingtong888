import test from 'node:test';
import assert from 'node:assert/strict';
import {inventorySearchDefaults,appendInventorySearch} from '../src/shared/inventory-search-fields.js';
import {applyFilterQuery} from '../frontend/admin/views/inventory/inventory-utils.js';

test('multiple product attributes survive route restore, request serialization and clearing',()=>{
 const defaults={...inventorySearchDefaults(),query:'',page:1};const state={...defaults};
 applyFilterQuery({query:{vehicleModel:'T4,T7',material:'TPU,皮革',page:'2',query:'123'}},state,defaults);
 assert.deepEqual(state.vehicleModel,['T4','T7']);assert.deepEqual(state.material,['TPU','皮革']);assert.equal(state.page,2);
 const params=appendInventorySearch(new URLSearchParams(),state);assert.equal(params.get('vehicleModel'),'T4,T7');assert.equal(params.get('material'),'TPU,皮革');
 applyFilterQuery({query:{}},state,defaults);assert.deepEqual(state.vehicleModel,[]);assert.deepEqual(state.material,[]);assert.equal(state.query,'');
 assert.equal(appendInventorySearch(new URLSearchParams(),state).has('material'),false);
});

import {applyStockAlertQuery} from '../src/services/inventory-alert-utils.js';
test('FBP exact SKU rows stay distinct and creation-date filters use Beijing calendar days',()=>{
 const product={product_id:1,created_at:'2026-10-29 16:30:00',skus:[{shop_id:20,ozon_sku:'123',offer_id:'offer-a',fbp_present:2,fbp_available:2},{shop_id:20,ozon_sku:'1234',offer_id:'offer-b',fbp_present:3,fbp_available:3}]};
 const found=applyStockAlertQuery([product],{mode:'fbp',inventorySku:'123',dateFrom:'2026-10-30',dateTo:'2026-10-30'});
 assert.equal(found.total,1);assert.equal(found.rows[0].ozon_sku,'123');
 assert.equal(applyStockAlertQuery([product],{mode:'fbp',dateTo:'2026-10-29'}).total,0);
});
