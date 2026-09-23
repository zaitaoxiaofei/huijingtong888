import { createHash } from 'node:crypto';

export const procurementLedgerSchema = [
  `CREATE TABLE IF NOT EXISTS procurement_ledger_actions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_key VARCHAR(80) NOT NULL, product_id BIGINT UNSIGNED NOT NULL,
    action_type VARCHAR(40) NOT NULL, person_id BIGINT UNSIGNED NOT NULL,
    reason TEXT NOT NULL, before_json JSON NOT NULL, result_json JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ledger_request (request_key), KEY idx_ledger_product (product_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS procurement_history_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action_id BIGINT UNSIGNED NOT NULL, order_item_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL, quantity INT NOT NULL, inbound_record_id BIGINT UNSIGNED NULL,
    UNIQUE KEY uk_history_source (action_id, order_item_id, product_id),
    KEY idx_history_source_item (order_item_id, product_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];
let schemaPromise;
export async function ensureProcurementLedgerSchema(execute) {
  if (!schemaPromise) schemaPromise = (async () => {
    for (const sql of procurementLedgerSchema) await execute(sql);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

export function ledgerRevision(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function integer(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label}必须是大于等于 ${minimum} 的整数`);
  return number;
}
function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('采购金额、运费必须是非负数；金额未知请填 0，后续补齐');
  return Math.round(number * 10000) / 10000;
}

function historicalPurchaseTime(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(date) || !Number.isFinite(Date.parse(date)) || Date.parse(date) > Date.now()) throw new Error('请填写真实采购时间（北京时间），不能晚于当前时间');
  if (new Date(Date.parse(date) + 8 * 3600000).toISOString().slice(0, 19) !== date.slice(0, 19)) throw new Error('实际采购日期不存在，请重新填写北京时间');
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

