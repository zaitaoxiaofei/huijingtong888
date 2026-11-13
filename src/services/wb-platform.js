import {createWbProductWorkspace,saveWbProductCard,wbProductView} from './wb-product-workspace.js';
import {createWbPublishRecords} from './wb-publish-records.js';
import {createWbProductOperations} from './wb-product-operations.js';
import {createWbPublishFlow} from './wb-publish-flow.js';
import {WB_LISTING_PUBLISH_ENABLED} from '../shared/wb-capabilities.js';
import { readWbCardLimits } from './wb-card-limits.js';
import { createWbCategoryCatalog } from "./wb-category-catalog.js";
import { createWbListingWorkflow } from "./wb-listing-workflow.js";
import { wbListingSource } from "../shared/wb-listing-source.js";
import { resolveInventoryTenantScope, inventoryTenantSql } from "./inventory-tenant-scope.js";
import { WB_REMOTE_WRITES_ENABLED, WB_REMOTE_WRITE_ACTIONS } from '../shared/wb-capabilities.js';
import { randomUUID, createHash } from 'node:crypto';
import { wbRequest } from './wb-client.js';
import { wbOrderState } from '../shared/wb-order-state.js';
import { assertTenantQuotaAvailable } from './tenant-quotas.js';

const pricingCommissionCache = new Map();

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const positiveId = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('缺少有效的店铺、商品或订单编号，请刷新后重新选择。');
  return id;
};
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

