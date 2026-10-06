const positive = (value) => Math.max(0, Number(value) || 0);
const rounded = (value) => Math.round(value * 10000) / 10000;

export function planPartialReceipt(record, quantity, expectedQuantity) {
  if (record.status !== 'pending_arrival') throw new Error('该批次已入库或已取消，请刷新后核对');
  const total = Number(record.quantity);
  if (Number(expectedQuantity) !== total) throw new Error('批次剩余数量已变化，请刷新后重新确认');
  const received = Number(quantity);
  if (!Number.isInteger(received) || received <= 0 || received > total) throw new Error(`本次实收数量必须为 1 至 ${total} 的整数`);
  const amount = rounded(Number(record.amount || 0) * received / total);
  const shippingAmount = rounded(Number(record.shipping_amount || 0) * received / total);
  return { received, remaining: total - received, amount, shippingAmount,
    remainingAmount: rounded(Number(record.amount || 0) - amount),
    remainingShipping: rounded(Number(record.shipping_amount || 0) - shippingAmount) };
}

// This is an operational projection. It never repairs the inventory ledger or
// creates purchases from a shipping status. All quantities use physical product units.
export function calculateOrderProcurementCoverage({ demands = [], stocks = [], allocations = [], inbounds = [], requests = [], marks = [], sources = [], stockSources = [], includeTrace = false }) {
  const traces = new Map();
  const trace = (detail, batch, quantity, basis, purpose) => {
    if (!includeTrace || quantity <= 0) return;
    if (!traces.has(detail)) traces.set(detail, []);
    traces.get(detail).push({ batch_id: batch && !batch.stock_source ? Number(batch.id) : null,
      purchase_order_no: batch?.purchase_order_no || '', purchase_order_id: batch?.purchase_order_id || null,
      quantity: rounded(quantity), basis, purpose,
      source_label: batch?.stock_source ? '期初／退回库存来源' : batch ? '采购批次' : '其他已记录来源' });
  };
  const prioritizedProducts = new Set(demands.filter(row => row.needs_fulfillment && row.allocation_priority > 0).map(row => Number(row.product_id)));
  const stockByProduct = new Map(stocks.map(row => [Number(row.product_id), row]));
  const pools = new Map(stocks.map(row => [Number(row.product_id), positive(Number(row.ledger || 0) + Number(row.open_deducted || 0) - positive(row.fbp_reserved))]));
  const requestById = new Map(requests.map(row => [Number(row.id), row]));
  const batches = [...inbounds, ...stockSources.map(row => ({ ...row, id: -Number(row.id), status: 'approved', stock_source: true }))].filter(row => ['pending_arrival', 'approved'].includes(row.status)).map(row => ({ ...row, remaining: positive(row.quantity) }));
  batches.sort((a, b) => new Date(a.purchased_at || a.created_at || a.approved_at || 0) - new Date(b.purchased_at || b.created_at || b.approved_at || 0) || Number(a.id) - Number(b.id));
  const batchesByProduct = new Map();
  const pendingIncomingByProduct = new Map();
  for (const batch of batches) {
    const id = Number(batch.product_id);
    if (!batchesByProduct.has(id)) batchesByProduct.set(id, []);
    batchesByProduct.get(id).push(batch);
    if (batch.status === 'pending_arrival') {
      pendingIncomingByProduct.set(id, positive((pendingIncomingByProduct.get(id) || 0) + batch.remaining));
    }
  }
  const markByItem = new Map(marks.filter(m => m.status === 'handled' && ['stock_available', 'no_procurement_needed'].includes(m.handling_type))
    .map(m => [`${m.order_item_id}:${m.product_id}`, m]));
  const details = demands.map(row => ({ ...row, sort_time: new Date(row.ordered_at || 0).getTime() || 0, quantity: positive(row.quantity), stock_quantity: 0, incoming_quantity: 0,
    received_quantity: 0, shortage_quantity: 0, missing_record_quantity: 0, missing_purchase_quantity: 0, missing_receipt_quantity: 0, missing_amount: false,
    quantity_needs_review: false, documented_quantity: 0, current_recorded_supply: 0, receipt_claims: [], incoming_sources: [], batches: [] })).sort((a, b) =>
      Number(!!a.needs_fulfillment) - Number(!!b.needs_fulfillment)
      || Number(!!b.needs_fulfillment && b.allocation_priority > 0) - Number(!!a.needs_fulfillment && a.allocation_priority > 0)
      || (a.entered_transport && b.entered_transport ? new Date(a.transport_at || a.ordered_at || 0) - new Date(b.transport_at || b.ordered_at || 0) : a.sort_time - b.sort_time)
      || Number(a.order_item_id) - Number(b.order_item_id));
  const byItem = new Map();
  for (const detail of details) {
    const key = `${detail.order_item_id}:${detail.product_id}`;
    byItem.set(key, detail);
  }
  // Explicit historical source corrections are durable evidence, not current supply.
  for (const source of sources) {
    const detail = byItem.get(`${source.order_item_id}:${source.product_id}`);
    if (!detail || (!Number(detail.entered_transport) && !Number(detail.needs_fulfillment)) || detail.stock_location === 'FBP') continue;
    const batch = batches.find(row => Number(row.id) === Number(source.inbound_record_id) && Number(row.product_id) === Number(source.product_id));
    if (source.inbound_record_id && (!batch || batch.status !== 'approved')) continue;
    const quantity = Math.min(positive(source.quantity), positive(detail.quantity - detail.documented_quantity), batch ? batch.remaining : Infinity);
    detail.documented_quantity += quantity;
    trace(detail, batch, quantity, 'recorded', 'source');
    if (batch) {
      batch.remaining = positive(batch.remaining - quantity);
      if (quantity > 0) detail.missing_amount ||= !(Number(batch.amount) > 0);
    }
  }
  const assigned = [...allocations];
  const assignedRequests = new Set(allocations.map(a => Number(a.procurement_request_id)));
  for (const request of requests) {
    if (request.source_order_item_id && !assignedRequests.has(Number(request.id))) {
      assigned.push({ order_item_id: request.source_order_item_id, product_id: request.product_id,
        procurement_request_id: request.id, allocated_quantity: request.quantity });
    }
  }
  // Honor recorded order allocations first, including history, so one batch
  // cannot be promised again merely because the user changed the list filter.
  // Historical retries can leave several request allocations on one order
  // item. They are evidence of the same demand, not additional demand: never
  // let them reserve more supply than the item actually needs.
  const allocationAllowanceByItem = new Map(details.map(detail => [
    `${detail.order_item_id}:${detail.product_id}`,
    positive(detail.quantity)
  ]));
  for (const allocation of assigned.sort((a, b) => Number(a.order_item_id) - Number(b.order_item_id))) {
    const detail = byItem.get(`${allocation.order_item_id}:${allocation.product_id}`);
    const request = requestById.get(Number(allocation.procurement_request_id));
    if (!request || request.status === 'cancelled') continue;
    if (detail && !Number(detail.needs_fulfillment) && !Number(detail.entered_transport)) continue;
    if (detail && detail.stock_location !== 'FBP' && (request.purchase_order_id || ['purchased', 'done', 'inbound_done'].includes(request.status)) && !positive(request.quantity)) detail.quantity_needs_review = true;
    const allocationKey = detail ? `${detail.order_item_id}:${detail.product_id}` : '';
    const allowance = detail ? positive(allocationAllowanceByItem.get(allocationKey)) : 0;
    let remaining = detail
      ? Math.min(positive(allocation.allocated_quantity), allowance)
      : positive(allocation.allocated_quantity);
    if (detail) allocationAllowanceByItem.set(allocationKey, positive(allowance - remaining));
    if (!remaining) continue;
    const matching = (batchesByProduct.get(Number(request.product_id)) || []).filter(b => (Number(b.procurement_request_id) === Number(request.id)
        || (b.purchase_order_id && Number(b.purchase_order_id) === Number(request.purchase_order_id))))
      .sort((a, b) => (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1) || Number(a.id) - Number(b.id));
    for (const batch of matching) {
      const take = Math.min(remaining, batch.remaining);
      if (!take) continue;
      batch.remaining -= take;
      remaining -= take;
      if (!detail || detail.stock_location === 'FBP') continue;
      const covered = Math.min(take, positive(detail.quantity - detail.received_quantity - detail.documented_quantity - detail.incoming_quantity));
      if (batch.status === 'approved') detail.received_quantity += covered;
      else { detail.incoming_quantity += covered; detail.incoming_sources.push({ batch, quantity: covered }); }
      trace(detail, batch, covered, 'recorded', batch.status === 'approved' ? 'source' : detail.entered_transport ? 'receipt_pending' : 'incoming');
      if (batch.status === 'pending_arrival' && (Number(batch.procurement_request_id) === Number(request.id)
        || (!Number(batch.procurement_request_id) && request.purchase_order_id && Number(batch.purchase_order_id) === Number(request.purchase_order_id))) && covered > 0) {
        detail.receipt_claims.push({ batch_id: Number(batch.id), quantity: covered });
      }
      detail.missing_amount ||= !(Number(batch.amount) > 0);
      detail.batches.push(batch);
    }
  }
  // Received supply linked to a live order is reserved before distributing
  // shared stock. This prevents receipt + stock from covering two orders.
  for (const detail of details) {
    if (Number(detail.needs_fulfillment) && detail.stock_location !== 'FBP') {
      // Once physically counted, old receipts remain cost/source evidence only.
      // They cannot override the counted supply or preempt FIFO allocation.
      const stock = stockByProduct.get(Number(detail.product_id));
      if (stock?.stocktake_id || positive(stock?.fbp_reserved) || prioritizedProducts.has(Number(detail.product_id))) continue;
      const productId = Number(detail.product_id);
      const recordedSupply = positive(detail.received_quantity + detail.documented_quantity);
      // A received-purchase record is source evidence, not extra stock.  It
      // can cover this open order only when the current physical pool still
      // contains that quantity. This prevents a historical receipt from
      // masking a real zero-stock shortage after the goods were consumed.
      detail.current_recorded_supply = Math.min(recordedSupply, pools.get(productId) || 0);
      pools.set(productId, positive((pools.get(productId) || 0) - detail.current_recorded_supply));
    }
  }
  // A physical count supersedes old promises of incoming supply. Release live
  // incoming reservations together, then allocate counted stock first in FIFO.
  for (const detail of details) {
    if (!detail.needs_fulfillment || !stockByProduct.get(Number(detail.product_id))?.stocktake_id) continue;
    for (const source of detail.incoming_sources) source.batch.remaining += source.quantity;
    detail.incoming_quantity = 0;
    detail.receipt_claims = [];
    detail.batches = detail.batches.filter(batch => batch.status !== 'pending_arrival');
    if (includeTrace) traces.set(detail, (traces.get(detail) || []).filter(source => source.purpose !== 'incoming'));
  }
  for (const detail of details) {
    const productId = Number(detail.product_id);
    const stock = stockByProduct.get(productId) || {};
    detail.ledger_stock = Number(stock.ledger || 0);
    detail.physical_stock_estimate = detail.ledger_stock + Number(stock.open_deducted || 0);
    detail.inventory_needs_review = detail.stock_location !== 'FBP' && Number(stock.ledger || 0) + Number(stock.open_deducted || 0) < 0;
    const sourceMark = markByItem.get(`${detail.order_item_id}:${productId}`);
    if (Number(detail.needs_fulfillment) && detail.stock_location !== 'FBP') {
      const recordedSupply = stock.stocktake_id || positive(stock.fbp_reserved) || prioritizedProducts.has(productId) ? 0 : detail.current_recorded_supply;
      let needed = positive(detail.quantity - recordedSupply - detail.incoming_quantity);
      const stockQuantity = Math.min(needed, pools.get(productId) || 0);
      pools.set(productId, positive((pools.get(productId) || 0) - stockQuantity));
      detail.stock_quantity = recordedSupply + stockQuantity;
      needed -= stockQuantity;
      for (const batch of batchesByProduct.get(productId) || []) {
        if (batch.status !== 'pending_arrival' || Number(batch.product_id) !== productId || !needed) continue;
        const take = Math.min(needed, batch.remaining);
        if (!take) continue;
        batch.remaining -= take;
        detail.incoming_quantity += take;
        trace(detail, batch, take, 'fifo', 'incoming');
        detail.missing_amount ||= !(Number(batch.amount) > 0);
        detail.batches.push(batch);
        needed -= take;
      }
      detail.shortage_quantity = detail.quantity_needs_review ? 0 : rounded(needed);
    } else if (Number(detail.entered_transport) && detail.stock_location !== 'FBP') {
      // In-transit supplier goods do not prove the source of a shipped item.
      let missing = sourceMark?.handling_type === 'no_procurement_needed' ? 0 : positive(detail.quantity - detail.received_quantity - detail.documented_quantity);
      // Older receipts can predate order-allocation records. Allocate their
      // remaining confirmed quantity FIFO as historical source evidence only.
      for (const batch of batchesByProduct.get(productId) || []) {
        if (batch.status !== 'approved' || Number(batch.product_id) !== productId || !missing) continue;
        // A later unrelated purchase must not silently erase old source debt.
        // Receipt registration can be late. FIFO is an accounting assignment,
        // not proof of the physical picking batch; explicit links remain first.
        const receiptTime = new Date(batch.purchased_at || batch.created_at || batch.approved_at || 0).getTime();
        const cutoff = new Date(detail.transport_at || detail.ordered_at || 0).getTime();
        if (receiptTime && cutoff && receiptTime > cutoff) continue;
        const take = Math.min(missing, batch.remaining);
        batch.remaining -= take;
        missing -= take;
        trace(detail, batch, take, 'fifo', 'source');
        if (take > 0 && !batch.stock_source) detail.missing_amount ||= !(Number(batch.amount) > 0);
      }
      detail.missing_record_quantity = missing;
      let receiptGap = positive(missing - detail.incoming_quantity);
      for (const batch of batchesByProduct.get(productId) || []) {
        const bought = new Date(batch.purchased_at || batch.created_at || 0).getTime();
        const cutoff = new Date(detail.transport_at || detail.ordered_at || 0).getTime();
        if (batch.status !== 'pending_arrival' || !bought || !cutoff || bought > cutoff || !receiptGap) continue;
        const take = Math.min(receiptGap, batch.remaining);
        if (!take) continue;
        batch.remaining -= take;
        receiptGap -= take;
        trace(detail, batch, take, 'fifo', 'receipt_pending');
        detail.receipt_claims.push({ batch_id: Number(batch.id), quantity: take, unallocated: true });
      }
      detail.missing_purchase_quantity = receiptGap;
      detail.missing_receipt_quantity = missing - receiptGap;
      // Shipped goods are no longer awaiting supply. Keep the receipt claim
      // reserved for reconciliation, but never label it incoming coverage.
      detail.incoming_quantity = 0;
    }
  }
  const availableIncomingByProduct = new Map();
  for (const [productId, productBatches] of batchesByProduct) {
    availableIncomingByProduct.set(productId, productBatches
      .filter(batch => batch.status === 'pending_arrival')
      .reduce((total, batch) => total + positive(batch.remaining), 0));
  }
  const result = new Map();
  const historicalMissingByProduct = new Map();
  for (const detail of details) {
    if (Number(detail.entered_transport) && detail.stock_location !== 'FBP') {
      const id = Number(detail.product_id);
      historicalMissingByProduct.set(id, (historicalMissingByProduct.get(id) || 0) + detail.missing_purchase_quantity);
    }
  }
  for (const detail of details) {
    const id = Number(detail.order_id);
    if (!result.has(id)) result.set(id, { order_id: id, posting_number: detail.posting_number || String(id), ordered_at: detail.ordered_at || null, transport_at: detail.transport_at || null, shortage_quantity: 0, stock_quantity: 0, incoming_quantity: 0,
      missing_record_quantity: 0, missing_purchase_quantity: 0, missing_receipt_quantity: 0, missing_amount: false, quantity_needs_review: false, inventory_needs_review: false,
      stock_location: detail.stock_location, needs_fulfillment: Boolean(Number(detail.needs_fulfillment)), entered_transport: Boolean(Number(detail.entered_transport)), items: [], batches: [] });
    const order = result.get(id);
    for (const key of ['shortage_quantity', 'stock_quantity', 'incoming_quantity', 'missing_record_quantity', 'missing_purchase_quantity', 'missing_receipt_quantity']) order[key] = rounded(order[key] + detail[key]);
    for (const key of ['missing_amount', 'quantity_needs_review', 'inventory_needs_review']) order[key] ||= detail[key];
    order.items.push({ order_item_id: Number(detail.order_item_id), product_id: Number(detail.product_id), product_name: detail.product_name || '',
      ...(includeTrace ? { coverage_trace: traces.get(detail) || [] } : {}),
      receipt_claims: detail.receipt_claims, quantity_needs_review: detail.quantity_needs_review, unit: detail.stock_unit || '件', quantity: detail.quantity, stock_quantity: detail.stock_quantity, incoming_quantity: detail.incoming_quantity,
      product_total_incoming_quantity: pendingIncomingByProduct.get(Number(detail.product_id)) || 0,
      product_historical_missing_purchase_quantity: historicalMissingByProduct.get(Number(detail.product_id)) || 0,
      product_available_incoming_quantity: availableIncomingByProduct.get(Number(detail.product_id)) || 0,
      product_reserved_incoming_quantity: positive((pendingIncomingByProduct.get(Number(detail.product_id)) || 0) - (availableIncomingByProduct.get(Number(detail.product_id)) || 0)),
      shortage_quantity: detail.shortage_quantity, missing_record_quantity: detail.missing_record_quantity,
      missing_purchase_quantity: detail.missing_purchase_quantity, missing_receipt_quantity: detail.missing_receipt_quantity, missing_amount: detail.missing_amount, ledger_stock: detail.ledger_stock,
      physical_stock_estimate: detail.physical_stock_estimate, allocation_priority: Number(detail.allocation_priority || 0),
      product_fbp_reserved: positive(stockByProduct.get(Number(detail.product_id))?.fbp_reserved),
      inventory_needs_review: detail.inventory_needs_review });
    for (const batch of detail.batches) if (!order.batches.some(b => Number(b.id) === Number(batch.id))) {
      const { remaining, ...record } = batch;
      order.batches.push(record);
    }
  }
  result.available_batches = batches.filter(batch => !batch.stock_source).map(({ remaining, ...batch }) => ({ ...batch, unallocated_quantity: remaining }));
  const localReserved = new Map();
  for (const order of result.values()) if (order.needs_fulfillment && order.stock_location !== 'FBP') {
    for (const item of order.items) localReserved.set(item.product_id, (localReserved.get(item.product_id) || 0) + Number(item.stock_quantity || 0));
  }
  for (const order of result.values()) for (const item of order.items) {
    item.product_local_available = positive(item.physical_stock_estimate - (localReserved.get(item.product_id) || 0) - item.product_fbp_reserved);
  }
  return result;
}
