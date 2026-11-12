import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreReviewedSingleFissionVariant} from '../src/shared/reviewed-single-fission-variant.js';
test('reviewed single restoration uses current draft media and prices and removes all inherited source SKU identities',()=>{
 const canonical={title:'Накладки MAZDA CX-50',price:{value:361,old_price:1379,currency_code:'CNY'},dimensions:{weight_g:200},attributes:[{attribute_id:7204,value:['Mazda']}],images:['current.png'],variants:[{sku:'source-1',offer_id:'JELAND-J6',images:['old.png']},{offer_id:'JELAND-J7'}]};
 const input={editable_payload:canonical,source_ozon_sku:'archived-source'};const before=structuredClone(input);
 const output=restoreReviewedSingleFissionVariant(input,{offerId:'AI-MAZDA-CX50',title:canonical.title,canonical,images:['current.png']});
 assert.deepEqual(input,before);assert.equal(output.editable_payload.variants.length,1);
 const v=output.editable_payload.variants[0];assert.equal(v.offer_id,'AI-MAZDA-CX50');assert.equal(v.sku,'');assert.equal(v.price,361);assert.equal(v.old_price,1379);assert.equal(v.currency_code,'CNY');assert.deepEqual(v.images,['current.png']);assert.deepEqual(v.dimensions,{weight_g:200});assert.equal(output.source_ozon_sku,'archived-source');
});
test('missing reviewed media fails rather than borrowing a source image',()=>{
 assert.throws(()=>restoreReviewedSingleFissionVariant({variants:[]},{offerId:'one',title:'title',canonical:{},images:[]}));
});
