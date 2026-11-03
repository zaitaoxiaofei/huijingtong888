import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {hasPermission} from '../src/shared/permissions.js';
const source=readFileSync(new URL('../frontend/admin/layouts/AdminLayout.vue',import.meta.url),'utf8').match(/async function approveInventoryRequestNotification\([^]*?\n}/)[0];
function fixture(role='manager'){
 let scope='a',rotateOnConfirm=false;const calls=[],events=[];
 const context=vm.createContext({hasPermission,authStore:{user:{role,tenant:{id:2,role:'member'}}},currentApiCacheScope:()=>scope,approvingInventoryRequest:{value:null},apiClient:{get:async()=>({id:7,applicant_id:1,status:'pending',revision:3,payload:{name:'测试库存'}}),put:async(...args)=>{calls.push(args);return {status:'approved'};}},ElMessageBox:{confirm:async()=>{if(rotateOnConfirm)scope='b';}},ElMessage:{success(){},info(){},warning(){},error(message){throw Error(message);}},window:{dispatchEvent:e=>events.push(e.type)},CustomEvent:class{constructor(type){this.type=type;}},loadNotifications:async()=>{}});
 vm.runInContext(source,context);return {context,calls,events,rotate:()=>rotateOnConfirm=true};
}
test('notification approval uses the current application revision and supports an authorized creator',async()=>{const f=fixture();await f.context.approveInventoryRequestNotification({id:1,entity_id:'7'});assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/api/inventory-product-requests/7');assert.equal(f.calls[0][1].revision,3);assert.equal(f.calls[0][1].action,'approve');assert.deepEqual(f.events,['erp:inventory-product-requests-changed']);});
test('ordinary operators and an enterprise switch during confirmation cannot approve from a notification',async()=>{const a=fixture('operations');await a.context.approveInventoryRequestNotification({id:1,entity_id:7});assert.equal(a.calls.length,0);const b=fixture();b.rotate();await b.context.approveInventoryRequestNotification({id:1,entity_id:7});assert.equal(b.calls.length,0);});
