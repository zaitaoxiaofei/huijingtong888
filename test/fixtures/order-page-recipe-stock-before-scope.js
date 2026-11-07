// Frozen release b1880bd order-row SQL reader before narrowing recipe aggregation.
// Used only in isolated equivalence tests; never imported by the application.
export async function orderRowsByIdsMysql(ids = [], coveragePromise = undefined, tenantId = "admin", { summaryOnly = false, bypassCache = false } = {}) {
  const cleanIds = [...new Set(ids.map(Number).filter(Boolean))];
  if (!cleanIds.length) return [];
  const tenantScope = await orderListTenantScopeMysql(tenantId);
  if (summaryOnly && coveragePromise === null && !bypassCache) {
    const value = await cachedOrderRead(`rows:${tenantScope.id}:${tenantScope.defaultTenant ? 1 : 0}:${cleanIds.join(',')}`,
      () => orderRowsByIdsMysql(cleanIds, null, tenantId, { summaryOnly: true, bypassCache: true }));
    return structuredClone(value);
  }
  const billingScope = await readableLogisticsTenantScopeMysql(tenantId, "visible_rule");
  await ensureProcurementOrderSourceSchemaMysql();
  await ensureSkuInventoryRecipeSchemaMysql();
  await ensureProductCompositionSchemaMysql();
  // Existing detail callers stay fully enriched. Paged ordinary lists pass
  // null so their initial rows are not held by the full-ledger calculation.
  if (coveragePromise === undefined) {
    coveragePromise = orderTenantCoverageMysql(tenantScope);
    coveragePromise.catch(() => {});
  }
  // Resolve one active mapping, preferring the explicit binding. Avoid an OR
  // join that scans every mapping and can multiply profit/quantity aggregates.
  const mappingJoin = `LEFT JOIN sku_mappings sm ON sm.id = COALESCE(
    (SELECT direct_mapping.id FROM sku_mappings direct_mapping
      WHERE direct_mapping.id = oi.sku_mapping_id AND direct_mapping.shop_id = o.shop_id
        AND direct_mapping.active = 1 AND ${orderTenantPredicateMysql("direct_mapping", tenantScope)}),
    (SELECT MIN(fallback_mapping.id) FROM sku_mappings fallback_mapping
      WHERE fallback_mapping.shop_id = o.shop_id AND fallback_mapping.ozon_sku = oi.ozon_sku
        AND fallback_mapping.active = 1 AND ${orderTenantPredicateMysql("fallback_mapping", tenantScope)})
  )`;
  const rows = await mysqlQuery(`
    WITH scoped_order_items AS (
      SELECT DISTINCT oi.id AS order_item_id, oi.order_id, oi.ozon_sku, o.shop_id, sm.id AS mapping_id, scoped_product.id AS product_id
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      ${mappingJoin}
      LEFT JOIN products scoped_product ON scoped_product.id = sm.product_id AND ${orderTenantPredicateMysql("scoped_product", tenantScope)}
      WHERE oi.order_id IN (${cleanIds.map(() => "?").join(",")})
        ${tenantScope ? `AND o.shop_id IN (SELECT tenant_shop.id FROM shops tenant_shop WHERE ${orderTenantPredicateMysql("tenant_shop", tenantScope)})` : ""}
    ),
    scoped_product_ids AS (
      SELECT DISTINCT product_id FROM scoped_order_items WHERE product_id IS NOT NULL
    ),
    scoped_recipe_product_ids AS (
      SELECT DISTINCT ri.product_id
      FROM sku_inventory_recipes recipe
      JOIN scoped_order_items scoped_item
        ON scoped_item.shop_id = recipe.shop_id AND scoped_item.ozon_sku = recipe.ozon_sku
      JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
      ${tenantScope ? `JOIN products recipe_product ON recipe_product.id = ri.product_id AND ${orderTenantPredicateMysql("recipe_product", tenantScope)}` : ""}
      WHERE recipe.active = 1
    ),
    scoped_component_product_ids AS (
      SELECT DISTINCT pc.component_product_id AS product_id
      FROM product_components pc
      JOIN scoped_product_ids scoped_product ON scoped_product.product_id = pc.product_id
      ${tenantScope ? `JOIN products component_product ON component_product.id = pc.component_product_id AND ${orderTenantPredicateMysql("component_product", tenantScope)}
      WHERE ${orderTenantPredicateMysql("pc", tenantScope)}` : ""}
      UNION
      SELECT product_id FROM scoped_recipe_product_ids
    ),
    scoped_procurement_request_ids AS (
      SELECT DISTINCT allocation.procurement_request_id
      FROM procurement_order_allocations allocation
      JOIN scoped_order_items scoped_item ON scoped_item.order_item_id = allocation.order_item_id AND scoped_item.order_id = allocation.order_id
      WHERE allocation.status = 'allocated'
    )
    SELECT ${summaryOnly ? 'STRAIGHT_JOIN ' : ''}o.*, s.name AS shop_name,
      (SELECT COUNT(*) FROM order_items item_count_oi WHERE item_count_oi.order_id = o.id) AS item_count,
      (SELECT COALESCE(SUM(total_oi.quantity), 0) FROM order_items total_oi WHERE total_oi.order_id = o.id) AS total_quantity,
      (SELECT COALESCE(SUM(revenue_oi.sale_price * revenue_oi.quantity), 0) FROM order_items revenue_oi WHERE revenue_oi.order_id = o.id) AS revenue,
      COALESCE(SUM(COALESCE(oi.estimated_profit, opi.net_profit_cny, 0)), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS actual_profit,
      ${summaryOnly ? '' : `COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,`}
      ${summaryOnly ? '' : `COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,`}
      GROUP_CONCAT(DISTINCT oi.settlement_state) AS settlement_states,
      GROUP_CONCAT(DISTINCT opi.profit_status) AS profit_statuses,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.id) SEPARATOR '||') AS sku_order_item_ids,
       GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.quantity) SEPARATOR '||') AS sku_quantities,
       GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(visible_rule.id, '')) SEPARATOR '||') AS sku_logistics_rule_ids,
       GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', oi.sale_price, ':', oi.quantity) SEPARATOR '||') AS sku_prices,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)) SEPARATOR '||') AS sku_sale_amounts,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(oi.estimated_profit, opi.net_profit_cny, 0)) SEPARATOR '||') AS sku_estimated_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profits,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', CASE
        WHEN opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued' THEN 1
        ELSE 0
      END) SEPARATOR '||') AS sku_actual_profit_ready,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), '')) SEPARATOR '||') AS sku_names,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) SEPARATOR '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN op.ozon_product_id IS NOT NULL AND op.ozon_product_id != '' THEN CONCAT(oi.ozon_sku, ':', op.ozon_product_id) END) AS sku_ozon_product_ids,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), '')) AS order_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.image_url, '') END) AS inventory_image_urls,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.id) END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.name) END SEPARATOR '||') AS sku_inventory_names,
      GROUP_CONCAT(DISTINCT CASE WHEN p.inventory_number IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', p.inventory_number) END SEPARATOR '||') AS sku_inventory_numbers,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', op.id) END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':', sm.id) END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT CASE
        WHEN sku_recipe.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':combo')
        WHEN p.id IS NOT NULL THEN CONCAT(oi.ozon_sku, ':single')
      END) AS sku_inventory_modes,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(stock.fbs_present, 0), ':', COALESCE(stock.fbp_present, 0), ':', COALESCE(sku_recipe_stock.local_stock, parent_component_stock.local_stock, local_stock.local_stock, 0))) AS sku_stock_summaries,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', COALESCE(parent_component_stock.component_count, 0))) AS sku_component_counts,
      GROUP_CONCAT(DISTINCT CONCAT(oi.ozon_sku, ':', GREATEST(COALESCE(purchase_info.pending_incoming_quantity, 0), COALESCE(parent_component_stock.incoming_stock, 0)))) AS sku_incoming_summaries,
      ${summaryOnly ? '' : `GROUP_CONCAT(DISTINCT purchase_info.purchase_order_numbers) AS purchase_order_numbers,`}
      ${summaryOnly ? '' : `GROUP_CONCAT(DISTINCT purchase_info.purchase_tracking_numbers) AS purchase_tracking_numbers,`}
      COALESCE(SUM(procurement_allocation.allocated_quantity), 0) AS procurement_allocated_quantity,
      COALESCE(
        MAX(procurement_allocation.latest_purchase_at),
        MAX(CASE WHEN oipm.handling_type = 'procurement_request' THEN COALESCE(pr_source.created_at, oipm.created_at) END),
        MAX(purchase_info.latest_incoming_purchase_at),
        MAX(parent_component_stock.latest_purchase_at)
      ) AS procurement_latest_purchase_at,
      COALESCE(
        MAX(procurement_allocation.in_transit_days),
        MAX(CASE WHEN oipm.handling_type = 'procurement_request' THEN TIMESTAMPDIFF(DAY, COALESCE(pr_source.created_at, oipm.created_at), CURRENT_TIMESTAMP) END),
        MAX(TIMESTAMPDIFF(DAY, purchase_info.latest_incoming_purchase_at, CURRENT_TIMESTAMP)),
        MAX(TIMESTAMPDIFF(DAY, parent_component_stock.latest_purchase_at, CURRENT_TIMESTAMP))
      ) AS procurement_in_transit_days,
      GREATEST(
        COALESCE(MAX(procurement_allocation.overdue), 0),
        COALESCE(MAX(CASE
          WHEN oipm.handling_type = 'procurement_request'
            AND TIMESTAMPDIFF(HOUR, COALESCE(pr_source.created_at, oipm.created_at), CURRENT_TIMESTAMP) >= 72 THEN 1
          ELSE 0
        END), 0),
        COALESCE(MAX(CASE
          WHEN purchase_info.pending_incoming_quantity > 0
            AND TIMESTAMPDIFF(HOUR, purchase_info.latest_incoming_purchase_at, CURRENT_TIMESTAMP) >= 72 THEN 1
          ELSE 0
        END), 0),
        COALESCE(MAX(CASE
          WHEN parent_component_stock.incoming_stock > 0
            AND TIMESTAMPDIFF(HOUR, parent_component_stock.latest_purchase_at, CURRENT_TIMESTAMP) >= 72 THEN 1
          ELSE 0
        END), 0)
      ) AS procurement_overdue,
      MAX(CASE WHEN procurement_allocation.order_item_id IS NOT NULL THEN 1 ELSE 0 END) AS procurement_has_allocation,
      MAX(CASE WHEN COALESCE(procurement_allocation.pending_incoming_quantity, 0) > 0 THEN 1 ELSE 0 END) AS procurement_has_order_incoming,
      MAX(CASE WHEN COALESCE(purchase_info.pending_incoming_quantity, 0) > 0 OR parent_component_stock.inbound_record_ids IS NOT NULL THEN 1 ELSE 0 END) AS procurement_has_product_incoming,
      MAX(GREATEST(COALESCE(purchase_info.pending_incoming_quantity, 0), COALESCE(parent_component_stock.component_incoming_quantity, 0))) AS procurement_product_incoming_quantity,
      GROUP_CONCAT(DISTINCT procurement_allocation.pending_inbound_record_ids) AS procurement_inbound_record_ids,
      ${summaryOnly ? '' : `COALESCE(MAX(procurement_allocation.person_name), MAX(NULLIF(pr_person.name, '')), MAX(NULLIF(pr_creator.name, '')), MAX(NULLIF(mark_creator.name, '')), '未记录') AS procurement_person_name,`}
      MAX(procurement_allocation.purchase_order_no) AS procurement_purchase_order_no,
      ${summaryOnly ? '' : `MAX(procurement_allocation.product_name) AS procurement_product_name,`}
      COALESCE(MAX(procurement_allocation.pending_incoming_quantity), 0) AS procurement_inbound_quantity,
      ${summaryOnly ? '' : `COALESCE(MAX(procurement_allocation.amount), 0) AS procurement_inbound_amount,`}
      ${summaryOnly ? '' : `COALESCE(MAX(procurement_allocation.shipping_amount), 0) AS procurement_inbound_shipping_amount,`}
      GROUP_CONCAT(DISTINCT procurement_allocation.request_ids) AS procurement_request_ids,
      MIN(procurement_allocation.request_unallocated_quantity) AS procurement_request_unallocated_quantity,
      COUNT(DISTINCT oi.id) AS procurement_total_item_count,
      COUNT(DISTINCT CASE WHEN oipm.id IS NOT NULL OR pr_source.id IS NOT NULL THEN oi.id END) AS procurement_handled_item_count,
      GROUP_CONCAT(DISTINCT COALESCE(oipm.handling_type, CASE WHEN pr_source.id IS NOT NULL THEN 'procurement_request' END)) AS procurement_handling_types,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL AND sku_recipe.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL AND sku_recipe.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL AND sku_recipe.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE
        WHEN p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE
        WHEN p.id IS NOT NULL AND p.code LIKE 'P-%' THEN p.code
        WHEN p.id IS NOT NULL THEN CONCAT('P-', DATE_FORMAT(p.created_at, '%Y%m%d-%H%i%s'), '-', LPAD(p.id, 3, '0'))
        ELSE NULL
      END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, CASE WHEN sku_recipe.id IS NOT NULL THEN '组合库存方案' ELSE 'Unbound product' END)) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CONCAT(COALESCE(p.length_cm, 0), 'x', COALESCE(p.width_cm, 0), 'x', COALESCE(p.height_cm, 0)) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      olp.print_batch_id AS print_batch_id,
      olp.print_sequence AS print_sequence,
      ${summaryOnly ? "NULL" : "raw.raw_json"} AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.quantity > 0
    LEFT JOIN scoped_order_items page_item ON page_item.order_item_id = oi.id AND page_item.order_id = o.id
    LEFT JOIN sku_mappings sm ON sm.id = page_item.mapping_id
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1 ${tenantScope ? `AND ${orderTenantPredicateMysql("p", tenantScope)}` : ""}
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN (
      SELECT snapshot.shop_id, snapshot.ozon_sku,
        SUM(CASE WHEN snapshot.stock_type = 'fbs_virtual' THEN snapshot.present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN snapshot.stock_type = 'fbp_real' THEN snapshot.present ELSE 0 END) AS fbp_present
      FROM ozon_stock_snapshots snapshot
      JOIN (SELECT DISTINCT shop_id, ozon_sku FROM scoped_order_items) scoped_sku
        ON scoped_sku.shop_id = snapshot.shop_id AND scoped_sku.ozon_sku = snapshot.ozon_sku
      GROUP BY snapshot.shop_id, snapshot.ozon_sku
    ) stock ON stock.shop_id = o.shop_id AND stock.ozon_sku = oi.ozon_sku
    LEFT JOIN (
      SELECT inventory_movements.product_id, SUM(inventory_movements.quantity_delta) AS local_stock
      FROM inventory_movements
      JOIN scoped_product_ids scoped_product ON scoped_product.product_id = inventory_movements.product_id
      WHERE status = 'posted'
        ${tenantScope ? `AND ${orderTenantPredicateMysql("inventory_movements", tenantScope)}` : ""}
        AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') != 'FBP'
      GROUP BY inventory_movements.product_id
    ) local_stock ON local_stock.product_id = p.id
    LEFT JOIN sku_inventory_recipes sku_recipe ON sku_recipe.shop_id = o.shop_id
      AND sku_recipe.ozon_sku = oi.ozon_sku
      AND sku_recipe.active = 1
    LEFT JOIN (
      SELECT ri.recipe_id,
        MIN(FLOOR(COALESCE(stock.local_stock, 0) / NULLIF(ri.quantity, 0))) AS local_stock
      FROM sku_inventory_recipe_items ri
      JOIN scoped_component_product_ids scoped_component ON scoped_component.product_id = ri.product_id
      LEFT JOIN (
        SELECT movement.product_id, SUM(movement.quantity_delta) AS local_stock
        FROM inventory_movements movement
        JOIN scoped_component_product_ids scoped_component ON scoped_component.product_id = movement.product_id
        WHERE movement.status = 'posted'
          ${tenantScope ? `AND ${orderTenantPredicateMysql("movement", tenantScope)}` : ""}
          AND ${localStockLocationPredicateMysql("movement")}
        GROUP BY movement.product_id
      ) stock ON stock.product_id = ri.product_id
      GROUP BY ri.recipe_id
    ) sku_recipe_stock ON sku_recipe_stock.recipe_id = sku_recipe.id
    LEFT JOIN (
      SELECT pc.product_id,
        COUNT(*) AS component_count,
        MIN(FLOOR(COALESCE(stock.local_stock, 0) / NULLIF(pc.quantity, 0))) AS local_stock,
        GREATEST(0,
          MIN(FLOOR((COALESCE(stock.local_stock, 0) + COALESCE(incoming.incoming_stock, 0)) / NULLIF(pc.quantity, 0)))
          - MIN(FLOOR(COALESCE(stock.local_stock, 0) / NULLIF(pc.quantity, 0)))
        ) AS incoming_stock,
        SUM(COALESCE(incoming.incoming_stock, 0)) AS component_incoming_quantity,
        MAX(incoming.latest_purchase_at) AS latest_purchase_at,
        GROUP_CONCAT(DISTINCT incoming.inbound_record_ids) AS inbound_record_ids,
        ${summaryOnly ? '' : `MAX(incoming.person_name) AS person_name,`}
        MAX(incoming.purchase_order_no) AS purchase_order_no,
        ${summaryOnly ? '' : `MAX(incoming.product_name) AS product_name,`}
        ${summaryOnly ? '' : `MAX(incoming.amount) AS amount,`}
        ${summaryOnly ? 'NULL AS shipping_amount' : 'MAX(incoming.shipping_amount) AS shipping_amount'}
      FROM product_components pc
      JOIN scoped_product_ids scoped_product ON scoped_product.product_id = pc.product_id
      JOIN products component_product ON component_product.id = pc.component_product_id AND component_product.active = 1 ${tenantScope ? `AND ${orderTenantPredicateMysql("component_product", tenantScope)} AND ${orderTenantPredicateMysql("pc", tenantScope)}` : ""}
      LEFT JOIN (
        SELECT inventory_movements.product_id, SUM(inventory_movements.quantity_delta) AS local_stock
        FROM inventory_movements
        JOIN scoped_component_product_ids scoped_component ON scoped_component.product_id = inventory_movements.product_id
        WHERE status = 'posted'
          ${tenantScope ? `AND ${orderTenantPredicateMysql("inventory_movements", tenantScope)}` : ""}
          AND ${localStockLocationPredicateMysql()}
        GROUP BY inventory_movements.product_id
      ) stock ON stock.product_id = pc.component_product_id
      LEFT JOIN (
        SELECT ir.product_id,
          SUM(ir.quantity) AS incoming_stock,
          MAX(COALESCE(po.purchased_at, ir.created_at)) AS latest_purchase_at,
          GROUP_CONCAT(DISTINCT ir.id ORDER BY ir.id) AS inbound_record_ids,
          ${summaryOnly ? '' : `MAX(COALESCE(NULLIF(pe.name, ''), NULLIF(creator.name, ''), '未记录')) AS person_name,`}
          MAX(po.order_no) AS purchase_order_no,
          ${summaryOnly ? '' : `MAX(product.name) AS product_name,`}
          ${summaryOnly ? '' : `MAX(ir.amount) AS amount,`}
          ${summaryOnly ? 'NULL AS shipping_amount' : 'MAX(ir.shipping_amount) AS shipping_amount'}
        FROM inbound_records ir
        JOIN scoped_component_product_ids scoped_component ON scoped_component.product_id = ir.product_id
        LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id AND ${orderTenantPredicateMysql("po", tenantScope)}
        ${summaryOnly ? '' : `LEFT JOIN people pe ON pe.id = ir.person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = pe.id AND member.active = 1)` : ""}`}
        ${summaryOnly ? '' : `LEFT JOIN people creator ON creator.id = po.created_by_person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = creator.id AND member.active = 1)` : ""}`}
        ${summaryOnly ? '' : `LEFT JOIN products product ON product.id = ir.product_id`}
        WHERE ir.status = 'pending_arrival' AND ${orderTenantPredicateMysql("ir", tenantScope)} AND (ir.purchase_order_id IS NULL OR po.id IS NOT NULL)
        GROUP BY ir.product_id
      ) incoming ON incoming.product_id = pc.component_product_id
      GROUP BY pc.product_id
    ) parent_component_stock ON parent_component_stock.product_id = p.id
    LEFT JOIN (
      SELECT ir.product_id,
        ${summaryOnly ? '' : `GROUP_CONCAT(DISTINCT po.order_no ORDER BY po.order_no SEPARATOR ',') AS purchase_order_numbers,`}
        ${summaryOnly ? '' : `GROUP_CONCAT(DISTINCT COALESCE(NULLIF(ir.note, ''), NULLIF(ir.purchase_url, ''), po.order_no) ORDER BY ir.id SEPARATOR ',') AS purchase_tracking_numbers,`}
        SUM(CASE WHEN ir.status = 'pending_arrival' THEN ir.quantity ELSE 0 END) AS pending_incoming_quantity,
        GROUP_CONCAT(DISTINCT CASE WHEN ir.status = 'pending_arrival' THEN ir.id END ORDER BY ir.id SEPARATOR ',') AS pending_inbound_record_ids,
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN COALESCE(NULLIF(pe.name, ''), NULLIF(creator.name, ''), '未记录') END) AS pending_person_name,`}
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN po.order_no END) AS pending_purchase_order_no,`}
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN product.name END) AS pending_product_name,`}
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN ir.quantity END) AS pending_quantity,`}
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN ir.amount END) AS pending_amount,`}
        ${summaryOnly ? '' : `MAX(CASE WHEN ir.status = 'pending_arrival' THEN ir.shipping_amount END) AS pending_shipping_amount,`}
        MAX(CASE WHEN ir.status = 'pending_arrival' THEN COALESCE(po.purchased_at, ir.created_at) END) AS latest_incoming_purchase_at
      FROM inbound_records ir
      JOIN scoped_product_ids scoped_product ON scoped_product.product_id = ir.product_id
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id AND ${orderTenantPredicateMysql("po", tenantScope)}
      ${summaryOnly ? '' : `LEFT JOIN people pe ON pe.id = ir.person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = pe.id AND member.active = 1)` : ""}`}
      ${summaryOnly ? '' : `LEFT JOIN people creator ON creator.id = po.created_by_person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = creator.id AND member.active = 1)` : ""}`}
      ${summaryOnly ? '' : `LEFT JOIN products product ON product.id = ir.product_id`}
      WHERE ir.purchase_order_id IS NOT NULL AND ${orderTenantPredicateMysql("ir", tenantScope)} AND po.id IS NOT NULL
        ${summaryOnly ? "AND ir.status = 'pending_arrival'" : ''}
      GROUP BY ir.product_id
    ) purchase_info ON purchase_info.product_id = p.id
    LEFT JOIN (
      SELECT allocation.order_item_id,
        SUM(allocation.allocated_quantity) AS allocated_quantity,
        MAX(CASE WHEN allocation_inbound.id IS NOT NULL THEN allocation.allocated_quantity ELSE 0 END) AS pending_incoming_quantity,
        GROUP_CONCAT(DISTINCT allocation_inbound.id ORDER BY allocation_inbound.id) AS pending_inbound_record_ids,
        MAX(request.created_at) AS latest_purchase_at,
        MAX(TIMESTAMPDIFF(DAY, request.created_at, CURRENT_TIMESTAMP)) AS in_transit_days,
        MAX(request.quantity) AS purchase_quantity,
        MAX(allocation_purchase.order_no) AS purchase_order_no,
        ${summaryOnly ? '' : `MAX(allocation_product.name) AS product_name,`}
        ${summaryOnly ? '' : `MAX(request.amount) AS amount,`}
        ${summaryOnly ? '' : `MAX(request.shipping_amount) AS shipping_amount,`}
        ${summaryOnly ? '' : `MAX(COALESCE(NULLIF(request_person.name, ''), NULLIF(request_creator.name, ''), '未记录')) AS person_name,`}
        MAX(CASE
          WHEN request.status NOT IN ('done', 'cancelled', 'inbound_done')
            AND TIMESTAMPDIFF(HOUR, request.created_at, CURRENT_TIMESTAMP) >= 72 THEN 1
          ELSE 0
        END) AS overdue,
        GROUP_CONCAT(DISTINCT request.id ORDER BY request.id) AS request_ids,
        MIN(GREATEST(0, request.quantity - COALESCE(request_allocated.allocated_quantity, 0))) AS request_unallocated_quantity
      FROM procurement_order_allocations allocation
      JOIN scoped_order_items scoped_item ON scoped_item.order_item_id = allocation.order_item_id AND scoped_item.order_id = allocation.order_id
      JOIN procurement_requests request ON request.id = allocation.procurement_request_id
        AND request.status != 'cancelled'
        ${tenantScope ? `AND ${orderTenantPredicateMysql("request", tenantScope)}` : ""}
      ${summaryOnly ? '' : `LEFT JOIN people request_person ON request_person.id = request.person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = request_person.id AND member.active = 1)` : ""}`}
      ${summaryOnly ? '' : `LEFT JOIN people request_creator ON request_creator.id = request.created_by_person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = request_creator.id AND member.active = 1)` : ""}`}
      LEFT JOIN purchase_orders allocation_purchase ON allocation_purchase.id = request.purchase_order_id AND ${orderTenantPredicateMysql("allocation_purchase", tenantScope)}
      ${summaryOnly ? '' : `LEFT JOIN products allocation_product ON allocation_product.id = request.product_id ${tenantScope ? `AND ${orderTenantPredicateMysql("allocation_product", tenantScope)}` : ""}`}
      LEFT JOIN inbound_records allocation_inbound ON allocation_inbound.purchase_order_id = request.purchase_order_id
        AND allocation_inbound.product_id = request.product_id
        AND allocation_inbound.status = 'pending_arrival' AND ${orderTenantPredicateMysql("allocation_inbound", tenantScope)}
      LEFT JOIN (
        SELECT active_allocation.procurement_request_id, SUM(active_allocation.allocated_quantity) AS allocated_quantity
        FROM procurement_order_allocations active_allocation
        JOIN scoped_procurement_request_ids scoped_request
          ON scoped_request.procurement_request_id = active_allocation.procurement_request_id
        JOIN orders allocated_order ON allocated_order.id = active_allocation.order_id
        WHERE active_allocation.status = 'allocated' AND EXISTS (SELECT 1 FROM shops allocated_shop WHERE allocated_shop.id = allocated_order.shop_id AND ${orderTenantPredicateMysql("allocated_shop", tenantScope)})
          AND LOWER(COALESCE(allocated_order.status, '')) NOT LIKE '%cancel%'
          AND LOWER(COALESCE(allocated_order.tracking_stage, '')) NOT LIKE '%cancel%'
        GROUP BY active_allocation.procurement_request_id
      ) request_allocated ON request_allocated.procurement_request_id = request.id
      WHERE allocation.status = 'allocated'
      GROUP BY allocation.order_item_id
    ) procurement_allocation ON procurement_allocation.order_item_id = oi.id
    LEFT JOIN procurement_requests pr_source ON pr_source.source_order_item_id = oi.id AND pr_source.status NOT IN ('cancelled', 'pending', 'suggested') ${tenantScope ? `AND ${orderTenantPredicateMysql("pr_source", tenantScope)}` : ""}
    LEFT JOIN order_item_procurement_marks oipm ON oipm.order_item_id = oi.id AND oipm.status = 'handled'
    ${summaryOnly ? '' : `LEFT JOIN people pr_person ON pr_person.id = pr_source.person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = pr_person.id AND member.active = 1)` : ""}`}
    ${summaryOnly ? '' : `LEFT JOIN people pr_creator ON pr_creator.id = pr_source.created_by_person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = pr_creator.id AND member.active = 1)` : ""}`}
    ${summaryOnly ? '' : `LEFT JOIN people mark_creator ON mark_creator.id = oipm.created_by_person_id ${tenantScope ? `AND EXISTS (SELECT 1 FROM tenant_members member WHERE ${orderTenantPredicateMysql("member", tenantScope)} AND member.person_id = mark_creator.id AND member.active = 1)` : ""}`}
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN logistics_fee_rules visible_rule ON visible_rule.id = oi.frozen_logistics_rule_id AND ${billingScope.sql}
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    ${summaryOnly ? "" : "LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number"}
    WHERE o.id IN (${cleanIds.map(() => "?").join(",")})
      ${tenantScope ? `AND ${orderTenantPredicateMysql("s", tenantScope)}` : ""}
    GROUP BY o.id
  `, [...cleanIds, ...billingScope.params, ...cleanIds]);
  // Keep large raw payloads out of GROUP BY temporary rows. Fetch exactly the
  // same owned source payload after numeric aggregation, before enrichment.
  if (summaryOnly && rows.length) {
    const payloads = await mysqlQuery(`SELECT o.id, raw.raw_json
      FROM orders o JOIN shops s ON s.id=o.shop_id
      LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number
      WHERE o.id IN (${cleanIds.map(() => "?").join(",")}) AND ${orderTenantPredicateMysql("s", tenantScope)}`, cleanIds);
    const byOrder = new Map(payloads.map(row => [Number(row.id), row.raw_json]));
    for (const row of rows) row.raw_json = byOrder.get(Number(row.id)) ?? null;
  }
  const ordering = new Map(cleanIds.map((value, index) => [String(value), index]));
  return (await enrichOrderRowsForListMysql(rows, coveragePromise, Boolean(tenantScope), tenantId)).sort((a, b) => (ordering.get(String(a.id)) ?? 0) - (ordering.get(String(b.id)) ?? 0));
}
