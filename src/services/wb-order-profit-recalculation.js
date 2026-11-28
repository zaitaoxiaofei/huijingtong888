import { WB_ORDER_ESTIMATE_MODEL_VERSION, estimateWbOrderProfit } from '../shared/wb-order-profit.js';
import { currentWbTariff } from '../shared/wb-logistics-catalog.js';
import { wbOrderAmountCny } from '../shared/wb-order-state.js';
import { ensureOrderProfitCalculationState, recordOrderProfitCalculation, retryProfitCalculationTransaction } from './order-profit-calculation-versions.js';

const fields = ['purchaseCost', 'domesticCost', 'weight', 'length', 'width', 'height', 'commissionRate', 'paymentRate', 'adRate', 'otherRate', 'returnRate', 'returnLoss', 'warehouseId'];
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const rows = result => Array.isArray(result?.[0]) ? result[0] : result;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const nonnegative = value => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);
const positive = value => nonnegative(value) > 0 ? Number(value) : null;
const pick = value => Object.fromEntries(fields.filter(field => Object.hasOwn(value || {}, field)).map(field => [field, value[field]]));

function decodedSnapshot(row) {
  const inputs = parse(row?.inputs_json), outputs = parse(row?.outputs_json);
  return row && inputs && outputs ? {
    inputs: inputs.estimate_inputs || inputs, outputs, calculated_at: row.calculated_at ?? row.created_at,
    revision_id: Number(row.revision_id ?? row.id), manual_overrides: inputs.manual_overrides || {}
  } : null;
}

export async function readWbOrderProfitSnapshots({ query, tenantId, orderIds }) {
  const tenant = positiveId(tenantId);
  if (!tenant) throw fail('缺少有效企业，无法读取 WB 利润记录。', 403);
  const ids = [...new Set((orderIds || []).map(positiveId))];
  if (ids.some(id => !id)) throw fail('WB 订单编号无效。');
  const result = new Map();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const saved = rows(await query(`SELECT state.order_id,revision.id AS revision_id,revision.inputs_json,
      revision.outputs_json,revision.created_at AS calculated_at
      FROM order_profit_calc_state state
      JOIN order_items i ON i.id=state.order_item_id AND i.order_id=state.order_id
      JOIN orders o ON o.id=i.order_id
      JOIN shops s ON s.id=o.shop_id AND s.platform='wb' AND s.tenant_id=?
      JOIN wb_order_details w ON w.order_id=o.id AND w.shop_id=o.shop_id AND w.tenant_id=s.tenant_id
      JOIN order_profit_calc_revisions revision ON revision.id=state.current_estimate_revision_id
        AND revision.tenant_key=state.tenant_key AND revision.order_item_id=i.id AND revision.order_id=o.id
        AND revision.layer='estimate' AND revision.formula_version=?
      WHERE state.tenant_key=? AND state.formula_version=? AND state.order_id IN (${chunk.map(() => '?').join(',')})`,
    [tenant, WB_ORDER_ESTIMATE_MODEL_VERSION, String(tenant), WB_ORDER_ESTIMATE_MODEL_VERSION, ...chunk]));
    for (const row of saved) {
      const snapshot = decodedSnapshot(row);
      if (snapshot) result.set(Number(row.order_id), snapshot);
    }
  }
  return result;
}

const contextSql = ids => `SELECT i.*,o.id AS order_id,o.shop_id,o.ordered_at,w.wb_order_id,w.raw_json,
  p.purchase_cost,p.domestic_shipping,p.handling_fee,p.package_weight_g,p.length_cm,p.width_cm,p.height_cm,
  p.id AS product_id,c.raw_json AS card_json,
  opi.id AS profit_item_id,opi.sale_amount_cny,opi.purchase_cost_cny,opi.domestic_shipping_cny,
  opi.international_shipping_cny,opi.packaging_cost_cny,opi.commission_rate,opi.commission_fee_cny,
  opi.ozon_service_fee_cny,opi.return_loss_cny,opi.advertising_cost_cny,opi.other_fee_cny,
  opi.gross_profit_cny,opi.net_profit_cny,opi.profit_status,opi.is_locked,opi.locked_at,opi.lock_reason
  FROM orders o JOIN shops s ON s.id=o.shop_id AND s.platform='wb' AND s.status='active' AND s.tenant_id=?
  JOIN wb_order_details w ON w.order_id=o.id AND w.shop_id=o.shop_id AND w.tenant_id=s.tenant_id
  LEFT JOIN order_items i ON i.order_id=o.id
  LEFT JOIN sku_mappings m ON m.id=i.sku_mapping_id AND m.shop_id=o.shop_id AND m.tenant_id=w.tenant_id AND m.active=1
  LEFT JOIN products p ON p.id=m.product_id AND p.active=1 AND (p.tenant_id=w.tenant_id OR
    (p.tenant_id IS NULL AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=w.tenant_id AND t.slug='default')))
  LEFT JOIN wb_product_cards c ON c.tenant_id=w.tenant_id AND c.shop_id=w.shop_id
    AND c.nm_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(w.raw_json,'$.nmId')) AS UNSIGNED)
  LEFT JOIN order_profit_items opi ON opi.order_item_id=i.id
  WHERE o.id IN (${ids.map(() => '?').join(',')}) ORDER BY o.id,i.id`;

