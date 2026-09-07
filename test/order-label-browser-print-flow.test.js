import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../frontend/orders/services/orders-service.js", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/server/routes/orders.js", import.meta.url), "utf8");
const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("order labels use the browser print confirmation flow without a bound printer dialog", () => {
  assert.doesNotMatch(pageSource, /面单打印设置|预览 PDF|Gprinter GP-1324D|Canon MG2500 series Printer/);
  assert.match(pageSource, /const result = await previewOrderLabels\(ids\)/);
  assert.match(serviceSource, /id="printNow" class="primary"/);
  assert.match(serviceSource, /package-label-printed/);
  assert.match(serviceSource, /contentWindow\?\.print\(\)/);
  assert.match(serviceSource, /id="printCompleted"/);
  assert.match(serviceSource, /id="printFailed"/);
});

test("only an explicit failed result removes the current operator print batch", () => {
  assert.match(serviceSource, /package-label-print-failed/);
  assert.match(serviceSource, /print_batch_id: printBatchId/);
  assert.match(routeSource, /services\.removeFailedOrderLabelPrintBatch/);
  assert.match(mysqlSource, /DELETE FROM order_label_prints WHERE print_batch_id = \? AND printed_by_person_id = \?/);
  assert.match(mysqlSource, /DELETE FROM order_label_prints WHERE print_batch_id = \? AND printed_by_person_id IS NULL/);
});
