import test from 'node:test';
import assert from 'node:assert/strict';
import { wbListingValidation, wbListingCard } from '../src/shared/wb-listing-validation.js';
const valid=()=>({subject_id:1,images:['https://images.example.test/main.jpg'],card:{title:'Brake pads',vendorCode:'PAD-1',dimensions:{length:10,width:10,height:2,weightBrutto:0.2},sizes:[{techSize:'0',price:300,skus:['1234567890123']}],characteristics:[{id:7,value:0},{id:8,value:['Steel']} ]}});
const attributes=[{charcID:7,charcType:4,required:true,name:'Thickness'},{charcID:8,charcType:1,required:true,name:'Material',maxCount:1}];
test('WB validation retains numeric zero, selected attributes and exact image order',()=>{const p=valid();assert.equal(wbListingValidation(p,attributes).ok,true);assert.equal(wbListingCard(p).characteristics[0].value,0);assert.ok(!('photos' in wbListingCard(p)));});
test('WB listing blocks incomplete packaging, fractional price, duplicate barcodes and authenticated media',()=>{const p=valid();p.card.dimensions.length=0.5;p.card.sizes.push({...p.card.sizes[0],price:0.2});p.images=['https://user:password@example.test/main.jpg'];const r=wbListingValidation(p,attributes);assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e.includes('整数厘米')));assert.ok(r.errors.some(e=>e.includes('条码')));assert.ok(r.errors.some(e=>e.includes('图片')));});
test('WB category change rejects old attributes and missing new required values',()=>{const p=valid();const r=wbListingValidation(p,[{charcID:12,charcType:1,required:true,name:'New required'}]);assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e.includes('New required')));assert.ok(r.errors.some(e=>e.includes('不属于')));});

import {wbListingSource} from '../src/shared/wb-listing-source.js';
test('WB source import uses effective images and does not inherit Ozon price, category, or attributes',()=>{
 const result=wbListingSource({id:1,internal_code:'WF-1',product_name:'Key cover',effective_images:[],source_images:['https://old.test/a.jpg'],sale_price:999,weight_g:220,length_cm:12,width_cm:22,height_cm:11,template_payload:{editable_payload:{variants:[{title:'Current title',images:[],images_manually_edited:true}],attributes:[{id:99,value:'Ozon only'}]}}});
 assert.deepEqual(result.images,[]);assert.equal(result.card.title,'Current title');assert.equal(result.card.sizes[0].price,null);assert.equal(result.subject_id,null);assert.deepEqual(result.card.characteristics,[]);assert.equal(result.card.dimensions.weightBrutto,0.22);
});

import {readFileSync} from 'node:fs';
test('WB editor drag reorder persists the new image order without historical image fallback',()=>{
 const source=readFileSync(new URL('../frontend/admin/components/listing/WbListingEditor.vue',import.meta.url),'utf8');
 const fn=source.match(/function drop\(index\)\{[^\n]+\}/)?.[0];assert.ok(fn);
 const form={images:['current-main','current-detail','current-third']},dragIndex={value:2};
 const drop=new Function('form','dragIndex',`${fn};return drop;`)(form,dragIndex);drop(0);
 assert.deepEqual(form.images,['current-third','current-main','current-detail']);assert.equal(dragIndex.value,-1);
 assert.match(source,/@dragover\.prevent/);assert.match(source,/@drop\.prevent="drop\(index\)"/);
 assert.ok(!source.includes('source_images'));assert.match(source,/const value=clone\(form\)/);
});
