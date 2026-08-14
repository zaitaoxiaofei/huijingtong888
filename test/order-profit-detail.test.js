import assert from "node:assert/strict";
import test from "node:test";

import { buildOrderProfitDetailSnapshotPayload } from "../src/services/order-profit-detail-snapshots.js";
import { buildOrderProfitDetail } from "../frontend/orders/utils/order-profit-detail.js";

const order = {
  id: 1001,
  shop_id: 5,
  posting_number: "55643945-0158-1",
  status: "delivered",
  tracking_stage: "posting_received"
};

const items = [{
  id: 6678,
  quantity: 1,
  sale_price: 28,
  sale_amount_cny: 25.88,
  purchase_cost_cny: 2,
  domestic_shipping_cny: 0,
  international_shipping_cny: 5.1,
  packaging_cost_cny: 0.5,
  commission_fee_cny: 3.11,
  ozon_service_fee_cny: 0,
  return_loss_cny: 0,
  advertising_cost_cny: 0,
  other_fee_cny: 0.48,
  estimated_profit: 12.42,
  actual_profit: 14.69,
  net_profit_cny: 14.69,
  profit_status: "accrued",
  settlement_state: "accrued",
  lock_reason: "finance_accrued"
}];

const finance = [
  {
    service_type: "sale_commission",
    service_name: "Ozon sale commission",
    amount_cny: -3.11,
    fee_amount_cny: 3.11,
    accruals_for_sale_cny: 25.88
  },
  {
    service_type: "delivery_charge",
    service_name: "Ozon delivery charge",
    amount_cny: -5.1,
    fee_amount_cny: 5.1
  },
  {
    service_type: "return_delivery_charge",
    service_name: "Partial compensation to customer",
    amount_cny: -10.16,
    fee_amount_cny: 10.16
  },
  {
    service_type: "service_0_MarketplaceRedistributionOfAcquiringOperation",
    service_name: "MarketplaceRedistributionOfAcquiringOperation",
    amount_cny: 0,
    fee_amount_cny: 0.48
  }
];

function rowByKey(detail, key) {
  return detail.rows.find((row) => row.key === key);
}

test("snapshot detail includes all settled Ozon finance costs in actual profit", () => {
  const detail = buildOrderProfitDetailSnapshotPayload(order, items, finance);

  assert.equal(detail.actual_profit_ready, 1);
  assert.equal(detail.actual_profit_cny, 4.53);
  assert.equal(detail.actual_cost_total_cny, 21.35);
  assert.equal(rowByKey({ rows: detail.detailRows }, "commission").actual, 3.11);
  assert.equal(rowByKey({ rows: detail.detailRows }, "collecting").actual, 0.48);
  assert.equal(rowByKey({ rows: detail.detailRows }, "other").actual, 0);
  assert.equal(rowByKey({ rows: detail.detailRows }, "aftersale").actual, 10.16);
  assert.equal(rowByKey({ rows: detail.detailRows }, "profit").actual, 4.53);
});

test("frontend detail includes all settled Ozon finance costs in actual profit", () => {
  const detail = buildOrderProfitDetail(order, items, finance);

  assert.equal(detail.summary.actualProfitReady, true);
  assert.equal(detail.summary.actualProfit, 4.53);
  assert.equal(detail.summary.actualCostTotal, 21.35);
  assert.equal(rowByKey(detail, "commission").actual, 3.11);
  assert.equal(rowByKey(detail, "collecting").actual, 0.48);
  assert.equal(rowByKey(detail, "other").actual, 0);
  assert.equal(rowByKey(detail, "aftersale").actual, 10.16);
  assert.equal(rowByKey(detail, "profit").actual, 4.53);
});

test("settled acquiring fee is not deducted again as an order item other fee", () => {
  const settledItems = [{
    ...items[0],
    sale_amount_cny: 69.17,
    purchase_cost_cny: 22,
    international_shipping_cny: 9.03,
    packaging_cost_cny: 1,
    commission_fee_cny: 7.61,
    ozon_service_fee_cny: 1.04,
    other_fee_cny: 1.28,
    net_profit_cny: 27.21,
    actual_profit: 0,
    settlement_state: "pending"
  }];
  const settledFinance = [
    {
      service_type: "sale_commission",
      amount_cny: -7.61,
      accruals_for_sale_cny: 69.17
    },
    {
      service_type: "delivery_charge",
      amount_cny: -9.03
    },
    {
      service_type: "service_0_ItemAgentServiceStarsMembership",
      amount_cny: -1.04
    },
    {
      service_type: "service_0_MarketplaceRedistributionOfAcquiringOperation",
      service_name: "MarketplaceRedistributionOfAcquiringOperation",
      amount_cny: -1.28
    }
  ];

  const snapshot = buildOrderProfitDetailSnapshotPayload(order, settledItems, settledFinance);
  const frontend = buildOrderProfitDetail(order, settledItems, settledFinance);

  assert.equal(snapshot.actual_profit_cny, 27.21);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "collecting").actual, 1.28);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "other").actual, 0);
  assert.equal(frontend.summary.actualProfit, 27.21);
  assert.equal(rowByKey(frontend, "collecting").actual, 1.28);
  assert.equal(rowByKey(frontend, "other").actual, 0);
});

