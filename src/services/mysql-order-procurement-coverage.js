import { calculateOrderProcurementCoverage } from './order-procurement-coverage.js';

let demandCache;

async function loadDemands(query, sql, fresh = false) {
  if (fresh) return query(sql);
  const now = Date.now();
  if (!demandCache || demandCache.expires <= now) {
    const rows = await query(sql);
    demandCache = { rows, expires: now + 10 * 60 * 1000 };
    return rows;
  }
  const previousOpenIds = [...new Set(demandCache.rows.filter(row => Number(row.needs_fulfillment)).map(row => Number(row.order_id)))].filter(Number.isSafeInteger);
  const rows = await query(`${sql} WHERE (
    o.status IN ('awaiting_packaging','awaiting_approve','acceptance_in_progress','posting_created','posting_acceptance_in_progress','awaiting_deliver','awaiting_registration','posting_awaiting_registration','posting_registration_error','posting_registered','sent_by_seller','posting_ready_for_pickup','posting_transferred_to_courier_service','posting_transferring','posting_in_carriage','posting_transferring_to_delivery')
    OR o.last_status_changed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 MINUTE)
    ${previousOpenIds.length ? `OR o.id IN (${previousOpenIds.join(',')})` : ''}
  )`);
  const changed = new Set([...previousOpenIds, ...rows.map(row => Number(row.order_id))]);
  demandCache.rows = [...demandCache.rows.filter(row => !changed.has(Number(row.order_id))), ...rows];
  return demandCache.rows;
}

let cached;
let pending;
let generation = 0;
const COVERAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export function invalidateOrderProcurementCoverage() { generation += 1; cached = null; pending = null; }

