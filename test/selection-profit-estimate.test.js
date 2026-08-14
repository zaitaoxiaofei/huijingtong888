import test from "node:test";
import assert from "node:assert/strict";
import { estimateItemProfit } from "../src/profit.js";
import {
  estimateSelectionProfit,
  solveSelectionSalePrice
} from "../frontend/admin/utils/selection-profit-estimate.js";

const product = {
  purchase_cost: 18,
  domestic_shipping: 6,
  purchase_quantity: 3,
  handling_fee: 0.5,
  package_weight_g: 420,
  exchange_rate: 11.32,
  shipping_method: "air_land",
  return_rate: 5,
  advertising_rate: 8,
  withdrawal_fee_rate: 0.012,
  desired_profit_mode: "margin",
  desired_profit_value: 20,
  commission_low: 0.12,
  commission_high: 0.17
};

const logisticsRule = {
  id: 7,
  name: "CEL Standard",
  carrier: "CEL",
  channel: "air_land",
  base_fee_cny: 3,
  per_gram_cny: 0.031,
  per_ticket_cny: 1.2
};

test("selection estimate uses the same freight and profit model as orders", () => {
  const selection = estimateSelectionProfit(product, logisticsRule, 100);
  const order = estimateItemProfit({
    salePrice: 100,
    quantity: 1,
    product: {
      ...product,
      logistics_rule_id: logisticsRule.id,
      logistics_rule_name: logisticsRule.name,
      logistics_rule_carrier: logisticsRule.carrier,
      logistics_rule_channel: logisticsRule.channel,
      logistics_rule_base_fee_cny: logisticsRule.base_fee_cny,
      logistics_rule_per_gram_cny: logisticsRule.per_gram_cny,
      logistics_rule_per_ticket_cny: logisticsRule.per_ticket_cny,
      return_rate: 0.05,
      advertising_rate: 0.08
    },
    mapping: product
  });

  assert.equal(selection.freight, order.freight);
  assert.equal(selection.commission, order.commission);
  assert.equal(selection.paymentFee, order.paymentFee);
  assert.equal(selection.withdrawalFee, order.withdrawalFee);
  assert.equal(selection.advertisingCost, order.advertisingCost);
  assert.equal(selection.expectedReturnLoss, order.expectedReturnLoss);
  assert.equal(selection.profit, order.profit);
});

test("suggested selection price reaches the target through the order model", () => {
  const suggested = solveSelectionSalePrice(product, logisticsRule);
  const quote = estimateSelectionProfit(product, logisticsRule, suggested.saleRmb);

  assert.ok(quote.margin >= 20);
  assert.ok(estimateSelectionProfit(product, logisticsRule, suggested.saleRmb - 0.02).margin < 20);
});
