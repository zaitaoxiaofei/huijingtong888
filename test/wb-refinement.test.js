import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {wbNativePrice} from '../src/shared/wb-native-fields.js';import {wbLocalizedOptions,wbAttributeLabel} from '../src/shared/wb-display.js';import {wbListingValidation} from '../src/shared/wb-listing-validation.js';
test('WB native price multiplier does not manufacture a crossed-out field',()=>{assert.equal(wbNativePrice(200,1.5),300);assert.equal(wbNativePrice(200,2),400);assert.throws(()=>wbNativePrice(null),/大于零/);});
test('Chinese directory labels never replace Russian values and country IDs survive reordered translations',()=>{const colors=wbLocalizedOptions([{name:'черный'},{name:'красный'}],[{name:'黑色'},{name:'红色'}],'colors');assert.deepEqual(colors,[{value:'черный',label:'黑色'},{value:'красный',label:'红色'}]);const countries=wbLocalizedOptions([{id:1,name:'Китай'},{id:2,name:'Россия'}],[{id:2,name:'俄罗斯'},{id:1,name:'中国'}],'countries');assert.deepEqual(countries.map(o=>o.label),['中国','俄罗斯']);assert.equal(wbAttributeLabel({charcID:15000001,name:'FEACN'}),'海关编码（ТНВЭД）');assert.deepEqual(wbLocalizedOptions([{tnved:'3926909709',isKiz:true}],[{tnved:'3926909709'}],'tnved'),[{value:'3926909709',label:'3926909709（需强制标识）'}]);});
test('legacy ERP crossed-out fields do not block a native WB draft',()=>{const p={subject_id:3373,images:['https://example.test/main.jpg'],card:{vendorCode:'P',title:'Product',dimensions:{length:1,width:1,height:1,weightBrutto:.1},characteristics:[],sizes:[{techSize:'0',price:200,old_price:400,skus:['12345678']}]}};assert.equal(wbListingValidation(p,[]).ok,true);p.card.sizes[0].old_price=300;assert.equal(wbListingValidation(p,[]).ok,true);});
test('WB keeps the image dialog and native inline fields without invented price attributes',()=>{const s=readFileSync(new URL('../frontend/admin/components/listing/WbListingEditor.vue',import.meta.url),'utf8');assert.match(s,/<el-dialog v-if="active!==null"/);assert.match(s,/:mode="editorMode"/);assert.match(s,/v-for="attribute in attributes"/);assert.ok(!s.includes('common-section"><h3>共用属性'));assert.ok(!s.includes('wbApplyCommon('));assert.ok(!s.includes('old_price'));assert.ok(!s.includes("edit($index,'sizes')"));assert.ok(!s.includes("edit($index,'package')"));assert.match(s,/定价策略/);const child=readFileSync(new URL('../frontend/admin/components/listing/WbListingVariantEditor.vue',import.meta.url),'utf8');for(const mode of ['images','video','sizes','package'])assert.ok(child.includes(`'${mode}'`));});

