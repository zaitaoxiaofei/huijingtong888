import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryOverview } from '../frontend/orders/utils/inventory-overview.js';
import { orderAliasProducts } from '../frontend/orders/utils/order-product-aliases.js';
test('single inventory alias is identified by the product, never by the order or SKU', () => {
 const view=inventoryOverview({id:999,inventorySummaries:[{productId:23,productName:'EXEED VX 配件',inventoryNumber:'1-2-3',sku:'888',quantity:1}]});
 assert.deepEqual(orderAliasProducts(view),[{product_id:23,product_name:'EXEED VX 配件',inventory_number:'1-2-3'}]);
 assert.deepEqual(orderAliasProducts(view,{includeParents:true}),orderAliasProducts(view));
});
test('procurement aliases follow physical children; hovering also identifies the bound bundle', () => {
 const view=inventoryOverview({inventorySummaries:[{productId:42,productName:'两件套',inventoryNumber:'1-2-42',quantity:1,componentCount:2,pickingItems:[{product_id:23,product_name:'左件',inventory_number:'1-2-23',required_quantity:1},{product_id:24,product_name:'右件',inventory_number:'1-2-24',required_quantity:1}]}]});
 assert.deepEqual(orderAliasProducts(view).map(p=>p.product_id),[23,24]);
 assert.deepEqual(orderAliasProducts(view,{includeParents:true}).map(p=>p.product_id),[42,23,24]);
});
test('shared children are shown once and virtual recipe identities do not become inventory products', () => {
 const view=inventoryOverview({inventorySummaries:[{productId:0,inventoryKey:'recipe-400',productName:'虚拟套装',quantity:1,pickingItems:[{product_id:23,product_name:'同一实物',required_quantity:2}]},{productId:0,inventoryKey:'recipe-401',quantity:1,pickingItems:[{product_id:23,product_name:'同一实物',required_quantity:1}]}]});
 assert.deepEqual(orderAliasProducts(view,{includeParents:true}).map(p=>p.product_id),[23]);
 for(const product_id of [0,-1,NaN,Infinity,1.5,'SKU123'])assert.deepEqual(orderAliasProducts({items:[{product_id}]}),[]);
 assert.deepEqual(orderAliasProducts(),[]);
});
