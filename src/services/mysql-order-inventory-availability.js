const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503 });

export function orderInventoryAvailabilityIds(query = {}) {
  const values = String(query.orderIds ?? query.order_ids ?? "").split(",").map((value) => value.trim());
  if (!values.length || values.length > 100 || values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw Object.assign(new Error("请提供 1 至 100 个有效的订单 ID（orderIds）"), { statusCode: 400 });
  }
  return [...new Set(values.map(Number))];
}

// Only product facts are projected here. Order allocation and purchase coverage
// remain owned by the full procurement reconciliation path.
export async function loadOrderInventoryAvailability({ query, loadBalances }, request = {}, { tenantId = null, defaultTenantId } = {}) {
  const orderIds = orderInventoryAvailabilityIds(request);
  const defaultTenant = Number(defaultTenantId);
  const tenant = tenantId == null ? null : Number(tenantId);
  if (!Number.isSafeInteger(defaultTenant) || defaultTenant <= 0
    || (tenant !== null && (!Number.isSafeInteger(tenant) || tenant <= 0))) {
    throw unavailable("企业库存上下文无效，无法读取订单库存数量");
  }
  const placeholders = orderIds.map(() => "?").join(",");
  const scope = tenant === null ? "" : " AND s.tenant_id = ? AND s.status = 'active'";
  const args = tenant === null ? orderIds : [...orderIds, tenant];
  const orders = await query(`SELECT o.id AS order_id, s.tenant_id
    FROM orders o JOIN shops s ON s.id = o.shop_id
    WHERE o.id IN (${placeholders})${scope}`, args);
  const byOrder = new Map(orders.map((row) => [Number(row.order_id), row]));
  if (byOrder.size !== orderIds.length || orderIds.some((id) => !byOrder.has(id))) {
    throw Object.assign(new Error("订单不存在或不属于当前企业"), { statusCode: 404 });
  }
  const tenantByOrder = new Map();
  for (const id of orderIds) {
    const value = byOrder.get(id).tenant_id;
    const actualTenant = value == null ? defaultTenant : Number(value);
    if (!Number.isSafeInteger(actualTenant) || actualTenant <= 0 || (tenant !== null && actualTenant !== tenant)) {
      throw unavailable("订单所属企业无效，无法读取库存数量");
    }
    tenantByOrder.set(id, actualTenant);
  }
  // The order's shop is authoritative, including when an administrator reads
  // several tenants. Null ownership is accepted only for the default legacy data.
  const owned = (alias) => `(${alias}.tenant_id = COALESCE(s.tenant_id, ${defaultTenant})
    OR (${alias}.tenant_id IS NULL AND COALESCE(s.tenant_id, ${defaultTenant}) = ${defaultTenant}))`;
  const products = await query(`SELECT DISTINCT oi.order_id, child.id AS product_id,
      COALESCE(s.tenant_id, ${defaultTenant}) AS tenant_id
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings direct_mapping ON direct_mapping.id = oi.sku_mapping_id
      AND direct_mapping.shop_id = o.shop_id AND direct_mapping.active = 1 AND ${owned("direct_mapping")}
    LEFT JOIN sku_mappings sm ON sm.id = COALESCE(direct_mapping.id, (
      SELECT MIN(fallback_mapping.id) FROM sku_mappings fallback_mapping
      WHERE fallback_mapping.shop_id = o.shop_id AND fallback_mapping.ozon_sku = oi.ozon_sku
        AND fallback_mapping.active = 1 AND ${owned("fallback_mapping")}
    )) AND ${owned("sm")}
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1 AND ${owned("p")}
    LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id = o.shop_id AND recipe.ozon_sku = oi.ozon_sku
      AND recipe.active = 1 AND recipe.mode = 'combo'
    LEFT JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
    LEFT JOIN product_components pc ON pc.product_id = p.id AND recipe.id IS NULL AND ${owned("pc")}
    JOIN products child ON child.id = CASE WHEN recipe.id IS NOT NULL THEN ri.product_id
      WHEN pc.component_product_id IS NOT NULL THEN pc.component_product_id ELSE p.id END
      AND child.active = 1 AND ${owned("child")}
    WHERE oi.order_id IN (${placeholders})${scope}`, args);
  const productsByOrder = new Map(orderIds.map((id) => [id, new Set()]));
  const productsByTenant = new Map();
  for (const row of products) {
    const id = Number(row.order_id), productId = Number(row.product_id);
    if (!productsByOrder.has(id) || !Number.isSafeInteger(productId) || productId <= 0
      || Number(row.tenant_id) !== tenantByOrder.get(id)) {
      throw unavailable("订单库存关联无效，请刷新后重试");
    }
    productsByOrder.get(id).add(productId);
    const actualTenant = tenantByOrder.get(id);
    if (!productsByTenant.has(actualTenant)) productsByTenant.set(actualTenant, new Set());
    productsByTenant.get(actualTenant).add(productId);
  }
  const factsByTenant = new Map();
  for (const [actualTenant, productSet] of productsByTenant) {
    const ids = [...productSet].sort((a, b) => a - b), facts = new Map();
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const balances = await loadBalances(batch, actualTenant, actualTenant === defaultTenant, String(request.refresh || "") === "1");
      for (const productId of batch) {
        const balance = balances.get(productId);
        if (!balance || balance.physical_stock == null || balance.available_stock == null
          || !Number.isFinite(Number(balance.physical_stock)) || !Number.isFinite(Number(balance.available_stock))) {
          throw unavailable("订单库存数量暂不可用，请稍后重试");
        }
        facts.set(productId, {
          product_id: productId, physical_stock: Number(balance.physical_stock), available_stock: Number(balance.available_stock),
          inventory_needs_review: Boolean(Number(balance.inventory_needs_review))
        });
      }
    }
    factsByTenant.set(actualTenant, facts);
  }
  return { rows: orderIds.map((id) => ({
    order_id: id,
    inventory_availability: [...productsByOrder.get(id)].sort((a, b) => a - b)
      .map((productId) => factsByTenant.get(tenantByOrder.get(id)).get(productId))
  })) };
}
