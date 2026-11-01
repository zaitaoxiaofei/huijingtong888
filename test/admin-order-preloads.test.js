import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {adminOrderPreloadScript} from '../scripts/lib/admin-order-preloads.mjs';
const root='frontend/admin/';
const manifest={
 [root+'main.js']:{file:'assets/admin.js'},
 [root+'views/orders/OrdersView.vue']:{file:'assets/modes.js',imports:[root+'main.js','shared']},
 'frontend/orders/OrdersPage.vue':{file:'assets/print.js',imports:['shared'],dynamicImports:['detail']},
 [root+'components/inventory/InventorySupplyWorkspace.vue']:{file:'assets/inventory.js',imports:['shared']},
 shared:{file:'assets/shared.js',imports:['cycle']},cycle:{file:'assets/cycle.js',imports:['shared']},detail:{file:'assets/detail.js'}
};
function run(hash){const links=[];vm.runInNewContext(adminOrderPreloadScript(manifest),{location:{hash},URLSearchParams,document:{head:{appendChild:link=>links.push(link)},querySelector:()=>null,createElement:()=>({})}});return links.map(link=>link.href);}
test('preloads only order-mode static imports, once despite cycles, without executing modules',()=>{
 assert.deepEqual(run('#/orders'),['/vue-apps/assets/modes.js','/vue-apps/assets/shared.js','/vue-apps/assets/cycle.js','/vue-apps/assets/print.js']);
 assert.deepEqual(run('#/orders?mode=inventory').at(-1),'/vue-apps/assets/inventory.js');
 assert.deepEqual(run('#/finance'),[]);assert.deepEqual(run('#/orders-old'),[]);
 assert.ok(!run('#/orders').some(path=>/admin|detail|inventory/.test(path)));
});
test('missing optional entries and unsafe asset paths cannot break the shell',()=>{
 const source=adminOrderPreloadScript({[root+'views/orders/OrdersView.vue']:{file:'../x"</script>.js'}});
 assert.ok(!source.includes('</script>'));assert.doesNotThrow(()=>new vm.Script(source));
});
