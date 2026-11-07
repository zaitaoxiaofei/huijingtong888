import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {orderPrintPlan,orderSelectionSummary} from "../frontend/orders/utils/order-print-selection.js";

const pageSource = fs.readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../frontend/orders/services/orders-service.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/server/routes/orders.js", import.meta.url), "utf8");
const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("order labels use the browser print confirmation flow without a bound printer dialog", () => {
  assert.doesNotMatch(pageSource, /面单打印设置|预览 PDF|Gprinter GP-1324D|Canon MG2500 series Printer/);
  assert.match(pageSource, /const result = await previewOrderLabels\(ids,options\)/);
  assert.match(serviceSource, /id="printNow" class="primary"/);
  assert.match(serviceSource, /package-label-printed/);
  assert.match(serviceSource, /record\?\.ok !== true \|\| !record\?\.print_batch_id/);
  assert.match(serviceSource, /contentWindow\?\.print\(\)/);
  assert.match(serviceSource, /id="printCompleted"/);
  assert.match(serviceSource, /id="printFailed"/);
});

test("only an explicit failed result removes the current operator print batch", () => {
  assert.match(serviceSource, /package-label-print-failed/);
  assert.match(serviceSource, /print_batch_id: printBatchId/);
  assert.match(routeSource, /services\.removeFailedOrderLabelPrintBatch/);
  const rollback = mysqlSource.slice(mysqlSource.indexOf("export async function removeFailedOrderLabelPrintBatchMysql("), mysqlSource.indexOf("function sortRowsByInputMysql("));
  assert.match(rollback, /DELETE printed FROM order_label_prints printed JOIN orders o ON o\.id = printed\.order_id JOIN shops s ON s\.id = o\.shop_id/);
  assert.match(rollback, /printed\.print_batch_id = \? AND printed\.printed_by_person_id = \? AND \$\{orderTenantPredicateMysql\("s", scope\)\}/);
  assert.match(rollback, /printed\.print_batch_id = \? AND printed\.printed_by_person_id IS NULL AND \$\{orderTenantPredicateMysql\("s", scope\)\}/);
});

test("bulk printing directly includes printed selections across pages and retains selections",async()=>{
 const handlers=pageSource.slice(pageSource.indexOf("function selectedActionOrderIds("),pageSource.indexOf("function handleToolbarMoreAction("));
 const tableRows={value:[{id:3,availableActions:{print:true}},{id:4,availableActions:{print:true},printed_at:'2026-11-01 01:00:00'},{id:5,availableActions:{print:false}}]};
 const selectedRows={value:[{id:1,availableActions:{print:true}},{id:2,availableActions:{print:true},printed_at:'yesterday'}]},selectedOrderIds={value:new Set([1,2,3,4,5])};
 const labelPrintBusy={value:false},calls=[],warnings=[],loads=[];let result={},scope='a',reply;
 const run=vm.runInNewContext(`${handlers};({bulkPrintSelected,bulkPrintPage})`,{tableRows,selectedRows,selectedOrderIds,labelPrintBusy,orderPrintPlan,currentApiCacheScope:()=>scope,
 orderDetailCache:new Map(),loadOrders:async()=>loads.push(true),ElMessage:{warning:m=>warnings.push(m),error:m=>warnings.push(m),success(){}},previewOrderLabels:async ids=>{calls.push(Array.from(ids));return reply?await reply:result;}});
 result={printed:true,printed_ids:[1,2,3,4]};await run.bulkPrintSelected();assert.deepEqual(calls[0],[1,2,3,4],'Both printed and unprinted rows go directly to the label page');
 assert.deepEqual([...selectedOrderIds.value],[1,2,3,4,5]);assert.match(warnings.at(-1),/1 单暂不可打印/);
 result={printed:false,failed:true};await run.bulkPrintSelected();assert.deepEqual([...selectedOrderIds.value],[1,2,3,4,5]);
 await run.bulkPrintPage();assert.deepEqual(calls.at(-1),[3,4],'Print page does not include off-page selections');
 labelPrintBusy.value=true;const count=calls.length;await run.bulkPrintSelected();assert.equal(calls.length,count);labelPrintBusy.value=false;
 let resolve;reply=new Promise(r=>resolve=r);const pending=run.bulkPrintSelected();const loaded=loads.length;scope='b';selectedOrderIds.value=new Set([99]);resolve({printed:true});await pending;assert.equal(loads.length,loaded);assert.deepEqual([...selectedOrderIds.value],[99],'A late print cannot alter a new enterprise selection');reply=null;
 selectedOrderIds.value.clear();await run.bulkPrintSelected();assert.match(warnings.at(-1),/请选择/);
 tableRows.value=Array.from({length:81},(_,i)=>({id:i+1,availableActions:{print:true}}));await run.bulkPrintPage();assert.match(warnings.at(-1),/80/);
 assert.doesNotMatch(pageSource,/允许重复打印|确认本次打印范围|order-print-review/);
});
test("print planning excludes unavailable rows and includes historical prints without opt-in",()=>{
 assert.deepEqual(orderPrintPlan([{id:1},{id:2,availableActions:{print:true},printed_at:'now'}],[1,2]).ids,[2]);
 assert.deepEqual(orderSelectionSummary(new Set(),[]),{total:0,current:0,other:0});
});

