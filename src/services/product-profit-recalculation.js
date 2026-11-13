import { createHash } from 'node:crypto';
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
export function normalizeProductProfitRecalculation(options = {}) {
  const scope = options.recalculation_scope;
  if (!['pending', 'unfulfilled'].includes(scope)) throw invalid('请选择未结算订单或未发货订单');
  const tariffMode = options.tariff_mode || 'original';
  if (!['original', 'product', 'specified'].includes(tariffMode)) throw invalid('请选择原订单运价、当前商品运价或指定运价版本');
  const date = value => {
    if (!value) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString().slice(0, 10) !== value) throw invalid('订单日期格式无效');
    return value;
  };
  const from = date(options.date_from), to = date(options.date_to);
  if (from && to && from > to) throw invalid('开始日期不能晚于结束日期');
  const ruleId = Number(options.logistics_rule_id || 0);
  if (tariffMode === 'specified' && (!Number.isSafeInteger(ruleId) || ruleId <= 0)) throw invalid('请选择指定物流运价版本');
  return { scope, tariffMode, from, to, ruleId: tariffMode === 'specified' ? ruleId : null };
}
export function productProfitRecalculationSkipReason(item, scope) {
  if (Number(item.is_locked) === 1 || item.profit_status === 'accrued' || item.settlement_state === 'accrued') return '已结算或锁定';
  if (item.sync_state === 'final' || /cancel|return|reject|lost/i.test(`${item.order_status} ${item.tracking_stage}`)) return '已结束或售后订单';
  if (scope === 'unfulfilled' && !['awaiting_packaging', 'awaiting_deliver'].includes(item.order_status)) return '不属于未发货订单';
  return '';
}
export function productProfitRecalculationToken(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export async function scopedProductProfitRecalculation(deps, productId, options) {
  const { orderListTenantScopeMysql, assertOrderTaskAccessMysql, mysqlQueryOne, mysqlQuery, orderTenantPredicateMysql,
    chinaDateSqlMysql, productForProfitEstimateMysql, readableLogisticsTenantScopeMysql, productWithOglOrderRateMysql,
    productWithLogisticsRuleMysql, estimatePinnedOrderItemProfit, estimateProfitBreakdownMysql,
    roundMoneyMysql, persistRecalculatedItemMysql, invalidateOrderReadCache, readProfitFxState, refreshProfitSnapshots } = deps;
  const selection = normalizeProductProfitRecalculation(options);
  const tenantScope = await orderListTenantScopeMysql(options.tenantId || 'admin');
  await assertOrderTaskAccessMysql(tenantScope, options, ['inventory.write']);
  const inventorySnapshot = await mysqlQueryOne(`SELECT * FROM products WHERE id = ? AND active = 1 AND ${orderTenantPredicateMysql('products', tenantScope)}`, [Number(productId)]);
  if (!inventorySnapshot) throw Object.assign(new Error('库存商品不存在或不属于当前企业'), { statusCode: 404 });
  const rows = await mysqlQuery(`
    SELECT oi.*, o.shop_id, owned_shop.tenant_id AS profit_tenant_id, o.posting_number, o.status AS order_status, o.sync_state,
      o.tracking_stage, o.logistics_status, o.ordered_at, o.delivered_at, o.accrued_at,
      o.cancel_reason_id, o.cancel_initiator, o.cancel_type, o.cancelled_after_ship,
      opi.is_locked, opi.profit_status, opi.updated_at AS profit_updated_at,
      (SELECT raw.raw_json FROM ozon_orders_raw raw WHERE raw.store_id = o.shop_id AND raw.posting_number = o.posting_number LIMIT 1) AS ozon_raw_json
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN shops owned_shop ON owned_shop.id = o.shop_id
    JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.shop_id = o.shop_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE sm.product_id = ? AND sm.active = 1 AND oi.quantity > 0 AND owned_shop.platform = 'ozon'
      AND ${orderTenantPredicateMysql('sm', tenantScope)} AND ${orderTenantPredicateMysql('owned_shop', tenantScope)}
      ${selection.from ? `AND ${chinaDateSqlMysql('o.ordered_at')} >= ?` : ''}
      ${selection.to ? `AND ${chinaDateSqlMysql('o.ordered_at')} <= ?` : ''}
    ORDER BY oi.id LIMIT 1001
  `, [Number(productId), ...(selection.from ? [selection.from] : []), ...(selection.to ? [selection.to] : [])]);
  if (rows.length > 1000) throw Object.assign(new Error('范围超过 1000 个商品行，请缩小订单日期范围后预览'), { statusCode: 409 });
  const plans = [], skipped = [];
  for (const item of rows) {
    const skipReason = productProfitRecalculationSkipReason(item, selection.scope);
    if (skipReason) { skipped.push({ order_item_id: item.id, posting_number: item.posting_number, reason: skipReason }); continue; }
    try {
      const mapping = await mysqlQueryOne(`SELECT sm.*, op.commissions_json FROM sku_mappings sm
        LEFT JOIN online_products op ON op.id = sm.online_product_id AND op.shop_id = sm.shop_id
        WHERE sm.id = ? AND sm.active = 1 AND ${orderTenantPredicateMysql('sm', tenantScope)}`, [item.sku_mapping_id]);
      if (!mapping) throw new Error('库存绑定已失效');
      const posting = { raw_json: item.ozon_raw_json, order_id: item.order_id, profitFxState: await readProfitFxState(item.profit_tenant_id || 'admin', item.order_id) };
      let effectiveProduct = await productForProfitEstimateMysql(productId, item.ordered_at, posting);
      const ruleId = selection.tariffMode === 'original' ? Number(item.frozen_logistics_rule_id || 0)
        : selection.tariffMode === 'product' ? Number(inventorySnapshot.logistics_rule_id || 0) : selection.ruleId;
      // A saved tariff version is deliberately selected, without silently
      // substituting today's tariff or the posting's inferred carrier.
      if (!ruleId) throw new Error('没有可用的运价版本，请指定运价规则');
      const readable = await readableLogisticsTenantScopeMysql(tenantScope.id, 'candidate');
      const rule = await mysqlQueryOne(`SELECT candidate.* FROM logistics_fee_rules candidate WHERE candidate.id = ? AND ${readable.sql}`, [ruleId, ...readable.params]);
      if (!rule) throw new Error('运价规则不存在或无权使用');
      effectiveProduct = await productWithOglOrderRateMysql(productWithLogisticsRuleMysql(effectiveProduct, rule, 'manual_recalculation'), item.ordered_at, posting);
      const estimated = await estimatePinnedOrderItemProfit(item.id, { salePrice: item.sale_price, quantity: item.quantity, product: effectiveProduct, mapping });
      if (estimated.fxPending) throw new Error('订单汇率或售价依据尚未就绪');
      const breakdown = await estimateProfitBreakdownMysql({ product: effectiveProduct, estimated, quantity: item.quantity, salePrice: item.sale_price, order: item, item });
      plans.push({ item, mapping, product: effectiveProduct, estimated, breakdown });
    } catch (error) {
      if (error.statusCode >= 500 || error.code?.startsWith('ER_')) throw error;
      skipped.push({ order_item_id: item.id, posting_number: item.posting_number, reason: error.message });
    }
  }
  const token = productProfitRecalculationToken({ tenant: tenantScope.id, selection, inventorySnapshot, plans, skipped });
  const previewRows = plans.map(({ item, product, estimated, breakdown }) => ({
    order_item_id: item.id, posting_number: item.posting_number, ordered_at: item.ordered_at,
    weight_g: Number(product.package_weight_g || 0), logistics_rule_id: product.resolved_logistics_rule_id,
    logistics_rule_name: product.logistics_rule_name, formula_version: estimated.formulaVersion,
    old_freight: Number(item.frozen_international_shipping || 0) * Number(item.quantity), new_freight: breakdown.internationalShipping,
    old_profit: Number(item.estimated_profit || 0), new_profit: roundMoneyMysql(breakdown.netProfit),
    profit_difference: roundMoneyMysql(breakdown.netProfit - Number(item.estimated_profit || 0))
  }));
  if (options.preview === true || Number(options.preview) === 1) return {
    ok: true, preview: true, preview_token: token, rows: previewRows, skipped_rows: skipped,
    selected_items: plans.length, skipped_items: skipped.length,
    profit_difference: roundMoneyMysql(previewRows.reduce((sum, row) => sum + row.profit_difference, 0))
  };
  if (!options.preview_token || options.preview_token !== token) throw Object.assign(new Error('商品、订单或运价已变化，请重新预览后确认重算'), { statusCode: 409 });
  let updated = 0;
  const completed = [];
  const failures = [];
  for (const plan of plans) {
    await assertOrderTaskAccessMysql(tenantScope, options, ['inventory.write']);
    const { item, product, estimated, mapping, breakdown } = plan;
    try {
      await persistRecalculatedItemMysql({ itemId: item.id, mapping, product, estimated,
        settlement: 'pending', returnLossEstimate: breakdown.returnLoss, estimatedProfit: breakdown.netProfit,
        quantity: item.quantity, salePrice: item.sale_price, order: item, item, pendingOnly: true, inventorySnapshot,
        expectedProjection: Object.fromEntries(['quantity', 'sale_price', 'sku_mapping_id', 'frozen_logistics_rule_id', 'frozen_international_shipping', 'estimated_profit'].map(key => [key, item[key] ?? 0])),
        reason: `库存参数变更重算；运价选择 ${selection.tariffMode}，规则 #${product.resolved_logistics_rule_id}` });
      updated += 1;
      completed.push(item);
    } catch (error) { failures.push({ order_item_id: item.id, posting_number: item.posting_number, reason: error.message }); }
  }
  invalidateOrderReadCache();
  let refreshWarning = '';
  if (completed.length) {
    try { await refreshProfitSnapshots(tenantScope.id, completed); }
    catch (error) { refreshWarning = `利润已保存，汇总刷新失败：${error.message}`; }
  }
  return { ok: true, updated, refresh_warning: refreshWarning, skipped: skipped.length, failed: failures.length, failed_rows: failures, rows: previewRows };
}

// Routine status sync must not silently apply later inventory edits. Explicit
// recalculation advances this pointer and is the only way to adopt new inputs.
export async function preserveOrderEstimateParameters({ query, tenantKey }, orderItemId, input) {
  const [row] = await query(`SELECT revision.id, revision.inputs_json FROM order_profit_calc_state state
    JOIN order_profit_calc_revisions revision ON revision.id = state.current_estimate_revision_id
      AND revision.tenant_key = state.tenant_key AND revision.order_item_id = state.order_item_id
    WHERE state.tenant_key = ? AND state.order_item_id = ? AND revision.layer = 'estimate'`, [String(tenantKey), Number(orderItemId)]);
  if (!row) return input;
  let archived;
  try { archived = JSON.parse(row.inputs_json); } catch { return input; }
  if (archived?.estimate?.fxPending || Number(archived?.product?.id) !== Number(input.product?.id)) return input;
  return { ...input, expectedEstimateRevisionId: row.id, product: { ...input.product, ...archived.product }, mapping: { ...input.mapping, ...archived.mapping } };
}
