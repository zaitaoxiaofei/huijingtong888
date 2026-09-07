import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/procurement-reconciliation.js", import.meta.url), "utf8");
const parser = fs.readFileSync(new URL("../frontend/admin/utils/procurement-file-parsers.js", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../frontend/admin/views/procurement/ProcurementReconciliationView.vue", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");

test("real procurement exports have dedicated parsers", () => {
  assert.match(parser, /parse1688File/);
  assert.match(parser, /货品标题/);
  assert.match(parser, /parseWechatFile/);
  assert.match(parser, /parseAlipayFile/);
  assert.match(parser, /gb18030/);
  assert.match(parser, /getUTCFullYear/);
});

test("reconciliation supports automatic, reviewed and manual payment matching", () => {
  assert.match(service, /autoMatchProcurementPayments/);
  assert.match(service, /match_status='confirmed'/);
  assert.match(service, /setProcurementPaymentMatch/);
  assert.match(routes, /reconciliation\/auto-match/);
  assert.match(routes, /payment-candidates/);
  assert.match(page, /查找流水/);
  assert.match(page, /应用实际成本/);
});

test("confirmed actual payment can flow to procurement and bound inventory cost", () => {
  assert.match(service, /UPDATE procurement_requests SET amount=/);
  assert.match(service, /UPDATE products p JOIN procurement_requests/);
  assert.match(service, /platform_summary/);
});
