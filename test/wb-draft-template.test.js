import test from 'node:test';
import assert from 'node:assert/strict';
import {wbDraftTemplate} from '../frontend/admin/utils/wb-draft-template.js';

const draft=()=>({id:15,shop_id:3,revision:8,status:'published',payload:{subject_id:3373,template_id:5,currency:'CNY',strategy:'independent',variants:[0,1].map(index=>({images:[`https://example.test/${index}.jpg`],video_url:`https://example.test/${index}.mp4`,video_source_image:`https://example.test/${index}.jpg`,card:{nmID:100+index,imtID:200,title:`Product ${index}`,vendorCode:`OLD-${index}`,brand:'Brand',description:'Description',dimensions:{length:10,width:8,height:4,weightBrutto:.1},characteristics:[{id:9,value:['black']}],sizes:[{chrtID:300+index,techSize:'M',price:258+index,skus:[`1234567${index}`]}]}}))}});

test('WB templates keep each row content and size prices while resetting all publication identities',()=>{
 const original=draft(),before=structuredClone(original),copy=wbDraftTemplate(original);
 assert.equal(copy.id,undefined);assert.equal(copy.revision,undefined);assert.equal(copy.status,undefined);
 assert.equal(copy.template_source_id,15);assert.equal(copy.target_shop_id,3);
 assert.equal(copy.payload.strategy,'independent');assert.equal(copy.payload.currency,'CNY');
 for(const [index,row] of copy.payload.variants.entries()){
  const source=original.payload.variants[index];
  assert.notEqual(row.card.vendorCode,source.card.vendorCode);assert.ok(row.card.vendorCode.length<=72);
  assert.equal(row.card.nmID,undefined);assert.equal(row.card.imtID,undefined);assert.equal(row.card.sizes[0].chrtID,undefined);
  assert.deepEqual(row.card.sizes[0],{techSize:'M',price:258+index,skus:[]});
  for(const field of ['title','brand','description','dimensions','characteristics'])assert.deepEqual(row.card[field],source.card[field]);
  for(const field of ['images','video_url','video_source_image'])assert.deepEqual(row[field],source[field]);
 }
 assert.deepEqual(copy.payload.card,copy.payload.variants[0].card);assert.deepEqual(copy.payload.images,copy.payload.variants[0].images);
 assert.notEqual(copy.payload.variants[0].card.vendorCode,copy.payload.variants[1].card.vendorCode);
 assert.deepEqual(original,before);
});

test('switching shops retains operator vendor codes and clears old shop identifiers and barcodes',()=>{
 const original=draft();original.target_shop_id=4;
 const copy=wbDraftTemplate(original,{regenerateVendorCodes:false});
 assert.equal(copy.target_shop_id,4);
 assert.deepEqual(copy.payload.variants.map(row=>row.card.vendorCode),['OLD-0','OLD-1']);
 assert.ok(copy.payload.variants.every(row=>!row.card.nmID&&row.card.sizes.every(size=>!size.chrtID&&!size.skus.length)));
 assert.equal(original.shop_id,3);assert.equal(original.payload.variants[0].card.nmID,100);
});

test('legacy single-product templates preserve explicitly empty media without fallback',()=>{
 const original={id:2,shop_id:3,payload:{subject_id:1,card:{title:'Legacy',vendorCode:'OLD',sizes:[{price:99,skus:['old']}]},images:[],video_url:''}};
 const copy=wbDraftTemplate(original);
 assert.equal(copy.payload.variants.length,1);assert.deepEqual(copy.payload.images,[]);assert.equal(copy.payload.video_url,'');
 assert.deepEqual(copy.payload.card.sizes,[{price:99,skus:[]}]);
});
