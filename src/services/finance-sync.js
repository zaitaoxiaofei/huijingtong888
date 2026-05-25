function executeStatement(deps, sql, params = []) {
  if (typeof deps.execute === "function") {
    return deps.execute(sql, params);
  }
  return deps.db.prepare(sql).run(...params);
}

export async function syncOzonFinance(deps, body = {}, options = {}) {
  const targetShopId = deps.nullable(body.shop_id);
  const activeShops = deps.shops().filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const from = body.from || deps.dateKeyDaysAgo(30);
  const to = body.to || deps.todayDateKey();
  let fetched = 0;
  let upserted = 0;
  const errors = [];
  for (const shop of activeShops) {
    try {
      const result = await deps.fetchOzonFinanceTransactions(shop, { from, to, signal: options.signal });
      fetched += result.fetched || 0;
      for (const operation of result.operations || []) upserted += upsertFinanceOperation(deps, shop.id, operation);
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }
  const applied = applyOzonFinanceToOrders(deps, { from, to });
  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}, applied ${applied.items}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  executeStatement(deps, "INSERT INTO sync_logs (job, status, message) VALUES ('ozon_finance', ?, ?)", [status, message]);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, applied, errors };
}

export function reapplySyncedOzonFinance(deps, { from = "", to = "" } = {}) {
  return applyOzonFinanceToOrders(deps, { from, to });
}

function upsertFinanceOperation(deps, shopId, operation) {
  const rows = financeRowsForOperation(operation);
  const rate = Number(deps.exchangeRateForDate(operation.operation_date).rate || deps.currentExchangeRate().rate || 11.32);
  let count = 0;
  for (const row of rows) {
    const amountRub = Number(row.amount || 0);
    const accrualsRub = Number(operation.accruals_for_sale || 0);
    const saleCommissionRub = Number(operation.sale_commission || 0);
    const deliveryChargeRub = Number(operation.delivery_charge || 0);
    const returnDeliveryChargeRub = Number(operation.return_delivery_charge || 0);
    executeStatement(deps, `
      INSERT INTO ozon_finance_items
      (shop_id, operation_id, posting_number, order_number, operation_type, operation_type_name, operation_date,
       service_type, service_name, amount, accruals_for_sale, sale_commission, delivery_charge, return_delivery_charge,
       currency_code, raw_json, amount_cny, accruals_for_sale_cny, sale_commission_cny, delivery_charge_cny, return_delivery_charge_cny, exchange_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, operation_id, service_type) DO UPDATE SET
        posting_number = excluded.posting_number,
        order_number = excluded.order_number,
        operation_type = excluded.operation_type,
        operation_type_name = excluded.operation_type_name,
        operation_date = excluded.operation_date,
        service_name = excluded.service_name,
        amount = excluded.amount,
        accruals_for_sale = excluded.accruals_for_sale,
        sale_commission = excluded.sale_commission,
        delivery_charge = excluded.delivery_charge,
        return_delivery_charge = excluded.return_delivery_charge,
        currency_code = excluded.currency_code,
        amount_cny = excluded.amount_cny,
        accruals_for_sale_cny = excluded.accruals_for_sale_cny,
        sale_commission_cny = excluded.sale_commission_cny,
        delivery_charge_cny = excluded.delivery_charge_cny,
        return_delivery_charge_cny = excluded.return_delivery_charge_cny,
        exchange_rate = excluded.exchange_rate,
        raw_json = excluded.raw_json,
        synced_at = CURRENT_TIMESTAMP
    `, [
      shopId,
      operation.operation_id || `${operation.posting_number}-${operation.operation_date}`,
      operation.posting_number || "",
      operation.order_number || "",
      operation.operation_type || "",
      operation.operation_type_name || "",
      operation.operation_date || "",
      row.service_type,
      row.service_name,
      amountRub,
      accrualsRub,
      saleCommissionRub,
      deliveryChargeRub,
      returnDeliveryChargeRub,
      operation.currency_code || "",
      operation.raw_json || "",
      deps.rubToCny(amountRub, rate),
      deps.rubToCny(accrualsRub, rate),
      deps.rubToCny(saleCommissionRub, rate),
      deps.rubToCny(deliveryChargeRub, rate),
      deps.rubToCny(returnDeliveryChargeRub, rate),
      rate
    ]);
    count += 1;
  }
  return count;
}

function financeRowsForOperation(operation) {
  const rows = [];
  if (Number(operation.sale_commission || 0)) rows.push({ service_type: "sale_commission", service_name: "Ozon 销售佣金", amount: Number(operation.sale_commission || 0) });
  if (Number(operation.delivery_charge || 0)) rows.push({ service_type: "delivery_charge", service_name: "Ozon 配送费用", amount: Number(operation.delivery_charge || 0) });
  if (Number(operation.return_delivery_charge || 0)) rows.push({ service_type: "return_delivery_charge", service_name: "退货配送费用", amount: Number(operation.return_delivery_charge || 0) });
  for (const [index, service] of (operation.services || []).entries()) {
    rows.push({ service_type: `service_${index}_${String(service.name || "").slice(0, 48)}`, service_name: service.name || "Ozon 服务费", amount: Number(service.price || 0) });
  }
  if (!rows.length) rows.push({ service_type: "operation_total", service_name: operation.operation_type_name || operation.operation_type || "Ozon 财务交易", amount: Number(operation.amount || 0) });
  return rows;
}