export async function loadOrderProcurementCoverage(query, openSql, { fresh = false, productId = null, productIds = null } = {}) {
  if (productId !== null && (!Number.isSafeInteger(Number(productId)) || Number(productId) <= 0)) throw new Error('库存商品 ID 无效');
  const scopedIds = [...new Set([
    ...(Array.isArray(productIds) ? productIds : []),
    productId
  ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (scopedIds.length) fresh = true; // A scoped snapshot must never reuse or populate the all-product cache.
  const scopedIdSql = scopedIds.join(',');
  const scope = (column = 'product_id') => scopedIds.length ? ` AND ${column} IN (${scopedIdSql})` : '';
  if (!fresh && cached && cached.expires > Date.now()) return cached.value;
  if (!fresh && pending) return pending;
  const version = generation;
  const work = (async () => {
    const [demands, stocks, allocations, inbounds, requests, marks, deductions, sources, stockSources] = await Promise.all([
      loadDemands(query, `SELECT o.id AS order_id, oi.id AS order_item_id, o.ordered_at, o.posting_number,
        COALESCE((SELECT MIN(h.last_status_changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.status IN ('delivering','delivered','posting_delivered','posting_in_transit')), o.delivered_at, o.ordered_at) AS transport_at,
        COALESCE(ri.product_id, pc.component_product_id, p.id, 0) AS product_id,
        cp.name AS product_name, cp.stock_unit,
        oi.quantity * COALESCE(ri.quantity, pc.quantity, 1) AS quantity,
        CASE WHEN (o.status IN ('awaiting_packaging','awaiting_approve','acceptance_in_progress','posting_created','posting_acceptance_in_progress','awaiting_deliver','awaiting_registration','posting_awaiting_registration','posting_registration_error','posting_registered','sent_by_seller','posting_ready_for_pickup','posting_transferred_to_courier_service','posting_transferring','posting_in_carriage','posting_transferring_to_delivery')
          OR o.tracking_stage IN ('awaiting_packaging','awaiting_deliver','awaiting_registration','posting_awaiting_registration','posting_registration_error','posting_registered'))
          AND LOWER(CONCAT_WS(' ', o.status, o.tracking_stage, o.logistics_status)) NOT REGEXP 'cancel|return|reject|delivered|dispute|arbitration'
          THEN 1 ELSE 0 END AS needs_fulfillment,
        CASE WHEN COALESCE(o.cancelled_after_ship, 0) > 0 OR o.delivered_at IS NOT NULL
          OR LOWER(CONCAT_WS(' ', o.status, o.tracking_stage, o.logistics_status)) REGEXP '(^| )(delivering|delivered|posting_delivered|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way)( |$)'
          OR (LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) REGEXP 'cancel|return|reject'
            AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id
              AND h.status IN ('delivering', 'delivered', 'posting_delivered', 'posting_in_transit') LIMIT 1)) THEN 1 ELSE 0 END AS entered_transport,
        CASE WHEN LOWER(CONCAT_WS(' ', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_fields.nested_delivery, '$.name')), JSON_UNQUOTE(JSON_EXTRACT(raw_fields.delivery, '$.name'))),
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_fields.nested_delivery, '$.warehouse')), JSON_UNQUOTE(JSON_EXTRACT(raw_fields.delivery, '$.warehouse'))),
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_fields.nested_analytics, '$.warehouse')), JSON_UNQUOTE(JSON_EXTRACT(raw_fields.analytics, '$.warehouse'))),
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(raw_fields.nested_analytics, '$.tpl_provider')), JSON_UNQUOTE(JSON_EXTRACT(raw_fields.analytics, '$.tpl_provider'))))) REGEXP 'fbp|fbo|hunchun|hun chun|hch-pd|hch-cr|珲春|混春|混川' THEN 'FBP' ELSE 'LOCAL' END AS stock_location
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN sku_mappings direct_mapping ON direct_mapping.id = oi.sku_mapping_id AND direct_mapping.active = 1
        LEFT JOIN (SELECT shop_id, ozon_sku, MIN(id) AS id FROM sku_mappings WHERE active = 1 GROUP BY shop_id, ozon_sku) fallback_mapping
          ON fallback_mapping.shop_id = o.shop_id AND fallback_mapping.ozon_sku = oi.ozon_sku
        LEFT JOIN sku_mappings sm ON sm.id = COALESCE(direct_mapping.id, fallback_mapping.id)
        LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
        LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id = o.shop_id AND recipe.ozon_sku = oi.ozon_sku AND recipe.active = 1 AND recipe.mode = 'combo'
        LEFT JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
        LEFT JOIN product_components pc ON pc.product_id = p.id AND recipe.id IS NULL
        LEFT JOIN products cp ON cp.id = COALESCE(ri.product_id, pc.component_product_id, p.id)
        LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
        -- Parse the large raw payload once; retain nested/root fallback and JSON-null semantics.
        LEFT JOIN JSON_TABLE(raw.raw_json, '$' COLUMNS (
          nested_delivery JSON PATH '$.raw.delivery_method',
          delivery JSON PATH '$.delivery_method',
          nested_analytics JSON PATH '$.raw.analytics_data',
          analytics JSON PATH '$.analytics_data'
        )) raw_fields ON TRUE
        ${scopedIds.length ? `WHERE (COALESCE(ri.product_id, pc.component_product_id, p.id, 0) IN (${scopedIdSql})
          OR oi.id IN (SELECT related_order_item_id FROM inventory_movements WHERE product_id IN (${scopedIdSql})
            AND status = 'posted' AND source_type = 'order_outbound'))` : ''}
`, fresh),
      // Match the order/inventory display: legacy UNKNOWN movements belong to the non-FBP ledger.
      query(`SELECT product_id, SUM(quantity_delta) AS ledger FROM inventory_movements
        WHERE status = 'posted' AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP'${scope()} GROUP BY product_id`),
      query(`SELECT a.order_item_id, a.product_id, a.procurement_request_id, a.allocated_quantity
        FROM procurement_order_allocations a WHERE a.status = 'allocated'${scope('a.product_id')}`),
      query(`SELECT ir.id, ir.product_id, ir.procurement_request_id, ir.purchase_order_id, ir.quantity, ir.amount,
        ir.shipping_amount, ir.status, ir.updated_at, ir.created_at, ir.approved_at, p.name AS product_name, p.stock_unit,
        pe.name AS person_name, po.order_no AS purchase_order_no,
        poi.id AS purchase_order_item_id, poi.actual_quantity AS purchase_quantity,
        poi.inbound_quantity AS purchase_received_quantity, poi.amount AS purchase_amount,
        poi.shipping_amount AS purchase_shipping_amount,
        COALESCE(poi.purchase_url, ir.purchase_url) AS purchase_url,
        COALESCE(poi.note, ir.note) AS purchase_note, po.note AS order_note,
        COALESCE(po.purchased_at, ir.created_at) AS purchased_at
        FROM inbound_records ir LEFT JOIN products p ON p.id = ir.product_id
        LEFT JOIN people pe ON pe.id = ir.person_id LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
        LEFT JOIN purchase_order_items poi ON poi.id = ir.purchase_order_item_id
        WHERE ir.status IN ('pending_arrival', 'approved') AND COALESCE(po.status, '') != 'cancelled'${scope('ir.product_id')}`),
      query(`SELECT id, product_id, source_order_item_id, quantity, amount, status, purchase_order_id
        FROM procurement_requests WHERE status != 'cancelled'${scope()}`),
      query(`SELECT order_item_id, product_id, handling_type, status FROM order_item_procurement_marks WHERE status = 'handled'${scope()}`),
      query(`SELECT im.related_order_item_id AS order_item_id, im.product_id, SUM(-im.quantity_delta) AS quantity, MAX(p.name) AS product_name, MAX(p.stock_unit) AS stock_unit
        FROM inventory_movements im LEFT JOIN products p ON p.id = im.product_id WHERE im.status = 'posted' AND im.source_type = 'order_outbound'
          AND COALESCE(NULLIF(im.stock_location, ''), 'LOCAL') != 'FBP'
          ${scope('im.product_id')}
        GROUP BY im.related_order_item_id, im.product_id`),
      query(`SELECT order_item_id, product_id, quantity, inbound_record_id FROM procurement_history_sources WHERE 1 = 1${scope()}`),
      query(`SELECT id, product_id, quantity_delta AS quantity, created_at AS approved_at FROM inventory_movements
        WHERE status = 'posted' AND quantity_delta > 0
          AND source_type IN ('return_in', 'initial_stock', 'opening_stock')
          AND (source_type != 'return_in' OR source_ref IS NULL OR source_ref NOT LIKE 'cancel_%')
          AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP'${scope()}`)
    ]);
    for (const row of demands) if (Number(row.entered_transport)) row.needs_fulfillment = 0;
    const liveItems = new Set(demands.filter(d => Number(d.needs_fulfillment) && d.stock_location === 'LOCAL').map(d => Number(d.order_item_id)));
    const byProduct = new Map(stocks.map(row => [Number(row.product_id), { ...row, open_deducted: 0 }]));
    for (const movement of deductions) {
      if (!liveItems.has(Number(movement.order_item_id))) continue;
      const id = Number(movement.product_id);
      if (!byProduct.has(id)) byProduct.set(id, { product_id: id, ledger: 0, open_deducted: 0 });
      byProduct.get(id).open_deducted += Number(movement.quantity || 0);
    }
    const historicItems = new Map(demands.filter(d => Number(d.entered_transport) && d.stock_location === 'LOCAL').map(d => [Number(d.order_item_id), d]));
    const frozenItems = new Set(deductions.filter(d => historicItems.has(Number(d.order_item_id))).map(d => Number(d.order_item_id)));
    const resolvedDemands = demands.filter(d => !frozenItems.has(Number(d.order_item_id)));
    for (const movement of deductions) {
      const original = historicItems.get(Number(movement.order_item_id));
      if (original && Number(movement.quantity) > 0) resolvedDemands.push({ ...original, ...movement });
    }
    const value = calculateOrderProcurementCoverage({ demands: scopedIds.length ? resolvedDemands.filter(row => scopedIds.includes(Number(row.product_id))) : resolvedDemands, stocks: [...byProduct.values()], allocations, inbounds, requests, marks, sources, stockSources });
    if (!fresh && generation === version) cached = { value, expires: Date.now() + COVERAGE_CACHE_TTL_MS };
    return value;
  })();
  if (!fresh) pending = work;
  try { return await work; } finally { if (pending === work) pending = null; }
}

export function procurementQueueSql(coverage, status) {
  const ids = [...coverage.values()].filter(row => row.stock_location !== 'FBP').filter(row => status === 'pending_purchase'
    ? row.needs_fulfillment && row.items.some(item => item.product_id > 0 && item.shortage_quantity > 0)
    : status === 'purchase_in_transit' ? row.incoming_quantity > 0 || row.quantity_needs_review
      : row.entered_transport && (row.missing_record_quantity > 0 || row.missing_amount || row.quantity_needs_review))
    .map(row => Number(row.order_id)).filter(Number.isSafeInteger);
  return ids.length ? `o.id IN (${ids.join(',')})` : '1 = 0';
}
