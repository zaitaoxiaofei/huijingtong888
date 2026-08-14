import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOrderAccounting,
  estimateOutcomeReturnLoss,
  isQualityCheckOrder
} from "../src/services/order-outcome.js";

test("quality-check prefixes take precedence over ordinary aftersale buckets", () => {
  const row = {
    posting_number: "0213176013-0142-1",
    status: "cancelled",
    tracking_stage: "posting_canceled",
    logistics_status: "cancelled",
    cancel_reason: "buyer rejected"
  };

  const accounting = classifyOrderAccounting(row, { qualityPrefixes: ["02131"] });

  assert.equal(accounting.is_quality_order, true);
  assert.equal(accounting.order_nature, "quality_check");
  assert.equal(accounting.loss_profile_code, "none");
  assert.equal(accounting.aftersale_bucket, "platform_document_issue");
  assert.equal(accounting.should_include_aftersale_loss, false);
});

test("quality-check rules only match the configured full prefix", () => {
  const row = {
    posting_number: "0213176013-0142-1",
    status: "cancelled",
    cancel_reason: "buyer rejected"
  };

  assert.equal(isQualityCheckOrder(row, { qualityPrefixes: ["02131"] }), true);
  assert.equal(isQualityCheckOrder(row, { qualityPrefixes: ["02130"] }), false);
});

test("Ozon description inspection reasons are treated as platform checks", () => {
  const row = {
    posting_number: "0247850422-0046-1",
    status: "cancelled",
    tracking_stage: "posting_canceled",
    logistics_status: "cancelled",
    cancel_reason_id: 992,
    cancel_reason: "\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0442\u043e\u0432\u0430\u0440\u0430 \u043d\u0430 \u0441\u043e\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u044e \u0432 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435"
  };

  assert.equal(isQualityCheckOrder(row), true);

  const accounting = classifyOrderAccounting(row);
  assert.equal(accounting.order_nature, "quality_check");
  assert.equal(accounting.aftersale_bucket, "platform_document_issue");
  assert.equal(accounting.loss_profile_code, "none");
});

test("split-pending cancelled postings are counted as pre-fulfillment cancellations", () => {
  const row = {
    posting_number: "0100507635-0234-1",
    status: "cancelled_from_split_pending",
    tracking_stage: "posting_canceled",
    logistics_status: "cancelled_from_split_pending",
    cancel_reason: "\u041f\u043e\u043a\u0443\u043f\u0430\u0442\u0435\u043b\u044c \u043e\u0442\u043c\u0435\u043d\u0438\u043b \u0437\u0430\u043a\u0430\u0437"
  };

  const accounting = classifyOrderAccounting(row);

  assert.equal(accounting.order_nature, "normal_sale");
  assert.equal(accounting.outcome_type, "cancelled_pre_fulfillment");
  assert.equal(accounting.aftersale_bucket, "pre_fulfillment_cancel");
  assert.equal(accounting.loss_profile_code, "none");
  assert.equal(accounting.should_include_aftersale_loss, true);
});

test("ordinary quality issue remains in the quality issue bucket", () => {
  const row = {
    posting_number: "1234567890-0001-1",
    status: "returned",
    delivered_at: "2026-05-01T00:00:00.000Z",
    cancel_reason_id: "aftersale_quality_issue",
    cancel_reason: "quality issue"
  };

  const accounting = classifyOrderAccounting(row, { qualityPrefixes: ["0213"] });

  assert.equal(accounting.is_quality_order, false);
  assert.equal(accounting.order_nature, "normal_sale");
  assert.equal(accounting.aftersale_bucket, "quality_issue");
  assert.equal(accounting.loss_profile_code, "commission_purchase_collecting_international");
  assert.equal(accounting.should_include_aftersale_loss, true);
});

test("return loss estimates use reason-specific cost components", () => {
  const base = {
    outcome: "after_delivery_return",
    quantity: 1,
    purchaseCostPerUnit: 2,
    domesticShippingPerUnit: 1,
    internationalShippingPerUnit: 5,
    packagingCostTotal: 0.5,
    commissionFeeTotal: 3,
    collectingFeeTotal: 0.5,
    serviceFeeTotal: 4
  };

  assert.equal(estimateOutcomeReturnLoss({ ...base, lossProfileCode: "purchase_collecting" }), 7.5);
  assert.equal(estimateOutcomeReturnLoss({ ...base, lossProfileCode: "purchase_collecting_international" }), 8.5);
  assert.equal(estimateOutcomeReturnLoss({ ...base, lossProfileCode: "commission_purchase_collecting_international" }), 11.5);
  assert.equal(estimateOutcomeReturnLoss({ ...base, lossProfileCode: "none" }), 0);
});
