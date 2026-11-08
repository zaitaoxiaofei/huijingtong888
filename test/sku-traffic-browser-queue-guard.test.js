import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/services/seller-analytics.js','utf8');
const code=source.slice(source.indexOf('export async function queueSkuTrafficDaily('),source.indexOf('export async function queueAllSkuTrafficDaily(')).replace('export ','');
test('manual collection validates the requested browser against the selected owned shop before queue creation',async()=>{
 let queued=0,valid=false;
 const context=vm.createContext({skuTrafficDaily:{shops:async(_,shop)=>shop==='all'?[{store_id:'Z'},{store_id:'X'}]:[{store_id:'Z'}],queue:async()=>{queued++;return{};}},sellerAnalyticsDb:{},validatePluginStatus:async(_,query)=>{assert.equal(query.plugin_instance_id,'browser-Z');assert.equal(query.store_id,'Z');return {ok:valid,message:'本机不是目标店铺'};},createCollectRun(){},loadCollectRunState(){},publishSkuTrafficDailyRun(){}});
 vm.runInContext(code+';this.queue=queueSkuTrafficDaily;',context);
 await assert.rejects(context.queue({shop_id:'all',browser_instance_id:'browser-Z'},'admin'),/一家店铺/);
 await assert.rejects(context.queue({shop_id:7,browser_instance_id:'browser-Z'},'admin'),/本机不是/);assert.equal(queued,0);
 valid=true;await context.queue({shop_id:7,browser_instance_id:'browser-Z'},'admin');assert.equal(queued,1);
});
