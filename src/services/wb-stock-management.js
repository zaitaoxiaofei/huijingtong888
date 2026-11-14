const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const id = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw fail('请选择有效的 WB 店铺、卖家仓和商品规格。'); return n; };
const amount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

// Manual platform stock settings are independent of local physical stock and SKU binding.
export function createWbStockManagement({ account, query, request }) {
  async function context(tenantId, body, writing = false) {
    const a = await account(tenantId, body.shop_id), warehouse = id(body.warehouse_id || a.wb_warehouse_id);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000) throw fail('每批请选择 1–1000 个 WB 规格，更多商品会由页面自动分批处理。');
    const seen = new Set();
    const items = body.items.map(item => {
      const row = { nm_id: id(item.nm_id), chrt_id: id(item.chrt_id) };
      if (seen.has(row.chrt_id)) throw fail('同一批次不能重复提交相同的 WB 规格。');
      seen.add(row.chrt_id);
      if (writing) {
        if (!amount(item.quantity)) throw fail('修改后数量必须填写为非负整数，清零请填写 0。');
        if (item.current !== null && !amount(item.current)) throw fail('缺少有效的 WB 当前库存，请先刷新库存再提交。');
        row.quantity = item.quantity; row.current = item.current;
      }
      return row;
    });
    const warehouses = await request(a, 'marketplace', '/api/v3/warehouses');
    const selected = Array.isArray(warehouses) && warehouses.find(row => Number(row.id) === warehouse);
    if (!selected || selected.isDeleting || selected.isProcessing) throw fail('所选 WB 卖家仓不存在、正在处理中或不属于当前店铺，请重新选择仓库。', 409);
    const nms = [...new Set(items.map(row => row.nm_id))];
    const cards = await query(`SELECT nm_id,raw_json FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id IN (${nms.map(() => '?').join(',')})`, [a.tenant_id, a.shop_id, ...nms]);
    const byId = new Map(cards.map(row => [Number(row.nm_id), parse(row.raw_json)]));
    for (const row of items) {
      const card = byId.get(row.nm_id);
      if (!card || card._wb_archived || !card.sizes?.some(size => Number(size.chrtID) === row.chrt_id)) throw fail('所选 WB 商品或规格不属于此店铺，或已归档，请同步商品后重新选择。', 409);
    }
    return { a, warehouse, items };
  }
  async function read(ctx) {
    const result = await request(ctx.a, 'marketplace', `/api/v3/stocks/${ctx.warehouse}`, { method: 'POST', body: { chrtIds: ctx.items.map(row => row.chrt_id) } });
    if (!Array.isArray(result.stocks)) throw fail('WB 未返回有效库存列表，请刷新重试；未返回的数量不会当作 0。', 502);
    const stocks = new Map();
    for (const row of result.stocks) if (amount(row.amount)) stocks.set(Number(row.chrtId), row.amount);
    return stocks;
  }
  async function readStockBatch(tenantId, body) {
    const ctx = await context(tenantId, body), stocks = await read(ctx);
    return { warehouse_id: ctx.warehouse, rows: ctx.items.map(row => ({ ...row, current: stocks.get(row.chrt_id) ?? null })) };
  }
  async function setStockBatch(tenantId, body) {
    const ctx = await context(tenantId, body, true), before = await read(ctx);
    const rows = ctx.items.map(row => ({ ...row, current: before.get(row.chrt_id) ?? null, status: 'pending', message: '' }));
    const eligible = rows.filter((row, index) => {
      if (row.current === ctx.items[index].current) return true;
      row.status = 'conflict'; row.message = 'WB 当前库存已变化，本行未修改；请核对新数量后重新提交。'; return false;
    });
    if (!eligible.length) return { ok: false, warehouse_id: ctx.warehouse, rows };
    let writeError;
    try {
      await request(ctx.a, 'marketplace', `/api/v3/stocks/${ctx.warehouse}`, { method: 'PUT', body: { stocks: eligible.map(row => ({ chrtId: row.chrt_id, amount: row.quantity })) } });
    } catch (error) { writeError = error; }
    let after;
    try { after = await read(ctx); } catch { /* An accepted write is not confirmed until read back. */ }
    for (const row of eligible) {
      row.current = after?.get(row.chrt_id) ?? null;
      if ((!writeError || writeError.code === 'WB_RESULT_UNKNOWN') && row.current === row.quantity) {
        row.status = 'success'; row.message = '修改成功，已回读核对';
      } else {
        row.status = writeError && writeError.code !== 'WB_RESULT_UNKNOWN' ? 'failed' : 'unconfirmed';
        row.message = writeError?.message || '已提交，WB 回读尚未一致；请先刷新库存核对，不会自动重发。';
      }
    }
    return { ok: rows.every(row => row.status === 'success'), warehouse_id: ctx.warehouse, rows };
  }
  return { readStockBatch, setStockBatch };
}
