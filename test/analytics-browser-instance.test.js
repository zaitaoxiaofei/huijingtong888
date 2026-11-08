import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const source=fs.readFileSync('pivot-table-master/background.js','utf8');
const code=source.slice(source.indexOf('let browserInstancePromise;'),source.indexOf('async function getErpConfig('));
function worker(storage){const context=vm.createContext({chrome:{runtime:{id:'sameExtension'},storage:{local:{get:async()=>storage,set:async data=>Object.assign(storage,data)}}},crypto:{randomUUID}});vm.runInContext(code+';this.id=getAnalyticsBrowserInstanceId;',context);return context.id;}
test('browser instance survives worker restarts, serializes concurrent initialization and differs across two computers with the same extension ID',async()=>{const first={},second={};const get=worker(first),ids=await Promise.all(Array.from({length:10},()=>get()));assert.equal(new Set(ids).size,1);assert.equal(await worker(first)(),ids[0]);assert.notEqual(await worker(second)(),ids[0]);assert.match(ids[0],/^sameExtension_[0-9a-f-]{36}$/);});

test('store discovery chooses the most recently used real Seller tab instead of a previously prepared store',()=>{const fn=source.slice(source.indexOf('function selectCurrentSellerTab('),source.indexOf('function selectSellerTab('));const context=vm.createContext({});vm.runInContext(fn+';this.select=selectCurrentSellerTab;',context);const selected=context.select([{id:1,url:'https://seller.ozon.ru/app/analytics',lastAccessed:1},{id:2,url:'https://seller.ozon.ru/app/products',lastAccessed:3},{id:3,url:'https://not-seller.test/',lastAccessed:99}]);assert.equal(selected.id,2);assert.equal(context.select([]),null);});
