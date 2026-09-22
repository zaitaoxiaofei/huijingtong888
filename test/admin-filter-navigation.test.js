import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../frontend/admin/main.js',import.meta.url),'utf8');
test('filter URL updates keep current requests alive; leaving the page cancels them',()=>{
 let guard;const events=[];const intended=[];
 const context=vm.createContext({router:{beforeEach:fn=>{guard=fn;}},window:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},rememberIntendedRoute:path=>intended.push(path)});
 vm.runInContext(source.slice(source.indexOf('router.beforeEach('),source.indexOf('router.afterEach(')),context);
 const from={path:'/inventory/products',fullPath:'/inventory/products'};
 const filtered={path:from.path,fullPath:from.path+'?inventoryCategory=钥匙壳&vehicleBrand=TENET',meta:{}};
 assert.equal(guard(filtered,from),true);assert.equal(events.length,0);
 assert.equal(intended.at(-1),filtered.fullPath);
 guard({path:'/orders',fullPath:'/orders',meta:{}},filtered);
 assert.equal(events.length,1);assert.equal(events[0].type,'admin:route-changing');
});
