import { randomUUID } from "node:crypto";
import { mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { inventoryTenantSql, resolveInventoryTenantScope, assertInventoryRecord, assertInventoryMember } from "./inventory-tenant-scope.js";
import { inventoryProductBalanceQueries, buildInventoryProductBalances, invalidateInventoryProductBalance } from "./mysql-inventory-product-balance.js";
import { invalidateOrderProcurementCoverage } from "./mysql-order-procurement-coverage.js";
import { loadProductFbpStocks } from "./fbp-inventory-display.js";
import { orderTransportEvidenceSql } from "./order-transport-evidence.js";
import { calculateFlowProduct, validateFlowSettings, whole, flowError } from "./inventory-flow-rules.js";
import { shanghaiDateKey, shanghaiDateDaysAgo } from "../shanghai-time.js";

const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const changed = () => { invalidateInventoryProductBalance(); invalidateOrderProcurementCoverage(); };

export function createInventoryFlowService({ query = mysqlQuery, transaction = withMysqlTransaction } = {}) {
  const connectionQuery = connection => async (sql, params = []) => (await connection.query(sql, params))[0];
  async function balances(scope, ids, q = query) {
    if (!ids.length) return new Map();
    const rows = [];
    // Also used under product locks; avoid opening a second transaction or cached projection.
    for (const sql of inventoryProductBalanceQueries(scope.id, scope.isDefault, ids)) rows.push(await q(sql));
    return new Map(buildInventoryProductBalances(ids, ...rows).map(row => [row.product_id, row]));
  }
  async function settings(scope, productId = 0, q = query) {
    const rows = await q("SELECT product_id, settings_json, revision FROM inventory_flow_settings WHERE tenant_id = ? AND product_id IN (0, ?)", [scope.id, productId]);
    const defaults = parse(rows.find(row => !Number(row.product_id))?.settings_json || {});
    const override = parse(rows.find(row => Number(row.product_id) === productId)?.settings_json || {});
    return { ...validateFlowSettings({ ...defaults, ...override, holidays: defaults.holidays || [] }), revision: Number(rows.find(row => Number(row.product_id) === productId)?.revision || 0) };
  }
  async function product(scope, id, balance, q = query, officialStocks = null) {
    const [p] = await q(`SELECT p.id, p.name, p.code, p.inventory_number,
      CASE WHEN p.image_url LIKE 'data:image/%' THEN CONCAT('/api/products/',p.id,'/image?thumb=1') ELSE p.image_url END AS image_url, p.production_lead_days,
      p.warehouse_logistics_days, DATEDIFF(UTC_TIMESTAMP(), p.created_at) AS created_days
      FROM products p WHERE p.id = ? AND p.active = 1 AND ${inventoryTenantSql(scope, "p")}`, [id]);
    if (!p) throw flowError("库存产品不存在或不属于当前企业", 404);
    const cfg = await settings(scope, id, q);
    const official = officialStocks || await loadProductFbpStocks(q, id, scope);
    const groups = new Map();
    for (const row of official.rows) {
      const key = `${row.shop_id}:${row.ozon_sku}`;
      if (!groups.has(key)) groups.set(key, { shop_id: Number(row.shop_id), shop_name: row.shop_name, ozon_sku: row.ozon_sku,
        offer_id: row.offer_id || "", mapping_id: row.mapping_id || null, per_set_quantity: Number(row.per_set_quantity), present: row.present == null ? null : 0,
        available: row.available == null ? null : 0, synced_at: row.synced_at, in_transit: 0, sales: {} });
      const sku = groups.get(key);
      sku.present = sku.present == null || row.present == null ? null : sku.present + Number(row.present);
      sku.available = sku.available == null || row.available == null ? null : sku.available + Number(row.available);
      if (row.synced_at && (!sku.synced_at || row.synced_at < sku.synced_at)) sku.synced_at = row.synced_at;
    }
    const skus = [...groups.values()];
    if (skus.length) {
      const mappings = await q(`SELECT m.id, m.shop_id, m.ozon_sku, m.product_id FROM sku_mappings m
        WHERE m.active = 1 AND ${inventoryTenantSql(scope, "m")} AND m.product_id = ?`, [id]);
      for (const sku of skus) sku.mapping_id = mappings.find(row => Number(row.shop_id) === sku.shop_id && row.ozon_sku === sku.ozon_sku)?.id || sku.mapping_id || null;
      const bindings = skus.map(() => "(o.shop_id = ? AND oi.ozon_sku = ?)").join(" OR ");
      const sales = await q(`SELECT o.shop_id, oi.ozon_sku,
        SUM(CASE WHEN o.ordered_at >= ? THEN oi.quantity ELSE 0 END) AS w1,
        SUM(CASE WHEN o.ordered_at >= ? AND o.ordered_at < ? THEN oi.quantity ELSE 0 END) AS w2,
        SUM(CASE WHEN o.ordered_at >= ? AND o.ordered_at < ? THEN oi.quantity ELSE 0 END) AS w3,
        SUM(CASE WHEN o.ordered_at >= ? AND o.ordered_at < ? THEN oi.quantity ELSE 0 END) AS w4,
        SUM(CASE WHEN o.ordered_at >= ? THEN oi.quantity ELSE 0 END) AS d14,
        SUM(oi.quantity) AS d60,
        SUM(CASE WHEN o.ordered_at >= ? AND EXISTS (SELECT 1 FROM ozon_orders_raw raw
          WHERE raw.store_id=o.shop_id AND raw.posting_number=o.posting_number AND raw.query_stock_location IN ('FBP','OGR')) THEN oi.quantity ELSE 0 END) AS fbp14,
        SUM(CASE WHEN o.ordered_at >= ? AND NOT EXISTS (SELECT 1 FROM ozon_orders_raw raw
          WHERE raw.store_id = o.shop_id AND raw.posting_number = o.posting_number AND raw.query_stock_location IN ('FBP','OGR')) THEN oi.quantity ELSE 0 END) AS fbs7
        FROM orders o JOIN shops shop ON shop.id = o.shop_id AND ${inventoryTenantSql(scope, "shop")}
        JOIN order_items oi ON oi.order_id = o.id
        WHERE (${bindings}) AND o.ordered_at >= ? AND o.ordered_at < ?
          AND ((LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) NOT LIKE '%cancel%') OR ${orderTransportEvidenceSql("o")})
          AND NOT EXISTS (SELECT 1 FROM order_items newer WHERE newer.order_id = oi.order_id
            AND newer.ozon_sku = oi.ozon_sku AND newer.id > oi.id)
        GROUP BY o.shop_id, oi.ozon_sku`, [
        dayStart(7), dayStart(14), dayStart(7), dayStart(21), dayStart(14), dayStart(28), dayStart(21), dayStart(14), dayStart(14), dayStart(7),
        ...skus.flatMap(row => [row.shop_id, row.ozon_sku]), dayStart(60), dayStart(0)
      ]);
      const transit = await q(`SELECT f.shop_id, f.ozon_sku, SUM(GREATEST(f.quantity - f.listed_quantity, 0)) AS quantity
        FROM fbp_transfer_records f JOIN shops s ON s.id = f.shop_id AND ${inventoryTenantSql(scope, "s")}
        WHERE f.status IN ('sent','in_transit','received') AND (${skus.map(() => '(f.shop_id = ? AND f.ozon_sku = ?)').join(' OR ')})
        GROUP BY f.shop_id, f.ozon_sku`, skus.flatMap(row => [row.shop_id, row.ozon_sku]));
      const planned = await q(`SELECT i.shop_id, i.ozon_sku,
        SUM(CASE WHEN o.status IN ('pending_review') THEN i.requested_qty ELSE 0 END) AS pending_qty,
        SUM(CASE WHEN o.status IN ('approved','ozon_created') THEN GREATEST(0,i.approved_qty + COALESCE((SELECT SUM(a.adjustment_qty) FROM fbp_replenishment_item_adjustments a WHERE a.item_id = i.id),0)) ELSE 0 END) AS committed_qty
        FROM fbp_replenishment_order_items i JOIN fbp_replenishment_orders o ON o.id = i.order_id
        JOIN shops s ON s.id = o.shop_id AND ${inventoryTenantSql(scope, 's')}
        WHERE i.product_id = ? GROUP BY i.shop_id, i.ozon_sku`, [id]);
      for (const sku of skus) {
        sku.sales = sales.find(row => Number(row.shop_id) === sku.shop_id && row.ozon_sku === sku.ozon_sku) || {};
        sku.in_transit = Number(transit.find(row => Number(row.shop_id) === sku.shop_id && row.ozon_sku === sku.ozon_sku)?.quantity || 0);
        const plan = planned.find(row => Number(row.shop_id) === sku.shop_id && row.ozon_sku === sku.ozon_sku);
        sku.pending_qty = Number(plan?.pending_qty || 0); sku.committed_qty = Number(plan?.committed_qty || 0);
      }
    }
    const [incoming] = await q(`SELECT COALESCE(SUM(ir.quantity),0) AS quantity FROM inbound_records ir
      JOIN products p ON p.id = ir.product_id AND ${inventoryTenantSql(scope, "p")}
      LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id AND ${inventoryTenantSql(scope, "po")}
      LEFT JOIN procurement_requests pr ON pr.id = ir.procurement_request_id AND ${inventoryTenantSql(scope, "pr")}
      WHERE ir.product_id = ? AND ${inventoryTenantSql(scope, "ir")} AND ir.status = 'pending_arrival'
        AND ((po.status IN ('purchased','partial_inbound') AND po.purchased_at IS NOT NULL) OR pr.status = 'purchased')`, [id]);
    return calculateFlowProduct({ ...p, incoming_stock: Number(incoming.quantity) }, balance, skus, cfg);
  }
  async function list(filters, tenantId) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    const page = Math.max(1, whole(filters.page || 1, "页码")), pageSize = Math.max(1, Math.min(30, whole(filters.pageSize || 20, "每页条数")));
    const text = String(filters.query || "").trim().slice(0, 100), args = [];
    let where = `p.active = 1 AND ${inventoryTenantSql(scope, "p")} AND (COALESCE(p.product_type,'main') != 'selection'
      OR EXISTS (SELECT 1 FROM sku_mappings m WHERE m.product_id = p.id AND m.active = 1 AND ${inventoryTenantSql(scope, "m")}))`;
    if (text) { where += ` AND (p.name LIKE ? OR p.code LIKE ? OR EXISTS (SELECT 1 FROM sku_mappings m WHERE m.product_id = p.id AND m.active = 1 AND ${inventoryTenantSql(scope, "m")} AND m.ozon_sku LIKE ?))`; args.push(...Array(3).fill(`%${text}%`)); }
    const [count] = await query(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`, args);
    const products = await query(`SELECT p.id FROM products p WHERE ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...args, pageSize, (page - 1) * pageSize]);
    const balance = await balances(scope, products.map(row => Number(row.id)));
    const rows = [];
    // Keep the SQL pool bounded even when a page has many SKU/warehouse bindings.
    for (let i = 0; i < products.length; i += 3) rows.push(...await Promise.all(products.slice(i, i + 3).map(row => product(scope, Number(row.id), balance.get(Number(row.id))))));
    return { rows, total: Number(count.total), page, pageSize, settings: await settings(scope), calculated_at: new Date().toISOString() };
  }
  async function detail(id, tenantId, { balance, official } = {}) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    await assertInventoryRecord(scope, "product", id, query);
    return product(scope, Number(id), balance || (await balances(scope, [Number(id)])).get(Number(id)), query, official);
  }
  async function saveSettings(body, tenantId, personId) {
    const scope = await resolveInventoryTenantScope(tenantId, query), id = whole(body.product_id || 0, "库存编号");
    if (id) await assertInventoryRecord(scope, "product", id, query);
    const value = validateFlowSettings(body.settings);
    if(!id&&value.local_safety_override!=null)throw flowError("人工保障数量只允许设置到具体库存商品，请选择库存后修改");
    await transaction(async connection => {
      const q = connectionQuery(connection);
      await assertInventoryMember(scope, personId, q);
      if(id){
        await assertInventoryRecord(scope,'product',id,q,{lock:true});
        if(value.production_days!=null&&![1,2,3,5,7,10,15,30].includes(value.production_days))throw flowError('生产周期须与库存商品一致，请选择1、2、3、5、7、10、15或30天');
        if(value.local_days!=null&&(value.local_days<1||value.local_days>5))throw flowError('运往本地仓周期须为1至5天，请在本地保障规则中修改');
        if(value.production_days!=null||value.local_days!=null)await q(`UPDATE products SET production_lead_days=COALESCE(?,production_lead_days),warehouse_logistics_days=COALESCE(?,warehouse_logistics_days),updated_at=CURRENT_TIMESTAMP WHERE id=? AND ${inventoryTenantSql(scope)}`,[value.production_days,value.local_days,id]);
      }
      const [row] = await q("SELECT revision FROM inventory_flow_settings WHERE tenant_id = ? AND product_id = ? FOR UPDATE", [scope.id, id]);
      if (Number(row?.revision || 0) !== whole(body.revision ?? 0, "规则版本")) throw flowError("规则已被其他同事修改，请刷新后重试", 409);
      await q(`INSERT INTO inventory_flow_settings (tenant_id, product_id, settings_json, updated_by) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_by = VALUES(updated_by), revision = revision + 1`, [scope.id, id, JSON.stringify(value), personId]);
      await audit(q, scope, personId, "settings", { product_id: id, settings: value }, null, id || null);
    });
    changed();
    return { ok: true };
  }
  async function audit(q, scope, actor, action, data, orderId = null, productId = null) {
    await q("INSERT INTO inventory_flow_events (tenant_id, order_id, product_id, person_id, action, detail_json) VALUES (?,?,?,?,?,?)", [scope.id, orderId, productId, actor, action, JSON.stringify(data)]);
  }
  async function history(filters, tenantId) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    return query(`SELECT e.*, p.name AS person_name FROM inventory_flow_events e
      LEFT JOIN people p ON p.id = e.person_id AND EXISTS (SELECT 1 FROM tenant_members m WHERE m.tenant_id = e.tenant_id AND m.person_id = p.id AND m.active = 1)
      WHERE e.tenant_id = ? ${filters.order_id ? "AND e.order_id = ?" : ""} ORDER BY e.id DESC LIMIT 200`, [scope.id, ...(filters.order_id ? [whole(filters.order_id, "备货编号")] : [])]);
  }
  async function tasks(tenantId) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    const orders = await query(`SELECT o.*, f.revision, f.locked, s.name AS shop_name FROM inventory_flow_tasks f
      JOIN fbp_replenishment_orders o ON o.id = f.order_id JOIN shops s ON s.id = o.shop_id AND ${inventoryTenantSql(scope, "s")}
      WHERE f.tenant_id = ? ORDER BY o.id DESC LIMIT 100`, [scope.id]);
    if (!orders.length) return [];
    const items = await query(`SELECT i.* FROM fbp_replenishment_order_items i
      JOIN inventory_flow_tasks f ON f.order_id = i.order_id AND f.tenant_id = ?
      WHERE i.order_id IN (${orders.map(() => '?').join(',')}) ORDER BY i.id`, [scope.id, ...orders.map(row => row.id)]);
    const transfers = await query(`SELECT f.* FROM fbp_transfer_records f JOIN fbp_replenishment_order_items i
      ON f.source_type = 'fbp_replenishment' AND f.source_ref = CONCAT('fbp_replenishment:', i.order_id, ':', i.id)
      JOIN inventory_flow_tasks task ON task.order_id = i.order_id AND task.tenant_id = ?
      WHERE task.order_id IN (${orders.map(() => '?').join(',')})`, [scope.id, ...orders.map(row => row.id)]);
    return orders.map(row => ({ ...row, items: items.filter(item => Number(item.order_id) === Number(row.id)),
      transfers: transfers.filter(transfer => String(transfer.source_ref).split(':')[1] === String(row.id)) }));
  }
  async function validateItem(scope, item, q) {
    const id = whole(item.mapping_id, "SKU绑定编号");
    const mapping = await assertInventoryRecord(scope, "mapping", id, q);
    if (!mapping.active) throw flowError("SKU绑定已停用，请先在SKU绑定页面修复");
    const [compositions] = await q(`SELECT (SELECT COUNT(*) FROM product_components WHERE product_id = ?)
      + (SELECT COUNT(*) FROM sku_inventory_recipes WHERE shop_id = ? AND ozon_sku = ? AND active = 1 AND mode = 'combo') AS quantity`, [mapping.product_id, mapping.shop_id, mapping.ozon_sku]);
    if (Number(compositions.quantity)) throw flowError("组合SKU可以查看实物需求；本轮备货写入暂不支持组合SKU，请使用原备货流程处理，避免重复扣减组成件");
    return mapping;
  }
  async function createTask(body, tenantId, personId) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw flowError("请勾选1至100条SKU并填写备货件数");
    const key = String(body.request_key || "");
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(key)) throw flowError("提交标识无效，请重新打开备货申请");
    return transaction(async connection => {
      const q = connectionQuery(connection);
      await assertInventoryMember(scope, personId, q);
      await q("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [scope.id]);
      const existing = await q("SELECT order_id FROM inventory_flow_tasks WHERE tenant_id = ? AND request_key LIKE ?", [scope.id, `${key}:%`]);
      if (existing.length) return { ok: true, order_ids: existing.map(row => row.order_id) };
      const groups = new Map(), seen = new Set();
      for (const item of body.items) {
        const mapping = await validateItem(scope, item, q), quantity = whole(item.quantity, "申请件数");
        if (!quantity || seen.has(Number(mapping.id))) throw flowError("申请数量需大于0，同一SKU不可重复提交");
        seen.add(Number(mapping.id));
        if (!groups.has(mapping.shop_id)) groups.set(mapping.shop_id, []);
        groups.get(mapping.shop_id).push({ mapping, quantity });
      }
      const ids = [];
      for (const [shopId, items] of groups) {
        const order = await q(`INSERT INTO fbp_replenishment_orders (order_no, shop_id, order_date, status, created_by, note)
          VALUES (?,?,?,'pending_review',?,?)`, [`FLOW-${randomUUID()}`, shopId, shanghaiDateKey(), personId, String(body.note || "库存流转中心申请").slice(0, 1000)]);
        const orderId = order.insertId;
        await q("INSERT INTO inventory_flow_tasks (order_id, tenant_id, request_key) VALUES (?,?,?)", [orderId, scope.id, `${key}:${shopId}`]);
        for (const { mapping, quantity } of items) {
          const [p] = await q("SELECT name FROM products WHERE id = ?", [mapping.product_id]);
          await q(`INSERT INTO fbp_replenishment_order_items (order_id, shop_id, product_id, mapping_id, ozon_sku, offer_id, product_name, requested_qty, requested_by)
            VALUES (?,?,?,?,?,?,?,?,?)`, [orderId, shopId, mapping.product_id, mapping.id, mapping.ozon_sku, mapping.offer_id || "", p.name, quantity, personId]);
        }
        await audit(q, scope, personId, "create", { items: items.map(row => ({ mapping_id: row.mapping.id, quantity: row.quantity })) }, orderId);
        ids.push(orderId);
      }
      return { ok: true, order_ids: ids };
    });
  }
  async function mutateTask(body, tenantId, personId) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    const orderId = whole(body.order_id, "备货编号");
    const result = await transaction(async connection => {
      const q = connectionQuery(connection);
      await assertInventoryMember(scope, personId, q);
      const [task] = await q(`SELECT o.*, f.revision, f.locked, f.snapshot_json FROM inventory_flow_tasks f
        JOIN fbp_replenishment_orders o ON o.id = f.order_id JOIN shops s ON s.id = o.shop_id AND ${inventoryTenantSql(scope, "s")}
        WHERE f.tenant_id = ? AND o.id = ? FOR UPDATE`, [scope.id, orderId]);
      if (!task) throw flowError("备货单不存在或不属于当前企业", 404);
      if (Number(task.revision) !== Number(body.revision)) throw flowError("备货单已被修改，请刷新后重新核对", 409);
      const items = await q("SELECT * FROM fbp_replenishment_order_items WHERE order_id = ? ORDER BY id FOR UPDATE", [orderId]);
      const ids = [...new Set(items.map(row => Number(row.product_id)))].sort((a, b) => a - b);
      for (const id of ids) await assertInventoryRecord(scope, "product", id, q, { lock: true });
      const action = String(body.action || "");
      if (["edit", "lock"].includes(action)) {
        if (task.locked || task.status !== "pending_review") throw flowError("仓管已确认本次版本，不能修改；新增需求请新建申请", 409);
        if (!Array.isArray(body.items) || body.items.length !== items.length) throw flowError("请提交本单完整SKU数量，刷新后重试");
        if (action === "lock" && Number(task.created_by) === Number(personId)) throw flowError("请由其他仓库同事确认自己提交的申请");
        const seen = new Set(), needs = new Map();
        for (const input of body.items) {
          const item = items.find(row => Number(row.id) === Number(input.id));
          if (!item || seen.has(item.id)) throw flowError("SKU明细重复或不属于本单");
          seen.add(item.id);
          const qty = whole(input.quantity, action === "lock" ? "实际配货件数" : "申请件数");
          if (action === "lock" && qty > Number(item.requested_qty)) throw flowError("实际配货不能超过申请数，请运营先调整申请");
          const mapping = await validateItem(scope, { mapping_id: item.mapping_id }, q);
          if (Number(mapping.product_id) !== Number(item.product_id) || Number(mapping.shop_id) !== Number(item.shop_id) || mapping.ozon_sku !== item.ozon_sku) throw flowError("SKU绑定发生变化，请核对本次申请", 409);
          needs.set(Number(item.product_id), (needs.get(Number(item.product_id)) || 0) + qty);
          await q(`UPDATE fbp_replenishment_order_items SET ${action === "lock" ? "approved_qty" : "requested_qty"} = ? WHERE id = ?`, [qty, item.id]);
        }
        if (![...needs.values()].some(qty => qty > 0)) throw flowError("本次总数量必须大于0");
        if (action === "lock") {
          const balance = await balances(scope, ids, q);
          for (const id of ids) {
            const current = await product(scope, id, balance.get(id), q);
            if (needs.get(id) > current.free_qty) throw flowError(`${current.name}目前最多可配${current.free_qty}件；请保留订单与安全库存后调整本次配货`, 409);
          }
          await q("UPDATE fbp_replenishment_orders SET status = 'approved', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE id = ?", [personId, orderId]);
          const snapshot = await q("SELECT id, mapping_id, product_id, requested_qty, approved_qty FROM fbp_replenishment_order_items WHERE order_id = ? ORDER BY id", [orderId]);
          await q("UPDATE inventory_flow_tasks SET locked = 1, snapshot_json = ? WHERE order_id = ?", [JSON.stringify(snapshot), orderId]);
        }
      } else if (action === "ship") {
        if (!task.locked || task.status !== "approved") throw flowError("本次已发运或尚未锁定，请刷新查看", 409);
        const snapshot = parse(task.snapshot_json || []);
        const current = items.map(({ id, mapping_id, product_id, requested_qty, approved_qty }) => ({ id, mapping_id, product_id, requested_qty, approved_qty }));
        const [adjustments] = await q(`SELECT COUNT(*) AS quantity FROM fbp_replenishment_item_adjustments a
          JOIN fbp_replenishment_order_items i ON i.id = a.item_id WHERE i.order_id = ?`, [orderId]);
        const sameSnapshot = snapshot.length === current.length && current.every(item => {
          const saved = snapshot.find(row => Number(row.id) === Number(item.id));
          return saved && Object.keys(item).every(key => Number(saved[key]) === Number(item[key]));
        });
        if (!sameSnapshot || Number(adjustments.quantity)) throw flowError("本单已被其他入口调整，与锁定版本不一致；请停止发运并联系管理员核对", 409);
        for (const item of items.filter(row => Number(row.approved_qty) > 0)) {
          const qty = Number(item.approved_qty);
          const mapping = await validateItem(scope, { mapping_id: item.mapping_id }, q);
          if (Number(mapping.product_id) !== Number(item.product_id) || Number(mapping.shop_id) !== Number(item.shop_id) || mapping.ozon_sku !== item.ozon_sku) throw flowError("SKU绑定已变化，不能按旧绑定发运", 409);
          const transfer = await q(`INSERT INTO fbp_transfer_records (product_id, mapping_id, shop_id, ozon_sku, quantity, status, source_type, source_ref, person_id, shipped_at, expected_arrival_at)
            VALUES (?,?,?,?,?,'sent','fbp_replenishment',?,?,UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`,
          [item.product_id, item.mapping_id, item.shop_id, item.ozon_sku, qty, `fbp_replenishment:${orderId}:${item.id}`, personId, (await settings(scope, Number(item.product_id), q)).fbp_days]);
          await q(`INSERT INTO inventory_movements (tenant_id, product_id, shop_id, sku_mapping_id, source_type, source_ref, quantity_delta, stock_location, stock_location_source, movement_type, owner_person_id, note)
            VALUES (?,?,?,?,'fbp_transfer_outbound',?,?,'LOCAL','inventory_flow','OUTBOUND',?,?)`,
          [scope.id, item.product_id, item.shop_id, item.mapping_id, `fbp_replenishment:${orderId}:${item.id}:outbound`, -qty, personId, `库存流转中心备货 ${task.order_no}`]);
        }
        await q("UPDATE fbp_replenishment_orders SET status = 'sent' WHERE id = ?", [orderId]);
      } else if (action === "receive") {
        if (task.status !== 'sent') throw flowError("本单尚未发运或已经全部到仓，请刷新核对", 409);
        const [transfer] = await q(`SELECT f.* FROM fbp_transfer_records f JOIN fbp_replenishment_order_items i
          ON f.source_type = 'fbp_replenishment' AND f.source_ref = CONCAT('fbp_replenishment:', i.order_id, ':', i.id)
          WHERE i.order_id = ? AND f.id = ? FOR UPDATE`, [orderId, whole(body.transfer_id, '发运记录编号')]);
        const received = whole(body.received_quantity, '本次实际到仓件数');
        if (!transfer || !received || received > Number(transfer.quantity) - Number(transfer.listed_quantity)) throw flowError('到仓数量须大于0且不超过本批剩余在途');
        const next = Number(transfer.listed_quantity) + received;
        await q("UPDATE fbp_transfer_records SET listed_quantity = ?, status = ?, closed_at = IF(? = quantity, UTC_TIMESTAMP(), closed_at) WHERE id = ?", [next, next === Number(transfer.quantity) ? 'listed' : 'received', next, transfer.id]);
        await q(`INSERT INTO inventory_movements (tenant_id, product_id, shop_id, sku_mapping_id, source_type, source_ref, quantity_delta, stock_location, stock_location_source, movement_type, owner_person_id, note)
          VALUES (?,?,?,?,'fbp_transfer_received',?,?,'FBP','inventory_flow','INBOUND',?,'库存流转中心确认到仓')`,
        [scope.id, transfer.product_id, transfer.shop_id, transfer.mapping_id, `flow:${transfer.id}:${task.revision}`, received, personId]);
        const [pending] = await q(`SELECT SUM(GREATEST(f.quantity - f.listed_quantity, 0)) AS quantity FROM fbp_transfer_records f
          JOIN fbp_replenishment_order_items i ON f.source_type = 'fbp_replenishment' AND f.source_ref = CONCAT('fbp_replenishment:',i.order_id,':',i.id)
          WHERE i.order_id = ? AND f.status != 'cancelled'`, [orderId]);
        if (!Number(pending.quantity)) await q("UPDATE fbp_replenishment_orders SET status = 'completed', closed_at = UTC_TIMESTAMP() WHERE id = ?", [orderId]);
      } else if (action === "correct") {
        if (!["sent", "completed"].includes(task.status)) throw flowError("仅已发运备货单可以核实少发纠错");
        const reason = String(body.reason || "").trim();
        if (!reason) throw flowError("请填写核实原因，确认少发货物仍在本地；运输丢失不能补回本地");
        const [transfer] = await q(`SELECT f.* FROM fbp_transfer_records f
          JOIN fbp_replenishment_order_items i ON f.source_type = 'fbp_replenishment' AND f.source_ref = CONCAT('fbp_replenishment:', i.order_id, ':', i.id)
          WHERE i.order_id = ? AND f.id = ? FOR UPDATE`, [orderId, whole(body.transfer_id, "发运记录编号")]);
        if (!transfer) throw flowError("发运记录不属于本次备货单", 404);
        const actual = whole(body.actual_quantity, "核实实发件数"), difference = Number(transfer.quantity) - actual;
        if (difference <= 0 || actual < Number(transfer.listed_quantity)) throw flowError("实发数量必须小于原记录且不小于已确认到仓数；到仓数有误请先核实到仓记录");
        await q("UPDATE fbp_transfer_records SET quantity = ?, note = CONCAT(COALESCE(note,''), ?) WHERE id = ?", [actual, `\n少发纠错：${reason.slice(0, 1000)}`, transfer.id]);
        await q(`INSERT INTO inventory_movements (tenant_id, product_id, shop_id, sku_mapping_id, source_type, source_ref, quantity_delta, stock_location, stock_location_source, movement_type, owner_person_id, note)
          VALUES (?,?,?,?,'fbp_flow_correction',?,?,'LOCAL','inventory_flow','INBOUND',?,?)`, [scope.id, transfer.product_id, transfer.shop_id, transfer.mapping_id, `${transfer.id}:${task.revision}`, difference, personId, reason.slice(0, 2000)]);
      } else throw flowError("不支持的备货操作");
      await q("UPDATE inventory_flow_tasks SET revision = revision + 1 WHERE order_id = ?", [orderId]);
      await audit(q, scope, personId, action, body, orderId);
      return { ok: true };
    });
    changed();
    return result;
  }
  return { list, detail, settings: async tenantId => settings(await resolveInventoryTenantScope(tenantId, query)), saveSettings, history, tasks, createTask, mutateTask };
}

function dayStart(days) { return new Date(`${shanghaiDateDaysAgo(days)}T00:00:00+08:00`).toISOString().slice(0, 19).replace('T', ' '); }
export const inventoryFlow = createInventoryFlowService();