function applyOzonFinanceToOrders(deps, { from = "", to = "" } = {}) {
  const rows = deps.all(`
    SELECT o.id AS order_id,
      MAX(o.status) AS order_status,
      MAX(o.tracking_stage) AS tracking_stage,
      MAX(o.logistics_status) AS logistics_status,
      MAX(o.delivered_at) AS delivered_at,
      MAX(o.accrued_at) AS accrued_at,
      MAX(o.cancel_reason) AS cancel_reason,
      MAX(o.cancel_reason_id) AS cancel_reason_id,
      MAX(o.cancel_initiator) AS cancel_initiator,
      MAX(o.cancel_type) AS cancel_type,
      MAX(o.cancelled_after_ship) AS cancelled_after_ship,
      COALESCE(SUM(CASE WHEN ofi.amount_cny < 0 THEN -ofi.amount_cny ELSE 0 END), 0) AS fee_amount_cny,
      COALESCE(MAX(CASE WHEN ABS(COALESCE(ofi.accruals_for_sale_cny, 0)) > 0 THEN ABS(ofi.accruals_for_sale_cny) ELSE 0 END), 0) AS sale_accrual_cny,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(ofi.amount_cny) ELSE 0 END), 0) AS commission_fee_cny,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(ofi.amount) ELSE 0 END), 0) AS commission_fee_rub,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(COALESCE(ofi.accruals_for_sale, 0)) ELSE 0 END), 0) AS commission_sale_rub,
      COALESCE(SUM(CASE WHEN ofi.service_type != 'sale_commission' AND ofi.amount_cny < 0 THEN -ofi.amount_cny ELSE 0 END), 0) AS service_fee_cny
    FROM orders o
    JOIN ozon_finance_items ofi ON ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number
    WHERE (? = '' OR substr(ofi.operation_date, 1, 10) >= ?)
      AND (? = '' OR substr(ofi.operation_date, 1, 10) <= ?)
    GROUP BY o.id
  `, [from, from, to, to]);
  let updated = 0;
  for (const row of rows) {
    const financeRows = deps.all(`
      SELECT service_type, service_name,
        COALESCE(SUM(amount_cny), 0) AS amount_cny,
        COALESCE(SUM(CASE WHEN amount_cny < 0 THEN -amount_cny ELSE 0 END), 0) AS fee_amount_cny
      FROM ozon_finance_items
      WHERE shop_id = (SELECT shop_id FROM orders WHERE id = ?)
        AND posting_number = (SELECT posting_number FROM orders WHERE id = ?)
        AND (? = '' OR substr(operation_date, 1, 10) >= ?)
        AND (? = '' OR substr(operation_date, 1, 10) <= ?)
      GROUP BY service_type, service_name
    `, [row.order_id, row.order_id, from, from, to, to]);
    const categoryTotals = financeRows.reduce((acc, item) => {
      const key = deps.ozonFinanceCategory(item);
      const rawAmount = Number(item.amount_cny || 0);
      const feeAmount = Number(item.fee_amount_cny || 0);
      const amount = feeAmount > 0 ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
      acc[key] = deps.roundMoney(Number(acc[key] || 0) + amount);
      return acc;
    }, {});
    const items = deps.all(`
      SELECT oi.*, opi.sale_amount_cny, opi.purchase_cost_cny, opi.domestic_shipping_cny, opi.international_shipping_cny,
        opi.packaging_cost_cny, opi.return_loss_cny, opi.advertising_cost_cny, opi.other_fee_cny
      FROM order_items oi
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE oi.order_id = ?
    `, [row.order_id]);
    const totalSale = items.reduce((sum, item) => sum + Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 1))), 0);
    const commissionRate = Number(row.commission_sale_rub || 0) > 0
      ? Number(row.commission_fee_rub || 0) / Number(row.commission_sale_rub || 0)
      : 0;
    const orderOutcome = deps.classifyOrderOutcome({
      status: row.order_status,
      tracking_stage: row.tracking_stage,
      logistics_status: row.logistics_status,
      delivered_at: row.delivered_at,
      accrued_at: row.accrued_at,
      cancel_reason: row.cancel_reason,
      cancel_reason_id: row.cancel_reason_id,
      cancel_initiator: row.cancel_initiator,
      cancel_type: row.cancel_type,
      cancelled_after_ship: row.cancelled_after_ship
    });
    const orderLossProfile = deps.resolveOrderLossProfile({
      status: row.order_status,
      tracking_stage: row.tracking_stage,
      logistics_status: row.logistics_status,
      delivered_at: row.delivered_at,
      accrued_at: row.accrued_at,
      cancel_reason: row.cancel_reason,
      cancel_reason_id: row.cancel_reason_id,
      cancel_initiator: row.cancel_initiator,
      cancel_type: row.cancel_type,
      cancelled_after_ship: row.cancelled_after_ship,
      outcome_type: orderOutcome,
      ...deps.describeCancellation({
        status: row.order_status,
        tracking_stage: row.tracking_stage,
        logistics_status: row.logistics_status,
        delivered_at: row.delivered_at,
        accrued_at: row.accrued_at,
        cancel_reason: row.cancel_reason,
        cancel_reason_id: row.cancel_reason_id,
        cancel_initiator: row.cancel_initiator,
        cancel_type: row.cancel_type,
        cancelled_after_ship: row.cancelled_after_ship,
        outcome_type: orderOutcome
      })
    });
    const hasFinalFinanceBasis = Number(row.sale_accrual_cny || 0) > 0.005 || orderOutcome !== "active";
    if (!hasFinalFinanceBasis) continue;
    for (const item of items) {
      const itemSale = Number(item.sale_amount_cny || (Number(item.sale_price || 0) * Number(item.quantity || 1)));
      const share = totalSale > 0 ? itemSale / totalSale : (items.length ? 1 / items.length : 0);
      const commissionFeeCny = commissionRate > 0
        ? deps.roundMoney(itemSale * commissionRate)
        : deps.roundMoney(Number(row.commission_fee_cny || 0) * share);
      const serviceFeeCny = deps.roundMoney(Number(categoryTotals.other || 0) * share);
      const collectingFee = deps.roundMoney(Number(categoryTotals.collecting_fee || 0) * share);
      const totalFinanceFeeCny = deps.roundMoney(Number(row.fee_amount_cny || 0) * share);
      const purchaseCost = Number(item.purchase_cost_cny || (Number(item.frozen_purchase_cost || 0) * Number(item.quantity || 1)));
      const domesticShipping = Number(item.domestic_shipping_cny || (Number(item.frozen_domestic_shipping || 0) * Number(item.quantity || 1)));
      const actualInternationalShipping = deps.roundMoney(Number(categoryTotals.platform_delivery || 0) * share + Number(categoryTotals.international_transport || 0) * share);
      const packagingCost = deps.packagingFeeForSaleAmount(itemSale);
      const returnLoss = deps.estimateOutcomeReturnLoss({
        outcome: orderOutcome,
        lossProfileCode: orderLossProfile.code,
        quantity: Number(item.quantity || 1),
        purchaseCostPerUnit: Number(item.purchase_cost_cny || item.frozen_purchase_cost || 0) / Math.max(Number(item.quantity || 1), 1),
        domesticShippingPerUnit: Number(item.domestic_shipping_cny || item.frozen_domestic_shipping || 0) / Math.max(Number(item.quantity || 1), 1),
        internationalShippingPerUnit: actualInternationalShipping / Math.max(Number(item.quantity || 1), 1),
        packagingCostTotal: packagingCost,
        commissionFeeTotal: commissionFeeCny,
        collectingFeeTotal: collectingFee,
        finalMileFeeTotal: 0,
        serviceFeeTotal: serviceFeeCny,
        returnRateLossTotal: deps.roundMoney(Number(categoryTotals.aftersale_loss || 0) * share) || Number(item.return_loss_cny || item.aftersale_loss || 0)
      });
      const advertisingCost = Number(item.advertising_cost_cny || 0);
      const otherFee = Number(item.other_fee_cny || 0);
      const actualProfit = deps.roundMoney(itemSale - purchaseCost - domesticShipping - actualInternationalShipping - packagingCost - commissionFeeCny - serviceFeeCny - collectingFee - returnLoss - advertisingCost - otherFee);
      executeStatement(deps, "UPDATE order_items SET platform_fee_actual = ?, actual_profit = ?, settlement_state = 'accrued' WHERE id = ?", [totalFinanceFeeCny, actualProfit, item.id]);
      executeStatement(deps, `
        UPDATE order_profit_items
        SET international_shipping_cny = ?, packaging_cost_cny = ?, commission_fee_cny = ?, commission_rate = ?, ozon_service_fee_cny = ?, return_loss_cny = ?, other_fee_cny = ?, net_profit_cny = ?, profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
      `, [actualInternationalShipping, packagingCost, commissionFeeCny, commissionRate, serviceFeeCny, returnLoss, otherFee, actualProfit, item.id]);
      deps.lockProfitItem(item.id, "finance_accrued");
      updated += 1;
    }
  }
  deps.refreshProfitAnalyticsSnapshots({ from, to });
  if (typeof deps.refreshOrderProfitDetailSnapshots === "function") {
    deps.refreshOrderProfitDetailSnapshots({ from, to, final_only: 1 });
  }
  return { orders: rows.length, items: updated };
}