test("Ozon transport operation types stay in international shipping when localized names are absent", () => {
  const financeWithoutLocalizedNames = [
    {
      service_type: "sale_commission",
      operation_type: "OperationAgentDeliveredToCustomer",
      amount_cny: -7.62,
      accruals_for_sale_cny: 69.26
    },
    {
      service_type: "operation_total",
      operation_type: "MarketplaceRedistributionOfDeliveryServicesOperation",
      amount_cny: -7.59
    },
    {
      service_type: "operation_total",
      operation_type: "OperationMarketplaceAgencyFeeAggregator3PLGlobal",
      amount_cny: -1.39
    },
    {
      service_type: "service_0_MarketplaceServiceItemRedistributionLastMilePVZ",
      operation_type: "OperationAgentDeliveredToCustomer",
      amount_cny: -2.84
    },
    {
      service_type: "service_0_ItemAgentServiceStarsMembership",
      operation_type: "StarsMembership",
      amount_cny: -1.04
    }
  ];
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, items, financeWithoutLocalizedNames);
  const frontend = buildOrderProfitDetail(order, items, financeWithoutLocalizedNames);

  assert.equal(rowByKey({ rows: snapshot.detailRows }, "international").actual, 11.82);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "service").actual, 1.04);
  assert.equal(rowByKey(frontend, "international").actual, 11.82);
  assert.equal(rowByKey(frontend, "service").actual, 1.04);
});

test("order detail popup uses backend detailRows instead of stale frontend fee grouping", () => {
  const backendSnapshot = buildOrderProfitDetailSnapshotPayload(order, items, [
    {
      service_type: "sale_commission",
      amount_cny: -6.4,
      accruals_for_sale_cny: 58.22
    },
    {
      operation_type: "MarketplaceRedistributionOfDeliveryServicesOperation",
      amount_cny: -9.45
    },
    {
      operation_type: "OperationMarketplaceAgencyFeeAggregator3PLGlobal",
      amount_cny: -1.33
    },
    {
      service_type: "service_0_ItemAgentServiceStarsMembership",
      amount_cny: -0.87
    }
  ]);
  const stalePopupFinance = [
    {
      service_type: "operation_total",
      service_name: "unclassified",
      amount_cny: -11.65
    }
  ];

  const popup = buildOrderProfitDetail(order, items, stalePopupFinance, backendSnapshot);

  assert.equal(popup.fromSnapshot, true);
  assert.equal(rowByKey(popup, "international").actual, 10.78);
  assert.equal(rowByKey(popup, "service").actual, 0.87);
});

test("settled zero local costs do not fall back to frozen estimates", () => {
  const zeroCostItems = [{
    ...items[0],
    purchase_cost_cny: 0,
    domestic_shipping_cny: 0,
    frozen_purchase_cost: 55,
    frozen_domestic_shipping: 12
  }];
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, zeroCostItems, finance);
  const frontend = buildOrderProfitDetail(order, zeroCostItems, finance);

  assert.equal(rowByKey({ rows: snapshot.detailRows }, "purchase").actual, 0);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "domestic").actual, 0);
  assert.equal(rowByKey(frontend, "purchase").actual, 0);
  assert.equal(rowByKey(frontend, "domestic").actual, 0);
});

test("positive Ozon reversals offset earlier fees in the same category", () => {
  const reversedFinance = [
    ...finance,
    {
      service_type: "sale_commission",
      operation_type: "ClientReturnAgentOperation",
      amount_cny: 3.11,
      accruals_for_sale_cny: -25.88
    },
    {
      service_type: "service_0_MarketplaceRedistributionOfAcquiringOperation",
      service_name: "MarketplaceRedistributionOfAcquiringOperation",
      amount_cny: 0.48
    }
  ];
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, items, reversedFinance);
  const frontend = buildOrderProfitDetail(order, items, reversedFinance);

  assert.equal(rowByKey({ rows: snapshot.detailRows }, "commission").actual, 0);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "collecting").actual, 0);
  assert.equal(rowByKey(frontend, "commission").actual, 0);
  assert.equal(rowByKey(frontend, "collecting").actual, 0);
});

