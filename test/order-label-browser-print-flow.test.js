import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

test("toolbar printing respects current-page order, printable eligibility, selection and the existing batch limit", async () => {
  const handlers = pageSource.slice(pageSource.indexOf("function selectedActionOrderIds("), pageSource.indexOf("function handleToolbarMoreAction("));
  const tableRows = { value: [{ id: 3, availableActions: { print: true } }, { id: 1, availableActions: { print: false } }, { id: 2, availableActions: { print: true } }] };
  const selectedOrderIds = { value: new Set([2, 99]) };
  const calls = [], warnings = [];
  const run = vm.runInNewContext(`${handlers};({bulkPrintSelected,bulkPrintPage})`, {
    tableRows, selectedOrderIds,
    ElMessage: { warning: message => warnings.push(message), error: message => { throw new Error(message); } },
    previewOrderLabels: async ids => { calls.push(Array.from(ids)); return {}; }
  });
  await run.bulkPrintSelected();
  assert.deepEqual(calls.pop(), [2]);
  await run.bulkPrintPage();
  assert.deepEqual(calls.pop(), [3, 2]);
  assert.deepEqual([...selectedOrderIds.value], [2, 99]);
  selectedOrderIds.value.clear();
  await run.bulkPrintSelected();
  assert.equal(calls.length, 0);
  await run.bulkPrintPage();
  assert.deepEqual(calls.pop(), [3, 2]);
  tableRows.value = [{ id: 1, availableActions: { print: false } }];
  await run.bulkPrintPage();
  assert.equal(calls.length, 0);
  tableRows.value = Array.from({ length: 81 }, (_, index) => ({ id: index + 1, availableActions: { print: true } }));
  await run.bulkPrintPage();
  assert.equal(calls.length, 0, "never truncate a page that exceeds the existing backend limit");
  assert.match(warnings.at(-1), /80/);
});
