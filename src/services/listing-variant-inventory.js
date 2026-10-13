export function listingVariantInventoryCandidates(rows = [], limit = 20) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.tenant_id, row.draft_id, row.variant_id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [];
  for (const links of groups.values()) {
    if (links.length < 2) continue;
    const ids = new Set(links.flatMap((link) => [link.source_product_id, link.online_inventory_id, link.mapped_inventory_id]
      .map(Number).filter(Boolean)));
    if (ids.size !== 1) continue;
    const needsBinding = links.some((link) => !Number(link.source_product_id)
      || (Number(link.online_row_id) && (!Number(link.online_inventory_id) || !Number(link.mapped_inventory_id))));
    if (!needsBinding) continue;
    const source = links.find((link) => link.ozon_sku && (link.online_inventory_id || link.mapped_inventory_id || link.source_product_id));
    if (!source) continue;
    candidates.push({ tenantKey: String(source.tenant_id), draftId: Number(source.draft_id),
      variantId: String(source.variant_id), shopId: Number(source.shop_id), ozonSku: String(source.ozon_sku),
      offerId: String(source.offer_id || ""), productId: [...ids][0] });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export async function propagateListingVariantInventory(
  { tenantKey, tenantPk, shopId, ozonSku, offerId = "", productId },
  dependencies = {}
) {
  const sku = String(ozonSku || "").trim();
  const inventoryId = Number(productId || 0);
  if (!tenantKey || !tenantPk || !shopId || !sku || !inventoryId) return { linked: 0, bound: 0, conflicts: 0, mapping_ids: [] };
  const runtime = dependencies.query && dependencies.transaction ? dependencies : await import("../mysql-pool.js");
  const query = runtime.query || runtime.mysqlQuery;
  const transaction = runtime.transaction || runtime.withMysqlTransaction;
  let sources;
  try {
    sources = await query(`SELECT DISTINCT l.draft_id, l.variant_id FROM listing_variant_lineage l
      JOIN shops source_shop ON source_shop.id = l.shop_id
        AND (source_shop.tenant_id = ?${tenantKey === "admin" ? " OR source_shop.tenant_id IS NULL" : ""})
      WHERE l.tenant_id = ? AND l.shop_id = ? AND (l.ozon_sku = ? OR (l.ozon_sku = '' AND l.offer_id = ? AND ? <> ''))`,
    [Number(tenantPk), tenantKey, Number(shopId), sku, String(offerId || "").trim(), String(offerId || "").trim()]);
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") return { linked: 0, bound: 0, conflicts: 0, mapping_ids: [] };
    throw error;
  }
  let linked = 0;
  let bound = 0;
  let conflicts = 0;
  const mappingIds = new Set();
  for (const source of sources) {
    const result = await transaction(async (connection) => {
      let groupBound = 0;
      const groupMappingIds = [];
      const [links] = await connection.execute(`SELECT l.id, l.shop_id, l.ozon_sku, l.offer_id, l.inventory_id AS source_product_id
        FROM listing_variant_lineage l JOIN shops s ON s.id = l.shop_id
          AND (s.tenant_id = ?${tenantKey === "admin" ? " OR s.tenant_id IS NULL" : ""})
        WHERE l.tenant_id = ? AND l.draft_id = ? AND l.variant_id = ? FOR UPDATE`,
      [Number(tenantPk), tenantKey, Number(source.draft_id), String(source.variant_id)]);
      if (links.some((link) => Number(link.source_product_id || 0) && Number(link.source_product_id) !== inventoryId)) {
        return { linked: 0, bound: 0, conflict: true };
      }
      await connection.execute(`UPDATE listing_variant_lineage SET ozon_sku = ?
        WHERE tenant_id = ? AND draft_id = ? AND variant_id = ? AND shop_id = ? AND ozon_sku = '' AND offer_id = ?`,
      [sku, tenantKey, Number(source.draft_id), String(source.variant_id), Number(shopId), String(offerId || "").trim()]);
      await connection.execute(`UPDATE listing_publish_variant_links SET ozon_sku = ?
        WHERE tenant_id = ? AND draft_id = ? AND variant_id = ? AND shop_id = ? AND ozon_sku = '' AND offer_id = ?`,
      [sku, tenantKey, Number(source.draft_id), String(source.variant_id), Number(shopId), String(offerId || "").trim()]);
      for (const link of links) {
        if (Number(link.shop_id) === Number(shopId) && String(link.offer_id) === String(offerId || "").trim() && !link.ozon_sku) link.ozon_sku = sku;
        if (link.ozon_sku || !link.offer_id) continue;
        const [matches] = await connection.execute(`SELECT op.ozon_sku FROM online_products op
          JOIN shops s ON s.id = op.shop_id
            AND (s.tenant_id = ?${tenantKey === "admin" ? " OR s.tenant_id IS NULL" : ""})
          WHERE op.shop_id = ? AND op.offer_id = ? AND op.ozon_sku <> '' LIMIT 2`,
        [Number(tenantPk), Number(link.shop_id), String(link.offer_id)]);
        if (matches.length !== 1) continue;
        link.ozon_sku = String(matches[0].ozon_sku);
        await connection.execute("UPDATE listing_variant_lineage SET ozon_sku = ? WHERE id = ? AND tenant_id = ?",
          [link.ozon_sku, Number(link.id), tenantKey]);
        await connection.execute(`UPDATE listing_publish_variant_links SET ozon_sku = ?
          WHERE tenant_id = ? AND draft_id = ? AND variant_id = ? AND shop_id = ? AND offer_id = ? AND ozon_sku = ''`,
        [link.ozon_sku, tenantKey, Number(source.draft_id), String(source.variant_id), Number(link.shop_id), String(link.offer_id || "")]);
      }
      const targetLinks = links.filter((link) => String(link.ozon_sku || "").trim());
      const [conflicts] = await connection.execute(`SELECT l.id FROM listing_variant_lineage l
        JOIN shops s ON s.id = l.shop_id
          AND (s.tenant_id = ?${tenantKey === "admin" ? " OR s.tenant_id IS NULL" : ""})
        JOIN online_products op ON op.shop_id = l.shop_id AND op.ozon_sku = l.ozon_sku COLLATE utf8mb4_0900_ai_ci
        LEFT JOIN sku_mappings sm ON sm.shop_id = l.shop_id AND sm.ozon_sku = l.ozon_sku COLLATE utf8mb4_0900_ai_ci
          AND sm.active = 1 AND (sm.tenant_id = ?${tenantKey === "admin" ? " OR sm.tenant_id IS NULL" : ""})
        WHERE l.tenant_id = ? AND l.draft_id = ? AND l.variant_id = ? AND l.ozon_sku <> ''
          AND ((op.product_id IS NOT NULL AND op.product_id <> ?)
            OR (sm.product_id IS NOT NULL AND sm.product_id <> ?)
            OR (l.inventory_id IS NOT NULL AND l.inventory_id <> ?)) LIMIT 1`,
      [Number(tenantPk), Number(tenantPk), tenantKey, Number(source.draft_id), String(source.variant_id), inventoryId, inventoryId, inventoryId]);
      if (conflicts.length) return { linked: 0, bound: 0, conflict: true };
      for (const link of targetLinks) {
        const [shopRows] = await connection.execute(`SELECT id FROM shops WHERE id = ? AND ${tenantKey === "admin" ? "status <> 'deleted'" : "status = 'active'"}
          AND (tenant_id = ?${tenantKey === "admin" ? " OR tenant_id IS NULL" : ""}) LIMIT 1`,
        [Number(link.shop_id), Number(tenantPk)]);
        if (!shopRows.length) continue;
        const [onlineRows] = await connection.execute(`SELECT op.id, op.offer_id, op.name, op.product_id FROM online_products op
          JOIN shops s ON s.id = op.shop_id
            AND (s.tenant_id = ?${tenantKey === "admin" ? " OR s.tenant_id IS NULL" : ""})
          WHERE op.shop_id = ? AND op.ozon_sku = ? ORDER BY op.id DESC LIMIT 1`,
        [Number(tenantPk), Number(link.shop_id), String(link.ozon_sku)]);
        const online = onlineRows[0] || null;
        if (!online && !String(link.ozon_sku || "").trim()) continue;
        const [mappingRows] = await connection.execute(`SELECT id, product_id FROM sku_mappings
          WHERE shop_id = ? AND ozon_sku = ? AND (tenant_id = ?${tenantKey === "admin" ? " OR tenant_id IS NULL" : ""})
          LIMIT 1 FOR UPDATE`, [Number(link.shop_id), String(link.ozon_sku), Number(tenantPk)]);
        const mapping = mappingRows[0];
        if ((mapping?.product_id && Number(mapping.product_id) !== inventoryId)
          || (online?.product_id && Number(online.product_id) !== inventoryId)) {
          throw new Error("同一草稿变体的线上 SKU 已绑定其他库存，自动绑定已停止");
        }
        if (online) await connection.execute(`UPDATE online_products op JOIN shops s ON s.id = op.shop_id
          AND (s.tenant_id = ?${tenantKey === "admin" ? " OR s.tenant_id IS NULL" : ""})
          SET op.product_id = ?, op.updated_at = CURRENT_TIMESTAMP WHERE op.id = ? AND op.shop_id = ?`,
        [Number(tenantPk), inventoryId, Number(online.id), Number(link.shop_id)]);
        let mappingId = Number(mapping?.id || 0);
        if (mappingId) {
          await connection.execute(`UPDATE sku_mappings SET product_id = ?, tenant_id = ?, online_product_id = COALESCE(?, online_product_id),
            offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            AND (tenant_id = ?${tenantKey === "admin" ? " OR tenant_id IS NULL" : ""})`,
          [inventoryId, Number(tenantPk), online ? Number(online.id) : null, String(online?.offer_id || link.offer_id || ""), String(online?.name || ""), mappingId, Number(tenantPk)]);
        } else {
          const [inserted] = await connection.execute(`INSERT INTO sku_mappings
            (shop_id, tenant_id, product_id, online_product_id, ozon_sku, offer_id, display_name, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [Number(link.shop_id), Number(tenantPk), inventoryId,
            online ? Number(online.id) : null, String(link.ozon_sku), String(online?.offer_id || link.offer_id || ""), String(online?.name || "")]);
          mappingId = Number(inserted.insertId);
        }
        await connection.execute(`UPDATE order_items oi JOIN orders o ON o.id = oi.order_id
          SET oi.sku_mapping_id = ? WHERE o.shop_id = ? AND TRIM(oi.ozon_sku) = ?`,
        [mappingId, Number(link.shop_id), String(link.ozon_sku)]);
        groupMappingIds.push(mappingId);
        groupBound += 1;
      }
      await connection.execute(`UPDATE listing_variant_lineage SET inventory_id = ?
        WHERE tenant_id = ? AND draft_id = ? AND variant_id = ?`,
      [inventoryId, tenantKey, Number(source.draft_id), String(source.variant_id)]);
      await connection.execute(`UPDATE listing_publish_variant_links SET source_product_id = ?
        WHERE tenant_id = ? AND draft_id = ? AND variant_id = ?`,
      [inventoryId, tenantKey, Number(source.draft_id), String(source.variant_id)]);
      return { linked: links.length, bound: groupBound, mapping_ids: groupMappingIds };
    });
    linked += result.linked;
    bound += result.bound;
    if (result.conflict) conflicts += 1;
    for (const id of result.mapping_ids || []) mappingIds.add(id);
  }
  return { linked, bound, conflicts, mapping_ids: [...mappingIds] };
}