export function createWbPlatform({ actorId, query, transaction, request = wbRequest, invalidate = () => {}, reconcileInventory = async () => {}, loadAvailability, loadSourceDraft, createInventoryProduct, prepareInventoryProduct }) {
  async function account(tenantId, shopId, allowUnchecked = false) {
    const rows = await query(`SELECT c.*, s.name FROM wb_shop_credentials c JOIN shops s ON s.id=c.shop_id
      WHERE c.tenant_id=? AND s.tenant_id=? AND c.shop_id=? AND s.platform='wb' AND s.status='active'`,
    [positiveId(tenantId), positiveId(tenantId), positiveId(shopId)]);
    if (!rows[0]) throw fail('该 WB 店铺不存在、已停用或不属于当前企业，请在企业店铺中检查。', 404);
    if(!allowUnchecked && rows[0].environment==='production' && (!rows[0].checked_at||!rows[0].seller_id))throw fail('WB 授权尚未核对，请先在企业店铺点击“检查授权”，确认 Token 对应的卖家身份后再拉取数据。',409);
    return rows[0];
  }
  async function cardLimits(tenantId, body) {
    return readWbCardLimits(await account(tenantId, body.shop_id), request);
  }
  async function pricingCommissions(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    const key = `${a.tenant_id}:${a.shop_id}:${createHash('sha256').update(a.token).digest('hex')}`;
    const cached = pricingCommissionCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = load();
    if (pricingCommissionCache.size >= 100) pricingCommissionCache.delete(pricingCommissionCache.keys().next().value);
    pricingCommissionCache.set(key, { value, expires: Date.now() + 12 * 60 * 1000 });
    try { return await value; } catch (error) { pricingCommissionCache.delete(key); throw error; }
    async function load() {
      const data = await request(a, 'common', '/api/v1/tariffs/commission', { query: { locale: 'zh' } });
      const rows = (Array.isArray(data.report) ? data.report : []).filter(row =>
        Number.isSafeInteger(Number(row.subjectID)) && Number(row.subjectID) > 0
        && row.kgvpChina !== '' && row.kgvpChina !== null && row.kgvpChina !== undefined && Number.isFinite(Number(row.kgvpChina))
        && Number(row.kgvpChina) >= 0 && Number(row.kgvpChina) < 100).map(row => ({
        id: row.subjectID, category: String(row.subjectName || ''), parent: String(row.parentName || ''), rate: Number(row.kgvpChina)
      }));
      if (!rows.length) throw fail('WB 未返回中国跨境类目佣金（kgvpChina），请在 WB 卖家后台核对类目费率后手动填写。', 502);
      return { rows, source: 'WB 中国区官方类目佣金', fetched_at: new Date().toISOString() };
    }
  }
  async function shops(tenantId) {
    return query(`SELECT s.id,s.name,s.platform,s.user_id,p.name AS user_name,s.legal_entity,s.status,
      c.environment,c.seller_id,c.handover_mode,c.wb_warehouse_id,c.local_warehouse_id,c.checked_at,c.updated_at,
      (LENGTH(c.token)>0) AS wb_token_configured FROM shops s
      JOIN wb_shop_credentials c ON c.shop_id=s.id AND c.tenant_id=s.tenant_id
      LEFT JOIN people p ON p.id=s.user_id WHERE s.tenant_id=? AND s.platform='wb' AND s.status<>'deleted' ORDER BY s.id`, [positiveId(tenantId)]);
  }
  async function saveShop(tenantId, body) {
    const tenant = positiveId(tenantId), user = positiveId(body.user_id);
    const name = String(body.name || '').trim();
    if (!name || name.length > 255) throw fail('请填写不超过 255 个字符的店铺名称。');
    const environment = body.environment || 'production';
    if (!['production', 'sandbox'].includes(environment)) throw fail('请选择正式或沙箱环境。');
    const mode=body.handover_mode||'unverified';
    if(!['unverified','shipping_units','collection_point'].includes(mode))throw fail('WB 交接要求无效，请按揽收点实际要求选择。');
    const token = String(body.wb_token || '').trim();
    if (!body.id && !token) throw fail('缺少 WB API Token，请在 WB 卖家后台创建授权后填写。');
    if (token.length > 8192 || /[\r\n]/.test(token)) throw fail('WB Token 格式无效，请重新复制完整授权。');
    const result = await transaction(async connection => {
      const [tenantRows] = await connection.execute('SELECT id,slug,shop_limit FROM tenants WHERE id=? FOR UPDATE', [tenant]);
      if (!tenantRows[0]) throw fail('当前企业不存在。', 403);
      const [members] = await connection.execute(`SELECT tm.person_id FROM tenant_members tm JOIN people p ON p.id=tm.person_id
        WHERE tm.tenant_id=? AND tm.person_id=? AND tm.active=1 AND p.active=1`, [tenant, user]);
      if (!members.length) throw fail('店铺负责人必须是当前企业的有效成员。');
      const [duplicates] = await connection.execute(`SELECT id FROM shops WHERE tenant_id=? AND name=? AND status<>'deleted' AND id<>?`, [tenant, name, Number(body.id || 0)]);
      if (duplicates.length) throw fail('本企业已有同名店铺，请换一个店铺名称。', 409);
      let shopId = Number(body.id || 0);
      if (shopId) {
        const [current] = await connection.execute(`SELECT c.environment,c.updated_at FROM shops s JOIN wb_shop_credentials c ON c.shop_id=s.id
          WHERE s.id=? AND s.tenant_id=? AND c.tenant_id=? AND s.platform='wb' FOR UPDATE`, [positiveId(shopId), tenant, tenant]);
        if (!current[0]) throw fail('WB 店铺不存在或不属于当前企业。', 404);
        if (body.updated_at && new Date(body.updated_at).getTime() !== new Date(current[0].updated_at).getTime()) throw fail('店铺已被其他用户修改，请刷新后重试。', 409);
        if (current[0].environment !== environment) throw fail('已有店铺不能切换正式/沙箱环境，请分别创建店铺，避免订单编号和库存混用。', 409);
        await connection.execute(`UPDATE shops SET name=?,legal_entity=?,user_id=?,status=? WHERE id=? AND tenant_id=? AND platform='wb'`,
        [name, String(body.legal_entity || ''), user, body.status === 'inactive' ? 'inactive' : 'active', shopId, tenant]);
        await connection.execute('UPDATE wb_shop_credentials SET handover_mode=? WHERE shop_id=? AND tenant_id=?',[mode,shopId,tenant]);
        if (token) await connection.execute('UPDATE wb_shop_credentials SET token=?,checked_at=NULL WHERE shop_id=? AND tenant_id=?', [token, shopId, tenant]);
      } else {
        const [counts] = await connection.execute(`SELECT COUNT(*) AS used FROM shops WHERE (tenant_id=? OR (?=1 AND tenant_id IS NULL)) AND status<>'deleted'`, [tenant,tenantRows[0].slug==='default'?1:0]);
        assertTenantQuotaAvailable({ label: '店铺', current: counts[0].used, limit: tenantRows[0].shop_limit });
        const [created] = await connection.execute(`INSERT INTO shops (tenant_id,name,legal_entity,user_id,platform,payout_rate) VALUES (?,?,?,?,'wb',0)`, [tenant, name, String(body.legal_entity || ''), user]);
        shopId = Number(created.insertId);
        await connection.execute('INSERT INTO wb_shop_credentials (shop_id,tenant_id,token,environment,handover_mode) VALUES (?,?,?,?,?)', [shopId, tenant, token, environment,mode]);
      }
      return { ok: true, id: shopId };
    });
    invalidate();
    return result;
  }
  async function check(tenantId, body) {
    const a = await account(tenantId, body.shop_id, true);
    // Per-service pings test the actual permissions used by this integration.
    const checks = [];
    for (const service of ['marketplace', 'content', 'prices']) {
      try { await request(a, service, '/ping'); checks.push({ service, ok: true }); }
      catch (error) { checks.push({ service, ok: false, message: error.message }); }
    }
    let sellerId=a.seller_id;
    if(a.environment==='production'){
      const seller=await request(a,'common','/api/v1/seller-info');
      sellerId=String(seller.sid||'').trim();
      if(!sellerId||sellerId.length>128)throw fail('WB 未返回有效卖家身份，授权检查尚未完成，请稍后重试。',502);
      if(a.seller_id&&a.seller_id!==sellerId)throw fail('新 Token 对应另一家 WB 店铺，未通过身份检查；请使用原店铺授权或另建 WB 店铺。',409);
      const duplicate=await query('SELECT shop_id FROM wb_shop_credentials WHERE tenant_id=? AND environment=? AND seller_id=? AND shop_id<>?',[a.tenant_id,a.environment,sellerId,a.shop_id]);
      if(duplicate.length)throw fail('该 WB 卖家已绑定本企业的另一家店铺，请使用已有店铺，避免重复导入订单。',409);
    }
    if (checks.every(item => item.ok)) {
      try{await query('UPDATE wb_shop_credentials SET checked_at=UTC_TIMESTAMP(),seller_id=? WHERE shop_id=? AND tenant_id=?', [sellerId||null,a.shop_id, a.tenant_id]);}
      catch(error){if(error.code==='ER_DUP_ENTRY')throw fail('该 WB 卖家已绑定本企业另一家店铺，请使用已有店铺。',409);throw error;}
    }
    return { ok: checks.every(item => item.ok), checks, seller_id:sellerId||null };
  }
  async function warehouses(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    return { rows: await request(a, 'marketplace', '/api/v3/warehouses'), selected: a.wb_warehouse_id };
  }
  async function saveWarehouse(tenantId, body) {
    const a = await account(tenantId, body.shop_id), id = positiveId(body.warehouse_id);
    const rows = await request(a, 'marketplace', '/api/v3/warehouses');
    if (!rows.some(row => Number(row.id) === id)) throw fail('该 WB 仓库不属于此店铺，请重新选择。', 403);
    await query('UPDATE wb_shop_credentials SET wb_warehouse_id=? WHERE tenant_id=? AND shop_id=?', [id, a.tenant_id, a.shop_id]);
    return { ok: true };
  }
  async function syncProducts(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    let cursor = { limit: 100 }, count = 0;
    for (let page = 0; page < 1000; page++) {
      const result = await request(a, 'content', '/content/v2/get/cards/list', { method: 'POST', query:{locale:'zh'}, body: { settings: { cursor, filter: { withPhoto: -1 } } } });
      if(!Array.isArray(result.cards))throw fail('WB 商品接口未返回商品列表，本次同步未完成，请检查授权并重试。',502);
      const cards = result.cards;
      for (const card of cards) {
        await saveWbProductCard(query,a,card);
        count++;
      }
      if (cards.length < 100) return { ok: true, count };
      if (!result.cursor?.updatedAt || !result.cursor?.nmID || (cursor.updatedAt === result.cursor.updatedAt && cursor.nmID === result.cursor.nmID)) throw fail('WB 商品分页游标没有推进，本次同步未完整完成，请重试。', 502);
      cursor = { limit: 100, updatedAt: result.cursor.updatedAt, nmID: result.cursor.nmID };
    }
    throw fail('WB 商品数量超过本次同步范围，请联系管理员分批同步。', 409);
  }
  async function products(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    const rows = await query('SELECT * FROM wb_product_cards WHERE tenant_id=? AND shop_id=? ORDER BY nm_id DESC', [a.tenant_id, a.shop_id]);
    const scope=await resolveInventoryTenantScope(a.tenant_id,query);
    const mappings = await query(`SELECT sm.ozon_sku,sm.product_id,p.name AS product_name,p.code AS product_code,p.inventory_number FROM sku_mappings sm
      JOIN products p ON p.id=sm.product_id AND ${inventoryTenantSql(scope,'p')} WHERE sm.tenant_id=? AND sm.shop_id=? AND sm.active=1`, [a.tenant_id,a.shop_id]);
    return { rows: rows.map(row => ({ ...wbProductView(row,a),
      mappings: mappings.filter(item=>(parse(row.raw_json).sizes||[]).some(size=>`WB-${size.chrtID}`===item.ozon_sku)) })) };
  }
  async function bindProduct(tenantId, body) {
    const a = await account(tenantId, body.shop_id), productId = positiveId(body.product_id), chrtId = positiveId(body.chrt_id);
    const cards = await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?', [a.tenant_id,a.shop_id,positiveId(body.nm_id)]);
    if (!cards[0] || !(parse(cards[0].raw_json).sizes||[]).some(size=>Number(size.chrtID)===chrtId)) throw fail('WB 商品规格不属于所选店铺，请先同步商品。',404);
    const scope=await resolveInventoryTenantScope(a.tenant_id,query);
    await transaction(async connection=>{
      const [products] = await connection.execute(`SELECT id FROM products WHERE id=? AND ${inventoryTenantSql(scope)} AND active=1 FOR UPDATE`,[productId]);
      if (!products.length) throw fail('基础商品不存在或不属于当前企业。',404);
      const sku = `WB-${chrtId}`;
      const [existing] = await connection.execute('SELECT id,product_id FROM sku_mappings WHERE tenant_id=? AND shop_id=? AND ozon_sku=? FOR UPDATE',[a.tenant_id,a.shop_id,sku]);
      if (existing[0] && Number(existing[0].product_id)!==productId) throw fail('此 WB 规格已绑定其他基础商品，请先核对历史订单与库存，不支持直接覆盖绑定。',409);
      if (!existing.length) await connection.execute(`INSERT INTO sku_mappings (tenant_id,shop_id,product_id,ozon_sku,offer_id,commission_low,commission_high) VALUES (?,?,?,?,?,0,0)`,[a.tenant_id,a.shop_id,productId,sku,String(parse(cards[0].raw_json).vendorCode||'')]);
    });
    const orders = await query('SELECT order_id FROM wb_order_details WHERE tenant_id=? AND shop_id=?',[a.tenant_id,a.shop_id]);
    for (const order of orders) await reconcileInventory(order.order_id,a.tenant_id);
    invalidate();
    return {ok:true};
  }
  async function uploadMedia(tenantId,body) {
    const a=await account(tenantId,body.shop_id), nm=positiveId(body.nm_id);
    const owned=await query('SELECT id FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?',[a.tenant_id,a.shop_id,nm]);
    if(!owned.length)throw fail('商品不属于所选 WB 店铺。',404);
    const urls=body.urls;
    if(!Array.isArray(urls)||!urls.length||urls.length>30||urls.some(value=>{try{return new URL(value).protocol!=='https:';}catch{return true;}}))throw fail('请填写 1–30 个有效的 HTTPS 图片地址。');
    const result=await request(a,'content','/content/v3/media/save',{method:'POST',body:{nmId:nm,data:urls}});
    if(result.error)throw fail('WB 未接受图片，请核对图片格式和地址。',409);
    return {ok:true,pending:true,message:'图片已提交，请稍后同步商品核对显示结果。'};
  }
  async function prices(tenantId,body) {
    return request(await account(tenantId,body.shop_id),'prices','/api/v2/list/goods/filter',{query:{limit:100,offset:Number(body.offset||0),filterNmID:body.nm_id||undefined}});
  }
  async function setPrice(tenantId,body) {
    const a=await account(tenantId,body.shop_id),nm=positiveId(body.nm_id),price=Number(body.price),discount=Number(body.discount||0);
    const owned=await query('SELECT id FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?',[a.tenant_id,a.shop_id,nm]);
    if(!owned.length)throw fail('商品不属于所选 WB 店铺。',404);
    if(!Number.isFinite(price)||price<=0||!Number.isInteger(discount)||discount<0||discount>99)throw fail('售价须大于零，折扣须为 0–99 的整数。');
    const result=await request(a,'prices','/api/v2/upload/task',{method:'POST',body:{data:[{nmID:nm,price,discount}]}});
    if(result.error||!result.data?.id)throw fail('WB 未确认收到改价任务，请核对价格后重试。',409);
    return {ok:true,pending:true,upload_id:result.data.id,message:'改价任务已提交，价格尚未确认生效；请检查处理结果和商品级错误。'};
  }
  async function priceResult(tenantId,body) {
    const a=await account(tenantId,body.shop_id),uploadID=positiveId(body.upload_id);
    return { task:await request(a,'prices','/api/v2/history/tasks',{query:{uploadID}}),
      details:await request(a,'prices','/api/v2/history/goods/task',{query:{uploadID,limit:100,offset:0}}) };
  }
  async function stockContext(tenantId,body,readOnly=false) {
    const a=await account(tenantId,body.shop_id);
    if(!a.wb_warehouse_id)throw fail('缺少 WB 卖家仓绑定，请由企业管理员在企业店铺中绑定 WB 仓库。',409);
    const cards=await query('SELECT raw_json FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?',[a.tenant_id,a.shop_id,positiveId(body.nm_id)]);
    const size=cards[0]&&(parse(cards[0].raw_json).sizes||[]).find(item=>Number(item.chrtID)===positiveId(body.chrt_id));
    if(!size?.skus?.length)throw fail('WB 商品规格或条码不存在，请先同步商品。',404);
    const mappings=await query('SELECT product_id FROM sku_mappings WHERE tenant_id=? AND shop_id=? AND ozon_sku=? AND active=1',[a.tenant_id,a.shop_id,`WB-${positiveId(body.chrt_id)}`]);
    if(!mappings[0]){if(readOnly)return {a,size,available:null,availability_message:'该规格尚未绑定基础商品，无法核对本地可分配量。'};throw fail('该 WB 规格尚未绑定基础商品，请先绑定库存。',409);}
    if(!loadAvailability){if(readOnly)return {a,size,available:null,availability_message:'本地库存核对暂不可用。'};throw fail('本地库存核对暂不可用，未推送库存。',503);}
    const scope=await resolveInventoryTenantScope(a.tenant_id,query);
    const value=await loadAvailability({productIds:String(mappings[0].product_id)},scope.isDefault?'admin':String(a.tenant_id));
    const local=value.rows.find(row=>Number(row.product_id)===Number(mappings[0].product_id));
    if(!local||local.inventory_needs_review){if(readOnly)return {a,size,available:null,availability_message:'本地库存需要在库存总览核对。'};throw fail('本地库存需要核对，未推送 WB 库存，请先在库存总览处理。',409);}
    return {a,size,available:Math.max(0,Math.floor(Number(local.local_available??local.available_stock??0)))};
  }
  async function stocks(tenantId,body) {
    const {a,size,available,availability_message}=await stockContext(tenantId,body,true);
    return {...await request(a,'marketplace',`/api/v3/stocks/${a.wb_warehouse_id}`,{method:'POST',body:{skus:[size.skus[0]]}}),available,availability_message,warehouse_id:a.wb_warehouse_id};
  }
  async function setStocks(tenantId,body) {
    const {a,size,available}=await stockContext(tenantId,body),amount=Number(body.quantity);
    if(!Number.isSafeInteger(amount)||amount<0||amount>available)throw fail(`WB 发布数量须为 0–${available} 的整数；可用量已扣除共用仓的订单及备货占用。`);
    await request(a,'marketplace',`/api/v3/stocks/${a.wb_warehouse_id}`,{method:'PUT',body:{stocks:[{sku:size.skus[0],amount}]}});
    const value=await request(a,'marketplace',`/api/v3/stocks/${a.wb_warehouse_id}`,{method:'POST',body:{skus:[size.skus[0]]}});
    const confirmed=value.stocks?.some(row=>row.sku===size.skus[0]&&Number(row.amount)===amount);
    return {ok:true,pending:!confirmed,message:confirmed?'WB 库存已回读核对；本地实物库存未改变。':'WB 库存已提交，回读尚未一致，请刷新核对。'};
  }
  async function categories(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    return request(a, 'content', '/content/v2/object/all', { query: { locale: 'zh', name: String(body.search || ''), limit: 100 } });
  }
  async function characteristics(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    return request(a, 'content', `/content/v2/object/charcs/${positiveId(body.subject_id)}`, { query: { locale: 'zh' } });
  }
  async function publish(tenantId, body) {
    const a = await account(tenantId, body.shop_id), card = body.card;
    if (!card || !String(card.title || '').trim() || !String(card.vendorCode || '').trim()) throw fail('请在 WB 商品编辑中填写商品标题和商家货号。');
    if (!Array.isArray(card.sizes) || !card.sizes.length || card.sizes.some(size => !size.skus?.length)) throw fail('请为每个规格填写商品条码。');
    const subject = positiveId(body.subject_id || card.subjectID);
    const attributes = await request(a, 'content', `/content/v2/object/charcs/${subject}`, { query: { locale: 'zh' } });
    const missing = (attributes.data || []).filter(item => item.required && !(card.characteristics || []).some(value => Number(value.id) === Number(item.charcID) && value.value?.length));
    if (missing.length) throw fail(`商品缺少 WB 类目必填属性：${missing.map(item => item.name).join('、')}。请在商品编辑中补全。`);
    if (card.nmID) {
      const owned = await query('SELECT id FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id=?', [a.tenant_id, a.shop_id, positiveId(card.nmID)]);
      if (!owned.length) throw fail('该 WB 商品不属于此店铺，请先同步商品。', 404);
    }
    const variant = { vendorCode: String(card.vendorCode), title: String(card.title), brand: String(card.brand || ''), description: String(card.description || ''), dimensions: card.dimensions, characteristics: card.characteristics || [], sizes: card.sizes };
    const result = await request(a, 'content', card.nmID ? '/content/v2/cards/update' : '/content/v2/cards/upload', {
      method: 'POST', body: card.nmID ? [{ ...variant, nmID: card.nmID }] : [{ subjectID: subject, variants: [variant] }]
    });
    if (result.error) throw fail('WB 未接受商品，请查看发布错误并补全类目、条码和属性。', 409);
    return { ok: true, pending: true, message: '已提交 WB 处理，尚未确认上架；请刷新商品并检查发布错误。' };
  }
  async function publishErrors(tenantId, body) {
    return request(await account(tenantId, body.shop_id), 'content', '/content/v2/cards/error/list', { method: 'POST', body: { cursor: { limit: 100 }, order: { ascending: false } } });
  }
  async function syncOrders(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    const result = await request(a, 'marketplace', '/api/v3/orders/new');
    const merged = new Map((result.orders || []).map(row=>[Number(row.id),row]));
    const from = body.from ? Date.parse(`${body.from}T00:00:00+08:00`) : Date.now()-7*86400000;
    const to = body.to ? Date.parse(`${body.to}T23:59:59+08:00`) : Date.now();
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>to||to-from>90*86400000)throw fail('WB 订单同步请选择不超过 90 天的有效日期范围。');
    for(let range=from;range<=to;range+=30*86400000){
      let next=0;
      for(let page=0;page<1000;page++){
        const response=await request(a,'marketplace','/api/v3/orders',{query:{limit:1000,next,dateFrom:Math.floor(range/1000),dateTo:Math.floor(Math.min(to,range+30*86400000-1)/1000)}});
        const batch=response.orders||[];
        for(const row of batch)merged.set(Number(row.id),row);
        if(!batch.length||!response.next)break;
        if(response.next===next)throw fail('WB 订单分页游标未推进，同步未完整完成。',502);
        next=response.next;
        if(page===999)throw fail('WB 订单过多，请缩小同步日期范围。',409);
      }
    }
    const recent = [...merged.values()];
    // Refresh known open orders as well; a new-orders response omits prepared orders.
    const known = await query(`SELECT wb_order_id FROM wb_order_details WHERE tenant_id=? AND shop_id=? AND wb_status NOT IN ('sold','canceled','canceled_by_client','declined_by_client','canceled_by_carrier','defect')`, [a.tenant_id, a.shop_id]);
    const ids = [...new Set([...recent.map(row => positiveId(row.id)), ...known.map(row => Number(row.wb_order_id))])];
    const states = new Map();
    for (let start = 0; start < ids.length; start += 1000) {
      const response = await request(a, 'marketplace', '/api/v3/orders/status', { method: 'POST', body: { orders: ids.slice(start, start + 1000) } });
      for (const state of response.orders || []) states.set(Number(state.id), state);
    }
    for (const row of recent) {
      const state = states.get(Number(row.id));
      if (!state) throw fail('WB 未返回部分新订单的状态，本次同步未完成，请重试。', 502);
      if (row.deliveryType && row.deliveryType !== 'fbs') throw fail('该店铺返回了非 FBS 订单，未导入，请核对店铺履约方式。', 409);
      await transaction(async connection => {
        const normalized = wbOrderState(state.supplierStatus, state.wbStatus);
        const orderedAt = new Date(row.createdAt);
        if (!Number.isFinite(orderedAt.getTime())) throw fail('WB 订单缺少有效下单时间，未写入。', 502);
        await connection.execute(`INSERT INTO orders (shop_id,posting_number,order_number,status,logistics_status,tracking_stage,ordered_at,last_synced_at)
          VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE last_synced_at=UTC_TIMESTAMP()`,
        [a.shop_id, `WB-${row.id}`, String(row.id), normalized.status, normalized.stage, normalized.status, orderedAt]);
        const [orders] = await connection.execute('SELECT id FROM orders WHERE shop_id=? AND posting_number=? FOR UPDATE', [a.shop_id, `WB-${row.id}`]);
        const id = orders[0].id;
        const [items] = await connection.execute('SELECT id FROM order_items WHERE order_id=? LIMIT 1', [id]);
        if (!items.length) await connection.execute(`INSERT INTO order_items (order_id,ozon_sku,ozon_name,quantity,sale_price) VALUES (?,?,?,1,?)`,
        [id, `WB-${positiveId(row.chrtId)}`, String(row.article || ''), 0]);
        await connection.execute(`INSERT INTO wb_order_details (order_id,tenant_id,shop_id,wb_order_id,supplier_status,wb_status,supply_id,raw_json,synced_at)
          VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE raw_json=VALUES(raw_json),synced_at=VALUES(synced_at)`,
        [id, a.tenant_id, a.shop_id, row.id, state.supplierStatus || '', state.wbStatus || '', row.supplyId || null, JSON.stringify(row)]);
      });
    }
    for (const state of states.values()) {
      const mapped = wbOrderState(state.supplierStatus, state.wbStatus);
      await query(`UPDATE orders o JOIN wb_order_details w ON w.order_id=o.id AND w.shop_id=o.shop_id
        SET o.status=?,o.logistics_status=?,o.tracking_stage=?,o.last_synced_at=UTC_TIMESTAMP(),o.updated_at=UTC_TIMESTAMP(),
        w.handover_at=IF(?='complete',COALESCE(w.handover_at,UTC_TIMESTAMP()),w.handover_at),w.supplier_status=?,w.wb_status=?,w.synced_at=UTC_TIMESTAMP()
        WHERE w.tenant_id=? AND w.shop_id=? AND w.wb_order_id=?`,
      [mapped.status, mapped.stage, mapped.status, state.supplierStatus || '', state.supplierStatus || '', state.wbStatus || '', a.tenant_id, a.shop_id, positiveId(state.id)]);
    }
    const localOrders = await query('SELECT order_id FROM wb_order_details WHERE tenant_id=? AND shop_id=?', [a.tenant_id, a.shop_id]);
    for (const row of localOrders) await reconcileInventory(row.order_id, a.tenant_id);
    invalidate();
    return { ok: true, fetched: recent.length, refreshed: states.size };
  }
  async function ownedOrders(tenantId, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids.map(Number)).size !== ids.length) throw fail('请选择 1–100 条不同的订单。');
    const clean = ids.map(positiveId);
    const rows = await query(`SELECT o.id,o.shop_id,w.wb_order_id,w.supplier_status,w.wb_status,w.supply_id,w.raw_json
      FROM orders o JOIN wb_order_details w ON w.order_id=o.id AND w.shop_id=o.shop_id
      JOIN shops s ON s.id=o.shop_id AND s.tenant_id=w.tenant_id AND s.status='active'
      WHERE w.tenant_id=? AND o.id IN (${clean.map(() => '?').join(',')})`, [positiveId(tenantId), ...clean]);
    if (rows.length !== clean.length) throw fail('所选 WB 订单不存在、店铺已停用或不属于当前企业。', 404);
    return clean.map(id => rows.find(row => Number(row.id) === id));
  }
  async function prepare(tenantId, body) {
    const rows = await ownedOrders(tenantId, body.order_ids);
    if (new Set(rows.map(row => Number(row.shop_id))).size !== 1) throw fail('WB 供货批次必须来自同一店铺，请按店铺分别备货。');
    if (rows.some(row => row.supplier_status !== 'new')) throw fail('部分 WB 订单已备货或状态变化，请先同步核对。', 409);
    const bindings = await query(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN sku_mappings sm ON sm.id=oi.sku_mapping_id AND sm.tenant_id=? AND sm.shop_id=o.shop_id AND sm.active=1 WHERE oi.order_id IN (${rows.map(()=>'?').join(',')}) AND sm.id IS NULL`, [positiveId(tenantId), ...rows.map(row=>row.id)]);
    if (bindings.length) throw fail('部分 WB 商品尚未绑定本地库存，请在 WB 在线商品中完成规格与基础商品的绑定，再备货。', 409);
    const cargos = new Set(rows.map(row => parse(row.raw_json).cargoType));
    if (cargos.size !== 1) throw fail('WB 要求同一供货批次的货物类型一致，请分批备货。');
    const a = await account(tenantId, rows[0].shop_id);
    // A durable operation prevents blind retries after an ambiguous create response.
    const key = `prepare:${a.shop_id}:${createHash('sha256').update(rows.map(row=>row.id).sort((x,y)=>x-y).join('-')).digest('hex')}`;
    const [operation] = await query('SELECT * FROM wb_supplies WHERE tenant_id=? AND operation_key=?', [a.tenant_id, key]);
    if (operation?.status === 'creating' || operation?.status === 'unknown') throw fail('上次 WB 供货批次创建结果未确认，请到 WB 后台核对批次后再处理，不能重复创建。', 409);
    let supplyId = operation?.supply_id;
    if (!supplyId) {
      await query(`INSERT INTO wb_supplies (tenant_id,shop_id,operation_key,status,order_ids_json) VALUES (?,?,?,'creating',?)`, [a.tenant_id, a.shop_id, key, JSON.stringify(body.order_ids)]);
      const created = await request(a, 'marketplace', '/api/v3/supplies', { method: 'POST', body: { name: `ERP-${randomUUID()}` } });
      if (!created.id) throw fail('WB 没有返回供货批次编号，创建结果待核对。', 502);
      supplyId = String(created.id);
      await query(`UPDATE wb_supplies SET supply_id=?,status='created' WHERE tenant_id=? AND operation_key=?`, [supplyId, a.tenant_id, key]);
    }
    await request(a, 'marketplace', `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/orders`, { method: 'PATCH', body: { orders: rows.map(row => Number(row.wb_order_id)) } });
    await query(`UPDATE wb_order_details SET supply_id=? WHERE tenant_id=? AND order_id IN (${rows.map(()=>'?').join(',')})`, [supplyId, a.tenant_id, ...rows.map(row=>row.id)]);
    await query(`UPDATE wb_supplies SET status='assembled' WHERE tenant_id=? AND operation_key=?`, [a.tenant_id, key]);
    await syncOrders(tenantId, { shop_id: a.shop_id });
    return { ok: true, count: rows.length, order_ids: rows.map(row=>row.id), supply_id: supplyId };
  }
  async function stickers(tenantId, body) {
    const rows = await ownedOrders(tenantId, body.order_ids), result = [];
    for (const row of rows) {
      if (!['confirm', 'complete'].includes(row.supplier_status)) throw fail('WB 面单需要先完成备货；如缺少报关单号或必填商品标识，请先在 WB 后台补全。', 409);
      const a = await account(tenantId, row.shop_id);
      const response = await request(a, 'marketplace', '/api/v3/orders/stickers', { method: 'POST', query: { type: 'png', width: 58, height: 40 }, body: { orders: [Number(row.wb_order_id)] } });
      const sticker = response.stickers?.find(item => Number(item.orderId) === Number(row.wb_order_id));
      if (!sticker?.file) throw fail('WB 尚未返回该订单面单，请核对报关和必填标识后重试。', 409);
      result.push({ order_id: row.id, file: sticker.file });
    }
    return { rows: result };
  }
  async function supply(tenantId, body) {
    const rows = await ownedOrders(tenantId, [body.order_id]);
    const row = rows[0], a = await account(tenantId, row.shop_id);
    if (!row.supply_id) throw fail('订单尚未加入 WB 供货批次，请先备货。', 409);
    return { shop_id: row.shop_id, supply_id: row.supply_id, supplier_status: row.supplier_status, handover_mode:a.handover_mode,
      details: await request(a, 'marketplace', `/api/v3/supplies/${encodeURIComponent(row.supply_id)}`),
      boxes: a.handover_mode==='shipping_units' ? await request(a, 'marketplace', `/api/v3/supplies/${encodeURIComponent(row.supply_id)}/trbx`) : null };
  }
  async function supplyAction(tenantId, body) {
    const rows = await ownedOrders(tenantId, [body.order_id]), row = rows[0], a = await account(tenantId, row.shop_id);
    if (!row.supply_id) throw fail('请先备货并创建 WB 供货批次。', 409);
    const path = `/api/v3/supplies/${encodeURIComponent(row.supply_id)}`;
    if(['boxes','box-labels'].includes(body.action)&&a.handover_mode!=='shipping_units')throw fail('当前店铺未确认需要 WB 运输箱标签，请按实际揽收要求在企业店铺中配置。',409);
    if (body.action === 'boxes') {
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > 1000) throw fail('运输箱数量须为 1–1000 的整数。');
      // Do not automatically retry a box creation, which is not idempotent.
      return request(a, 'marketplace', `${path}/trbx`, { method: 'POST', body: { amount } });
    }
    if (body.action === 'box-labels') {
      const boxes = await request(a, 'marketplace', `${path}/trbx`);
      const ids = (boxes.trbxes || []).map(item => typeof item === 'string' ? item : item.id);
      if (!ids.length) throw fail('请先创建运输箱，再打印箱标签。', 409);
      return request(a, 'marketplace', `${path}/trbx/stickers`, { method: 'POST', query: { type: 'png' }, body: { trbxIds: ids } });
    }
    if (body.action === 'handover') {
      if(a.handover_mode==='unverified')throw fail('尚未核对揽收点交接要求，请在企业店铺选择已确认的交接方式后重试；不能把中国揽收点默认当作 WB 运输箱交货点。',409);
      if(a.handover_mode==='shipping_units'){const boxes=await request(a,'marketplace',`${path}/trbx`);if(!boxes.trbxes?.length)throw fail('该交接方式需要运输箱标签，请先创建运输箱并打印贴标。',409);}
      await request(a, 'marketplace', `${path}/deliver`, { method: 'PATCH' });
      await syncOrders(tenantId, { shop_id: a.shop_id });
      return { ok: true, message: '已向 WB 提交交接，实际揽收及运输状态以后续同步为准。' };
    }
    if (body.action === 'supply-label') return request(a, 'marketplace', `${path}/barcode`, { query: { type: 'png' } });
    throw fail('不支持的 WB 交接操作。');
  }
  async function promotions(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    return request(a, 'calendar', '/api/v1/calendar/promotions', { query: { startDateTime: body.start, endDateTime: body.end, allPromo: true, limit: 100, offset: Number(body.offset || 0) } });
  }
  async function promotionProducts(tenantId, body) {
    const a = await account(tenantId, body.shop_id);
    return request(a, 'calendar', '/api/v1/calendar/promotions/nomenclatures', { query: { promotionID: positiveId(body.promotion_id), inAction: body.in_action === true || body.in_action === 'true', limit: 100, offset: Number(body.offset || 0) } });
  }
  async function enrollPromotion(tenantId, body) {
    const a=await account(tenantId,body.shop_id),promotionID=positiveId(body.promotion_id);
    const nomenclatures=[...new Set((body.nm_ids||[]).map(positiveId))];
    if(!nomenclatures.length||nomenclatures.length>100)throw fail('每次请选择 1–100 个商品报名。');
    const owned=await query(`SELECT nm_id FROM wb_product_cards WHERE tenant_id=? AND shop_id=? AND nm_id IN (${nomenclatures.map(()=>'?').join(',')})`,[a.tenant_id,a.shop_id,...nomenclatures]);
    if(owned.length!==nomenclatures.length)throw fail('部分报名商品尚未同步或不属于该 WB 店铺。',404);
    const details=await request(a,'calendar','/api/v1/calendar/promotions/details',{query:{promotionIDs:[promotionID]}});
    const promotion=details.data?.promotions?.find(item=>Number(item.id)===promotionID);
    if(!promotion||promotion.type==='auto')throw fail('该活动未找到或属于自动促销，不支持普通报名，请到 WB 后台核对。',409);
    const result=await request(a,'calendar','/api/v1/calendar/promotions/upload',{method:'POST',body:{data:{promotionID,uploadNow:body.upload_now===true,nomenclatures}}});
    if(!result.data?.uploadID)throw fail('WB 未确认收到报名任务，请同步核对活动商品，不要重复提交。',409);
    return {ok:true,pending:true,upload_id:result.data.uploadID,message:'报名已提交处理，尚未确认参加活动。请检查任务结果和活动已参加商品。'};
  }
  async function inventoryUsage(tenantId,body) {
    const product=positiveId(body.product_id),tenant=positiveId(tenantId);
    const scope=await resolveInventoryTenantScope(tenant,query);
    const owned=await query(`SELECT id FROM products WHERE id=? AND ${inventoryTenantSql(scope)}`,[product]);
    if(!owned.length)throw fail('基础商品不存在或不属于当前企业。',404);
    const rows=await query(`SELECT s.platform,
      SUM(CASE WHEN r.status='deducted' AND o.status IN ('awaiting_packaging','awaiting_deliver') THEN r.quantity ELSE 0 END) AS reserved_qty,
      SUM(CASE WHEN r.status='deducted' AND o.status='delivering' THEN r.quantity ELSE 0 END) AS transport_qty,
      SUM(CASE WHEN r.status='deducted' AND o.status='delivered' THEN r.quantity ELSE 0 END) AS delivered_qty,
      SUM(CASE WHEN r.status='deducted' AND o.status='cancelled' THEN r.quantity ELSE 0 END) AS cancelled_pending_review_qty
      FROM outbound_records r JOIN order_items oi ON oi.id=r.order_item_id JOIN orders o ON o.id=oi.order_id AND o.shop_id=r.shop_id
      JOIN shops s ON s.id=r.shop_id AND ${inventoryTenantSql(scope,'s')}
      WHERE r.product_id=? GROUP BY s.platform`,[product]);
    return {rows};
  }
  const catalog=createWbCategoryCatalog({query,request,account});
  async function listingSource(tenantId,body){await catalog.catalogAccount(tenantId,body);if(!loadSourceDraft)throw fail('草稿读取暂不可用。',503);return wbListingSource(await loadSourceDraft(positiveId(body.source_draft_id)));}
  const listing=createWbListingWorkflow({query,request,account,transaction,categoryOptions:catalog.categoryOptions});
  const publishing=createWbPublishFlow({query,transaction,request,account,listing,actorId,enabled:WB_LISTING_PUBLISH_ENABLED});
  const workspace=createWbProductWorkspace({query,transaction,request,account,syncProducts,products,createInventoryProduct,prepareInventoryProduct,actorId});
  const records=createWbPublishRecords({query,request,account,refreshProductSnapshots:workspace.refreshProductSnapshots});
  async function createProductInventory(tenantId,body){const result=await workspace.createProductInventory(tenantId,body);await bindProduct(tenantId,{...body,product_id:result.product_id});return result;}
  const productOperations=createWbProductOperations({query,transaction,request,account,listing,actorId,enabled:WB_LISTING_PUBLISH_ENABLED});
  return { cardLimits, pricingCommissions, refreshProducts:workspace.refreshProducts,createProductInventory,...records, ...catalog, listingSource, ...listing, ...publishing, ...productOperations, account, shops, saveShop, check, warehouses, saveWarehouse, products, syncProducts, bindProduct, uploadMedia, prices, setPrice, priceResult, stocks, setStocks, categories, characteristics, publish, publishErrors,
    syncOrders, ownedOrders, prepare, stickers, supply, supplyAction, promotions, promotionProducts, enrollPromotion, inventoryUsage };
}

export async function wbPlatform(session, permission = 'operations', signal) {
  if (!session) throw fail('WB 操作缺少企业会话。',403);
  const { mysqlQuery, withMysqlTransaction } = await import('../mysql-pool.js');
  const { authorizeBusinessTaskSession } = await import('./business-task-tenant.js');
  const { hasPermission, isEnterpriseAdmin } = await import('../shared/permissions.js');
  const { reconcileWbOrderInventoryMysql, invalidateWbOrderCachesMysql, productInventoryAvailabilityMysql, createProductMysql, prepareInventoryProductCreationMysql } = await import('./mysql-cutover.js');
  const authorize = async () => {
    const current=await authorizeBusinessTaskSession(session);
    if(!(permission==='enterprise.admin'?isEnterpriseAdmin(current):hasPermission(current,permission)))throw fail('当前企业岗位已无权执行该 WB 操作。',403);
    return current;
  };
  const runQuery = async(sql,params) => { if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))await authorize(); return mysqlQuery(sql,params); };
  const platform=createWbPlatform({actorId:session.personId,query:runQuery,transaction:async work=>{await authorize();return withMysqlTransaction(work);},
    request:async(a,service,path,options)=>{
      await authorize();
      const current=await mysqlQuery(`SELECT c.* FROM wb_shop_credentials c JOIN shops s ON s.id=c.shop_id AND s.tenant_id=c.tenant_id
        WHERE c.tenant_id=? AND c.shop_id=? AND s.status='active'`,[session.tenant.id,a.shop_id]);
      if(!current[0])throw fail('WB 店铺已停用或授权已撤销，操作已停止。',403);
      if(current[0].environment==='production'&&path!=='/ping'&&path!=='/api/v1/seller-info'
        &&(!current[0].checked_at||current[0].seller_id!==a.seller_id))throw fail('WB 授权已变更，操作已停止；请先检查店铺授权再继续。',409);
      const publishingWrite=options?.method==='POST'&&['/content/v2/cards/upload','/content/v3/media/save','/content/v2/barcodes','/api/v2/upload/task','/api/v2/upload/task/size'].includes(path);
      const beforeRequest=publishingWrite?async()=>{await authorize();const [latest]=await mysqlQuery("SELECT c.token,c.environment,c.seller_id,c.checked_at FROM wb_shop_credentials c JOIN shops s ON s.id=c.shop_id AND s.tenant_id=c.tenant_id WHERE c.tenant_id=? AND c.shop_id=? AND s.status='active'",[session.tenant.id,a.shop_id]);if(!latest||latest.token!==current[0].token||latest.environment!==current[0].environment||latest.seller_id!==current[0].seller_id||(latest.environment==='production'&&!latest.checked_at))throw fail('WB 授权在等待期间已变化，未发送写入请求，请核对后继续。',409);}:undefined;
      return wbRequest(current[0],service,path,{...options,beforeRequest,signal:options?.signal||signal});
    },invalidate:invalidateWbOrderCachesMysql,
    prepareInventoryProduct:async()=>{await authorize();await prepareInventoryProductCreationMysql();},
    createInventoryProduct:async(body,connection,tenant)=>{await authorize();return createProductMysql(body,connection,tenant);},
    reconcileInventory:async(...args)=>{await authorize();return reconcileWbOrderInventoryMysql(...args);},loadAvailability:productInventoryAvailabilityMysql,loadSourceDraft:async id=>{
      const current=await authorize(),key=current.tenant.slug==='default'?'admin':String(current.tenant.id);
      const rows=await mysqlQuery(`SELECT * FROM listing_drafts WHERE id=? AND status<>'deleted' AND (tenant_id=?${key==='admin'?' OR tenant_id IS NULL':''}) LIMIT 1`,[id,key]);
      if(!rows[0])throw fail('来源草稿不存在或不属于当前企业。',404);
      const {assembleListingDraftStoredRow}=await import('./listing-frozen-content.js');
      return assembleListingDraftStoredRow(mysqlQuery,{tenantId:key,row:rows[0]});
    }});
  const readCardLimits = platform.cardLimits;
  platform.cardLimits = async (...args) => { await authorize(); return readCardLimits(...args); };
  if(!WB_REMOTE_WRITES_ENABLED)for(const action of WB_REMOTE_WRITE_ACTIONS)platform[action]=async()=>{throw fail('当前先开放 WB 授权和数据拉取；上架、改价、平台库存及履约写操作需完成真实店铺联调后开放。',409);};
  return platform;
}
