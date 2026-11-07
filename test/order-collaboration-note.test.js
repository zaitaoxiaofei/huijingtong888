import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const page=fs.readFileSync(new URL('../frontend/orders/OrdersPage.vue',import.meta.url),'utf8');
const composable=fs.readFileSync(new URL('../frontend/orders/composables/useOrdersPage.js',import.meta.url),'utf8');

test('shared collaboration note updates only its order and enterprise while preserving the existing mark type',()=>{
 const rows=[{id:1,mark_type:'quality',mark_note:'原备注'},{id:2,mark_type:'urgent',mark_note:'另一单'}],deleted=[];
 const c=vm.createContext({vm:{rows},currentApiCacheScope:()=> 'enterprise-A',orderDetailCache:{delete:id=>deleted.push(id)}});
 const start=page.indexOf('function handleOrderCollaborationNoteSaved(');vm.runInContext(page.slice(start,page.indexOf('async function handleOpenOrderProcurement(',start)),c);
 const send=detail=>c.handleOrderCollaborationNoteSaved({detail});
 send({scope:'enterprise-B',orderId:1,note:'其他企业'});assert.equal(c.vm.rows,rows);
 send({scope:'enterprise-A',orderId:1,note:'  门槛条去部分字体\n到货请核对  '});assert.equal(c.vm.rows[0].mark_note,'门槛条去部分字体\n到货请核对');assert.equal(c.vm.rows[0].mark_type,'quality');assert.equal(c.vm.rows[1],rows[1]);assert.deepEqual(deleted,[1]);
 send({scope:'enterprise-A',orderId:1,note:'',markType:''});assert.equal(c.vm.rows[0].mark_note,'');assert.equal(c.vm.rows[0].mark_type,'');
 send({scope:'enterprise-A',orderId:1,note:'更新',markType:null});assert.equal(c.vm.rows[0].mark_type,'');
 const before=c.vm.rows;send({scope:'enterprise-A',orderId:0,note:'无效'});send({scope:'enterprise-A',orderId:1,note:null});assert.equal(c.vm.rows,before);
 assert.ok(page.includes("window.removeEventListener('erp:order-collaboration-note-saved', handleOrderCollaborationNoteSaved)"));
});

test('shared note invalidates the current enterprise page caches without requesting each order again',()=>{
 const list=new Map([['page1',{}]]),meta=new Map([['counts',{}]]);
 const aborted=[],loading={value:true},token={value:7};
 const c=vm.createContext({currentApiCacheScope:()=> 'enterprise-A',ordersListCache:list,ordersMetaCache:meta,window:{clearTimeout(){}},ordersMetaTimer:0,ordersListAbort:{value:{abort:()=>aborted.push('list')}},ordersInventoryAbort:{value:{abort:()=>aborted.push('inventory')}},ordersMetaAbort:{value:{abort:()=>aborted.push('meta')}},ordersLoadToken:token,ordersMetaRequestKey:{value:'old'},loading,vm:{rows:[]},inventoryRefreshFailed:{value:false},inventoryRefreshNotice:{value:''}});
 const start=composable.indexOf('const handleCollaborationNoteSaved =');vm.runInContext(composable.slice(start,composable.indexOf('window.addEventListener("erp:auth-scope-changed"',start))+'globalThis.handler=handleCollaborationNoteSaved;',c);
 c.handler({detail:{scope:'enterprise-B'}});assert.equal(list.size,1);assert.equal(meta.size,1);assert.deepEqual(aborted,[]);
 c.handler({detail:{scope:'enterprise-A'}});assert.equal(list.size,0);assert.equal(meta.size,0);assert.deepEqual(aborted,['list','inventory','meta']);assert.equal(token.value,8);assert.equal(loading.value,false);
 c.vm.rows=[{id:1,inventory_refresh_pending:true}];c.handler({detail:{scope:'enterprise-A'}});assert.equal(c.vm.rows[0].inventory_refresh_pending,true);assert.equal(c.inventoryRefreshFailed.value,true);assert.match(c.inventoryRefreshNotice.value,/重试库存刷新/);
 assert.ok(composable.includes('window.removeEventListener("erp:order-collaboration-note-saved", handleCollaborationNoteSaved)'));
});