function contextInputs(context) {
  const raw = parse(context.raw_json), card = parse(context.card_json), dimensions = card?.dimensions;
  const quantity = positiveId(context.quantity), single = quantity === 1;
  const cost = positive(context.purchase_cost), domestic = nonnegative(context.domestic_shipping), handling = nonnegative(context.handling_fee);
  let orderedAt = raw?.createdAt ?? context.ordered_at ?? null;
  if (orderedAt instanceof Date) orderedAt = orderedAt.toISOString();
  else if (orderedAt && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(orderedAt))) orderedAt = `${String(orderedAt).replace(' ', 'T')}Z`;
  return {
    shop_id: Number(context.shop_id), subject_id: positiveId(card?.subjectID), ordered_at: orderedAt,
    quantity, sale: wbOrderAmountCny(raw),
    purchaseCost: cost == null || !quantity ? null : cost * quantity,
    domesticCost: domestic == null || handling == null || !quantity ? null : (domestic + handling) * quantity,
    weight: single ? positive(dimensions?.weightBrutto) ? Number(dimensions.weightBrutto) * 1000 : positive(context.package_weight_g) : null,
    length: single ? positive(dimensions?.length) ?? positive(context.length_cm) : null,
    width: single ? positive(dimensions?.width) ?? positive(context.width_cm) : null,
    height: single ? positive(dimensions?.height) ?? positive(context.height_cm) : null
  };
}

function baseline(context) {
  const names = ['id', 'order_id', 'quantity', 'sale_price', 'sku_mapping_id', 'estimated_profit', 'actual_profit', 'settlement_state',
    'frozen_purchase_cost', 'frozen_domestic_shipping', 'frozen_international_shipping', 'frozen_logistics_rule_id', 'frozen_handling_fee',
    'estimated_commission', 'platform_fee_actual', 'aftersale_loss', 'profit_item_id', 'sale_amount_cny', 'purchase_cost_cny',
    'domestic_shipping_cny', 'international_shipping_cny', 'packaging_cost_cny', 'commission_rate', 'commission_fee_cny',
    'ozon_service_fee_cny', 'return_loss_cny', 'advertising_cost_cny', 'other_fee_cny', 'gross_profit_cny', 'net_profit_cny',
    'profit_status', 'is_locked', 'locked_at', 'lock_reason'];
  return Object.fromEntries(names.map(name => [name, context[name] ?? null]));
}

async function prepareFormula(connection, context, tenantId) {
  const scope = { tenantId, orderId: Number(context.order_id), orderItemId: Number(context.id) };
  let state = await ensureOrderProfitCalculationState(connection, { ...scope, legacy: false });
  if (state.formula_version === WB_ORDER_ESTIMATE_MODEL_VERSION) return state;
  if (state.formula_version !== 'V1') throw fail('WB 订单存在其他固定利润公式，停止重算，请核对历史计算记录。', 409);
  const [existing] = rows(await connection.query(`SELECT COUNT(*) AS incompatible_revisions FROM order_profit_calc_revisions
    WHERE tenant_key=? AND order_item_id=? AND legacy_baseline=0`, [String(tenantId), Number(context.id)]));
  if (Number(existing?.incompatible_revisions) > 0) throw fail('WB 订单已有其他公式的正式计算记录，不能覆盖其固定版本。', 409);
  const before = baseline(context);
  const hasActual = Number(context.is_locked) === 1 || context.settlement_state === 'accrued' || Number(context.actual_profit) !== 0;
  state = await ensureOrderProfitCalculationState(connection, {
    ...scope, legacy: true, baselineEstimate: before, baselineActual: hasActual ? before : null
  });
  await connection.execute(`UPDATE order_profit_calc_state SET formula_version=?
    WHERE tenant_key=? AND order_item_id=? AND formula_version='V1'`, [WB_ORDER_ESTIMATE_MODEL_VERSION, String(tenantId), Number(context.id)]);
  return { ...state, formula_version: WB_ORDER_ESTIMATE_MODEL_VERSION };
}

