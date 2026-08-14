export function normalizePurchasePlanMysql(body = {}) {
  const quantity = Math.max(1, Number(body.procurement_quantity ?? (body.purchase_quantity || 1)));
  const purchaseTotal = Number(body.purchase_total_amount ?? body.purchase_cost ?? 0);
  const domesticTotal = Number(body.domestic_shipping_total ?? body.domestic_shipping ?? 0);
  return {
    quantity,
    purchaseTotal,
    domesticTotal,
    amount: purchaseTotal,
    shippingAmount: domesticTotal,
    unitPurchaseCost: purchaseTotal / quantity,
    unitDomesticShipping: domesticTotal / quantity
  };
}