export function planLedgerAction(snapshot, body) {
  if (body.revision !== snapshot.revision) throw new Error('采购、订单或库存已变化，请刷新对账后重新提交');
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 1000) throw new Error('请在调整说明中填写真实原因或凭证编号（1～1000 字）');
  const type = String(body.action_type || '');
  const result = { type, reason, quantity: 0, local_delta: 0, target_delta: 0, amount: 0, shipping_amount: 0 };
  if (type === 'historical_purchase_bulk') {
    result.quantity = integer(body.quantity, '本次补齐采购数量（quantity）');
    result.amount = money(body.amount);
    if (!(result.amount > 0)) throw new Error('请填写实际总货款（amount），须大于 0，运费单独填写，才能补齐采购成本');
    result.shipping_amount = money(body.shipping_amount || 0);
    result.purchased_at = historicalPurchaseTime(body.purchased_at);
    if (body.inventory_effect !== 'already_accounted') throw new Error('历史补齐只能补记录（inventory_effect=already_accounted），不能重复增加库存');
    const candidates = snapshot.orders.filter(row => row.entered_transport && row.stock_location !== 'FBP' && Number(row.missing_purchase_quantity) > 0)
      .sort((a, b) => new Date(a.transport_at || 0) - new Date(b.transport_at || 0) || a.order_item_id - b.order_item_id);
    const missing = candidates.reduce((sum, row) => sum + Number(row.missing_purchase_quantity), 0);
    if (result.quantity > missing) throw new Error(`本库存实际缺采购记录 ${missing} 件，本次数量不能超过缺口；已有采购但缺收货的部分请核对历史收货`);
    let left = result.quantity, assigned = 0, goodsAssigned = 0, freightAssigned = 0;
    result.allocations = [];
    for (const order of candidates) {
      if (!left) break;
      const quantity = Math.min(left, Number(order.missing_purchase_quantity));
      if (order.transport_at && Date.parse(body.purchased_at) > new Date(order.transport_at).getTime()) throw new Error(`采购时间晚于历史订单 ${order.posting_number || order.order_id} 进入运输时间，请按实际采购批次分开补录`);
      left -= quantity;
      assigned += quantity;
      const goods = Math.round(result.amount * 10000 * assigned / result.quantity);
      const freight = Math.round(result.shipping_amount * 10000 * assigned / result.quantity);
      result.allocations.push({ order_item_id: order.order_item_id, order_id: order.order_id, posting_number: order.posting_number,
        quantity, amount: (goods - goodsAssigned) / 10000, shipping_amount: (freight - freightAssigned) / 10000 });
      goodsAssigned = goods; freightAssigned = freight;
    }
  } else if (['historical_purchase', 'historical_source', 'substitute', 'receive', 'link_purchase'].includes(type)) {
    result.order_item_id = integer(body.order_item_id, '历史订单明细 ID');
    const order = snapshot.orders.find(row => row.order_item_id === result.order_item_id && (row.entered_transport || (type === 'substitute' && row.needs_fulfillment)));
    if (!order) throw new Error('请选择已进入运输的本地历史订单明细；FBP 订单请到 FBP 库存核对');
    result.order_id = order.order_id;
    result.quantity = integer(body.quantity, '本次补登数量');
    const available = order.entered_transport ? order.missing_record_quantity : order.shortage_quantity;
    if (result.quantity > available) throw new Error(`本次只能补登该订单尚未解释／覆盖的 ${available} 件，请刷新核对`);
    if (type === 'historical_purchase') {
      if (result.quantity > order.missing_purchase_quantity) throw new Error('该订单已有采购记录或收货待核，请先关联采购／补收货，不能重复补采购');
      result.amount = money(body.amount);
      result.shipping_amount = money(body.shipping_amount || 0);
      if (body.inventory_effect !== 'already_accounted') throw new Error('补采购记录仅解释历史来源，不增加现货；如本地实物不符，请在库存明细的盘点调整中填写实盘数量（counted_quantity）');
      result.purchased_at = historicalPurchaseTime(body.purchased_at);
      if (order.transport_at && Date.parse(body.purchased_at) > new Date(order.transport_at).getTime()) throw new Error('历史采购时间晚于订单进入运输的时间，请核对真实采购日期，不能用新采购填旧账');
    }
    if (type === 'receive' || type === 'link_purchase') {
      const batch = snapshot.batches.find(row => Number(row.id) === Number(body.inbound_id));
      if (!batch || (type === 'receive' ? batch.status !== 'pending_arrival' : batch.status !== 'approved')) throw new Error('请选择对应的有效采购收货批次');
      if (result.quantity > Number(batch.unallocated_quantity) + Number(order.receipt_claims?.find(claim => Number(claim.batch_id) === Number(batch.id))?.quantity || 0)) throw new Error('该批次可关联数量不足，已有其他订单占用；请核对原订单关联');
      if (type === 'receive' && (snapshot.orders || []).some(other => other.order_item_id !== order.order_item_id
        && other.receipt_claims?.some(claim => !claim.unallocated && Number(claim.batch_id) === Number(batch.id)))) {
        throw new Error('该批次还分配给其他订单，请到订单页一并勾选关联订单补收货，避免将收货记到错误订单');
      }
      result.inbound = batch;
      result.already_allocated = Number(order.receipt_claims?.find(claim => Number(claim.batch_id) === Number(batch.id) && !claim.unallocated)?.quantity || 0);
      if (result.already_allocated && result.quantity > result.already_allocated) throw new Error('本次补收不能混合已关联与未关联数量，请分开处理');
      if (type === 'receive' && !['already_accounted', 'missing_inbound'].includes(body.inventory_effect)) throw new Error('请选择历史收货的库存影响（inventory_effect）：只补记录，或确认漏记入库；已计入盘点的货物不能再次增加库存');
      result.local_delta = type === 'receive' && body.inventory_effect === 'missing_inbound' ? result.quantity : 0;
    }
    if (type === 'substitute') {
      result.target_product_id = integer(body.target_product_id, '替代来源商品');
      result.target_delta = -integer(body.target_quantity, '实际消耗来源商品数量');
      // The target product's outbound has already been posted; restore its attribution.
      result.local_delta = result.quantity;
      if (order.entered_transport && result.quantity > Number(order.outbound_quantity || 0)) throw new Error('该订单缺少对应本地出库流水，请先核对出库记录，不能直接做替代冲正');
    }
  } else if (type === 'record_purchase') {
    result.quantity = integer(body.quantity, '补录采购数量');
    result.amount = money(body.amount);
    if (!(result.amount > 0)) throw new Error('请填写补录采购的货款金额（amount），须大于 0，运费单独填写');
    result.shipping_amount = money(body.shipping_amount || 0);
    result.purchased_at = historicalPurchaseTime(body.purchased_at);
    if (!['in_transit', 'missing_inbound', 'already_accounted'].includes(body.inventory_effect)) throw new Error('请选择补录采购的收货状态，明确是否需要增加本地库存');
    result.inventory_effect = body.inventory_effect;
    result.local_delta = body.inventory_effect === 'missing_inbound' ? result.quantity : 0;
  } else if (type === 'convert') {
    result.quantity = integer(body.quantity, '转换出库数量');
    result.target_product_id = integer(body.target_product_id, '转换目标商品');
    result.local_delta = -result.quantity;
    result.target_delta = integer(body.target_quantity, '转换入库数量');
    if (result.quantity > snapshot.local_stock) throw new Error('转换来源的本地库存不足，请先盘点核对，不能借用 FBP 或采购在途库存');
  } else if (['damage', 'loss', 'stocktake'].includes(type)) {
    if (type === 'stocktake') {
      result.counted_quantity = integer(body.counted_quantity, '本地实盘数量', 0);
      result.local_delta = result.counted_quantity - (snapshot.physical_estimate ?? snapshot.local_stock);
      if (!result.local_delta) throw new Error('实盘数量与账面相同，无需调整');
    } else {
      result.quantity = integer(body.quantity, '损失数量');
      if (result.quantity > snapshot.local_stock) throw new Error('损失数量超过本地账面库存，请先核对盘点结果');
      result.local_delta = -result.quantity;
    }
  } else if (type === 'revise_purchase') {
    const item = snapshot.purchases.find(row => Number(row.id) === Number(body.purchase_item_id));
    if (!item) throw new Error('请选择要纠正的正式采购明细');
    result.item = item;
    result.quantity = integer(body.quantity, '纠正后采购数量', 0);
    result.amount = money(body.amount);
    result.shipping_amount = money(body.shipping_amount || 0);
    const received = Number(item.received_quantity || 0);
    result.correct_received = body.correct_received === true;
    if (result.quantity < received && !result.correct_received) throw new Error(`该采购已有 ${received} 件收货记录；请核对并勾选“入库也录多了”才能减少已收货部分`);
    result.receipt_adjustments = planReceiptCorrection(snapshot.batches.filter(row => Number(row.purchase_order_item_id) === Number(item.id)), received, result.quantity);
    result.local_delta = result.receipt_adjustments.reduce((sum, row) => sum + row.delta, 0);
    result.pending_quantity = Math.max(0, result.quantity - received);
    const otherItems = snapshot.purchases.filter(row => Number(row.purchase_order_id) === Number(item.purchase_order_id) && Number(row.id) !== Number(item.id));
    result.request_adjustments = planAllocationCorrection(snapshot, Number(item.purchase_order_id), result.quantity + otherItems.reduce((sum, row) => sum + Number(row.actual_quantity), 0));
    result.affected_orders = result.request_adjustments.flatMap(row => row.allocations.filter(a => a.quantity < Number(a.allocated_quantity))
      .map(a => ({ order_item_id: Number(a.order_item_id), before: Number(a.allocated_quantity), after: a.quantity,
        posting_number: snapshot.orders.find(o => o.order_item_id === Number(a.order_item_id))?.posting_number || String(a.order_id) })));

  } else throw new Error('不支持的对账操作');
  if (result.target_product_id === Number(snapshot.product.id)) throw new Error('来源商品与目标商品不能相同');
  return result;
}