test("single-label click bypasses bulk review for both first printing and reprinting",async()=>{
 const handler=pageSource.match(/async function handlePrintOrder\([^]*?\n}/)[0];
 const tableRows={value:[{id:1,availableActions:{print:true}},{id:2,printed_at:'now',availableActions:{print:true}},{id:3,availableActions:{print:false}}]},calls=[],warnings=[];
 const run=vm.runInNewContext(`${handler};handlePrintOrder`,{tableRows,currentApiCacheScope:()=>"A",executeLabelPrint:async(ids,scope,options)=>calls.push([Array.from(ids),scope,options.autoPrint]),ElMessage:{warning:m=>warnings.push(m)}});
 await run(1);await run(2);assert.deepEqual(calls,[[[1],"A",true],[[2],"A",true]]);
 await run(3);await run(99);assert.equal(calls.length,2);assert.equal(warnings.length,2);
});

test("single auto-print waits for label load, records once and skips application result confirmation",async()=>{
 const source=serviceSource.slice(serviceSource.indexOf('function waitForPrintConfirmation('),serviceSource.indexOf('function failedLabelsFromHeader('));
 const calls=[],elements=new Map(),handlers=new Map();
 for(const id of ['printNow','closePage','printResultMask','printCompleted','printFailed','closeResult','labelFrame']){
  elements.set(id,{disabled:false,addEventListener(name,fn){handlers.set(id+':'+name,fn);},click(){return handlers.get(id+':click')?.();},classList:{add(name){calls.push('show:'+name);},remove(){}}});
 }
 const frame=elements.get('labelFrame');frame.contentWindow={focus(){},print(){calls.push('native-print');}};
 Object.defineProperty(frame,'src',{set(value){calls.push('loaded:'+value);handlers.get('labelFrame:load')();}});
 const popup={closed:false,document:{getElementById:id=>elements.get(id)},alert:m=>{throw Error(m);}};
 const run=vm.runInNewContext(`${source};waitForPrintConfirmation`,{writePrintPreviewPageSafe(){},window:{setInterval:()=>1,clearInterval(){}},apiClient:{post:async(path,body)=>{calls.push('record:'+body.order_ids.join(','));return{ok:true,print_batch_id:'one'};}}});
 const result=await run(popup,{url:'blob:single-label',orderIds:[7],autoPrint:true});
 assert.deepEqual(calls,['loaded:blob:single-label','record:7','native-print']);assert.equal(result.printed,true);assert.equal(result.failed,false);
 calls.length=0;const bulk=run(popup,{url:'blob:bulk-labels',orderIds:[7,8]});assert.deepEqual(calls,[],'Bulk preview still requires an explicit print click');
 await elements.get('printNow').click();assert.deepEqual(calls,['record:7,8','native-print','show:visible']);elements.get('printCompleted').click();assert.equal((await bulk).printed,true);
});
