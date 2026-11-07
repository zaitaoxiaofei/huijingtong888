import { createHash } from 'node:crypto';
import { receiptEvidence } from './procurement-evidence.js';

const conflict = () => Object.assign(new Error('此入库标识已提交，不能修改批次、数量或凭证；请刷新后重新登记'), { statusCode: 409 });

export function newArrivalReceiptRequest(body = {}) {
  if (!body.request_key || body.receipt_mode === 'historical' || (body.receipt_mode == null && body.counted_quantity != null)) return null;
  const key = String(body.request_key);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)) {
    throw Object.assign(new Error('入库操作标识无效，请关闭后重新打开入库页面'), { statusCode: 400 });
  }
  const productId = Number(body.product_id);
  const records = (Array.isArray(body.records) ? body.records : []).map(row => ({
    id: Number(row.id), quantity: Number(row.quantity), expected_quantity: Number(row.expected_quantity),
    reason: String(row.reason || ''), note: String(row.note || ''), ...receiptEvidence(row)
  })).sort((a, b) => a.id - b.id);
  const hash = createHash('sha256').update(JSON.stringify({ product_id: productId,
    receipt_mode: body.receipt_mode ?? 'new_arrival', expected_revision: body.expected_revision ?? null, records })).digest('hex');
  return { key, hash, productId };
}

export async function readNewArrivalReceipt(query, tenantId, personId, request, { lock = false } = {}) {
  const [event] = await query(`SELECT product_id,detail_json FROM inventory_flow_events
    WHERE tenant_id=? AND person_id=? AND action='purchase_receipt'
      AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [tenantId, personId, request.key]);
  if (!event) return null;
  let saved;
  try { saved = typeof event.detail_json === 'string' ? JSON.parse(event.detail_json) : event.detail_json; } catch { throw conflict(); }
  if (Number(event.product_id) !== request.productId || saved?.hash !== request.hash || !saved?.result?.ok) throw conflict();
  return { ...saved.result, duplicate: true };
}
