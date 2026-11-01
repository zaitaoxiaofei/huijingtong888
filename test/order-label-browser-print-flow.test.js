import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {orderPrintPlan,removePrintedSelection,orderSelectionSummary} from "../frontend/orders/utils/order-print-selection.js";

const pageSource = fs.readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../frontend/orders/services/orders-service.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/server/routes/orders.js", import.meta.url), "utf8");
const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("order labels use the browser print confirmation flow without a bound printer dialog", () => {
  assert.doesNotMatch(pageSource, /面单打印设置|预览 PDF|Gprinter GP-1324D|Canon MG2500 series Printer/);
  assert.match(pageSource, /const result = await previewOrderLabels\(ids\)/);
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

test("print review freezes cross-page selection, excludes printed orders and only removes successful IDs",async()=>{
 const handlers=pageSource.slice(pageSource.indexOf("function selectedActionOrderIds("),pageSource.indexOf("function handleToolbarMoreAction("));
 const tableRows={value:[{id:3,availableActions:{print:true}},{id:4,availableActions:{print:true},printed_at:'2026-11-01 01:00:00'},{id:5,availableActions:{print:false}}]};
 const selectedRows={value:[{id:1,availableActions:{print:true}},{id:2,availableActions:{print:true}}]},selectedOrderIds={value:new Set([1,2,3,4,5])};
 const printReview={busy:false},calls=[],warnings=[];let result={},scope='a';
 const run=vm.runInNewContext(`${handlers};({bulkPrintSelected,bulkPrintPage,confirmPrintReview})`,{tableRows,selectedRows,selectedOrderIds,printReview,currentApiCacheScope:()=>scope,
 printReviewPlan:{get value(){return orderPrintPlan(printReview.rows,printReview.pageIds,printReview.includePrinted);}},removePrintedSelection,
 orderDetailCache:new Map(),loadOrders:async()=>{},ElMessage:{warning:m=>warnings.push(m),error:m=>warnings.push(m),success(){}},previewOrderLabels:async ids=>{calls.push(Array.from(ids));return result;}});
 run.bulkPrintSelected();assert.equal(calls.length,0,'review precedes PDF generation');
 assert.deepEqual(orderSelectionSummary(selectedOrderIds.value,tableRows.value),{total:5,current:3,other:2});
 const plan=orderPrintPlan(printReview.rows,printReview.pageIds);assert.deepEqual(plan.ids,[1,2,3]);assert.equal(plan.other,2);assert.equal(plan.printed,1);assert.equal(plan.excluded,1);
 result={printed:false,failed:true};await run.confirmPrintReview();assert.deepEqual([...selectedOrderIds.value],[1,2,3,4,5]);
 result={printed:true,printed_ids:[1,3],failures:[{order_id:2}]};await run.confirmPrintReview();assert.deepEqual([...selectedOrderIds.value],[2,4,5]);
 run.bulkPrintPage();printReview.includePrinted=true;result={printed:true,printed_ids:[3,4]};await run.confirmPrintReview();assert.deepEqual(calls.at(-1),[3,4]);assert.deepEqual([...selectedOrderIds.value],[2,5]);
 run.bulkPrintSelected();scope='b';await run.confirmPrintReview();assert.equal(printReview.visible,false);assert.match(warnings.at(-1),/企业或登录/);
 scope='a';selectedOrderIds.value.clear();run.bulkPrintSelected();assert.match(warnings.at(-1),/请选择/);
 tableRows.value=Array.from({length:81},(_,i)=>({id:i+1,availableActions:{print:true}}));run.bulkPrintPage();assert.match(warnings.at(-1),/80/);
});
test("selection counts and print cleanup never drop failed, unconfirmed or newly selected orders",()=>{
 const ids=new Set([1,2,3,4]);assert.deepEqual([...removePrintedSelection(ids,{printed:false,printed_ids:[1]})],[1,2,3,4]);
 assert.deepEqual([...removePrintedSelection(ids,{printed:true,printed_ids:[1,2],failures:[{order_id:2}]})],[2,3,4]);
 assert.deepEqual([...removePrintedSelection(ids,{printed:true})],[1,2,3,4],'missing success IDs cannot clear the selection');
 assert.deepEqual(orderPrintPlan([{id:1},{id:2,availableActions:{print:true},printed_at:'now'}],[1,2]).ids,[]);
 assert.deepEqual(orderSelectionSummary(new Set(),[]),{total:0,current:0,other:0});
});