export function summarizeLedger(product, movements, purchases, orders) {
  const local = movements.filter(row => row.stock_location !== 'FBP');
  const sum = (rows, fn) => rows.reduce((total, row) => total + Number(fn(row) || 0), 0);
  // Open orders may already have posted outbound movements; those goods are
  // still physically in the warehouse until shipment.
  const localStock = sum(local, row => row.quantity_delta);
  const openDeducted = sum(orders.filter(row => row.needs_fulfillment), row => row.outbound_quantity);
  const physical = localStock + openDeducted;
  const reserved = sum(orders.filter(row => row.needs_fulfillment), row => row.stock_quantity);
  return {
    product, local_stock: localStock, physical_estimate: physical,
    current_stock_reserved: reserved, available_estimate: Math.max(0, physical - reserved),
    purchase_quantity: sum(purchases, row => row.actual_quantity),
    received_quantity: sum(purchases, row => row.received_quantity),
    incoming_quantity: sum(purchases, row => row.pending_quantity),
    historical_missing: sum(orders.filter(row => row.entered_transport), row => row.missing_record_quantity),
    missing_purchase: sum(orders, row => row.missing_purchase_quantity),
    missing_receipt: sum(orders, row => row.missing_receipt_quantity),
    current_shortage: sum(orders.filter(row => row.needs_fulfillment), row => row.shortage_quantity),
    current_incoming: sum(orders.filter(row => row.needs_fulfillment), row => row.incoming_quantity),
    shipped_quantity: sum(orders.filter(row => row.entered_transport), row => row.quantity),
    movements, purchases, orders
  };
}

