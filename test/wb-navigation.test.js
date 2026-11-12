import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRouter, createMemoryHistory } from 'vue-router';
import { WB_REMOTE_WRITES_ENABLED, WB_REMOTE_WRITE_ACTIONS } from '../src/shared/wb-capabilities.js';

test('WB routes resolve under the existing desktop layout, while Ozon routes retain their names',()=>{
  const source=readFileSync(new URL('../frontend/admin/router/index.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export const ','var ').replaceAll('export function ','function ');
  const AdminLayout={name:'AdminLayout'},MobileLayout={name:'MobileLayout'};
  const context=vm.createContext({createRouter,createWebHashHistory:createMemoryHistory,AdminLayout,MobileLayout,LoginView:{name:'LoginView'}});
  vm.runInContext(source,context);
  for(const [path,name]of [['/wb/online-products','wb-online-products'],['/wb/listing','wb-listing'],['/orders','orders'],['/online-products','online-products'],['/ozon-actions','ozon-actions']]){
    const route=context.router.resolve(path);assert.equal(route.name,name);assert.equal(route.matched[0].components.default,AdminLayout);
  }
  assert.ok(!context.router.getRoutes().some(route=>route.path.includes('marketplace-demo')||route.path.startsWith('/mobile/wb/')));
});
test('first acceptance stage prevents external WB business writes and inventory binding',()=>{
  assert.equal(WB_REMOTE_WRITES_ENABLED,false);
  for(const action of ['publish','setPrice','setStocks','prepare','stickers','supplyAction','enrollPromotion','bindProduct'])assert.ok(WB_REMOTE_WRITE_ACTIONS.has(action));
});
