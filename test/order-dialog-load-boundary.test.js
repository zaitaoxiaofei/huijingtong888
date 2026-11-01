import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const path=new URL('../public/vue-apps/.vite/manifest.json',import.meta.url);
test('production order entry defers inventory editor, category and procurement dialog chunks until needed',{skip:!existsSync(path)&&'Requires production frontend build'},()=>{
 const manifest=JSON.parse(readFileSync(path,'utf8')),seen=new Set(['frontend/admin/main.js']),initial=[];
 function visit(key){if(seen.has(key))return;seen.add(key);const item=manifest[key];if(!item)return;initial.push(item.file);for(const child of item.imports||[])visit(child);}
 visit('frontend/admin/views/orders/OrdersView.vue');visit('frontend/orders/OrdersPage.vue');
 const names=['ProductCreateEditDialog','ProductCompositionDialog','ProcurementLedgerDialog','HistoricalPurchaseQuickDialog','OzonCategorySelect','InventoryStructuredSearch'];
 for(const name of names){assert.ok(!initial.some(file=>file?.includes(name)),name+' must not block initial rows');assert.ok(Object.values(manifest).some(item=>item.file?.includes(name)),name+' must remain available');}
 const lazy=manifest['frontend/orders/OrdersPage.vue'].dynamicImports||[];
 for(const name of names)assert.ok(lazy.some(key=>key.includes(name)),name+' must be explicitly reachable on demand');
});