// Hooks keep all writes on the same transaction, including existing receipt/cost machinery.
export function createProcurementLedgerService(hooks) {
  const { query, transaction, coverage, postMovement, receive, recordCost, refreshPurchase, requirePerson, prepare } = hooks;
  async function snapshot(productId, run = query) {
    const products = await run('SELECT id, name, code, purchase_cost FROM products WHERE id = ? AND active = 1', [productId]);
    if (!products[0]) throw new Error('库存商品不存在或已停用，请重新选择');
    const movements = await run(`SELECT source_type, stock_location, SUM(quantity_delta) AS quantity_delta,
      MAX(id) AS last_id, COUNT(*) AS record_count FROM inventory_movements
      WHERE product_id = ? AND status = 'posted' GROUP BY source_type, stock_location ORDER BY source_type, stock_location`, [productId]);
    const purchases = await run(`SELECT poi.*, po.order_no, po.purchased_at,
      COALESCE(ir.received_quantity, 0) AS received_quantity, COALESCE(ir.pending_quantity, 0) AS pending_quantity
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN (SELECT purchase_order_item_id,
        SUM(CASE WHEN status = 'approved' THEN quantity ELSE 0 END) AS received_quantity,
        SUM(CASE WHEN status = 'pending_arrival' THEN quantity ELSE 0 END) AS pending_quantity
        FROM inbound_records WHERE product_id = ? GROUP BY purchase_order_item_id) ir ON ir.purchase_order_item_id = poi.id
      WHERE poi.product_id = ? AND po.status NOT IN ('cancelled', 'pending_purchase') ORDER BY poi.id`, [productId, productId]);
    const projection = await coverage(run, productId);
    const orders = [...projection.values()].filter(order => order.stock_location !== 'FBP').flatMap(order => order.items
      .filter(item => item.product_id === productId).map(item => ({ ...item, order_id: order.order_id,
        posting_number: order.posting_number, transport_at: order.transport_at, entered_transport: order.entered_transport, needs_fulfillment: order.needs_fulfillment })));
    const outbound = await run(`SELECT related_order_item_id AS order_item_id, -SUM(quantity_delta) AS quantity
      FROM inventory_movements WHERE product_id = ? AND status = 'posted' AND source_type = 'order_outbound'
      AND COALESCE(stock_location, 'LOCAL') != 'FBP' GROUP BY related_order_item_id`, [productId]);
    for (const order of orders) order.outbound_quantity = Number(outbound.find(row => Number(row.order_item_id) === order.order_item_id)?.quantity || 0);
    const value = summarizeLedger(products[0], movements, purchases, orders);
    value.batches = (projection.available_batches || []).filter(row => Number(row.product_id) === productId);
    const posted = await run(`SELECT source_ref, SUM(quantity_delta) AS quantity FROM inventory_movements
      WHERE product_id = ? AND status = 'posted' AND source_type IN ('purchase_inbound', 'purchase_inbound_correction', 'historical_receipt_offset')
      AND COALESCE(stock_location, 'LOCAL') != 'FBP' GROUP BY source_ref`, [productId]);
    for (const batch of value.batches) batch.local_posted_quantity = Number(posted.find(row => row.source_ref === `inbound_${batch.id}`)?.quantity || 0);
    value.requests = await run(`SELECT * FROM procurement_requests WHERE product_id = ? AND purchase_order_id IS NOT NULL AND status != 'cancelled' ORDER BY id`, [productId]);
    value.allocations = await run(`SELECT * FROM procurement_order_allocations WHERE product_id = ? AND status = 'allocated' ORDER BY id`, [productId]);
    value.sources = await run('SELECT * FROM procurement_history_sources WHERE product_id = ? ORDER BY id', [productId]);
    value.revision = ledgerRevision(value);
    value.actions = await run(`SELECT a.id, a.action_type, a.person_id, p.name AS person_name, a.reason, a.result_json, a.created_at FROM procurement_ledger_actions a
      LEFT JOIN people p ON p.id = a.person_id
      WHERE a.product_id = ? OR JSON_EXTRACT(a.result_json, '$.target_product_id') = ? ORDER BY a.id DESC LIMIT 50`, [productId, productId]);
    return value;
  }
  async function read(body) {
    await prepare();
    return snapshot(integer(body.product_id || body.productId, '库存商品 ID'));
  }
  async function apply(body, personId) {
    await prepare();
    const productId = integer(body.product_id, '库存商品 ID');
    const requestKey = String(body.request_key || '');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestKey)) throw new Error('本次操作标识缺失，请重新打开对账窗口');
    const result = await transaction(async connection => {
      const run = (sql, args = []) => connection.query(sql, args).then(([rows]) => rows);
      const actor = await requirePerson(personId, connection);
      const ids = [...new Set([productId, Number(body.target_product_id || 0)].filter(Boolean))].sort((a, b) => a - b);
      for (const id of ids) await run('SELECT id FROM products WHERE id = ? FOR UPDATE', [id]);
      const previous = await run('SELECT * FROM procurement_ledger_actions WHERE request_key = ? FOR UPDATE', [requestKey]);
      if (previous[0]) {
        if (Number(previous[0].product_id) !== productId || Number(previous[0].person_id) !== actor) throw new Error('操作标识重复，请刷新重试');
        const saved = typeof previous[0].before_json === 'string' ? JSON.parse(previous[0].before_json) : previous[0].before_json;
        if (ledgerRevision(saved.submitted) !== ledgerRevision(body)) throw new Error('同一操作标识不能提交不同内容，请重新预览');
        return typeof previous[0].result_json === 'string' ? JSON.parse(previous[0].result_json) : previous[0].result_json;
      }
      for (const id of ids) await run('SELECT id FROM inventory_movements WHERE product_id = ? FOR UPDATE', [id]);
      if (body.order_item_id) {
        await run('SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ? FOR UPDATE', [Number(body.order_item_id)]);
      }
      await run('SELECT id FROM inbound_records WHERE product_id = ? FOR UPDATE', [productId]);
      await run('SELECT id FROM purchase_order_items WHERE product_id = ? FOR UPDATE', [productId]);
      await run('SELECT id FROM procurement_requests WHERE product_id = ? FOR UPDATE', [productId]);
      await run('SELECT id FROM procurement_order_allocations WHERE product_id = ? FOR UPDATE', [productId]);
      const before = await snapshot(productId, run);
      const plan = planLedgerAction(before, body);
      if (plan.allocations?.length) {
        const orderItems = plan.allocations.map(row => row.order_item_id);
        await run(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id IN (${orderItems.map(() => '?').join(',')}) FOR UPDATE`, orderItems);
        planLedgerAction(await snapshot(productId, run), body);
      }
      if (plan.target_product_id) {
        const target = await snapshot(plan.target_product_id, run);
        if (body.target_revision !== target.revision) throw new Error('另一商品的库存已变化，请重新选择并核对');
        if (target.local_stock + plan.target_delta < 0) throw new Error('实际替代来源商品本地库存不足，请先核对');
        const components = await run('SELECT product_id FROM product_components WHERE product_id IN (?, ?) LIMIT 1', ids);
        if (components.length) throw new Error('组合商品请展开到实际库存子商品后进行替代或转换，避免重复记账');
      }
      const [action] = await connection.execute(`INSERT INTO procurement_ledger_actions
        (request_key, product_id, action_type, person_id, reason, before_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [requestKey, productId, plan.type, actor, plan.reason, JSON.stringify({ ...before, submitted: body })]);
      const actionId = Number(action.insertId);
      const note = `对账 #${actionId}：${plan.reason}`;
      const movement = async (id, delta, sourceType = 'reconciliation_adjustment', sourceRef = `reconciliation_${actionId}`) => {
        if (!delta) return;
        await postMovement(connection, { product_id: id, quantity_delta: delta, source_type: sourceType,
          source_ref: sourceRef, stock_location: 'LOCAL', movement_type: delta > 0 ? 'MANUAL_ADJUST' : 'ORDER_SHIPPED',
          owner_person_id: actor, operator: String(actor), note });
      };
      const source = async (inboundId = null) => connection.execute(`INSERT INTO procurement_history_sources
        (action_id, order_item_id, product_id, quantity, inbound_record_id) VALUES (?, ?, ?, ?, ?)`,
      [actionId, plan.order_item_id, productId, plan.quantity, inboundId]);
      let purchaseOrderId = null;
      if (['historical_purchase', 'historical_purchase_bulk', 'record_purchase'].includes(plan.type)) {
        const cost = (plan.amount + plan.shipping_amount) / plan.quantity;
        const inTransit = plan.inventory_effect === 'in_transit';
        const status = inTransit ? 'purchased' : 'inbound_done';
        const [purchase] = await connection.execute(`INSERT INTO purchase_orders
          (order_no, created_by_person_id, status, total_quantity, total_amount, note, purchased_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [`HISTORY-${actionId}`, actor, status, plan.quantity,
          plan.amount + plan.shipping_amount, `${note}；历史补录，不新增待采购`, plan.purchased_at]);
        purchaseOrderId = Number(purchase.insertId);
        const [item] = await connection.execute(`INSERT INTO purchase_order_items
          (purchase_order_id, product_id, requested_quantity, actual_quantity, inbound_quantity, amount, shipping_amount, unit_cost, status, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [purchaseOrderId, productId, plan.quantity, plan.quantity,
          inTransit ? 0 : plan.quantity, plan.amount, plan.shipping_amount, cost, status, note]);
        const [inbound] = await connection.execute(`INSERT INTO inbound_records
          (product_id, person_id, quantity, amount, shipping_amount, unit_cost, status, note,
            purchase_order_id, purchase_order_item_id, approved_at, approved_by_person_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [productId, actor, plan.quantity, plan.amount,
          plan.shipping_amount, cost, inTransit ? 'pending_arrival' : 'approved', `${note}；${inTransit ? '采购仍在途' : plan.local_delta ? '补漏记本地入库' : '仅补来源，库存已记账或直发'}`,
          purchaseOrderId, Number(item.insertId), inTransit ? null : plan.purchased_at, inTransit ? null : actor]);
        await movement(productId, plan.local_delta, 'purchase_inbound', `inbound_${inbound.insertId}`);
        if (plan.type === 'historical_purchase') await source(Number(inbound.insertId));
        for (const allocation of plan.allocations || []) await connection.execute(`INSERT INTO procurement_history_sources
          (action_id, order_item_id, product_id, quantity, inbound_record_id) VALUES (?, ?, ?, ?, ?)`,
        [actionId, allocation.order_item_id, productId, allocation.quantity, Number(inbound.insertId)]);
        await recordCost(connection, { product_id: productId, source_key: `purchase_order_item:${item.insertId}:purchased`,
          stage: 'historical_backfill', purchase_order_id: purchaseOrderId, purchase_order_item_id: Number(item.insertId),
          quantity: plan.quantity, amount: plan.amount, shipping_amount: plan.shipping_amount, person_id: actor, anomaly_reason: plan.reason });
      } else if (plan.type === 'receive' || plan.type === 'link_purchase') {
        if (plan.type === 'receive') await receive(connection, plan.inbound.id, {
          receive_quantity: plan.quantity, expected_remaining_quantity: plan.inbound.quantity, receipt_context: note
        }, { sessionPersonId: actor });
        // The receipt hook posts inbound stock. Undo that inventory effect when
        // the operator confirms these historical goods were already counted.
        if (plan.type === 'receive' && !plan.local_delta) await movement(productId, -plan.quantity, 'historical_receipt_offset', `inbound_${plan.inbound.id}`);
        if (!plan.already_allocated) await source(Number(plan.inbound.id));
      } else if (plan.type === 'historical_source' || plan.type === 'substitute') {
        await source();
        await movement(productId, plan.local_delta, 'substitution_restore');
        if (plan.target_product_id) await movement(plan.target_product_id, plan.target_delta, 'substitution_out');
      } else if (plan.type === 'revise_purchase') {
        await revisePurchase(connection, run, before, plan, actor, note, actionId);
        purchaseOrderId = Number(plan.item.purchase_order_id);
      } else {
        await movement(productId, plan.local_delta, `reconciliation_${plan.type}`);
        if (plan.target_product_id) await movement(plan.target_product_id, plan.target_delta, 'reconciliation_convert_in');
      }
      const response = { ok: true, action_id: actionId, action_type: plan.type, purchase_order_id: purchaseOrderId,
        allocations: plan.allocations || [],
        local_before: before.local_stock, local_after: before.local_stock + plan.local_delta,
        local_delta: plan.local_delta, target_product_id: plan.target_product_id || null, target_delta: plan.target_delta };
      await connection.execute('UPDATE procurement_ledger_actions SET result_json = ? WHERE id = ?', [JSON.stringify(response), actionId]);
      return response;
    });
    hooks.invalidate();
    return result;
  }
  async function revisePurchase(connection, run, before, plan, actor, note, actionId) {
    const item = plan.item;
    const productId = Number(before.product.id);
    let pendingLeft = plan.pending_quantity;
    const unitCost = plan.quantity ? (plan.amount + plan.shipping_amount) / plan.quantity : 0;
    const batches = before.batches.filter(row => Number(row.purchase_order_item_id) === Number(item.id));
    for (const batch of batches.filter(row => row.status === 'pending_arrival')) {
      const quantity = Math.min(pendingLeft, Number(batch.quantity));
      pendingLeft -= quantity;
      await connection.execute(`UPDATE inbound_records SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?,
        status = ?, note = CONCAT(COALESCE(note, ''), '；', ?) WHERE id = ?`, [quantity,
        plan.quantity ? plan.amount * quantity / plan.quantity : 0, plan.quantity ? plan.shipping_amount * quantity / plan.quantity : 0,
        unitCost, quantity ? 'pending_arrival' : 'cancelled', note, batch.id]);
    }
    if (pendingLeft > 0) await connection.execute(`INSERT INTO inbound_records
      (product_id, person_id, quantity, amount, shipping_amount, unit_cost, status, note, purchase_order_id, purchase_order_item_id)
      VALUES (?, ?, ?, ?, ?, ?, 'pending_arrival', ?, ?, ?)`, [productId, actor, pendingLeft,
      plan.amount * pendingLeft / plan.quantity, plan.shipping_amount * pendingLeft / plan.quantity, unitCost, note, item.purchase_order_id, item.id]);
    for (const change of plan.receipt_adjustments) {
      await connection.execute(`UPDATE inbound_records SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, status = ?,
        note = CONCAT(COALESCE(note, ''), '；', ?) WHERE id = ?`, [change.quantity,
        plan.quantity ? plan.amount * change.quantity / plan.quantity : 0,
        plan.quantity ? plan.shipping_amount * change.quantity / plan.quantity : 0,
        unitCost, change.quantity ? 'approved' : 'cancelled', note, change.id]);
      if (change.delta) await postMovement(connection, { product_id: productId, quantity_delta: change.delta,
        source_type: 'purchase_inbound_correction', source_ref: `inbound_${change.id}`, stock_location: 'LOCAL',
        movement_type: 'ORDER_SHIPPED', owner_person_id: actor, operator: String(actor), note });
      let sourceLeft = change.quantity;
      for (const linked of before.sources.filter(row => Number(row.inbound_record_id) === Number(change.id))) {
        const kept = Math.min(sourceLeft, Number(linked.quantity));
        sourceLeft -= kept;
        await connection.execute('UPDATE procurement_history_sources SET quantity = ? WHERE id = ?', [kept, linked.id]);
      }
    }
    await connection.execute(`UPDATE purchase_order_items SET actual_quantity = ?, inbound_quantity = ?, amount = ?, shipping_amount = ?,
      unit_cost = ?, note = CONCAT(COALESCE(note, ''), '；', ?) WHERE id = ?`, [plan.quantity,
      Math.min(plan.quantity, Number(item.received_quantity)), plan.amount, plan.shipping_amount, unitCost, note, item.id]);
    const otherItems = before.purchases.filter(row => Number(row.purchase_order_id) === Number(item.purchase_order_id) && Number(row.id) !== Number(item.id));
    const totalCapacity = plan.quantity + otherItems.reduce((sum, row) => sum + Number(row.actual_quantity), 0);
    const totalAmount = plan.amount + otherItems.reduce((sum, row) => sum + Number(row.amount), 0);
    const totalShipping = plan.shipping_amount + otherItems.reduce((sum, row) => sum + Number(row.shipping_amount), 0);
    for (const request of plan.request_adjustments) {
      const quantity = request.quantity;
      await connection.execute(`UPDATE procurement_requests SET quantity = ?, amount = ?, shipping_amount = ?,
        status = ?, note = CONCAT(COALESCE(note, ''), '；', ?) WHERE id = ?`, [quantity,
        totalCapacity ? totalAmount * quantity / totalCapacity : 0, totalCapacity ? totalShipping * quantity / totalCapacity : 0,
        quantity ? request.status : 'cancelled', note, request.id]);
      for (const allocation of request.allocations) {
        await connection.execute(`UPDATE procurement_order_allocations SET allocated_quantity = ?, status = ?, release_reason = ? WHERE id = ?`,
          [allocation.quantity, allocation.quantity ? 'allocated' : 'released', note.slice(0, 255), allocation.id]);
      }
    }
    await connection.execute(`UPDATE purchase_orders po SET
      total_quantity = (SELECT COALESCE(SUM(actual_quantity), 0) FROM purchase_order_items WHERE purchase_order_id = po.id),
      total_amount = (SELECT COALESCE(SUM(amount + shipping_amount), 0) FROM purchase_order_items WHERE purchase_order_id = po.id) WHERE id = ?`, [item.purchase_order_id]);
    await refreshPurchase(connection, Number(item.purchase_order_id));
    await connection.execute(`UPDATE purchase_cost_versions SET status = 'revised', revised_at = CURRENT_TIMESTAMP
      WHERE purchase_order_item_id = ? AND status = 'active'`, [item.id]);
    await recordCost(connection, { product_id: productId, source_key: `purchase_order_item:${item.id}:purchased`,
      stage: 'purchased_revision', purchase_order_id: Number(item.purchase_order_id), purchase_order_item_id: Number(item.id),
      quantity: plan.quantity, amount: plan.amount, shipping_amount: plan.shipping_amount, person_id: actor, anomaly_reason: note });
  }
  async function preview(body) {
    await prepare();
    const before = await snapshot(integer(body.product_id, '库存商品 ID'));
    // The editor supplies the values it loaded; preview obtains one fresh revision.
    // Apply still requires that exact revision inside its transaction.
    let submitted = body;
    if (!body.revision && body.action_type === 'revise_purchase' && body.expected_purchase) {
      const item = before.purchases.find(row => Number(row.id) === Number(body.purchase_item_id));
      const expected = body.expected_purchase;
      if (!item || Number(item.actual_quantity) !== Number(expected.quantity) || Number(item.amount) !== Number(expected.amount)
        || Number(item.shipping_amount || 0) !== Number(expected.shipping_amount || 0)) throw new Error('这笔采购记录已发生变化，请点击刷新记录后重新编辑');
      submitted = { ...body, revision: before.revision };
    } else if (!body.revision && body.action_type === 'record_purchase') {
      submitted = { ...body, revision: before.revision };
    }
    const plan = planLedgerAction(before, submitted);
    let target = null;
    if (plan.target_product_id) {
      target = await snapshot(plan.target_product_id);
      if (body.target_revision !== target.revision) throw new Error('另一商品已变化，请重新选择');
      if (target.local_stock + plan.target_delta < 0) throw new Error('替代来源商品本地库存不足');
    }
    return { ...plan, revision: before.revision, local_before: before.local_stock, local_after: before.local_stock + plan.local_delta,
      target_before: target?.local_stock, target_after: target ? target.local_stock + plan.target_delta : null };
  }
  return { read, apply, preview };
}

export function planReceiptCorrection(batches, received, quantity) {
  let reduce = Math.max(0, received - quantity);
  return batches.filter(row => row.status === 'approved').sort((a, b) => Number(b.id) - Number(a.id)).map(row => {
    const removed = Math.min(reduce, Number(row.quantity));
    reduce -= removed;
    const local = Number(row.local_posted_quantity || 0);
    if (removed && local !== 0 && local !== Number(row.quantity)) throw new Error('该收货批次与本地入库流水数量不一致，请先核对批次流水，不能直接纠正采购');
    return { id: row.id, quantity: Number(row.quantity) - removed, delta: local ? -removed : 0 };
  });
}


export function planAllocationCorrection(snapshot, purchaseOrderId, capacity) {
  const live = new Set(snapshot.orders.filter(row => row.needs_fulfillment).map(row => Number(row.order_item_id)));
  const allocations = snapshot.allocations || [];
  const requests = (snapshot.requests || []).filter(row => Number(row.purchase_order_id) === purchaseOrderId);
  const isLive = row => live.has(Number(row.source_order_item_id)) || allocations.some(a => Number(a.procurement_request_id) === Number(row.id) && live.has(Number(a.order_item_id)));
  return requests.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || Number(a.id) - Number(b.id)).map(row => {
    const quantity = Math.min(capacity, Number(row.quantity));
    capacity -= quantity;
    let remaining = quantity;
    const adjusted = allocations.filter(a => Number(a.procurement_request_id) === Number(row.id))
      .sort((a, b) => Number(live.has(Number(b.order_item_id))) - Number(live.has(Number(a.order_item_id))) || Number(a.id) - Number(b.id))
      .map(a => { const kept = Math.min(remaining, Number(a.allocated_quantity)); remaining -= kept; return { ...a, quantity: kept }; });
    return { ...row, quantity, allocations: adjusted };
  });
}
