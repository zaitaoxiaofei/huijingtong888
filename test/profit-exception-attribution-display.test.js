import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const backendSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/admin/views/exceptions/ExceptionWorkbenchView.vue", import.meta.url), "utf8");

test("profit exceptions expose the existing aftersales category before the translated reason", () => {
  assert.match(backendSource, /attribution_category_key: orderAccounting\.aftersale_bucket/);
  assert.match(backendSource, /attribution_category_label: AFTERSALE_BUCKET_LABELS_MYSQL/);
  assert.match(pageSource, /label="归类与具体原因"/);
  assert.match(pageSource, /一级归类：\{\{ profitDetailRow\.attribution_category_label/);
  assert.match(pageSource, /具体原因：\{\{ profitDetailRow\.cancel_reason_label/);
});

test("profit exception details expose cost components and final total loss", () => {
  assert.match(backendSource, /total_loss: roundMoneyMysql\(Math\.max\(0, -profitValue\)\)/);
  assert.match(backendSource, /loss_detail_rows: detailRows\.filter/);
  assert.match(pageSource, /各项成本损失/);
  assert.match(pageSource, /成本\/费用合计/);
  assert.match(pageSource, /最终总损失/);
});
