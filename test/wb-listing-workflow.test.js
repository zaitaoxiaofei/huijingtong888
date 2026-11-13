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
 const source=readFileSync(new URL('../frontend/admin/components/listing/WbListingVariantEditor.vue',import.meta.url),'utf8');
 const fn=source.match(/function drop\(index\)\{[^\n]+\}/)?.[0];assert.ok(fn);
 const form={images:['current-main','current-detail','current-third']},dragIndex={value:2};
 const selectedImages={value:[0]};const drop=new Function('form','dragIndex','selectedImages',`${fn};return drop;`)(form,dragIndex,selectedImages);drop(0);assert.deepEqual(selectedImages.value,[]);
 assert.deepEqual(form.images,['current-third','current-main','current-detail']);assert.equal(dragIndex.value,-1);
 assert.match(source,/@dragover\.prevent/);assert.match(source,/@drop\.prevent="drop\(index\)"/);
 assert.ok(!source.includes('source_images'));assert.match(source,/const value=clone\(form\)/);
});

test('WB optional video is validated separately from product images',()=>{
 const p=valid();p.video_url='https://media.example.test/product.mp4';assert.equal(wbListingValidation(p,attributes).ok,true);
 p.video_url='https://user:secret@media.example.test/product.mp4';assert.ok(wbListingValidation(p,attributes).errors.some(e=>e.includes('商品视频')));
 p.video_url='https://media.example.test/page.html';assert.ok(wbListingValidation(p,attributes).errors.some(e=>e.includes('商品视频')));
});
test('WB source import respects an explicitly removed current video',()=>{
 const draft={id:1,effective_images:[],template_payload:{video_urls:['https://old.example.test/video.mp4'],editable_payload:{variants:[{video_urls:[]}]}}};
 assert.equal(wbListingSource(draft).video_url,'');draft.template_payload.editable_payload.variants[0].video_urls=['https://new.example.test/video.mp4'];assert.equal(wbListingSource(draft).video_url,'https://new.example.test/video.mp4');
});

function uploaderContext(overrides={}){
 const source=readFileSync(new URL('../frontend/admin/components/listing/WbListingVariantEditor.vue',import.meta.url),'utf8');const fn=source.match(/function upload\(options,kind='image'\)\{[\s\S]*?\n\}/)?.[0];assert.ok(fn);
 const form={images:[],video_url:''},mediaUploading={value:0},errors=[];const calls=[];
 const upload=new Function('form','mediaUploading','currentApiCacheScope','uploadListingMedia','ElMessage','emit',`let mediaQueue=Promise.resolve();${fn};return upload;`)(form,mediaUploading,()=>1,async file=>{calls.push(file.name);await Promise.resolve();return {mediaType:file.name.endsWith('.mp4')?'video':'image',publishUrl:`https://media.example.test/${file.name}`};},{error:m=>errors.push(m)},()=>{});
 return {form,mediaUploading,errors,calls,upload,...overrides};
}
test('WB media upload queue preserves all images when selecting multiple files',async()=>{
 const c=uploaderContext();await Promise.all(['a.png','b.png','c.png'].map(name=>c.upload({file:{name,size:100},onSuccess:()=>{}})));
 assert.deepEqual(c.calls,['a.png','b.png','c.png']);assert.deepEqual(c.form.images,c.calls.map(n=>'https://media.example.test/'+n));assert.equal(c.mediaUploading.value,0);assert.deepEqual(c.errors,[]);
});
test('WB video upload stores a separate preview URL and refuses oversize files',async()=>{
 const c=uploaderContext();await c.upload({file:{name:'product.mp4',size:100}},'video');assert.equal(c.form.video_url,'https://media.example.test/product.mp4');assert.deepEqual(c.form.images,[]);
 await c.upload({file:{name:'oversize.mp4',size:51*1024*1024}},'video');assert.equal(c.errors.length,1);assert.equal(c.calls.length,1);assert.equal(c.mediaUploading.value,0);
});

test('WB first-image video reuses generation service and retains per-variant source image',async()=>{
 const source=readFileSync(new URL('../frontend/admin/components/listing/WbListingVariantEditor.vue',import.meta.url),'utf8');
 const fn=source.match(/async function generateVideo\(\)\{[\s\S]*?\n\}/)?.[0];assert.ok(fn);
 const form={images:['https://media.example.test/current.jpg'],card:{vendorCode:'ROW-A',title:'Title'}},calls=[],events=[];
 const generate=new Function('form','run','emit','currentApiCacheScope','generateAiVideo','ElMessage',`${fn};return generateVideo;`)(form,async work=>work(1),(...args)=>events.push(args),()=>1,async(...args)=>{calls.push(args);return {video:{publishUrl:'https://media.example.test/current.mp4'}};},{warning:()=>{},success:()=>{}});
 await generate();assert.equal(calls[0][0].imageUrl,form.images[0]);assert.equal(calls[0][1].listingVariantMedia,true);assert.equal(form.video_url,'https://media.example.test/current.mp4');assert.equal(form.video_source_image,form.images[0]);assert.deepEqual(events,[['upload-state',1],['upload-state',0]]);
 form.images=[];await generate();assert.equal(calls.length,1);
});