test('WB cached product reads retain rows when a price snapshot is unavailable without extra price requests',async()=>{
 const s=readFileSync(new URL('../frontend/admin/views/inventory/WbOnlineProductsView.vue',import.meta.url),'utf8'),load=s.match(/async function load\(\)\{[^\n]+/)?.[0];assert.ok(load);
 const rows={value:[]},page={value:1},shopId={value:13},loading={value:false},notice={value:''},product={nm_id:42,title:'Product',price_info:null,price_error:'permission denied'},calls=[];
 const run=new Function('rows','page','shopId','loading','notice','currentApiCacheScope','selected','apiClient','ElMessage',`let productRequest=0;${load};return load;`)(rows,page,shopId,loading,notice,()=>1,()=>13,{get:async url=>{calls.push(url);return {rows:[product]};}},{error:assert.fail});
 await run();assert.deepEqual(rows.value,[product]);assert.equal(loading.value,false);assert.equal(calls.length,1);assert.match(calls[0],/\/products\?/);
});
test('WB sync refuses malformed successful API responses instead of claiming an empty catalogue',async()=>{
 const {createWbPlatform}=await import('../src/services/wb-platform.js');const writes=[];
 const service=createWbPlatform({query:async(sql)=>{if(/^INSERT|^UPDATE/.test(sql))writes.push(sql);return [{tenant_id:1,shop_id:13,token:'test-only',environment:'production',checked_at:'yes',seller_id:'seller'}];},request:async()=>({})});
 await assert.rejects(service.syncProducts(1,{shop_id:13}),e=>e.statusCode===502&&e.message.includes('未返回商品列表'));assert.deepEqual(writes,[]);
});

test('native price strategy preserves barcode identity and refuses missing base',()=>{
 const s=readFileSync(new URL('../frontend/admin/components/listing/WbListingEditor.vue',import.meta.url),'utf8'),fn=s.match(/function applyPricing\(\)\{[^\n]+/)?.[0];assert.ok(fn);
 const rows={value:[{card:{sizes:[{price:200,skus:['12345678']}]}}]},pricing={visible:true},pricePreview={value:[{rowIndex:0,sizeIndex:0,base_price:200,price:300}]},warnings=[];
 const apply=new Function('pricePreview','rows','pricing','ElMessage',`${fn};return applyPricing;`)(pricePreview,rows,pricing,{warning:m=>warnings.push(m)});apply();assert.equal(rows.value[0].card.sizes[0].price,300);assert.equal(rows.value[0].card.sizes[0].old_price,undefined);assert.deepEqual(rows.value[0].card.sizes[0].skus,['12345678']);assert.equal(pricing.visible,false);pricing.visible=true;pricePreview.value=[{error:'missing base'}];apply();assert.equal(pricing.visible,true);assert.equal(warnings.length,1);
});

test('unbound WB inventory is readable but cannot be allocated or changed',async()=>{
 const {createWbPlatform}=await import('../src/services/wb-platform.js'),remote=[];
 const service=createWbPlatform({query:async(sql)=>sql.includes('FROM wb_shop_credentials')?[{tenant_id:1,shop_id:13,token:'test-only',environment:'production',checked_at:'yes',seller_id:'seller',wb_warehouse_id:100}]:sql.includes('SELECT raw_json FROM wb_product_cards')?[{raw_json:{sizes:[{chrtID:200,skus:['12345678']}]}}]:[],request:async(a,service,path,options)=>{remote.push({path,method:options.method});return {stocks:[{sku:'12345678',amount:7}]};}});
 const input={shop_id:13,nm_id:100,chrt_id:200};const r=await service.stocks(1,input);assert.equal(r.stocks[0].amount,7);assert.equal(r.available,null);assert.match(r.availability_message,/尚未绑定/);await assert.rejects(service.setStocks(1,{...input,quantity:0}),/尚未绑定/);assert.deepEqual(remote,[{path:'/api/v3/stocks/100',method:'POST'}]);
});

test('an older WB product request cannot replace the currently selected shop',async()=>{
 const s=readFileSync(new URL('../frontend/admin/views/inventory/WbOnlineProductsView.vue',import.meta.url),'utf8'),fn=s.match(/async function load\(\)\{[^\n]+/)?.[0];assert.ok(fn);
 const rows={value:[]},page={value:1},shopId={value:13},loading={value:false},notice={value:''},pending=[];
 const load=new Function('rows','page','shopId','loading','notice','currentApiCacheScope','selected','apiClient','ElMessage',`let productRequest=0;${fn};return load;`)(rows,page,shopId,loading,notice,()=>1,()=>shopId.value,{get:()=>new Promise(resolve=>pending.push(resolve))},{error:assert.fail});
 const first=load();shopId.value=14;const second=load();pending[1]({rows:[{nm_id:200,shop_id:14}]});await second;pending[0]({rows:[{nm_id:100,shop_id:13}]});await first;
 assert.deepEqual(rows.value,[{nm_id:200,shop_id:14}]);assert.equal(loading.value,false);
});