export function createWbOrderProfitRecalculation({ actorId, query, transaction, pricingCommissions, invalidate = () => {} }) {
  return async function recalculateOrderProfit(tenantId, body = {}) {
    const tenant = positiveId(tenantId), actor = positiveId(actorId), ids = body.order_ids;
    if (!tenant || !actor) throw fail('缺少当前企业或操作成员，无法保存 WB 利润。', 403);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !positiveId(id)) || new Set(ids.map(Number)).size !== ids.length) throw fail('请选择 1–100 条不同的有效 WB 订单。');
    const clean = ids.map(Number), overrides = body.overrides ?? {};
    if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw fail('WB 重算参数格式无效。');
    for (const [id, values] of Object.entries(overrides)) {
      if (!clean.includes(Number(id)) || !values || Array.isArray(values) || typeof values !== 'object' || Object.keys(values).some(key => !fields.includes(key))) throw fail('只能调整所选订单的采购、包裹和费用参数，销售额由订单确定。');
      for (const [key, value] of Object.entries(values)) {
        if (value == null || value === '') continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key.endsWith('Rate') && value > 100) || (key === 'warehouseId' && !positiveId(value))) throw fail('WB 重算参数包含无效金额、包裹尺寸或费率。');
      }
    }
    const commandId = String(body.command_id || '').trim();
    if (commandId.length > 96) throw fail('WB 利润重算命令编号过长。');
    const initial = rows(await query(contextSql(clean), [tenant, ...clean]));
    if (clean.some(id => !initial.some(row => Number(row.order_id) === id))) throw fail('部分 WB 订单不存在、店铺已停用或不属于当前企业。', 404);
    const preferenceKey = `user_preferences:${actor}:wb.profit.warehouse.${tenant}`;
    const commissionCache = new Map(), results = [];
    for (const orderId of clean.sort((a, b) => a - b)) {
      const candidates = initial.filter(row => Number(row.order_id) === orderId), initialContext = candidates[0];
      if (candidates.length !== 1 || !positiveId(initialContext.id) || !positiveId(initialContext.quantity)) {
        results.push({ order_id: orderId, status: 'needs_inputs', estimated_profit_cny: null, provisional: true,
          missing_inputs: [{ field: 'quantity', label: '有效的单商品订单明细与数量' }], error: 'WB 订单商品明细或数量异常，请同步订单并核对后重算。' });
        continue;
      }
      const planned = contextInputs(initialContext), override = overrides[orderId] || {};
      let officialCommission = null;
      if (!Object.hasOwn(override, 'commissionRate') && planned.subject_id) {
        if (!commissionCache.has(planned.shop_id)) commissionCache.set(planned.shop_id, pricingCommissions(tenant, { shop_id: planned.shop_id }).catch(() => ({ rows: [] })));
        const catalog = await commissionCache.get(planned.shop_id);
        officialCommission = catalog.rows?.find(row => Number(row.id) === planned.subject_id)?.rate ?? null;
      }
      try {
        const snapshot = await retryProfitCalculationTransaction(transaction, async connection => {
          await connection.query('SELECT id FROM order_items WHERE id=? FOR UPDATE', [Number(initialContext.id)]);
          const current = rows(await connection.query(`${contextSql([orderId])} FOR UPDATE`, [tenant, orderId]));
          if (current.length !== 1 || Number(current[0].id) !== Number(initialContext.id) || !positiveId(current[0].quantity)) throw fail('WB 订单商品或归属已变化，请刷新后重算。', 409);
          const context = current[0], authoritative = contextInputs(context);
          const readLocked = async (sql, params) => rows(await connection.query(sql, params));
          const latestSaved = (await readWbOrderProfitSnapshots({ query: readLocked, tenantId: tenant, orderIds: [orderId] })).get(orderId);
          const previous = Object.fromEntries(Object.entries(pick(latestSaved?.manual_overrides || {})).filter(([, value]) => value != null && value !== ''));
          const scenario = { ...previous, ...override };
          const [preference] = await readLocked('SELECT value_json FROM system_settings WHERE `key`=? LIMIT 1', [preferenceKey]);
          const preferenceValue = parse(preference?.value_json) || {};
          if (authoritative.shop_id !== planned.shop_id || (!Object.hasOwn(scenario, 'commissionRate') && authoritative.subject_id !== planned.subject_id)) throw fail('WB 店铺或类目已变化，请刷新后重新获取佣金。', 409);
          const inputs = {
            ...pick(authoritative), commissionRate: officialCommission, paymentRate: preferenceValue.paymentRates?.[String(authoritative.shop_id)] ?? null,
            adRate: 0, otherRate: 0, returnRate: 0, returnLoss: null, warehouseId: preferenceValue.warehouseId ?? null,
            ...scenario, sale: authoritative.sale
          };
          let tariff = null;
          try { tariff = currentWbTariff(authoritative.ordered_at); } catch {}
          const rule = tariff?.rows.find(row => row.id === Number(inputs.warehouseId));
          const output = estimateWbOrderProfit(inputs, rule);
          if (!tariff) output.missingInputs.push({ field: 'ordered_at', label: '有已登记报价的订单日期' });
          if (!tariff) output.profit = output.total = null;
          await prepareFormula(connection, context, tenant);
          const recorded = await recordOrderProfitCalculation(connection, {
            tenantId: tenant, orderId, orderItemId: Number(context.id), layer: 'estimate', formulaVersion: WB_ORDER_ESTIMATE_MODEL_VERSION,
            inputs: { estimate_inputs: inputs, shop_id: authoritative.shop_id, ordered_at: authoritative.ordered_at,
              subject_id: authoritative.subject_id, quantity: authoritative.quantity, manual_overrides: scenario }, outputs: output,
            inputCompleteness: output.profit == null ? 'missing_inputs' : output.provisional ? 'provisional' : 'complete',
            rateVersion: output.shipping || (tariff ? { tariffVersion: tariff.version, warehouseId: inputs.warehouseId } : null),
            costVersion: { product_id: context.product_id ?? null, sku_mapping_id: context.sku_mapping_id ?? null },
            source: 'wb_order_recalculation', reason: '操作员明确重算 WB 订单预估利润', actorId: actor,
            commandId: commandId ? `${commandId}:${orderId}` : null,
            project: async () => {
              if (output.profit == null) return;
              const result = await connection.execute(`UPDATE order_items i JOIN orders o ON o.id=i.order_id
                JOIN shops s ON s.id=o.shop_id AND s.platform='wb' AND s.tenant_id=?
                JOIN wb_order_details w ON w.order_id=o.id AND w.shop_id=o.shop_id AND w.tenant_id=s.tenant_id
                SET i.estimated_profit=? WHERE i.id=? AND i.order_id=?`, [tenant, output.profit, Number(context.id), orderId]);
              const header = Array.isArray(result) ? result[0] : result;
              if (!header.affectedRows) throw fail('WB 订单归属已变化，利润未保存，请刷新后重算。', 409);
            }
          });
          const [latest] = rows(await connection.query(`SELECT id,inputs_json,outputs_json,created_at FROM order_profit_calc_revisions
            WHERE tenant_key=? AND order_item_id=? AND id=? AND layer='estimate'`,
          [String(tenant), Number(context.id), Number(recorded.state.current_estimate_revision_id)]));
          return decodedSnapshot(latest);
        });
        if (!snapshot) throw fail('WB 利润保存后未能读取，请刷新重试。', 409);
        const output = snapshot.outputs;
        results.push({ order_id: orderId, status: output.profit == null ? 'needs_inputs' : 'saved', estimated_profit_cny: output.profit,
          provisional: output.provisional, missing_inputs: output.missingInputs, revision_id: snapshot.revision_id,
          error: output.shippingError || (output.inputErrors?.length ? `请核对${output.inputErrors.map(row => row.label).join('、')}。` : '') });
      } catch (error) {
        if (clean.length === 1) throw error;
        results.push({ order_id: orderId, status: 'needs_inputs', estimated_profit_cny: null, provisional: true, missing_inputs: [], error: error.message });
      }
    }
    invalidate();
    return { ok: true, updated_count: results.filter(row => row.status === 'saved').length, results };
  };
}
