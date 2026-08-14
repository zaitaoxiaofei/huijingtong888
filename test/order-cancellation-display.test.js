import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cancellationDisplay,
  translateCancellationInitiator,
  translateCancellationReason
} from "../src/services/order-cancellation-display.js";

const backendSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const ordersPageSource = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const ordersTableSource = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");

test("historical Russian cancellation reasons are translated to Chinese", () => {
  assert.equal(translateCancellationReason({ cancel_reason: "Покупатель отменил заказ" }).label, "买家主动取消订单");
  assert.equal(translateCancellationReason({ cancel_reason: "Клиент не забрал заказ" }).label, "买家未领取");
  assert.equal(translateCancellationReason({ cancel_reason: "Товар не подошел" }).label, "商品不合适");
  assert.equal(translateCancellationReason({ cancel_reason: "Товар поврежден при доставке" }).label, "商品在运输中损坏");
  assert.equal(translateCancellationReason({ cancel_reason_id: 992 }).label, "平台核验商品描述");
});

test("unknown cancellation reasons preserve the original text", () => {
  const result = translateCancellationReason({ cancel_reason: "Новая неизвестная причина" });
  assert.equal(result.translated, false);
  assert.equal(result.original, "Новая неизвестная причина");
  assert.equal(result.label, "未收录原因：Новая неизвестная причина");
});

test("initiators and loss formulas use operator-facing Chinese", () => {
  assert.equal(translateCancellationInitiator("Покупатель"), "买家");
  const result = cancellationDisplay(
    { cancel_reason: "Товар не подошел", cancel_initiator: "Покупатель" },
    { code: "purchase_collecting_international" }
  );
  assert.equal(result.reason_label, "商品不合适");
  assert.equal(result.initiator_label, "买家");
  assert.equal(result.loss_profile_label, "商品成本＋国内运费＋国际运费＋收单费");
  assert.match(result.loss_formula_text, /商品成本 \+ 国内运费 \+ 国际运费 \+ 收单费/);
});

test("order list and profit exception reuse the translated cancellation display", () => {
  assert.match(backendSource, /cancel_reason_label: cancellation\.reason_label/);
  assert.match(backendSource, /cancel_reason_original: cancellation\.reason_original/);
  assert.match(backendSource, /aftersale_bucket_label: AFTERSALE_BUCKET_LABELS_MYSQL/);
  assert.match(ordersPageSource, /row\?\.cancel_reason_label \|\| "取消原因待同步"/);
  assert.match(ordersPageSource, /损失口径：\$\{row\.loss_profile_label\}/);
  assert.match(ordersTableSource, /label="归类 \/ 具体原因"/);
  assert.match(ordersTableSource, /具体原因：\{\{ row\.cancelReasonText \}\}/);
  assert.match(ordersTableSource, /row\.cancelReasonMeta/);
  assert.match(ordersPageSource, /各项成本损失/);
  assert.match(ordersPageSource, /最终总损失/);
});
