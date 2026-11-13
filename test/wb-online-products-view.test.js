import test from 'node:test';
import assert from 'node:assert/strict';
import {wbKnownNumber,wbOnlineStatus,wbOnlineMapping,wbOnlineSizePrice,wbOnlineWeightGrams,wbLocalInventoryPackage} from '../frontend/admin/utils/wb-online-products.js';

test('WB online quantities and prices distinguish confirmed zero from missing snapshots',()=>{
 for(const value of [null,undefined,'','  ',false,[],{},NaN,Infinity])assert.equal(wbKnownNumber(value),null);
 assert.equal(wbKnownNumber(0),0);assert.equal(wbKnownNumber('0'),0);assert.equal(wbKnownNumber('12'),12);
 const row={price_info:{currency:'CNY',sizes:[{chrt_id:22,price:0,original_price:30},{chrt_id:11,price:20,original_price:40}]}};
 assert.equal(wbOnlineSizePrice(row,{chrtID:11}).price,20);assert.equal(wbOnlineSizePrice(row,{chrtID:22}).price,0);
 assert.equal(wbOnlineSizePrice(row,{chrtID:33}),null);assert.equal(wbOnlineSizePrice(row,{}),null);
});

test('WB mappings follow the actual returned specification ID and packaging displays grams',()=>{
 const row={mappings:[{ozon_sku:'WB-22',product_id:2},{ozon_sku:'WB-11',product_id:1}],card:{dimensions:{weightBrutto:0.215}}};
 assert.equal(wbOnlineMapping(row,{chrtID:11}).product_id,1);assert.equal(wbOnlineMapping(row,{chrtID:22}).product_id,2);
 assert.equal(wbOnlineMapping(row,{chrtID:33}),undefined);assert.equal(wbOnlineMapping(row,{}),undefined);
 assert.equal(wbOnlineWeightGrams(row),215);assert.equal(wbOnlineWeightGrams({card:{dimensions:{weightBrutto:0}}}),0);
 assert.equal(wbOnlineWeightGrams({card:{dimensions:{}}}),null);
});

test('WB card visibility is displayed without inventing a saleable state',()=>{
 assert.equal(wbOnlineStatus({online_status:'in_catalog',fbs_stock:0}),'商品库');
 assert.equal(wbOnlineStatus({online_status:'archived',fbs_stock:20}),'WB 回收站');
 assert.equal(wbOnlineStatus({}), '未返回状态');
});

test('local inventory packaging starts with platform knowns and leaves missing values editable',()=>{
 assert.deepEqual(wbLocalInventoryPackage({card:{dimensions:{length:16,width:8,height:5,weightBrutto:0.215}}}),{length_cm:16,width_cm:8,height_cm:5,package_weight_g:215});
 assert.deepEqual(wbLocalInventoryPackage({card:{dimensions:{length:0,width:null}}}),{length_cm:null,width_cm:null,height_cm:null,package_weight_g:null});
});
