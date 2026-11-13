import test from 'node:test';
import assert from 'node:assert/strict';
import {wbRecordProducts,wbRecordPriceText,wbRecordPriceSource,wbRecordScore,wbRecordHasOnlineSku,wbRecordCanDelete,wbRecordOnlineStatus,wbRecordMatches} from '../frontend/admin/utils/wb-publish-record-view.js';

test('WB record readmodel owns images and online identity without falling back to submitted content',()=>{
 const job={payload:{images:['historical.jpg'],card:{title:'Old',vendorCode:'OLD',nmID:123,sizes:[{price:99,skus:['draft-barcode']}]}},products:[{title:'Current',vendor_code:'NEW',images:[],nm_id:null,barcodes:[],price:null,score:null}]};
 assert.deepEqual(wbRecordProducts(job)[0].images,[]);assert.deepEqual(wbRecordProducts(job)[0].barcodes,[]);assert.equal(wbRecordHasOnlineSku(job),false);assert.equal(wbRecordPriceText(job),'未返回');assert.deepEqual(wbRecordScore(job),{text:'未返回',label:''});
});

test('legacy record fallback retains frozen variant materials and prices without presenting draft barcodes as online facts',()=>{
 const variants=[{images:['red.jpg'],card:{title:'Red',vendorCode:'RED',sizes:[{price:258,skus:['submitted-red']},{price:300}]}},{images:['blue.jpg'],card:{title:'Blue',vendorCode:'BLUE',sizes:[{price:280,skus:['submitted-blue']}]}}];
 const job={payload:{currency:'CNY',variants},state:{items:[{nm_id:123},{phase:'card'}]}};
 const products=wbRecordProducts(job);assert.deepEqual(products.map(row=>row.images),[['red.jpg'],['blue.jpg']]);assert.deepEqual(products.map(row=>row.barcodes),[[],[]]);assert.equal(products[0].nm_id,123);assert.equal(wbRecordPriceText(job),'258–300 CNY');assert.equal(wbRecordScore(job).text,'未返回');
});

test('WB record price aggregation keeps separate currencies and preserves zero score with its explicit source',()=>{
 const job={products:[{price:'258',currency:'CNY',score:0,score_source:'erp_completeness'},{price:300,currency:'CNY',score:80,score_label:'ERP资料完整度'},{price:29,currency:'RUB',score:null}]};
 assert.equal(wbRecordPriceText(job),'258–300 CNY / 29 RUB');assert.deepEqual(wbRecordScore(job),{text:'0–80 分（部分）',label:'ERP资料完整度'});
 assert.equal(wbRecordPriceSource({products:[{price:258,price_source:'submitted'}]}),'提交售价');assert.equal(wbRecordPriceSource({products:[{price:258,price_source:'online'}]}),'线上售价');
 assert.equal(wbRecordPriceSource({products:[{price:258,price_source:'online',price_partial:true}]}),'线上售价（部分规格）');
 assert.equal(wbRecordPriceText({products:[{price:258,prices:[],currency:'CNY'}]}),'258 CNY');
 assert.equal(wbRecordOnlineStatus({online_status:'in_catalog'}),'在商品库');assert.equal(wbRecordOnlineStatus({online_status:'not_synced'}),'未同步');
});

test('WB record search includes every variant, synced SKU and barcode and composes shop/status filters',()=>{
 const job={id:1,shop_id:3,shop_name:'WB store',publisher_name:'Operator',category_name:'Key cover',status:'completed',products:[{title:'Red',vendor_code:'RED',nm_id:123,barcodes:['11111111']},{title:'Blue',vendor_code:'BLUE',nm_id:456,barcodes:['22222222']}]};
 for(const query of ['blue','456','22222222','Operator','Key cover'])assert.equal(wbRecordMatches(job,{query}),true);
 assert.equal(wbRecordMatches(job,{query:'blue',shopId:3,status:'completed'}),true);assert.equal(wbRecordMatches(job,{query:'blue',shopId:4}),false);assert.equal(wbRecordMatches(job,{status:'processing'}),false);
});

test('active WB publishing records cannot be deleted while completed/failed history stays deletable',()=>{
 for(const status of ['queued','processing'])assert.equal(wbRecordCanDelete({status}),false);
 for(const status of ['completed','failed','needs_review','paused','superseded'])assert.equal(wbRecordCanDelete({status}),true);
});
