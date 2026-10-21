import { classifyOrderOutcome } from "./order-outcome.js";
import { roundMoney } from "./profit.js";

export function estimatedProfitValue({ order = null, item, product, estimated, returnLossEstimate }) {
  const outcome = classifyOrderOutcome(order || item || {});
  if (["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcome)) {
    return roundMoney(-Number(returnLossEstimate || 0));
  }
  return roundMoney(
    Number(item.sale_price || 0) * Number(item.quantity || 1)
    - (Number(product.purchase_cost || 0) + Number(product.domestic_shipping || 0) + Number(estimated.freight || product.international_shipping || 0)) * Number(item.quantity || 1)
    - Number(estimated.commission || 0)
    - Number(estimated.paymentFee || 0)
    - Number(estimated.withdrawalFee || 0)
    - returnLossEstimate
    - Number(estimated.advertisingCost || 0)
  );
}

export function aggregateEstimatedProfit({ terminalNoRevenue, saleAmount, purchaseCost, domesticShipping,
  internationalShipping, packagingCost, commission, ozonServiceFee, otherFee, returnLoss, advertisingCost }) {
  const costTotal = purchaseCost + domesticShipping + internationalShipping + packagingCost + commission + ozonServiceFee + otherFee + returnLoss + advertisingCost;
  const netProfit = roundMoney(terminalNoRevenue ? -costTotal : saleAmount - costTotal);
  return { costTotal, netProfit, grossProfit: roundMoney(netProfit + ozonServiceFee + returnLoss + advertisingCost) };
}

export function aggregateActualProfit({ terminalNoRevenue, itemSale, purchaseCost, domesticShipping,
  actualInternationalShipping, packagingCost, commissionFeeCny, actualServiceFeeCny, returnLoss, advertisingCost, otherFee }) {
  const terminalLoss = purchaseCost + domesticShipping + actualInternationalShipping + packagingCost + commissionFeeCny + actualServiceFeeCny + returnLoss + advertisingCost + otherFee;
  const actualProfit = roundMoney(terminalNoRevenue ? -terminalLoss : itemSale - terminalLoss);
  return { terminalLoss, actualProfit, grossProfit: roundMoney(actualProfit + advertisingCost) };
}
