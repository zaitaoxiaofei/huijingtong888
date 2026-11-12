import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from "./business-task-tenant.js";
import { WB_REMOTE_WRITES_ENABLED } from '../shared/wb-capabilities.js';
import { wbPlatform } from './wb-platform.js';
import { wbOrderCapabilities } from '../shared/wb-order-state.js';

export async function enrichWbOrders(result) {
  const rows = Array.isArray(result) ? result : result?.rows;
  const wbRows = (rows || []).filter(row => row.platform === 'wb');
  if (!wbRows.length) return result;
  const { mysqlQuery } = await import('../mysql-pool.js');
  const ids = wbRows.map(row=>Number(row.id));
  const details = await mysqlQuery(`SELECT w.order_id,w.supplier_status AS wb_supplier_status,w.wb_status,w.supply_id AS wb_supply_id,w.raw_json
    FROM wb_order_details w JOIN orders o ON o.id=w.order_id AND o.shop_id=w.shop_id
    JOIN shops s ON s.id=w.shop_id AND s.tenant_id=w.tenant_id
    WHERE w.order_id IN (${ids.map(()=>'?').join(',')})`, ids);
  const map = new Map(details.map(row=>[Number(row.order_id),row]));
  for (const row of wbRows) {
    const detail = map.get(Number(row.id));
    if (!detail) continue;
    const raw = typeof detail.raw_json === 'string' ? JSON.parse(detail.raw_json) : detail.raw_json;
    Object.assign(row, { wb_supplier_status: detail.wb_supplier_status, wb_status: detail.wb_status, wb_supply_id: detail.wb_supply_id,
      availableActions: { ...wbOrderCapabilities(detail), ...(!WB_REMOTE_WRITES_ENABLED ? {prepare:false,print:false,handover:false}:{}), profit: false }, fulfillment_type_key: 'fbs', fulfillment_type_label: 'FBS',
      warehouse_name: raw?.warehouseId ? `WB 卖家仓 ${raw.warehouseId}` : '', sale_currency: raw?.currencyCode === 643 ? 'RUB' : '',
      wb_amount: Number(raw?.price || 0) / 100 });
  }
  return result;
}

async function partitionWbOrders(ids, session) {
  if (!session?.tenant?.id || !session.tenant.slug) throw Object.assign(new Error('缺少有效企业上下文。'), { statusCode: 403 });
  const { mysqlQuery } = await import('../mysql-pool.js');
  const clean = [...new Set((ids || []).map(Number))];
  if (!clean.length || clean.some(id=>!Number.isSafeInteger(id)||id<=0)) throw new Error('请选择有效订单。');
  const rows = await mysqlQuery(`SELECT o.id,s.platform FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id IN (${clean.map(()=>'?').join(',')}) AND (s.tenant_id=?${session.tenant.slug === 'default' ? ' OR s.tenant_id IS NULL' : ''})`, [...clean, Number(session.tenant.id)]);
  if(rows.some(row=>!['ozon','wb'].includes(row.platform||'ozon')))throw Object.assign(new Error('所选平台尚未接通此履约操作。'),{statusCode:409});
  if (rows.length !== clean.length) throw Object.assign(new Error('部分订单不存在或不属于当前企业。'), { statusCode: 404 });
  return { wb: clean.filter(id=>rows.find(row=>Number(row.id)===id)?.platform==='wb'), ozon: clean.filter(id=>rows.find(row=>Number(row.id)===id)?.platform!=='wb') };
}

export async function dispatchPrepare(body, userId, tenantId, options, ozonPrepare) {
  const session = await authorizeBusinessTaskSession(options.session);
  assertBusinessTaskPermission(session, 'packing');
  options = { ...options, session };
  const groups = await partitionWbOrders(body.order_ids, options.session);
  if (!groups.wb.length) return ozonPrepare(body, userId, tenantId, options);
  // Validate the complete selection before submitting any platform operation.
  const wb = await wbPlatform(options.session, 'packing');
  const rows = await wb.ownedOrders(options.session.tenant.id, groups.wb);
  const shops = [...new Set(rows.map(row=>Number(row.shop_id)))];
  const results = [];
  for (const shopId of shops) results.push(await wb.prepare(options.session.tenant.id, { order_ids: rows.filter(row=>Number(row.shop_id)===shopId).map(row=>Number(row.id)) }));
  if (groups.ozon.length) results.push(await ozonPrepare({ ...body, order_ids: groups.ozon }, userId, tenantId, options));
  return { ok: true, count: results.reduce((sum,row)=>sum+Number(row.count||0),0), order_ids: results.flatMap(row=>row.order_ids||[]), updated_orders: results.flatMap(row=>row.updated_orders||[]) };
}

export async function dispatchLabels(body, userId, tenantId, options, ozonLabels) {
  const session = await authorizeBusinessTaskSession(options.session);
  assertBusinessTaskPermission(session, 'packing');
  options = { ...options, session };
  if (!body.order_ids?.length) return ozonLabels(body, userId, tenantId, options);
  if(body.order_ids.length>80)throw Object.assign(new Error('每批最多打印 80 张面单。'),{statusCode:400});
  const groups = await partitionWbOrders(body.order_ids, options.session);
  if (!groups.wb.length) return ozonLabels(body, userId, tenantId, options);
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  const wb = await wbPlatform(options.session, 'packing');
  const stickers = await wb.stickers(options.session.tenant.id, { order_ids: groups.wb });
  const images = new Map(stickers.rows.map(row=>[Number(row.order_id),row.file]));
  // Fetch each Ozon page through the original path; output remains in selection order.
  for (const id of body.order_ids.map(Number)) {
    if (images.has(id)) {
      const image = await document.embedPng(Buffer.from(images.get(id), 'base64'));
      const page = document.addPage([58 / 25.4 * 72, 40 / 25.4 * 72]);
      page.drawImage(image, { x:0,y:0,width:page.getWidth(),height:page.getHeight() });
    } else {
      const label = await ozonLabels({ ...body, order_ids:[id] }, userId, tenantId, options);
      const pdf = await PDFDocument.load(label.buffer);
      for (const page of await document.copyPages(pdf, pdf.getPageIndices())) document.addPage(page);
    }
  }
  return { buffer: Buffer.from(await document.save()), filename:'order-labels.pdf', count:body.order_ids.length, printed_ids:body.order_ids.map(Number), failures:[], stats:{} };
}