test("partial finance rows never become settled profit", () => {
  const partialFinance = finance.filter((row) => row.service_type !== "sale_commission");
  const snapshot = buildOrderProfitDetailSnapshotPayload(order, items, partialFinance);
  const frontend = buildOrderProfitDetail(order, items, partialFinance);

  assert.equal(snapshot.actual_profit_ready, 0);
  assert.equal(snapshot.actual_profit_cny, null);
  assert.equal(frontend.summary.actualProfitReady, false);
  assert.equal(frontend.summary.actualProfit, null);
});

test("cancelled order detail does not use original sale as revenue", () => {
  const cancelledOrder = {
    ...order,
    status: "cancelled",
    tracking_stage: "posting_canceled",
    outcome_type: "cancelled_pre_fulfillment",
    loss_profile_code: "none"
  };
  const cancelledItems = [{
    ...items[0],
    sale_price: 24,
    sale_amount_cny: 24,
    frozen_purchase_cost: 2.88,
    purchase_cost_cny: 2.88,
    frozen_international_shipping: 4.21,
    international_shipping_cny: 0,
    estimated_commission: 4.08,
    commission_fee_cny: 0,
    aftersale_loss: 12.51,
    return_loss_cny: 0,
    other_fee_cny: 0.45,
    estimated_profit: -1.18,
    actual_profit: -2.88,
    net_profit_cny: -2.88
  }];

  const snapshot = buildOrderProfitDetailSnapshotPayload(cancelledOrder, cancelledItems, []);
  const frontend = buildOrderProfitDetail(cancelledOrder, cancelledItems, []);

  assert.equal(snapshot.sale_amount_cny, 0);
  assert.equal(snapshot.actual_profit_cny, -0.45);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "purchase").actual, 0);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "international").actual, 0);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "collecting").actual, 0.45);
  assert.equal(frontend.summary.saleAmount, 0);
  assert.equal(frontend.summary.actualProfit, -0.45);
});

test("returned order detail uses frozen freight when profit fact was zeroed", () => {
  const returnedOrder = {
    ...order,
    status: "cancelled",
    tracking_stage: "posting_returned",
    outcome_type: "rejected_unclaimed",
    loss_profile_code: "purchase_collecting"
  };
  const returnedItems = [{
    ...items[0],
    sale_price: 24,
    sale_amount_cny: 24,
    frozen_purchase_cost: 4,
    purchase_cost_cny: 4,
    frozen_international_shipping: 4.21,
    international_shipping_cny: 0,
    return_loss_cny: 0,
    other_fee_cny: 0,
    profit_status: "estimated",
    settlement_state: "pending",
    lock_reason: ""
  }];

  const snapshot = buildOrderProfitDetailSnapshotPayload(returnedOrder, returnedItems, []);
  const frontend = buildOrderProfitDetail(returnedOrder, returnedItems, []);

  assert.equal(snapshot.sale_amount_cny, 0);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "international").actual, 4.21);
  assert.equal(rowByKey({ rows: snapshot.detailRows }, "profit").actual, -8.21);
  assert.equal(frontend.summary.saleAmount, 0);
  assert.equal(rowByKey(frontend, "international").actual, 4.21);
  assert.equal(frontend.summary.actualProfit, -8.21);
});

test("settled returned order preserves a legitimate zero actual freight", () => {
  const returnedOrder = {
    ...order,
    status: "cancelled",
    tracking_stage: "posting_returned",
    outcome_type: "rejected_unclaimed",
    loss_profile_code: "purchase_collecting"
  };
  const returnedItems = [{
    ...items[0],
    sale_amount_cny: 0,
    frozen_purchase_cost: 4,
    purchase_cost_cny: 4,
    frozen_international_shipping: 40,
    international_shipping_cny: 0,
    commission_fee_cny: 0,
    ozon_service_fee_cny: 0,
    return_loss_cny: 0,
    other_fee_cny: 0
  }];

  const snapshot = buildOrderProfitDetailSnapshotPayload(returnedOrder, returnedItems, []);
  const frontend = buildOrderProfitDetail(returnedOrder, returnedItems, []);

  assert.equal(rowByKey({ rows: snapshot.detailRows }, "international").actual, 0);
  assert.equal(snapshot.actual_profit_cny, -4);
  assert.equal(rowByKey(frontend, "international").actual, 0);
  assert.equal(frontend.summary.actualProfit, -4);
});
