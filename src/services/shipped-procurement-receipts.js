export function selectedReceiptOrderIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 200
    || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error('请勾选 1 至 200 个订单后预览补登清单');
  }
  return [...new Set(value.map(Number))].sort((a, b) => a - b);
}

export function planShippedProcurementReceipts(coverage, orderIds) {
  const selected = new Set(selectedReceiptOrderIds(orderIds));
  const lines = new Map();
  const skipped = [];
  for (const id of selectedReceiptOrderIds(orderIds)) {
    const order = coverage.get(id);
    if (!order || order.stock_location === 'FBP' || !order.entered_transport || order.needs_fulfillment || order.quantity_needs_review) {
      skipped.push({ order_id: id, posting_number: order?.posting_number || String(id), reason: '未进入运输、FBP 或数量待核，不自动建议补登' });
      continue;
    }
    let added = false;
    for (const item of order.items) {
      let missing = Number(item.missing_record_quantity || 0);
      if (!(item.product_id > 0) || !Number.isInteger(missing)) continue;
      for (const claim of item.receipt_claims || []) {
        if (claim.unallocated) continue; // Suggested historical matches require explicit ledger linking.
        const batch = order.batches.find(b => Number(b.id) === Number(claim.batch_id));
        if (!batch || batch.status !== 'pending_arrival' || Number(batch.product_id) !== item.product_id) continue;
        const quantity = Math.min(missing, Number(claim.quantity));
        if (!Number.isInteger(quantity) || quantity <= 0) continue;
        const line = lines.get(Number(batch.id)) || { id: Number(batch.id), product_id: Number(batch.product_id), purchase_order_id: Number(batch.purchase_order_id || 0), procurement_request_id: Number(batch.procurement_request_id || 0), product_name: batch.product_name, unit: batch.stock_unit || '件',
          purchase_order_no: batch.purchase_order_no || '', remaining_quantity: Number(batch.quantity),
          version_updated_at: batch.updated_at instanceof Date ? batch.updated_at.toISOString() : String(batch.updated_at || ''), quantity: 0, orders: [] };
        line.quantity += quantity;
        line.orders.push({ order_id: id, posting_number: order.posting_number || String(id), quantity });
        lines.set(Number(batch.id), line);
        missing -= quantity;
        added = true;
      }
    }
    if (!added) skipped.push({ order_id: id, posting_number: order.posting_number || String(id), reason: '无明确的未收采购关联，或来源已覆盖，请核对记录' });
  }
  // The legacy allocator assigns approved receipts FIFO within a purchase/product.
  // Require its entire pending recipient group to be selected and eligible so
  // receiving a later order cannot silently satisfy an unselected earlier one.
  for (const line of [...lines.values()]) {
    let ambiguous = false;
    for (const order of coverage.values()) {
      for (const item of order.items) {
        if (item.product_id !== line.product_id) continue;
        const related = (item.receipt_claims || []).some(claim => {
          const batch = order.batches.find(b => Number(b.id) === Number(claim.batch_id));
          return batch && (line.purchase_order_id ? Number(batch.purchase_order_id) === line.purchase_order_id
            : Number(batch.procurement_request_id) === line.procurement_request_id);
        });
        if (related && (!selected.has(order.order_id) || !order.entered_transport || order.needs_fulfillment
          || order.quantity_needs_review || !(item.missing_record_quantity > 0))) ambiguous = true;
      }
    }
    if (ambiguous) {
      lines.delete(line.id);
      for (const order of line.orders) skipped.push({ ...order, reason: '同采购单商品还关联其他未选或待核订单，请一并勾选已运输关联订单核对；无法确认时到采购工作台登记' });
    }
  }
  for (const line of lines.values()) {
    if (!Number.isInteger(line.remaining_quantity) || line.quantity > line.remaining_quantity) throw new Error('关联数量超过批次余量，请先核对采购记录');
  }
  return { records: [...lines.values()].sort((a, b) => a.id - b.id), skipped };
}

export function validateShippedReceiptSubmission(plan, records) {
  if (!Array.isArray(records) || !records.length || records.length > 200) throw new Error('请选择需要补登的批次');
  const seen = new Set();
  return records.map(record => {
    const line = plan.records.find(row => row.id === Number(record.id));
    if (!line || seen.has(line.id)) throw new Error('批次已变化或重复，请重新预览');
    seen.add(line.id);
    const quantity = Number(record.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > line.quantity
      || Number(record.remaining_quantity) !== line.remaining_quantity
      || !record.version_updated_at || String(record.version_updated_at) !== String(line.version_updated_at)) {
      throw new Error('补登数量或采购批次已变化，请重新预览并确认');
    }
    return { ...line, quantity };
  });
}
