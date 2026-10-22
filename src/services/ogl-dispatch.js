import { randomUUID } from 'node:crypto';
import { classifyOrderLogistics } from './order-logistics-classification.js';
import { effectiveTenantMembershipRole } from './tenant-membership-authority.js';
import { getRoles, hasPermission, isEnterpriseAdmin } from '../shared/permissions.js';
import { isOglPlatformOnline, hasOglPlatformHandover } from './ogl-dispatch-state.js';
import { invalidateMasterDataCache } from './mysql-master-data-cache.js';
import { invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';
import { invalidateInventoryProductBalance } from './mysql-inventory-product-balance.js';
import { normalizeShanghaiDateInput, shanghaiDateKey } from '../shanghai-time.js';
export { OGL_DISPATCH_SCHEMA_SQL, ensureOglDispatchSchema, ensureSchema } from './ogl-dispatch-schema.js';

function fail(message, statusCode = 400, code = 'OGL_DISPATCH_INVALID') {
  throw Object.assign(new Error(message), { statusCode, status: statusCode, code });
}
function id(value, label = '编号') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label}无效`);
  return number;
}
function ids(value, label = '订单') {
  if (!Array.isArray(value) || !value.length || value.length > 2000) fail(`请选择 1 至 2000 个${label}`);
  return [...new Set(value.map(v => id(v, label)))];
}
function text(value, limit = 1000) { return String(value ?? '').trim().slice(0, limit); }
function reason(value) { const result = text(value); if (!result) fail('请填写原因，便于后续追溯'); return result; }
function containers(value) { const result = id(value, '实际货位数量（container_count）'); if (result > 1000) fail('实际货位数量不能超过 1000'); return result; }
function marks(values) { return values.map(() => '?').join(','); }
function parsed(value, fallback = {}) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '') || fallback; } catch { return fallback; } }
function sqlDate(value) { return new Date(value).toISOString().slice(0, 19).replace('T', ' '); }
function instant(value) {
  if(value instanceof Date) return value.getTime();
  const valueText=String(value||'');
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(valueText)?`${valueText.replace(' ','T')}Z`:valueText);
}
export function isOglLogisticsFresh(member) {
  return !member.sync_error&&Boolean(member.last_synced_at)&&(!member.dispatched_at||instant(member.last_synced_at)>=instant(member.dispatched_at));
}
function invalidateWorkflowCaches() {
  invalidateMasterDataCache(); invalidateOrderProcurementCoverage(); invalidateInventoryProductBalance();
}
function officialStatusLabel(value) {
  return {new:'待确认',formed:'已生成',sended:'已发送',received:'验收中',closed:'已完成',cancelled:'已取消',canceled:'已取消'}[String(value||'').toLowerCase()]||'待核实';
}
function optionalCount(value) {
  const number=Number(value);
  return value!=null&&value!==''&&Number.isSafeInteger(number)&&number>=0?number:null;
}
function beijingDay(value, now) {
  const day=value==null||value===''?shanghaiDateKey(now()):String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||shanghaiDateKey(`${day}T00:00:00+08:00`)!==day) fail('请选择有效的北京日期（YYYY-MM-DD）');
  return day;
}
const shopScope = (scope, alias = 's') => `(${alias}.tenant_id = ?${scope.slug === 'default' ? ` OR ${alias}.tenant_id IS NULL` : ''})`;

// Raw platform status remains authoritative; local handover is separate data.
export function oglPlatformProgress(row = {}) {
  const raw = parsed(row.raw_json); const posting = raw.raw || raw;
  const states = [row.status, row.logistics_status, row.tracking_stage, row.substatus, posting.status, posting.substatus]
    .map(value => String(value || '').toLowerCase());
  const cancelled = states.some(value => /cancel|return|reject|not_accepted|arbitration|dispute|not_delivered/.test(value));
  const delivered = !cancelled&&states.some(value => ['delivered','posting_delivered','posting_received_by_buyer','signed','received'].includes(value));
  const evidence = { ...row, substatus: row.substatus || posting.substatus };
  const online = isOglPlatformOnline(evidence);
  const handover = hasOglPlatformHandover(evidence);
  return { online, handover, delivered, cancelled, awaiting_delivery: String(row.status || posting.status || '').toLowerCase() === 'awaiting_deliver' && !handover && !cancelled };
}

export function summarizeOglMembers(members = []) {
  const active = members.filter(m => m.active);
  return {
    planned: members.length, active: active.length, withdrawn: members.length - active.length,
    dispatched: active.filter(m => m.dispatched_at).length,
    awaiting_dispatch: active.filter(m => !m.dispatched_at && !m.online).length,
    online: active.filter(m => m.online).length,
    delivered: active.filter(m => m.delivered).length,
    not_online: active.filter(m => m.dispatched_at && isOglLogisticsFresh(m) && !m.online && !m.cancelled).length,
    exception: active.filter(m => m.exception_code).length,
    sync_pending: active.filter(m => !m.online&&!m.cancelled&&(m.sync_error || (m.dispatched_at && !isOglLogisticsFresh(m)))).length
  };
}

export function createOglDispatchService({ transaction, api, syncPostings, extractLabelTracking, now = () => new Date() }) {
  if (typeof transaction !== 'function') throw new Error('OGL dispatch requires a transaction');
  const timestamp = () => sqlDate(now());
  // Cache parsed tracking identifiers only; never retain labels or customer data.
  const trackingCache=new Map();
  const trackingPending=new Map();
  async function scope(connection, session, write = false) {
    const tenantId = id(session?.tenant?.id, '当前企业'); const personId = id(session?.personId, '操作账号');
    const [rows] = await connection.execute(`SELECT t.id, t.slug, tm.role AS tenant_role, tm.business_roles_json,
      p.role AS legacy_role, p.roles_json FROM tenants t
      JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.person_id = ? AND tm.active = 1
      JOIN people p ON p.id = tm.person_id AND p.active = 1
      WHERE t.id = ? AND t.status = 'active' AND t.subscription_status IN ('active','trial')
        AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP())${write ? ' FOR UPDATE' : ''}`, [personId, tenantId]);
    const row = rows[0];
    if (!row || row.slug !== session.tenant.slug) fail('当前企业、成员或订阅已失效，请检查企业订阅或重新登录', 403);
    const trusted = { personId, roles: getRoles({ roles: row.business_roles_json ?? row.roles_json ?? row.legacy_role }), tenant: {
      id: tenantId, slug: row.slug, role: effectiveTenantMembershipRole({ ...row, tenant_slug: row.slug })
    } };
    if (!hasPermission(trusted, 'orders.read') || (write && !hasPermission(trusted, 'packing') && !hasPermission(trusted, 'orders.manage'))) fail('当前岗位无权操作 OGL 发运，请联系企业管理员', 403);
    return { id: tenantId, slug: row.slug, personId, session: trusted, can_settings: isEnterpriseAdmin(trusted) };
  }
  async function shops(connection, current) {
    const [rows] = await connection.execute(`SELECT s.* FROM shops s WHERE ${shopScope(current)} AND s.status = 'active' ORDER BY s.id`, [current.id]);
    return rows;
  }
  async function shop(connection, current, shopId, credentials = false) {
    const [rows] = await connection.execute(`SELECT s.* FROM shops s WHERE s.id = ? AND ${shopScope(current)} AND s.status = 'active'`, [id(shopId, '默认发运店铺'), current.id]);
    const row = rows[0];
    if (!row) fail('默认发运店铺不属于当前企业或已停用，请在 OGL 发运设置中重新选择', 409);
    if (credentials && (!text(row.ozon_client_id) || !text(row.ozon_api_key || row.api_key_hint))) fail('默认发运店铺缺少 Ozon Client-Id 或 API Key，请在企业店铺设置中补充授权', 409);
    return row;
  }
  async function batch(connection, current, batchId, lock = false) {
    const [rows] = await connection.execute(`SELECT b.*, s.name AS dispatch_shop_name FROM ogl_dispatch_batches b
      LEFT JOIN shops s ON s.id = b.default_shop_id AND ${shopScope(current)}
      WHERE b.id = ? AND b.tenant_id = ?${lock ? ' FOR UPDATE' : ''}`, [current.id, id(batchId, '发运批次'), current.id]);
    if (!rows[0]) fail('发运批次不存在或不属于当前企业', 404);
    return rows[0];
  }
  async function members(connection, current, batchId, lock = false) {
    const [rows] = await connection.execute(`SELECT m.*, o.status AS platform_status, o.logistics_status, o.tracking_stage,
      o.last_synced_at AS order_last_synced_at, raw.raw_json, raw.substatus, s.name AS shop_name,
      s.status AS shop_status FROM ogl_dispatch_members m
      JOIN orders o ON o.id = m.order_id AND o.shop_id = m.shop_id
      JOIN shops s ON s.id = o.shop_id AND ${shopScope(current)}
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      WHERE m.tenant_id = ? AND m.batch_id = ? ORDER BY m.id${lock ? ' FOR UPDATE' : ''}`, [current.id, current.id, batchId]);
    return rows.map(row => {
      const progress = oglPlatformProgress({ ...row, status: row.platform_status });
      const lastSynced=instant(row.order_last_synced_at)>instant(row.last_synced_at)?row.order_last_synced_at:row.last_synced_at||row.order_last_synced_at;
      const refreshedAfterFailure=row.sync_error&&row.last_refresh_attempt_at
        &&instant(row.order_last_synced_at)>=instant(row.last_refresh_attempt_at)
        &&(!row.last_synced_at||instant(row.order_last_synced_at)>instant(row.last_synced_at));
      const member={ ...row, ...progress, active: Number(row.active_order_id) === Number(row.order_id) && !row.withdrawn_at,
        exception_reason: row.exception_note || '', last_synced_at: lastSynced, sync_error:refreshedAfterFailure?null:row.sync_error,
        logistics_status: row.substatus || row.logistics_status || row.tracking_stage || row.platform_status };
      return {...member,logistics_fresh:isOglLogisticsFresh(member)};
    });
  }
  async function event(connection, current, batchId, action, details = {}, memberId = null, why = '') {
    await connection.execute(`INSERT INTO ogl_dispatch_events (tenant_id,batch_id,member_id,action,reason,detail_json,person_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, [current.id,batchId,memberId,action,text(why),JSON.stringify(details),current.personId,timestamp()]);
  }
  async function getDetail(connection, current, batchId) {
    const result = await batch(connection, current, batchId); const rows = await members(connection, current, result.id);
    const [events] = await connection.execute(`SELECT id, member_id, action, reason, detail_json, person_id, created_at FROM ogl_dispatch_events WHERE tenant_id = ? AND batch_id = ? ORDER BY id DESC LIMIT 200`, [current.id,result.id]);
    const official=parsed(result.official_result_json);
    return { batch: { ...result, official_result: official, official_operation_token: undefined }, members: rows.map(({ raw_json, ...row }) => row), events,
      summary: {...summarizeOglMembers(rows),container_count_mismatch:Boolean(official.container_count_mismatch),delivery_method_mismatch:Boolean(official.delivery_method_mismatch)} };
  }
  async function previewRows(connection, current, orderIds, lock = false) {
    const selected = ids(orderIds);
    const [rows] = await connection.execute(`SELECT o.*, s.name AS shop_name, s.status AS shop_status, raw.raw_json,
      raw.substatus, olp.printed_at, m.batch_id AS active_batch_id,
      EXISTS (SELECT 1 FROM ogl_dispatch_members history WHERE history.tenant_id = ? AND history.order_id = o.id
        AND history.active_order_id IS NULL AND history.official_member = 1) AS has_official_conflict
      FROM orders o JOIN shops s ON s.id = o.shop_id AND ${shopScope(current)}
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      LEFT JOIN order_label_prints olp ON olp.order_id = o.id
      LEFT JOIN ogl_dispatch_members m ON m.tenant_id = ? AND m.active_order_id = o.id
      WHERE o.id IN (${marks(selected)}) ORDER BY o.id${lock ? ' FOR UPDATE' : ''}`, [current.id,current.id,current.id,...selected]);
    const byId = new Map(rows.map(row => [Number(row.id), row])); const eligible = []; const rejected = [];
    for (const orderId of selected) {
      const row = byId.get(orderId); let why = '';
      if (!row || row.shop_status !== 'active') why = '订单不存在、不属于当前企业或来源店铺已停用';
      else if (classifyOrderLogistics(row).logistics_carrier !== 'ogl') why = '仅可加入 OGL 物流订单';
      else if (!oglPlatformProgress(row).awaiting_delivery) why = '订单已离开等待发货状态，请刷新订单';
      else if (!row.printed_at) why = '订单尚未确认打印小面单，请先完成打印';
      else if (row.active_batch_id) why = '订单已经加入活动 OGL 批次，请先查看原批次';
      else if (Number(row.has_official_conflict)) why = '订单仍被历史官方发运收录，请先核实并同步原批次的官方组成';
      if (why) rejected.push({ id: orderId, order_id: orderId, reason: why });
      else { const { raw_json, ...safe } = row; eligible.push(safe); }
    }
    return { order_ids: selected, eligible, rejected, counts: { selected: selected.length, eligible: eligible.length, rejected: rejected.length } };
  }
  async function bootstrap(session) {
    return transaction(async connection => {
      const current = await scope(connection, session); const available = await shops(connection, current);
      const [settings] = await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?', [current.id]);
      return { settings: { dispatch_shop_id: Number(settings[0]?.default_shop_id) || null }, can_manage_settings: current.can_settings,
        shops: available.filter(row=>text(row.ozon_client_id)&&text(row.ozon_api_key||row.api_key_hint)).map(row => ({ id: Number(row.id), name: row.name, authorized: true })) };
    });
  }
  async function saveSettings(session, body = {}) {
    return transaction(async connection => {
      const current = await scope(connection, session, true);
      if (!current.can_settings) fail('只有企业负责人或管理员可以设置默认 OGL 发运店铺', 403);
      const selected = await shop(connection, current, body.dispatch_shop_id);
      await connection.execute(`INSERT INTO ogl_dispatch_settings (tenant_id,default_shop_id,updated_by,updated_at) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE default_shop_id=VALUES(default_shop_id),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`, [current.id,selected.id,current.personId,timestamp()]);
      return { dispatch_shop_id: Number(selected.id) };
    });
  }
  async function preview(session, body = {}) {
    return transaction(async connection => previewRows(connection, await scope(connection, session), body.order_ids));
  }
  async function createBatch(session, body = {}) {
    const requestId = text(body.client_request_id,128); if (!requestId) fail('创建批次缺少操作标识（client_request_id），请关闭弹窗后重试');
    const count = containers(body.container_count ?? body.containers_count);
    const result=await transaction(async connection => {
      const current = await scope(connection, session, true);
      // Lock the tenant row to serialize idempotent creation without reserving a real order twice.
      await connection.execute('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [current.id]);
      const [existing] = await connection.execute('SELECT id FROM ogl_dispatch_batches WHERE tenant_id = ? AND client_request_id = ?', [current.id,requestId]);
      if (existing[0]) return getDetail(connection,current,existing[0].id);
      const [settings] = await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?', [current.id]);
      if (!settings[0]) fail('尚未配置本企业默认 OGL 发运店铺，请让企业管理员在发运设置中选择当前有 OGL 订单的店铺',409);
      const selected = await shop(connection,current,settings[0].default_shop_id);
      const checked = await previewRows(connection,current,body.order_ids,true);
      if (checked.rejected.length) fail(`有 ${checked.rejected.length} 个订单不能入批：${checked.rejected[0].reason}，请重新预览`,409);
      const batchDay = shanghaiDateKey(now()).replaceAll('-','');
      const batchNumber = `OGL-${batchDay}-${randomUUID().slice(0,8).toUpperCase()}`;
      const [insert] = await connection.execute(`INSERT INTO ogl_dispatch_batches
        (tenant_id,batch_number,client_request_id,default_shop_id,containers_count,note,delivery_method_id,departure_date,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`, [current.id,batchNumber,requestId,selected.id,count,text(body.note),text(body.delivery_method_id,64)||null,text(body.departure_date,64)||null,current.personId]);
      for (const row of checked.eligible) await connection.execute(`INSERT INTO ogl_dispatch_members
        (tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number) VALUES (?,?,?,?,?,?)`, [current.id,insert.insertId,row.id,row.id,row.shop_id,row.posting_number]);
      await event(connection,current,insert.insertId,'create',{order_ids:checked.order_ids,containers_count:count,default_shop_id:Number(selected.id)});
      return getDetail(connection,current,insert.insertId);
    });
    invalidateWorkflowCaches(); return result;
  }
  async function listBatches(session, query = {}) {
    return transaction(async connection => {
      const current = await scope(connection, session); const params = [current.id]; let filter = '';
      if (query.status && query.status !== 'all') { filter=' AND b.status = ?'; params.push(text(query.status,32)); }
      const page = Math.max(1,Math.floor(Number(query.page)||1)); const size = Math.min(100,Math.max(1,Math.floor(Number(query.page_size)||20)));
      const [total] = await connection.execute(`SELECT COUNT(*) AS total FROM ogl_dispatch_batches b WHERE b.tenant_id = ?${filter}`,params);
      const [rows] = await connection.query(`SELECT b.id FROM ogl_dispatch_batches b WHERE b.tenant_id = ?${filter} ORDER BY b.id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      const details = []; for (const row of rows) { const detail = await getDetail(connection,current,row.id); details.push({ ...detail.batch,summary:detail.summary }); }
      return { rows:details,total:Number(total[0].total) };
    });
  }
  async function detail(session, batchId) { return transaction(async connection => getDetail(connection,await scope(connection,session),batchId)); }
  async function officialReadContext(session) {
    if(!api?.deliveryMethods||!api?.request) fail('当前环境未配置 Ozon 发运 API',503);
    return transaction(async connection=>{
      const current=await scope(connection,session);
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(!settings[0]) fail('尚未配置本企业默认 OGL 发运店铺，请让企业管理员先选择有 OGL 发运的店铺，再查询后台已有单',409);
      return {current,shop:await shop(connection,current,settings[0].default_shop_id,true)};
    });
  }
  async function officialRows(ctx, day) {
    // A date filter also includes historical carriages that the default window
    // can omit. Keep the calendar-day check explicit across UTC boundaries.
    const methods=await api.deliveryMethods(ctx.shop,{departure_date:day});
    const rows=[]; const seen=new Set();
    for(const method of methods) {
      if(shanghaiDateKey(method.departure_date)!==day||!Array.isArray(method.carriages)) continue;
      for(const carriage of method.carriages) {
        const carriageId=String(carriage.id??carriage.carriage_id??'');
        if(!/^\d+$/.test(carriageId)||Number(carriageId)<=0||seen.has(carriageId)) continue;
        seen.add(carriageId);
        rows.push({id:carriageId,carriage_id:carriageId,delivery_method_id:String(method.delivery_method_id??''),
          delivery_method_name:text(method.delivery_method_name??method.name,255),departure_date:method.departure_date,
          has_entrusted_acceptance:method.has_entrusted_acceptance===true,status:text(carriage.status,64),status_label:officialStatusLabel(carriage.status),
          available_actions:Array.isArray(carriage.available_actions)?carriage.available_actions.filter(value=>typeof value==='string'):[],
          postings_count:optionalCount(carriage.postings_count),containers_count:optionalCount(carriage.containers_count),official_only:true});
      }
    }
    return rows;
  }
  async function listOfficial(session,query={}) {
    const day=beijingDay(query.date??query.departure_date,now); const ctx=await officialReadContext(session);
    const rows=await officialRows(ctx,day);
    return transaction(async connection=>{
      const current=await scope(connection,session); await shop(connection,current,ctx.shop.id,true);
      // A default-shop change while the request was in flight must not display
      // one shop's response under another shop's current setting.
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有单',409);
      const [batches]=await connection.execute('SELECT id,batch_number,official_carriage_id FROM ogl_dispatch_batches WHERE tenant_id = ? AND default_shop_id = ? AND official_carriage_id IS NOT NULL',[current.id,ctx.shop.id]);
      const local=new Map(batches.map(row=>[String(row.official_carriage_id),row]));
      return {rows:rows.map(row=>({...row,official_only:!local.has(row.carriage_id),local_batch_id:local.has(row.carriage_id)?Number(local.get(row.carriage_id).id):null,local_batch_number:local.get(row.carriage_id)?.batch_number||''})),total:rows.length,
        dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},departure_date:day};
    });
  }
  async function officialDetail(session,query={}) {
    const day=beijingDay(query.date??query.departure_date,now); const carriageId=String(id(query.id??query.carriage_id,'官方发运编号'));
    const ctx=await officialReadContext(session); const rows=await officialRows(ctx,day); const listed=rows.find(row=>row.carriage_id===carriageId);
    if(!listed) fail('该官方发运不在默认店铺所选北京日期的已有单中，请核对日期或默认店铺',404);
    const data=await readOfficial(ctx,carriageId);
    if(data.info?.carriage_id!=null&&String(data.info.carriage_id)!==carriageId) fail('Ozon 返回的官方发运编号与查询编号不一致，请重新查询',502);
    if(data.info?.delivery_method_id!=null&&String(data.info.delivery_method_id)!==listed.delivery_method_id) fail('Ozon 官方详情与列表配送方式不一致，请重新查询',502);
    return transaction(async connection=>{
      const current=await scope(connection,session); await shop(connection,current,ctx.shop.id,true);
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有单',409);
      const numbers=[...new Set(data.numbers)]; const localOrders=[];
      // Match both shop and posting number. A number belonging to another shop
      // never becomes an authorized local member of this official manifest.
      for(let offset=0;offset<numbers.length;offset+=500) {
        const part=numbers.slice(offset,offset+500);
        const [orders]=await connection.execute(`SELECT o.id,o.posting_number,o.shop_id,o.status AS platform_status,o.logistics_status,o.tracking_stage,o.last_synced_at,s.name AS shop_name
          FROM orders o JOIN shops s ON s.id=o.shop_id AND ${shopScope(current)}
          WHERE o.shop_id = ? AND o.posting_number IN (${marks(part)})`,[current.id,ctx.shop.id,...part]);
        localOrders.push(...orders);
      }
      const local=new Map(localOrders.map(row=>[row.posting_number,row]));
      const members=numbers.map(postingNumber=>{
        const row=local.get(postingNumber); const rawPosting=data.list.find(value=>value&&typeof value==='object'&&value.posting_number===postingNumber);
        const platformStatus=row?.platform_status||text(rawPosting?.status,64); const logisticsStatus=row?.logistics_status||text(rawPosting?.substatus,128);
        const progress=oglPlatformProgress({status:platformStatus,logistics_status:logisticsStatus,tracking_stage:row?.tracking_stage});
        return {posting_number:postingNumber,order_id:row?Number(row.id):null,shop_id:Number(ctx.shop.id),shop_name:ctx.shop.name,matched_local:Boolean(row),
          platform_status:platformStatus,logistics_status:logisticsStatus,tracking_stage:row?.tracking_stage||'',last_synced_at:row?.last_synced_at||null,
          online:progress.online,delivered:progress.delivered,cancelled:progress.cancelled};
      });
      const [batches]=await connection.execute('SELECT id,batch_number FROM ogl_dispatch_batches WHERE tenant_id = ? AND default_shop_id = ? AND official_carriage_id = ?',[current.id,ctx.shop.id,carriageId]);
      const status=text(data.info?.status||listed.status,64);
      const carriage={...listed,status,status_label:officialStatusLabel(status),containers_count:data.info?.containers_count==null?listed.containers_count:optionalCount(data.info.containers_count),
        available_actions:Array.isArray(data.info?.available_actions)?data.info.available_actions.filter(value=>typeof value==='string'):listed.available_actions,
        first_mile_type:text(data.info?.first_mile_type,64),integration_type:text(data.info?.integration_type,64),
        official_only:!batches.length,local_batch_id:batches[0]?Number(batches[0].id):null,local_batch_number:batches[0]?.batch_number||''};
      return {carriage,members,summary:{official_members:members.length,matched_local:localOrders.length,unmatched_local:members.length-localOrders.length,online:members.filter(row=>row.online).length},
        dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},departure_date:day};
    });
  }
  async function verifyOfficialReadScope(session,ctx) {
    return transaction(async connection=>{
      const current=await scope(connection,session);await shop(connection,current,ctx.shop.id,true);
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(current.id!==ctx.current.id||Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有申请',409);
    });
  }
  async function officialTracking(session,query={}) {
    const day=beijingDay(query.date??query.departure_date,now);const carriageId=String(id(query.id??query.carriage_id,'官方申请号'));
    const ctx=await officialReadContext(session);
    // Validate the existing application and its exact default-shop/date scope.
    // This is a read-only detail lookup; it never imports or takes over a batch.
    const detail=await officialDetail(session,{id:carriageId,date:day});
    if(Number(detail.dispatch_shop.id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有申请',409);
    const key=`${ctx.current.id}:${ctx.shop.id}:${carriageId}:${day}:${detail.carriage.containers_count??'unknown'}`;
    for(const [cacheKey,entry] of trackingCache)if(entry.expires<=Date.now())trackingCache.delete(cacheKey);
    const cached=trackingCache.get(key);
    if(cached) {
      await verifyOfficialReadScope(session,ctx);
      return {carriage_id:carriageId,dispatch_shop:detail.dispatch_shop,departure_date:day,tracking:structuredClone(cached.tracking)};
    }
    if(trackingPending.has(key)) {
      const result=await trackingPending.get(key);await verifyOfficialReadScope(session,ctx);return structuredClone(result);
    }
    const operation=(async()=>{
    let tracking;
    try {
      const file=await api.request(ctx.shop,'/v2/posting/fbs/act/get-container-labels',{id:Number(carriageId)},{binary:true});
      if(!Buffer.isBuffer(file?.buffer)||file.contentType!=='application/pdf') throw new Error('Official labels are not a PDF');
      const extract=extractLabelTracking||(await import('./ogl-label-tracking.js')).extractOglLabelTracking;
      tracking=await extract(file.buffer,{containersCount:detail.carriage.containers_count});
      if(!tracking||!['found','ambiguous','not_found'].includes(tracking.status)) throw new Error('Invalid tracking extraction result');
    } catch {
      await verifyOfficialReadScope(session,ctx);
      fail('未取得标签中的运单号，请稍后重新读取；已有申请详情仍可查看',502,'OGL_TRACKING_LABEL_UNAVAILABLE');
    }
    await verifyOfficialReadScope(session,ctx);
    if(tracking.status==='not_found') tracking={...tracking,notice:`未取得标签中的运单号。${text(tracking.notice,500)}`};
    else if(Array.isArray(tracking.tracking_numbers)&&tracking.tracking_numbers.length) {
      trackingCache.set(key,{expires:Date.now()+60000,tracking:structuredClone(tracking)});
      while(trackingCache.size>100)trackingCache.delete(trackingCache.keys().next().value);
    }
    return {carriage_id:carriageId,dispatch_shop:detail.dispatch_shop,departure_date:day,tracking};
    })();
    trackingPending.set(key,operation);
    try{return await operation;}finally{if(trackingPending.get(key)===operation)trackingPending.delete(key);}
  }
  async function localAction(session, body) {
    return transaction(async connection => {
      const current = await scope(connection,session,true); const item=await batch(connection,current,body.batch_id,true);
      if (['cancelled','closed'].includes(item.status)) fail('该批次已结束，不能继续修改',409);
      const all = await members(connection,current,item.id,true);
      let selected = all.filter(row=>row.active);
      if (body.order_ids !== undefined) { const wanted=ids(body.order_ids); selected=selected.filter(row=>wanted.includes(Number(row.order_id))); if(selected.length!==wanted.length) fail('所选订单不属于当前活动批次',409); }
      const action=body.action;
      if(['close','cancel'].includes(action)) selected=all.filter(row=>row.active);
      const why=['withdraw','exception','cancel'].includes(action)?reason(body.reason ?? body.exception_reason):text(body.reason);
      if (action==='assign') {
        if (!['not_created','failed'].includes(item.official_status)) fail('已生成官方标签后不能直接修改装袋；请先核对官方发运及旧标签有效性',409);
        const containerNo=body.container_no==null||body.container_no===''?null:id(body.container_no,'货位编号');
        if(containerNo>Number(item.containers_count)) fail('货位编号超出本批次实际货位数量');
        for(const row of selected) {
          if(row.dispatched_at) fail('订单已交运，不能移动货位',409);
          await connection.execute('UPDATE ogl_dispatch_members SET container_no = ? WHERE tenant_id = ? AND id = ?',[containerNo,current.id,row.id]);
          await event(connection,current,item.id,'assign',{from:row.container_no,to:containerNo},row.id,why);
        }
      } else if (action==='dispatch') {
        if(!selected.length) fail('该批次没有可交运订单',409);
        if(selected.some(row=>row.shop_status!=='active'||!row.awaiting_delivery||row.online||row.cancelled||classifyOrderLogistics(row).logistics_carrier!=='ogl')) fail('部分订单已变更平台状态、物流方式或店铺已停用，请先刷新并核实',409);
        if(!['approved'].includes(item.official_status)) fail('请先创建、核对并确认官方发运，下载货位标签后再标记实际交运',409);
        for(const row of selected.filter(row=>!row.dispatched_at)) {
          await connection.execute('UPDATE ogl_dispatch_members SET dispatched_at = ?, dispatched_by = ? WHERE tenant_id = ? AND id = ?',[timestamp(),current.personId,current.id,row.id]);
          await event(connection,current,item.id,'dispatch',{},row.id,why);
        }
        await connection.execute("UPDATE ogl_dispatch_batches SET status = 'tracking' WHERE tenant_id = ? AND id = ?",[current.id,item.id]);
      } else if(action==='withdraw'||action==='cancel') {
        if(selected.some(row=>row.handover||row.delivered||row.cancelled||!row.awaiting_delivery)) fail('订单已有真实物流推进、取消或状态变化，不能普通撤回；请先人工核实平台记录',409);
        if(['creating','create_unknown','confirming','confirm_unknown'].includes(item.official_status)) fail('官方请求结果尚未核实，请先同步官方发运再撤回',409);
        if(selected.some(row=>Number(row.official_member))) fail('所选订单仍在官方发运清单，请先在 Ozon 后台移出或取消官方单，再同步官方清单后撤回',409);
        for(const row of selected) {
          await connection.execute(`UPDATE ogl_dispatch_members SET active_order_id = NULL,withdrawn_at = ?,withdrawn_by = ?,exception_code = 'withdrawn',exception_note = ? WHERE tenant_id = ? AND id = ?`,[timestamp(),current.personId,why,current.id,row.id]);
          await event(connection,current,item.id,action,{container_no:row.container_no,dispatched_at:row.dispatched_at},row.id,why);
        }
        if(action==='cancel') await connection.execute("UPDATE ogl_dispatch_batches SET status = 'cancelled' WHERE tenant_id = ? AND id = ?",[current.id,item.id]);
      } else if(action==='exception'||action==='resolve') {
        for(const row of selected) {
          await connection.execute('UPDATE ogl_dispatch_members SET exception_code = ?,exception_note = ? WHERE tenant_id = ? AND id = ?',[action==='exception'?text(body.exception_code||'manual',64):null,action==='exception'?why:null,current.id,row.id]);
          await event(connection,current,item.id,action,{},row.id,why);
        }
      } else if(action==='close') {
        if(selected.some(row=>!row.online&&!row.cancelled)) fail('还有订单未上网，请处理未交运、未上网或撤回订单后再结束批次',409);
        await connection.execute("UPDATE ogl_dispatch_batches SET status = 'closed' WHERE tenant_id = ? AND id = ?",[current.id,item.id]);
        await event(connection,current,item.id,'close',{},null,why);
      } else fail('不支持的 OGL 批次操作');
      return getDetail(connection,current,item.id);
    });
  }

  async function context(session, batchId, write = false) {
    return transaction(async connection => { const current = await scope(connection,session,write); const item=await batch(connection,current,batchId); return { current,batch:item,shop:await shop(connection,current,item.default_shop_id,true),members:await members(connection,current,item.id) }; });
  }
  async function officialOptions(session, body) {
    if(!api?.deliveryMethods) fail('当前环境未配置 Ozon 发运 API',503);
    const ctx=await context(session,body.batch_id,true);
    const options=await api.deliveryMethods(ctx.shop,{});
    return { options };
  }
  async function saveOfficial(session,batchId,token,values,actionName,details={}) {
    return transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,batchId,true);
      if(token&&item.official_operation_token!==token) fail('官方操作已由另一请求更新，请刷新批次',409);
      const allowed=['official_status','official_carriage_id','official_result_json','official_error','official_operation_token','delivery_method_id','departure_date'];
      const entries=Object.entries(values).filter(([key])=>allowed.includes(key));
      if(entries.length) await connection.execute(`UPDATE ogl_dispatch_batches SET ${entries.map(([key])=>`${key} = ?`).join(',')} WHERE tenant_id = ? AND id = ?`,[...entries.map(([,value])=>value),current.id,batchId]);
      if(values.official_status==='failed') await connection.execute('DELETE FROM ogl_dispatch_official_locks WHERE tenant_id = ? AND batch_id = ? AND operation_token = ?',[current.id,batchId,token]);
      if(actionName) await event(connection,current,batchId,actionName,details);
      return getDetail(connection,current,batchId);
    });
  }
  async function readOfficial(ctx,carriageId) {
    const result=await api.request(ctx.shop,'/v1/carriage/get',{carriage_id:Number(carriageId)});
    const postings=await api.request(ctx.shop,'/v2/posting/fbs/act/get-postings',{id:Number(carriageId)});
    const list=Array.isArray(postings?.result)?postings.result:Array.isArray(postings?.postings)?postings.postings:[];
    // Missing/malformed membership data is not an empty verified official manifest.
    if(!Array.isArray(postings?.result)&&!Array.isArray(postings?.postings)) fail('Ozon 官方组成响应缺少货件列表，不能确认已核对清单',502);
    const numbers=list.map(row=>typeof row==='string'?row:row.posting_number).filter(Boolean);
    return { info:result?.result||result,numbers,list };
  }
  async function recordOfficial(session,ctx,carriageId,result,token=null) {
    return transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,ctx.batch.id,true);
      if(token ? item.official_operation_token!==token : item.official_operation_token!==ctx.batch.official_operation_token||item.official_status!==ctx.batch.official_status) fail('官方操作已变化，请刷新',409);
      const officialState=text(result.info?.status,32).toLowerCase();
      const membersNow=await members(connection,current,item.id,true);
      for(const member of membersNow) await connection.execute('UPDATE ogl_dispatch_members SET official_member = ? WHERE tenant_id = ? AND id = ?', [Number(Number(member.shop_id)===Number(item.default_shop_id)&&result.numbers.includes(member.posting_number)),current.id,member.id]);
      const localSame=membersNow.filter(row=>row.active&&Number(row.shop_id)===Number(item.default_shop_id)).map(row=>row.posting_number);
      const extra=result.numbers.filter(number=>!localSame.includes(number));
      const missing=localSame.filter(number=>!result.numbers.includes(number));
      const isCancelled=['cancelled','canceled'].includes(officialState);
      const approved=['sended','received','closed'].includes(officialState);
      const exact=!extra.length&&!missing.length;
      const countValue=result.info?.containers_count;
      const missingCount=countValue==null||countValue==='';
      const actualCount=missingCount?null:Number(countValue);
      const countMismatch=approved&&(missingCount||!Number.isSafeInteger(actualCount)||actualCount!==Number(item.containers_count));
      const methodValue=result.info?.delivery_method_id;
      const missingMethod=methodValue==null||methodValue===''||!item.delivery_method_id;
      const methodMismatch=!isCancelled&&(missingMethod||String(methodValue)!==String(item.delivery_method_id));
      const proofMissing=(approved&&missingCount)||missingMethod;
      const nextStatus=isCancelled?'cancelled':proofMissing?'sync_required':!exact||countMismatch||methodMismatch?'mismatch':approved?'approved':item.official_status==='confirming'?'confirm_unknown':officialState==='new'?'created':'sync_required';
      const errors=[];
      if(!exact&&!isCancelled) errors.push('官方组成与本店所选订单不一致，请在 Ozon 后台修正后重新同步');
      if(countMismatch&&!isCancelled) errors.push(missingCount?`Ozon 未返回官方货位数量（containers_count），本地为 ${item.containers_count} 个；请重新核对官方单，核实前不能下载标签或交运`:`官方货位数量为 ${countValue} 个，本地批次为 ${item.containers_count} 个；请在 Ozon 后台核实并修正后重新同步`);
      if(methodMismatch) errors.push(missingMethod?'官方配送方式（delivery_method_id）或批次配送方式快照缺失，无法证明属于本批次；请重新核对官方单':`官方配送方式为 ${methodValue}，批次配置为 ${item.delivery_method_id}；请核对是否填错官方发运编号`);
      const summary={capabilities:parsed(item.official_result_json).capabilities,info:result.info,posting_numbers:result.numbers,extra,missing,
        container_count_mismatch:countMismatch,container_count_expected:Number(item.containers_count),container_count_actual:actualCount,
        delivery_method_mismatch:methodMismatch,delivery_method_expected:item.delivery_method_id,delivery_method_actual:methodValue??null,
        cross_shop_local_only:membersNow.filter(row=>row.active&&Number(row.shop_id)!==Number(item.default_shop_id)).map(row=>row.posting_number)};
      if(isCancelled) await connection.execute('UPDATE ogl_dispatch_members SET official_member = 0 WHERE tenant_id = ? AND batch_id = ?',[current.id,item.id]);
      await connection.execute(`UPDATE ogl_dispatch_batches SET official_carriage_id = ?,official_status = ?,official_result_json = ?,official_error = ?,official_operation_token = NULL,
        status = CASE WHEN status = 'preparing' AND ? = 'approved' THEN 'ready' ELSE status END WHERE tenant_id = ? AND id = ?`,[String(carriageId),nextStatus,JSON.stringify(summary),errors.join('；')||null,nextStatus,current.id,item.id]);
      if(isCancelled||nextStatus==='approved') await connection.execute('DELETE FROM ogl_dispatch_official_locks WHERE tenant_id = ? AND batch_id = ?',[current.id,item.id]);
      else if(item.delivery_method_id) await connection.execute(`INSERT INTO ogl_dispatch_official_locks (tenant_id,default_shop_id,delivery_method_id,batch_id,operation_token)
        VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id)`,[current.id,item.default_shop_id,item.delivery_method_id,item.id,token||randomUUID()]);
      await event(connection,current,item.id,'official-sync',{carriage_id:String(carriageId),status:nextStatus,extra,missing});
      return getDetail(connection,current,item.id);
    });
  }
  async function officialCreate(session,body) {
    if(!api?.request) fail('当前环境未配置 Ozon 发运 API',503);
    const ctx=await context(session,body.batch_id,true);
    if(['closed','cancelled'].includes(ctx.batch.status)) fail('已结束的内部批次不能创建官方发运',409);
    if(!['not_created','failed'].includes(ctx.batch.official_status)||ctx.batch.official_carriage_id) fail('该批次已有官方单或请求结果待核实，请使用同步官方发运，勿重复创建',409);
    if(!ctx.members.some(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id))) fail('默认店铺在当前批次没有自己的待发订单；空发运及跨店写入尚未验证，请选有本店订单的默认店铺重新组批',409);
    if(ctx.members.some(row=>row.active&&(!row.awaiting_delivery||classifyOrderLogistics(row).logistics_carrier!=='ogl'))) fail('部分订单平台状态或物流方式已变化，请先刷新并核实',409);
    const method=text(body.delivery_method_id||ctx.batch.delivery_method_id,64); const inputDate=text(body.departure_date||ctx.batch.departure_date,64);
    if(!method||!inputDate) fail('缺少官方配送方式（delivery_method_id）或发运日期（departure_date），请先查询可用发运方式并选择');
    id(method,'官方配送方式（delivery_method_id）');
    for(const member of ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id))) {
      const raw=parsed(member.raw_json); const posting=raw.raw||raw; const memberMethod=posting.delivery_method?.id;
      if(memberMethod==null) fail(`订单 ${member.posting_number} 缺少平台配送方式（delivery_method.id），请先按来源店铺刷新物流后再创建官方发运`,409);
      if(String(memberMethod)!==method) fail(`订单 ${member.posting_number} 的配送方式与所选官方配送方式不一致，请将默认店铺不同仓库／配送方式的订单分成不同批次`,409);
    }
    const selectedDay=normalizeShanghaiDateInput(inputDate);
    const options=await api.deliveryMethods(ctx.shop,{delivery_method_id:Number(method),departure_date:selectedDay});
    const capability=options.find(row=>String(row.delivery_method_id??row.id)===method&&shanghaiDateKey(row.departure_date)===selectedDay);
    if(!capability) fail('默认店铺当前没有该配送方式与所选日期的可用组合，请重新获取官方发运选项',409);
    // The create API requires date-time. Reuse the exact official slot value;
    // the date picker is only an operator selection, never an invented timestamp.
    const date=String(capability.departure_date);
    if(capability.has_entrusted_acceptance!==true) fail('所选配送方式尚未确认启用按货位的信任验收（has_entrusted_acceptance），不能提交实际货位数量；请在 Ozon 后台或联系物流商确认后重试',409);
    if(!Array.isArray(capability.carriages)||!capability.carriages.some(row=>(row.id===0||row.id==='0')&&Array.isArray(row.available_actions)&&row.available_actions.includes('create'))) fail('Ozon 当前没有返回可创建的发运槽位（carriages.id=0、available_actions=create），请核对发运日期和默认店铺待发订单',409);
    const token=randomUUID();
    await transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,ctx.batch.id,true);
      if(!['not_created','failed'].includes(item.official_status)||item.official_carriage_id) fail('另一请求已开始创建官方发运，请刷新',409);
      if(item.status!=='preparing') fail('内部批次已交运、取消或结束，请重新核对待发批次',409);
      const currentMembers=await members(connection,current,item.id,true);
      const activeIds=list=>list.filter(row=>row.active).map(row=>Number(row.order_id)).sort((a,b)=>a-b).join(',');
      if(activeIds(currentMembers)!==activeIds(ctx.members)||currentMembers.some(row=>row.active&&(!row.awaiting_delivery||classifyOrderLogistics(row).logistics_carrier!=='ogl'))) fail('批次成员、平台状态或物流方式已变化，请刷新后重新创建',409);
      await connection.execute(`INSERT INTO ogl_dispatch_official_locks (tenant_id,default_shop_id,delivery_method_id,batch_id,operation_token)
        VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id)`,[current.id,item.default_shop_id,method,item.id,token]);
      const [locks]=await connection.execute('SELECT batch_id FROM ogl_dispatch_official_locks WHERE tenant_id = ? AND default_shop_id = ? AND delivery_method_id = ? FOR UPDATE',[current.id,item.default_shop_id,method]);
      if(Number(locks[0].batch_id)!==Number(item.id)) fail(`同一默认店铺及配送方式已有待核实官方发运（内部批次 ${locks[0].batch_id}），请先核实、确认或取消该官方发运后再建下一单`,409);
      await connection.execute("UPDATE ogl_dispatch_batches SET official_status = 'creating',official_operation_token = ?,delivery_method_id = ?,departure_date = ?,official_result_json = ?,official_error = NULL WHERE tenant_id = ? AND id = ?",[token,method,date,JSON.stringify({capabilities:{has_entrusted_acceptance:true,delivery_method_id:method,departure_date:date,warehouse_id:capability.warehouse_id??null,first_mile_type:capability.first_mile_type??null}}),current.id,item.id]);
      await event(connection,current,item.id,'official-create-start',{delivery_method_id:method,departure_date:date});
    });
    let carriageId;
    try {
      const response=await api.request(ctx.shop,'/v1/carriage/create',{delivery_method_id:Number(method),departure_date:date});
      carriageId=response?.carriage_id??response?.result?.carriage_id;
      if(!carriageId||!/^\d+$/.test(String(carriageId))||Number(carriageId)<=0) throw Object.assign(new Error('Ozon 未返回有效发运编号，需在后台查找后同步，不能直接重建'),{unknown:true});
      // Persist the returned ID before any subsequent network call can fail.
      await saveOfficial(session,ctx.batch.id,token,{official_carriage_id:String(carriageId)},'official-created',{carriage_id:String(carriageId)});
      // Only postings belonging to the authorized creation shop are sent. The
      // physical mixed-shop members remain explicitly local until API support is proven.
      const ownNumbers=ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id)).map(row=>row.posting_number);
      const initial=await readOfficial(ctx,carriageId);
      if(String(initial.info?.status||'').toLowerCase()==='new') {
        const response=await api.request(ctx.shop,'/v1/carriage/set-postings',{carriage_id:Number(carriageId),posting_numbers:ownNumbers});
        const rows=response?.result;
        if(!Array.isArray(rows)||ownNumbers.some(number=>!rows.some(row=>row.posting_number===number&&row.result===true&&!row.error))) {
          throw Object.assign(new Error('Ozon 未逐项确认本店货件组成；请同步官方发运并核对失败订单'),{unknown:true});
        }
      }
      const verified=await readOfficial(ctx,carriageId);
      return recordOfficial(session,ctx,carriageId,verified,token);
    } catch(error) {
      await saveOfficial(session,ctx.batch.id,token,{official_status:carriageId?'sync_required':error.unknown||error.operationOutcome==='unknown'?'create_unknown':'failed',official_error:text(error.message,2000),official_operation_token:null},'official-create-error',{outcome:carriageId?'created_sync_required':error.operationOutcome||'unknown'});
      throw error;
    }
  }
  async function officialSync(session,body) {
    const ctx=await context(session,body.batch_id,true); const carriageId=text(body.official_carriage_id||ctx.batch.official_carriage_id,64);
    if(['creating','confirming'].includes(ctx.batch.official_status)&&Date.now()-new Date(ctx.batch.updated_at).getTime()<300000) fail('官方操作正在处理中，请等待请求完成再同步；中断的请求五分钟后可回读核实',409);
    if(!carriageId||!/^\d+$/.test(carriageId)) fail('请填写待核实的 Ozon 官方发运编号（official_carriage_id），可在默认店铺后台查看');
    if(ctx.batch.official_carriage_id&&String(ctx.batch.official_carriage_id)!==carriageId) fail('历史批次不能更换官方发运编号',409);
    return recordOfficial(session,ctx,carriageId,await readOfficial(ctx,carriageId));
  }
  async function officialConfirm(session,body) {
    const ctx=await context(session,body.batch_id,true);
    if(['closed','cancelled'].includes(ctx.batch.status)) fail('已结束的内部批次不能确认官方发运',409);
    if(ctx.batch.official_status!=='created'||!ctx.batch.official_carriage_id) fail('请先创建官方发运，并确保官方组成核对一致；结果未知时先同步',409);
    const verified=await readOfficial(ctx,ctx.batch.official_carriage_id);
    if(String(verified.info?.status||'').toLowerCase()!=='new') {
      await recordOfficial(session,ctx,ctx.batch.official_carriage_id,verified);
      fail('官方发运已不处于可确认的初始 new 状态，请核对最新官方状态',409);
    }
    if(parsed(ctx.batch.official_result_json).capabilities?.has_entrusted_acceptance!==true) fail('批次未保存按货位信任验收能力，不能确认货位数；请核对官方配置',409);
    const same=ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id)).map(row=>row.posting_number);
    if(same.length!==verified.numbers.length||same.some(number=>!verified.numbers.includes(number))) {
      await recordOfficial(session,ctx,ctx.batch.official_carriage_id,verified);
      fail('官方组成已经变化，请核对本店订单清单后再确认',409);
    }
    const contact=body.courier_contact||{};
    if(contact.phone||contact.wechat_nickname||contact.comment) {
      if(verified.info?.first_mile_type!=='pickup'||verified.info?.integration_type!=='ozon_outsourced') fail('当前官方发运不是 Ozon 外包上门取件（pickup / ozon_outsourced），请清空取件联系人字段后按实际送货方式确认',409);
      const enteredPhone=text(contact.phone,128).replace(/[\s()-]/g,'');
      const phoneDigits=enteredPhone.startsWith('+86')?enteredPhone.slice(3):enteredPhone;
      if(!/^\d{11}$/.test(phoneDigits)) fail('请在联系人区域填写有效的 11 位中国取件联系电话（phone），可带 +86 国家区号');
      const phone=`+86(${phoneDigits.slice(0,3)})${phoneDigits.slice(3,7)}-${phoneDigits.slice(7)}`;
      const wechat=text(contact.wechat_nickname,128),comment=text(contact.comment,1000);
      if(wechat.length>50||comment.length>500) fail('取件微信号不得超过 50 字，备注不得超过 500 字，请在联系人区域修改');
      await api.request(ctx.shop,'/v1/carriage/courier-contact/set',{carriage_id:Number(ctx.batch.official_carriage_id),phone,...(wechat?{wechat_nickname:wechat}:{}),...(comment?{comment}:{})});
    }
    const token=randomUUID();
    await transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,ctx.batch.id,true);
      if(item.official_status!=='created') fail('另一请求已修改官方单，请刷新',409);
      if(item.status!=='preparing') fail('内部批次已交运、取消或结束，不能确认官方发运',409);
      const currentMembers=await members(connection,current,item.id,true);
      const activeIds=list=>list.filter(row=>row.active).map(row=>Number(row.order_id)).sort((a,b)=>a-b).join(',');
      if(activeIds(currentMembers)!==activeIds(ctx.members)||currentMembers.some(row=>row.active&&(!row.awaiting_delivery||classifyOrderLogistics(row).logistics_carrier!=='ogl'))) fail('批次成员或平台物流已变化，请刷新后重新核对官方发运',409);
      await connection.execute("UPDATE ogl_dispatch_batches SET official_status = 'confirming',official_operation_token = ? WHERE tenant_id = ? AND id = ?",[token,current.id,item.id]);
      await event(connection,current,item.id,'official-confirm-start',{containers_count:item.containers_count});
    });
    try {
      const response=await api.request(ctx.shop,'/v1/carriage/approve',{carriage_id:Number(ctx.batch.official_carriage_id),containers_count:Number(ctx.batch.containers_count)});
      if(response?.result===false||response?.error) throw new Error('Ozon 未确认发运，请检查官方返回结果');
      return recordOfficial(session,ctx,ctx.batch.official_carriage_id,await readOfficial(ctx,ctx.batch.official_carriage_id),token);
    } catch(error) {
      await saveOfficial(session,ctx.batch.id,token,{official_status:'confirm_unknown',official_error:text(error.message,2000),official_operation_token:null},'official-confirm-error');
      throw error;
    }
  }
  async function refresh(session,body) {
    const ctx=await context(session,body.batch_id,true); if(typeof syncPostings!=='function') fail('当前环境未配置订单物流精确刷新',503);
    const groups=new Map(); for(const row of ctx.members.filter(row=>row.active&&!row.delivered&&!row.cancelled)) { if(!groups.has(Number(row.shop_id))) groups.set(Number(row.shop_id),[]); groups.get(Number(row.shop_id)).push(row); }
    const results=[];
    for(const [shopId,rows] of groups) {
      let result; let error='';
      try { result=await syncPostings(ctx.current.session,shopId,rows.map(row=>row.posting_number)); }
      catch(failure) { error=text(failure.message,2000); }
      await transaction(async connection=>{
        const current=await scope(connection,session,true); await batch(connection,current,ctx.batch.id,true);
        for(const row of rows) {
          const observed=result?.rows?.find(item=>item.posting_number===row.posting_number&&Number(item.shop_id)===shopId&&item.found!==false);
          const issue=error||(!observed?'未取得该订单的最新物流，请稍后刷新或检查来源店铺授权':'');
          await connection.execute(`UPDATE ogl_dispatch_members SET sync_error = ?,last_refresh_attempt_at = ?,last_synced_at = CASE WHEN ? = '' THEN ? ELSE last_synced_at END WHERE tenant_id = ? AND id = ?`,[issue||null,timestamp(),issue,timestamp(),current.id,row.id]);
          results.push({order_id:row.order_id,ok:!issue,error:issue});
        }
      });
    }
    await transaction(async connection=>{const current=await scope(connection,session,true); await batch(connection,current,ctx.batch.id,true);
      if(results.every(row=>row.ok)) await connection.execute('UPDATE ogl_dispatch_batches SET last_refreshed_at = ? WHERE tenant_id = ? AND id = ?',[timestamp(),current.id,ctx.batch.id]);
      await event(connection,current,ctx.batch.id,'refresh',{results});
    });
    const result=await detail(session,ctx.batch.id); return {...result,refresh_results:results};
  }
  async function action(session,body={}) {
    let result;
    if(body.action==='refresh') result=await refresh(session,body);
    else if(body.action==='official-options') return officialOptions(session,body);
    else if(body.action==='official-create') result=await officialCreate(session,body);
    else if(body.action==='official-confirm') result=await officialConfirm(session,body);
    else if(body.action==='official-sync') result=await officialSync(session,body);
    else result=await localAction(session,body);
    invalidateWorkflowCaches(); return result;
  }
  async function file(session,queryOrId,typeArg) {
    const query=typeof queryOrId==='object'?queryOrId:{batch_id:queryOrId,type:typeArg};
    const ctx=await context(session,query.batch_id);
    const path={'container-labels':'/v2/posting/fbs/act/get-container-labels',barcode:'/v2/posting/fbs/act/get-barcode'}[query.type];
    if(!path) fail('文件类型必须为货位标签或发运条码');
    if(ctx.batch.official_status!=='approved'||!ctx.batch.official_carriage_id) fail('官方发运尚未核实确认，暂不能下载有效标签',409);
    const result=await api.request(ctx.shop,path,{id:Number(ctx.batch.official_carriage_id)},{binary:true});
    if(!result?.buffer) fail('Ozon 尚未生成文件，请稍后重试',502);
    const extension=result.contentType==='image/png'?'png':result.contentType==='image/jpeg'?'jpg':'pdf';
    return {...result,filename:`${ctx.batch.batch_number}-${query.type}.${extension}`};
  }
  return {bootstrap,saveSettings,preview,createBatch,listBatches,detail,listOfficial,officialDetail,officialTracking,action,file};
}
