import { randomUUID, createHash } from 'node:crypto';
import { classifyOrderLogistics } from './order-logistics-classification.js';
import { effectiveTenantMembershipRole } from './tenant-membership-authority.js';
import { getRoles, hasPermission, isEnterpriseAdmin } from '../shared/permissions.js';
import { isOglPlatformOnline, hasOglPlatformHandover, oglManualTracking } from './ogl-dispatch-state.js';
import { invalidateMasterDataCache } from './mysql-master-data-cache.js';
import { invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';
import { invalidateInventoryProductBalance } from './mysql-inventory-product-balance.js';
import { normalizeShanghaiDateInput, shanghaiDateKey } from '../shanghai-time.js';
import { restoreBusinessTaskSession } from './business-task-tenant.js';
import { oglOfficialDateRange, oglOfficialCreatedAt } from './ogl-official-range.js';
import { unchangedOglObservation } from './ogl-refresh-events.js';
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
export function oglOrderReviewSignature(row={}) {
  return createHash('sha256').update(JSON.stringify([text(row.mark_type),text(row.mark_note)])).digest('hex');
}
function orderReviews(rows) { return Object.fromEntries(rows.filter(row=>text(row.mark_type)||text(row.mark_note)).map(row=>[Number(row.order_id||row.id),oglOrderReviewSignature(row)])); }

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
export function oglFileCapabilities(info={}) {
  const actions=Array.isArray(info.available_actions)?info.available_actions:null;
  const cancelled=['cancelled','canceled'].includes(String(info.status||'').toLowerCase());
  const capability=(type,keys)=>{
    const available=cancelled?false:actions?keys.some(key=>actions.includes(key)):null;
    return {available,reason:available?'':cancelled?'官方申请已取消，文件不可用':available===null?'尚未取得官方文件开放状态，请显式刷新官方申请':type==='barcode'?'此官方申请未提供交接条码；货位标签是独立 PDF，可单独下载':'此官方申请尚未开放货位标签，请刷新后重试'};
  };
  return {container_labels:capability('container_labels',['get_label_containers']),barcode:capability('barcode',['get_barcode','get_label_barcode'])};
}
export function normalizeOglHandoverType(info={}) {
  const mode=String(info?.first_mile_type||'').trim().toLowerCase().replaceAll('_','');
  return mode==='pickup'?'courier':mode==='dropoff'?'self':null;
}
function assertHandoverSelection(body,info) {
  if(body.handover_type===undefined) return;
  if(!['courier','self'].includes(body.handover_type)) fail('交运方式仅支持上门取件或自行送货，请重新选择',400,'OGL_HANDOVER_TYPE_INVALID');
  const actual=normalizeOglHandoverType(info);
  if(!actual) fail('官方尚未返回可确定的交运方式（first_mile_type），不能证明已切换取件或自送；请在 Ozon 后台核对后重新获取可用方式',409,'OGL_HANDOVER_TYPE_UNKNOWN');
  if(actual!==body.handover_type) fail('所选交运方式与官方配送方式不一致，请选择官方返回的取件或自送方式；本系统不会直接修改仓库的全局交运设置',409,'OGL_HANDOVER_TYPE_MISMATCH');
}
function officialConfirmationObserved(info={}) {
  const state=String(info.status||'').toLowerCase();
  return ['sended','received','closed'].includes(state)
    ||state==='formed'&&oglFileCapabilities(info).container_labels.available===true;
}
function beijingDay(value, now) {
  const day=value==null||value===''?shanghaiDateKey(now()):String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||shanghaiDateKey(`${day}T00:00:00+08:00`)!==day) fail('请选择有效的北京日期（YYYY-MM-DD）');
  return day;
}
const shopScope = (scope, alias = 's') => `(${alias}.tenant_id = ?${scope.slug === 'default' ? ` OR ${alias}.tenant_id IS NULL` : ''})`;
const monitorAuthorityFailure = error => [401,403].includes(Number(error?.statusCode||error?.status))
  || ['OGL_ACCESS_REVOKED','OGL_SHOP_ACCESS_REVOKED','OGL_SETTINGS_CHANGED','OGL_BATCH_SCOPE_CHANGED'].includes(error?.code);
const monitorFailure = (stage,key,error) => ({stage,...key,status:Number(error?.statusCode||error?.status)||null,
  code:/^[A-Z][A-Z0-9_]{0,79}$/.test(String(error?.code||''))?error.code:'OGL_MONITOR_ITEM_FAILED'});

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
  const monitorState=new Map();
  let monitorCursor=0;
  let monitorRunning=false;
  async function scope(connection, session, write = false) {
    const tenantId = id(session?.tenant?.id, '当前企业'); const personId = id(session?.personId, '操作账号');
    const [rows] = await connection.execute(`SELECT t.id, t.slug, tm.role AS tenant_role, tm.business_roles_json,
      p.role AS legacy_role, p.roles_json FROM tenants t
      JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.person_id = ? AND tm.active = 1
      JOIN people p ON p.id = tm.person_id AND p.active = 1
      WHERE t.id = ? AND t.status = 'active' AND t.subscription_status IN ('active','trial')
        AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP())${write ? ' FOR UPDATE' : ''}`, [personId, tenantId]);
    const row = rows[0];
    if (!row || row.slug !== session.tenant.slug) fail('当前企业、成员或订阅已失效，请检查企业订阅或重新登录', 403,'OGL_ACCESS_REVOKED');
    const trusted = { personId, roles: getRoles({ roles: row.business_roles_json ?? row.roles_json ?? row.legacy_role }), tenant: {
      id: tenantId, slug: row.slug, role: effectiveTenantMembershipRole({ ...row, tenant_slug: row.slug })
    } };
    if (!hasPermission(trusted, 'orders.read') || (write && !hasPermission(trusted, 'packing') && !hasPermission(trusted, 'orders.manage'))) fail('当前岗位无权操作 OGL 发运，请联系企业管理员', 403,'OGL_ACCESS_REVOKED');
    return { id: tenantId, slug: row.slug, personId, session: trusted, can_settings: isEnterpriseAdmin(trusted) };
  }
  async function shops(connection, current) {
    const [rows] = await connection.execute(`SELECT s.* FROM shops s WHERE ${shopScope(current)} AND s.status = 'active' ORDER BY s.id`, [current.id]);
    return rows;
  }
  async function shop(connection, current, shopId, credentials = false) {
    const [rows] = await connection.execute(`SELECT s.* FROM shops s WHERE s.id = ? AND ${shopScope(current)} AND s.status = 'active'`, [id(shopId, '默认发运店铺'), current.id]);
    const row = rows[0];
    if (!row) fail('默认发运店铺不属于当前企业或已停用，请在 OGL 发运设置中重新选择', 409,'OGL_SHOP_ACCESS_REVOKED');
    if (credentials && (!text(row.ozon_client_id) || !text(row.ozon_api_key || row.api_key_hint))) fail('默认发运店铺缺少 Ozon Client-Id 或 API Key，请在企业店铺设置中补充授权', 409,'OGL_SHOP_ACCESS_REVOKED');
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
    const [rows] = await connection.execute(`SELECT m.*, (SELECT te.detail_json FROM ogl_dispatch_events te WHERE te.tenant_id=m.tenant_id AND te.batch_id=m.batch_id AND te.member_id=m.id AND te.action='assign-tracking' ORDER BY te.id DESC LIMIT 1) AS manual_tracking_json, o.status AS platform_status, o.logistics_status, o.tracking_stage,
      o.ordered_at, o.last_synced_at AS order_last_synced_at, raw.raw_json, raw.substatus, om.mark_type, om.note AS mark_note, s.name AS shop_name,
      s.status AS shop_status FROM ogl_dispatch_members m
      JOIN orders o ON o.id = m.order_id AND o.shop_id = m.shop_id AND o.posting_number = m.posting_number
      JOIN shops s ON s.id = o.shop_id AND ${shopScope(current)}
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      LEFT JOIN order_marks om ON om.order_id=o.id
      WHERE m.tenant_id = ? AND m.batch_id = ? ORDER BY m.id${lock ? ' FOR UPDATE' : ''}`, [current.id, current.id, batchId]);
    return rows.map(row => {
      const progress = oglPlatformProgress({ ...row, status: row.platform_status });
      const lastSynced=instant(row.order_last_synced_at)>instant(row.last_synced_at)?row.order_last_synced_at:row.last_synced_at||row.order_last_synced_at;
      const refreshedAfterFailure=row.sync_error&&row.last_refresh_attempt_at
        &&instant(row.order_last_synced_at)>=instant(row.last_refresh_attempt_at)
        &&(!row.last_synced_at||instant(row.order_last_synced_at)>instant(row.last_synced_at));
      const member={ ...row, ...progress, tracking_assignment:oglManualTracking(row), active: Number(row.active_order_id) === Number(row.order_id) && !row.withdrawn_at,
        exception_reason: row.exception_note || '', last_synced_at: lastSynced, sync_error:refreshedAfterFailure?null:row.sync_error,
        logistics_status: row.substatus || row.logistics_status || row.tracking_stage || row.platform_status };
      return {...member,order_path:`/orders?orderId=${Number(row.order_id)}&shopId=${Number(row.shop_id)}&searchType=order&searchQuery=${encodeURIComponent(row.posting_number)}${row.ordered_at?`&dateFrom=${shanghaiDateKey(row.ordered_at)}&dateTo=${shanghaiDateKey(row.ordered_at)}`:''}`,logistics_fresh:isOglLogisticsFresh(member)};
    });
  }
  async function event(connection, current, batchId, action, details = {}, memberId = null, why = '') {
    if (['refresh','official-sync'].includes(action)) {
      // Callers already hold this enterprise's batch FOR UPDATE, so concurrent
      // observers cannot both append the same unchanged result. Checks and
      // fresh timestamps are persisted by the caller even when no event is new.
      const [previous] = await connection.execute(`SELECT detail_json FROM ogl_dispatch_events
        WHERE tenant_id = ? AND batch_id = ? AND action = ? ORDER BY id DESC LIMIT 1`, [current.id,batchId,action]);
      if (unchangedOglObservation(action,previous[0]?.detail_json,details)) return;
    }
    await connection.execute(`INSERT INTO ogl_dispatch_events (tenant_id,batch_id,member_id,action,reason,detail_json,person_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, [current.id,batchId,memberId,action,text(why),JSON.stringify(details),current.personId,timestamp()]);
  }
  async function getDetail(connection, current, batchId) {
    const result = await batch(connection, current, batchId); const rows = await members(connection, current, result.id);
    const [events] = await connection.execute(`SELECT id, member_id, action, reason, detail_json, person_id, created_at FROM ogl_dispatch_events WHERE tenant_id = ? AND batch_id = ? ORDER BY id DESC LIMIT 200`, [current.id,result.id]);
    const official=parsed(result.official_result_json);
    return { batch: { ...result, official_result: official, file_capabilities:oglFileCapabilities(official.carriage||official.info),
      snapshot_at:oglOfficialCreatedAt(official.last_observed_at),last_checked_at:oglOfficialCreatedAt(official.last_observed_at),official_operation_token: undefined }, members: rows.map(({ raw_json, ...row }) => row), events,
      summary: {...summarizeOglMembers(rows),failed_postings:Array.isArray(official.failed_postings)?official.failed_postings:[],container_count_mismatch:Boolean(official.container_count_mismatch),delivery_method_mismatch:Boolean(official.delivery_method_mismatch)} };
  }
  function localManifestMembers(detail,creationShopId,numbers) {
    const accepted=new Set(numbers);
    return detail.members.map(row=>{
      const own=Number(row.shop_id)===Number(creationShopId),official=own&&accepted.has(row.posting_number);
      return {...row,official_member:Number(official),association_type:official?'official':own?'local_missing_official':'local_other_shop',
        association_label:official?'官方已收录':own?'本店未被官方收录':'仅 ERP 关联（其他店铺）'};
    });
  }
  async function previewRows(connection, current, orderIds, lock = false, targetBatchId = 0) {
    const selected = ids(orderIds);
    const [rows] = await connection.execute(`SELECT o.*, s.name AS shop_name, s.status AS shop_status, raw.raw_json,
      raw.substatus, olp.printed_at, olp.print_batch_id, om.mark_type, om.note AS mark_note, m.batch_id AS active_batch_id,
      EXISTS (SELECT 1 FROM ogl_dispatch_members history WHERE history.tenant_id = ? AND history.order_id = o.id
        AND history.active_order_id IS NULL AND history.official_member = 1) AS has_official_conflict
      FROM orders o JOIN shops s ON s.id = o.shop_id AND ${shopScope(current)}
      LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
      LEFT JOIN order_label_prints olp ON olp.order_id = o.id
      LEFT JOIN order_marks om ON om.order_id = o.id
      LEFT JOIN ogl_dispatch_members m ON m.tenant_id = ? AND m.active_order_id = o.id
      WHERE o.id IN (${marks(selected)}) ORDER BY o.id${lock ? ' FOR UPDATE' : ''}`, [current.id,current.id,current.id,...selected]);
    const byId = new Map(rows.map(row => [Number(row.id), row])); const eligible = []; const rejected = [];
    for (const orderId of selected) {
      const row = byId.get(orderId); let why = '';
      if (!row || row.shop_status !== 'active') why = '订单不存在、不属于当前企业或来源店铺已停用';
      else if (classifyOrderLogistics(row).logistics_fulfillment_type === 'fbp') why = 'FBP 订单由平台仓履约，不能加入本地 OGL 交运';
      else if (classifyOrderLogistics(row).logistics_carrier !== 'ogl') why = '仅可加入 OGL 物流订单';
      else if (!oglPlatformProgress(row).awaiting_delivery) why = '订单已离开等待发货状态，请刷新订单';
      else if (!row.printed_at) why = '订单尚未确认打印小面单，请先完成打印';
      else if (row.active_batch_id && Number(row.active_batch_id) !== Number(targetBatchId)) why = `订单已关联活动批次 #${row.active_batch_id}，请先核对原批次；不会自动移动`;
      else if (Number(row.has_official_conflict)) why = '订单仍被历史官方发运收录，请先核实并同步原批次的官方组成';
      if (why) rejected.push({ id: orderId, order_id: orderId, posting_number:row?.posting_number,active_batch_id:row?.active_batch_id,reason: why });
      else { const { raw_json, ...safe } = row; eligible.push({...safe,needs_review:Boolean(text(row.mark_type)||text(row.mark_note)),review_signature:oglOrderReviewSignature(row),already_bound:Number(row.active_batch_id)===Number(targetBatchId)&&Number(targetBatchId)>0}); }
    }
    return { order_ids: selected, eligible, rejected, counts: { selected: selected.length, eligible: eligible.length, rejected: rejected.length } };
  }
  async function bootstrap(session) {
    return transaction(async connection => {
      const current = await scope(connection, session); const available = await shops(connection, current);
      const [settings] = await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?', [current.id]);
      const monitoring=monitorState.get(current.id);
      return { settings: { dispatch_shop_id: Number(settings[0]?.default_shop_id) || null }, monitoring:monitoring?{status:monitoring.status,notice:monitoring.notice||'',checked_at:monitoring.checked_at}:null, can_manage_settings: current.can_settings,
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
    return transaction(async connection => {
      const current=await scope(connection,session);if(body.batch_id)await batch(connection,current,body.batch_id);
      return previewRows(connection,current,body.order_ids,false,Number(body.batch_id)||0);
    });
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
      assertOrderReview(checked.eligible,body);
      const batchDay = shanghaiDateKey(now()).replaceAll('-','');
      const batchNumber = `OGL-${batchDay}-${randomUUID().slice(0,8).toUpperCase()}`;
      const [insert] = await connection.execute(`INSERT INTO ogl_dispatch_batches
        (tenant_id,batch_number,client_request_id,default_shop_id,containers_count,note,delivery_method_id,departure_date,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`, [current.id,batchNumber,requestId,selected.id,count,text(body.note),text(body.delivery_method_id,64)||null,text(body.departure_date,64)||null,current.personId]);
      for (const row of checked.eligible) await connection.execute(`INSERT INTO ogl_dispatch_members
        (tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number) VALUES (?,?,?,?,?,?)`, [current.id,insert.insertId,row.id,row.id,row.shop_id,row.posting_number]);
      await event(connection,current,insert.insertId,'create',{order_ids:checked.order_ids,containers_count:count,default_shop_id:Number(selected.id),reviewed_order_ids:body.reviewed_order_ids||[],review_signatures:orderReviews(checked.eligible),review_note:text(body.review_note)});
      return getDetail(connection,current,insert.insertId);
    });
    invalidateWorkflowCaches(); return result;
  }
  function assertOrderReview(rows,body) {
    const reviewed=new Set(Array.isArray(body.reviewed_order_ids)?body.reviewed_order_ids.map(Number):[]);
    const pending=rows.filter(row=>row.needs_review);
    if(pending.some(row=>!reviewed.has(Number(row.id))||body.review_signatures?.[row.id]!==oglOrderReviewSignature(row))||pending.length&&!text(body.review_note))fail('有标记或备注的订单须逐单确认并填写复核说明；原备注将保留',409,'OGL_ORDER_REVIEW_REQUIRED');
  }
  async function candidates(session,query={}) {
    const range=oglOfficialDateRange({date_from:query.printed_from||shanghaiDateKey(now()),date_to:query.printed_to||shanghaiDateKey(now())},now());
    const pageValue=Number(query.page)||1;if(!Number.isSafeInteger(pageValue)||pageValue<1||pageValue>100000)fail('页码无效，请重新查询打印订单');
    const page=pageValue,size=Math.min(100,Math.max(1,Math.floor(Number(query.page_size)||20)));
    return transaction(async connection=>{
      const current=await scope(connection,session),target=Number(query.batch_id)||0;if(target)await batch(connection,current,target);
      const params=[current.id,current.id,sqlDate(`${range.date_from}T00:00:00+08:00`),sqlDate(new Date(Date.parse(`${range.date_to}T00:00:00+08:00`)+86400000))];
      let where=`${shopScope(current)} AND s.status='active' AND olp.printed_at>=? AND olp.printed_at<?`;
      if(query.shop_id&&query.shop_id!=='all'){await shop(connection,current,query.shop_id);where+=' AND o.shop_id=?';params.push(id(query.shop_id));}
      if(text(query.search)){where+=' AND o.posting_number LIKE ?';params.push('%'+text(query.search,128).replace(/[\\%_]/g,'\\$&')+'%');}
      if(text(query.print_batch_id)){where+=' AND olp.print_batch_id=?';params.push(text(query.print_batch_id,128));}
      if(query.binding!=='all'){where+=' AND (m.active_order_id IS NULL OR m.batch_id=?)';params.push(target);}
      if(query.review==='clear')where+=" AND COALESCE(om.mark_type,'')='' AND TRIM(COALESCE(om.note,''))=''";
      if(query.review==='review')where+=" AND (COALESCE(om.mark_type,'')<>'' OR TRIM(COALESCE(om.note,''))<>'')";
      const from=`FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_label_prints olp ON olp.order_id=o.id LEFT JOIN ogl_dispatch_members m ON m.tenant_id=? AND m.active_order_id=o.id LEFT JOIN order_marks om ON om.order_id=o.id WHERE ${where}`;
      const [totals]=await connection.execute(`SELECT COUNT(*) AS total ${from}`,params);
      const [rows]=await connection.query(`SELECT o.id ${from} ORDER BY olp.printed_at DESC,o.id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      const checked=rows.length?await previewRows(connection,current,rows.map(row=>Number(row.id)),false,target):{eligible:[],rejected:[]};
      return {...checked,page,page_size:size,total:Number(totals[0].total)};
    });
  }
  async function bindOrders(session,body) {
    const requestKey=text(body.client_request_id,128);if(!/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey))fail('绑定缺少有效操作标识，请重新打开组批窗口');
    const selected=ids(body.order_ids),ctx=await context(session,body.batch_id,true);
    if(!ctx.batch.official_carriage_id||!['observed','approved'].includes(ctx.batch.official_status))fail('请先同步已有官方申请并选择可核对的批次',409);
    const official=await readOfficial(ctx,ctx.batch.official_carriage_id);
    if(!['new','formed','sended'].includes(String(official.info?.status||'').toLowerCase())||official.failed_postings.length)fail('官方申请已结束、取消或有失败货件，请先核对官方状态',409);
    const accepted=new Set(official.numbers);
    return transaction(async connection=>{
      const current=await scope(connection,session,true);await shop(connection,current,ctx.batch.default_shop_id,true);
      await connection.execute('SELECT id FROM tenants WHERE id=? FOR UPDATE',[current.id]);
      const item=await batch(connection,current,ctx.batch.id,true);
      if(item.official_status!==ctx.batch.official_status||item.official_carriage_id!==ctx.batch.official_carriage_id||(item.official_operation_token??null)!==ctx.operationToken)fail('申请状态已变化，请刷新后绑定',409);
      const [events]=await connection.execute("SELECT detail_json FROM ogl_dispatch_events WHERE tenant_id=? AND batch_id=? AND action='bind-orders' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1",[current.id,item.id,requestKey]);
      if(events[0]){const previous=parsed(events[0].detail_json);if(JSON.stringify([...previous.order_ids].sort((a,b)=>a-b))!==JSON.stringify([...selected].sort((a,b)=>a-b)))fail('同一操作标识不能用于不同订单，请重新核对',409);return getDetail(connection,current,item.id);}
      const previous=await members(connection,current,item.id,true);
      const adding=selected.some(orderId=>!previous.some(row=>row.active&&Number(row.order_id)===orderId));
      if(['closed','cancelled'].includes(item.status)||adding&&(item.status==='tracking'||previous.some(row=>row.active&&row.dispatched_at)))fail('该批次已开始实际交运或已结束，不能追加订单',409);
      const checked=await previewRows(connection,current,selected,true,item.id);
      if(checked.rejected.length)fail(`有 ${checked.rejected.length} 个订单不能绑定：${checked.rejected[0].reason}`,409);
      assertOrderReview(checked.eligible,body);
      for(const row of checked.eligible){
        const own=Number(row.shop_id)===Number(item.default_shop_id);
        if(own&&!accepted.has(row.posting_number))fail(`本店订单 ${row.posting_number} 未被 Ozon 发运单收录，请在 Ozon 后台添加后同步；不能冒充官方关联`,409);
        if(row.already_bound)continue;
        const [old]=await connection.execute('SELECT id FROM ogl_dispatch_members WHERE tenant_id=? AND batch_id=? AND order_id=? FOR UPDATE',[current.id,item.id,row.id]);
        if(old[0])await connection.execute('UPDATE ogl_dispatch_members SET active_order_id=order_id,withdrawn_at=NULL,withdrawn_by=NULL,official_member=? WHERE tenant_id=? AND id=?',[Number(own),current.id,old[0].id]);
        else await connection.execute('INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member) VALUES(?,?,?,?,?,?,?)',[current.id,item.id,row.id,row.id,row.shop_id,row.posting_number,Number(own)]);
      }
      const metadata={...parsed(item.official_result_json)};delete metadata.local_management;
      await connection.execute('UPDATE ogl_dispatch_batches SET official_result_json=? WHERE tenant_id=? AND id=?',[JSON.stringify(metadata),current.id,item.id]);
      await event(connection,current,item.id,'bind-orders',{request_key:requestKey,order_ids:selected,reviewed_order_ids:body.reviewed_order_ids||[],review_signatures:orderReviews(checked.eligible),physical_dispatch:false},null,text(body.review_note));
      return getDetail(connection,current,item.id);
    });
  }
  async function listBatches(session, query = {}) {
    return transaction(async connection => {
      const current = await scope(connection, session); const params = [current.id]; let filter = '';
      if (query.status && query.status !== 'all') { filter=' AND b.status = ?'; params.push(text(query.status,32)); }
      if(query.date_from||query.date_to) {
        const range=oglOfficialDateRange(query,now());
        filter+=' AND b.created_at >= ? AND b.created_at < ?';
        params.push(sqlDate(`${range.date_from}T00:00:00+08:00`),sqlDate(new Date(Date.parse(`${range.date_to}T00:00:00+08:00`)+86400000)));
      }
      const page = Math.max(1,Math.floor(Number(query.page)||1)); const size = Math.min(100,Math.max(1,Math.floor(Number(query.page_size)||20)));
      const [total] = await connection.execute(`SELECT COUNT(*) AS total FROM ogl_dispatch_batches b WHERE b.tenant_id = ?${filter}`,params);
      const [rows] = await connection.query(`SELECT b.id FROM ogl_dispatch_batches b WHERE b.tenant_id = ?${filter} ORDER BY b.id DESC LIMIT ? OFFSET ?`,[...params,size,(page-1)*size]);
      const details = []; for (const row of rows) { const detail = await getDetail(connection,current,row.id); details.push({ ...detail.batch,summary:detail.summary }); }
      return { rows:details,total:Number(total[0].total) };
    });
  }
  async function detail(session, batchId) { return transaction(async connection => getDetail(connection,await scope(connection,session),batchId)); }
  async function officialReadContext(session,requireApi=true,selectedShopId=null) {
    if(requireApi&&(!api?.deliveryMethods||!api?.request)) fail('当前环境未配置 Ozon 发运 API',503);
    return transaction(async connection=>{
      const current=await scope(connection,session);
      if(selectedShopId!=null&&selectedShopId!=='')return {current,shop:await shop(connection,current,selectedShopId,true),currentSettings:false,write:false};
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(!settings[0]) fail('尚未配置本企业默认 OGL 发运店铺，请让企业管理员先选择有 OGL 发运的店铺，再查询后台已有单',409,'OGL_SETTINGS_CHANGED');
      return {current,shop:await shop(connection,current,settings[0].default_shop_id,true),currentSettings:true,write:false};
    });
  }
  async function snapshotReadContext(session,selectedShopId) {
    return transaction(async connection=>{
      const current=await scope(connection,session);
      const available=selectedShopId!=null&&selectedShopId!==''?[await shop(connection,current,selectedShopId,true)]
        :(await shops(connection,current)).filter(row=>text(row.ozon_client_id)&&text(row.ozon_api_key||row.api_key_hint));
      return {current,shops:available,selectedShopId:selectedShopId!=null&&selectedShopId!==''?id(selectedShopId,'同步原店铺'):null};
    });
  }
  async function verifySnapshotScope(session,ctx,shopIds) {
    await transaction(async connection=>{
      const current=await scope(connection,session);
      if(current.id!==ctx.current.id)fail('企业已变化，请重新打开已申请列表',403);
      for(const shopId of new Set([...shopIds,...(ctx.selectedShopId?[ctx.selectedShopId]:[])]))await shop(connection,current,shopId,true);
    });
  }
  async function verifyExternalContext(ctx) {
    return transaction(async connection=>{
      const current=await scope(connection,ctx.current.session,ctx.write===true);
      if(current.id!==ctx.current.id) fail('当前企业已变更，请重新打开 OGL 发运',403);
      const selected=await shop(connection,current,ctx.shop.id,true);
      if(ctx.monitorSetting)await verifyMonitorSetting(connection,current,ctx.monitorSetting);
      if(ctx.batch) {
        const item=await batch(connection,current,ctx.batch.id);
        if(Number(item.default_shop_id)!==Number(ctx.shop.id)) fail('批次默认发运店铺已变更，请重新打开批次',409,'OGL_BATCH_SCOPE_CHANGED');
        if((item.official_operation_token??null)!==ctx.operationToken) fail('官方操作已变化，请刷新批次',409);
        if(ctx.requiredOfficialStatus&&item.official_status!==ctx.requiredOfficialStatus) fail('官方发运状态已变化，请重新核对后下载标签',409);
      } else if(ctx.currentSettings) {
        const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
        if(Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有申请',409,'OGL_SETTINGS_CHANGED');
      }
      return selected;
    });
  }
  async function verifyMonitorSetting(connection,current,setting) {
    const [rows]=await connection.execute('SELECT default_shop_id,updated_by FROM ogl_dispatch_settings WHERE tenant_id=?',[current.id]);
    if(Number(rows[0]?.default_shop_id)!==Number(setting.default_shop_id)||Number(rows[0]?.updated_by)!==Number(setting.updated_by))
      fail('OGL 自动跟踪设置已变更，请在下一轮使用最新设置重新核验',409,'OGL_SETTINGS_CHANGED');
  }
  async function verifyMonitorAuthority(session,setting,shopIds=[]) {
    return transaction(async connection=>{
      const current=await scope(connection,session,true);
      await verifyMonitorSetting(connection,current,setting);
      for(const shopId of new Set([Number(setting.default_shop_id),...shopIds.filter(value=>Number.isSafeInteger(value)&&value>0)]))await shop(connection,current,shopId,true);
    });
  }
  async function externalRequest(ctx,path,body={},options={}) {
    const selected=await verifyExternalContext(ctx);
    const result=await api.request(selected,path,body,options);
    await verifyExternalContext(ctx);
    return result;
  }
  async function externalDeliveryMethods(ctx,filter={}) {
    const selected=await verifyExternalContext(ctx);
    const result=await api.deliveryMethods(selected,filter,{
      maxPages:10,
      beforeRequest:()=>verifyExternalContext(ctx),
      afterRequest:()=>verifyExternalContext(ctx)
    });
    await verifyExternalContext(ctx);
    return result;
  }
  async function officialRows(ctx, day) {
    // A date filter also includes historical carriages that the default window
    // can omit. Keep the calendar-day check explicit across UTC boundaries.
    const methods=await externalDeliveryMethods(ctx,{departure_date:day});
    const rows=[]; const seen=new Set();
    for(const method of methods) {
      if(shanghaiDateKey(method.departure_date)!==day||!Array.isArray(method.carriages)) continue;
      for(const carriage of method.carriages) {
        const carriageId=String(carriage.id??carriage.carriage_id??'');
        if(!/^\d+$/.test(carriageId)||Number(carriageId)<=0||seen.has(carriageId)) continue;
        seen.add(carriageId);
        rows.push({id:carriageId,carriage_id:carriageId,delivery_method_id:String(method.delivery_method_id??''),
          delivery_method_name:text(method.delivery_method_name??method.name,255),departure_date:day,departure_at:method.departure_date,
          has_entrusted_acceptance:method.has_entrusted_acceptance===true,status:text(carriage.status,64),status_label:officialStatusLabel(carriage.status),
          available_actions:Array.isArray(carriage.available_actions)?carriage.available_actions.filter(value=>typeof value==='string'):[],
          postings_count:optionalCount(carriage.postings_count),containers_count:optionalCount(carriage.containers_count),official_only:true});
      }
    }
    return rows;
  }
  function officialCarriageRow(listed,info={}) {
    if(info.carriage_id!=null&&String(info.carriage_id)!==listed.carriage_id)fail('Ozon 返回的官方发运编号与查询编号不一致，请重新查询',502,'OGL_OFFICIAL_SCOPE_MISMATCH');
    if(info.delivery_method_id!=null&&String(info.delivery_method_id)!==listed.delivery_method_id)fail('Ozon 官方详情与列表配送方式不一致，请重新查询',502,'OGL_OFFICIAL_SCOPE_MISMATCH');
    const status=text(info.status||listed.status,64);
    return {...listed,status,status_label:officialStatusLabel(status),created_at:oglOfficialCreatedAt(info.created_at),
      containers_count:info.containers_count==null?listed.containers_count:optionalCount(info.containers_count),
      postings_count:info.postings_count==null?listed.postings_count:optionalCount(info.postings_count),
      available_actions:Array.isArray(info.available_actions)?info.available_actions.filter(value=>typeof value==='string'):listed.available_actions,
      file_capabilities:oglFileCapabilities({...info,status,available_actions:Array.isArray(info.available_actions)?info.available_actions:listed.available_actions}),
      first_mile_type:text(info.first_mile_type,64),integration_type:text(info.integration_type,64)};
  }
  function snapshotRow(item) {
    const saved=parsed(item.official_result_json),info=saved.carriage||saved.info||{};
    const rawDay=info.departure_date||saved.capabilities?.departure_date||item.departure_date;
    const day=/^\d{4}-\d{2}-\d{2}$/.test(String(rawDay||''))?String(rawDay):shanghaiDateKey(rawDay);
    const status=text(info.status||saved.official_status,64);
    const base={id:String(item.official_carriage_id),carriage_id:String(item.official_carriage_id),
      delivery_method_id:String(info.delivery_method_id||item.delivery_method_id||''),delivery_method_name:text(info.delivery_method_name,255),
      departure_date:day||null,departure_at:info.departure_at||item.departure_date||null,status,
      available_actions:Array.isArray(info.available_actions)?info.available_actions:undefined,
      containers_count:optionalCount(info.containers_count),postings_count:optionalCount(info.postings_count),
      official_only:false,local_batch_id:Number(item.id),batch_id:Number(item.id),local_batch_number:item.batch_number||''};
    const tracking=saved.label_tracking||{},valid=tracking.source==='official_container_label'&&!['cancelled','canceled'].includes(status);
    const row=officialCarriageRow(base,info);
    return {...row,dispatch_shop:{id:Number(item.default_shop_id),name:item.dispatch_shop_name||''},data_source:'snapshot',snapshot_at:oglOfficialCreatedAt(saved.last_observed_at),last_checked_at:oglOfficialCreatedAt(saved.last_observed_at),
      carrier_name:valid?text(tracking.carrier_name,128)||null:null,master_tracking_number:valid?text(tracking.master_tracking_number,128)||null:null,
      tracking_numbers:valid&&Array.isArray(tracking.tracking_numbers)?tracking.tracking_numbers.map(value=>text(value,128)).filter(Boolean):[],tracking_status:valid?tracking.status:'pending',tracking_source:valid?tracking.source:null,
      dispatch_stage:['cancelled','canceled'].includes(status)?'cancelled':Number(item.physically_dispatched)?'dispatched':'applied',
      dispatch_stage_label:['cancelled','canceled'].includes(status)?'官方已取消':Number(item.physically_dispatched)?'已实际交运':'已申请·待交接'};
  }
  async function listOfficialSnapshots(session,query) {
    const range=oglOfficialDateRange(query,now()),ctx=await snapshotReadContext(session,query.shop_id);
    const result=await transaction(async connection=>{
      const current=await scope(connection,session),shopIds=ctx.shops.map(row=>Number(row.id));
      const [batches]=shopIds.length?await connection.execute(`SELECT b.id,b.batch_number,b.default_shop_id,s.name AS dispatch_shop_name,b.official_carriage_id,b.official_result_json,b.departure_date,b.delivery_method_id,
        EXISTS(SELECT 1 FROM ogl_dispatch_members m JOIN orders mo ON mo.id=m.order_id AND mo.shop_id=m.shop_id AND mo.posting_number=m.posting_number
          JOIN shops ms ON ms.id=m.shop_id JOIN tenants mt ON mt.id=m.tenant_id
          WHERE m.tenant_id=b.tenant_id AND m.batch_id=b.id AND m.active_order_id=m.order_id AND m.withdrawn_at IS NULL AND m.dispatched_at IS NOT NULL
            AND (ms.tenant_id=m.tenant_id OR (ms.tenant_id IS NULL AND mt.slug='default'))) AS physically_dispatched
        FROM ogl_dispatch_batches b JOIN shops s ON s.id=b.default_shop_id AND ${shopScope(current)}
        WHERE b.tenant_id = ? AND b.default_shop_id IN (${marks(shopIds)}) AND s.status='active' AND b.official_carriage_id IS NOT NULL`,[current.id,current.id,...shopIds]):[[]];
      const all=batches.map(snapshotRow),rows=all.filter(row=>row.departure_date&&row.departure_date>=range.date_from&&row.departure_date<=range.date_to);
      if(rows.length>100)fail('所选日期有超过 100 份已保存申请，请缩小日期范围；未截断显示',409);
      rows.sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0)||String(b.departure_date).localeCompare(String(a.departure_date))||Number(b.carriage_id)-Number(a.carriage_id));
      const snapshotAt=rows.map(row=>row.snapshot_at).filter(Boolean).sort().at(-1)||null;
      const unknown=all.filter(row=>!row.departure_date).length;
      return {rows,total:rows.length,source:'snapshot',freshness:'saved',snapshot_at:snapshotAt,last_checked_at:snapshotAt,
        unknown_departure_count:unknown,dispatch_shop:ctx.selectedShopId?{id:ctx.selectedShopId,name:ctx.shops[0]?.name||''}:null,shop_scope:ctx.selectedShopId?'selected':'enterprise',date_from:range.date_from,date_to:range.date_to,departure_date:range.days.length===1?range.date_from:null,
        notice:!ctx.shops.length?'本企业尚无启用且具备 Ozon 授权的店铺；请在企业店铺补充 Client-Id / API Key 后选择同步，目前没有可读的申请快照':`${ctx.selectedShopId?'所选原店铺':'本企业有授权店铺'}${rows.length?'已保存的官方申请快照，具体核验时间见各行；不代表刚刚读取了官方状态':'在所选日期尚无已保存申请，请选择原店铺同步；不代表官方没有申请'}${unknown?`；另有 ${unknown} 份记录缺少发运日期，未纳入日期结果，请选原店铺同步核实`:''}`};
    });
    await verifySnapshotScope(session,ctx,result.rows.map(row=>row.dispatch_shop.id));return result;
  }
  async function officialSnapshotDetail(session,query) {
    const ctx=await officialReadContext(session,false,query.shop_id),day=beijingDay(query.date??query.departure_date,now),carriageId=String(id(query.id??query.carriage_id,'官方申请号'));
    const result=await transaction(async connection=>{
      const current=await scope(connection,session);await shop(connection,current,ctx.shop.id,true);
      const [items]=await connection.execute('SELECT * FROM ogl_dispatch_batches WHERE tenant_id=? AND default_shop_id=? AND official_carriage_id=?',[current.id,ctx.shop.id,carriageId]);
      if(!items[0])fail('当前企业原店铺尚无这份申请的已保存快照，请显式刷新官方申请',404);
      const item=items[0],saved=parsed(item.official_result_json),detail=await getDetail(connection,current,item.id);
      const carriage=snapshotRow({...item,dispatch_shop_name:ctx.shop.name,physically_dispatched:Number(detail.summary.dispatched)>0?1:0});
      if(carriage.departure_date!==day)fail('申请快照不属于所选北京发运日期，请核对日期后重试',404);
      const own=detail.members.filter(row=>Number(row.shop_id)===Number(ctx.shop.id));
      const stored=Array.isArray(saved.official_posting_numbers)?saved.official_posting_numbers:Array.isArray(saved.posting_numbers)?saved.posting_numbers:null;
      const failed_postings=Array.isArray(saved.failed_postings)?saved.failed_postings.map(row=>({posting_number:text(row.posting_number,128),status:text(row.status,64),seller_error:text(row.seller_error,500)})):[];
      const failedNumbers=new Set(failed_postings.map(row=>row.posting_number));
      const accepted=stored?[...new Set(stored.map(value=>text(value,128)).filter(value=>value&&!failedNumbers.has(value)))]:own.filter(row=>row.official_member&&!failedNumbers.has(row.posting_number)).map(row=>row.posting_number);
      const numbers=[...new Set([...accepted,...failedNumbers])];
      const local_members=localManifestMembers(detail,ctx.shop.id,accepted);
      const members=numbers.map(postingNumber=>{
        const local=own.find(row=>row.posting_number===postingNumber);
        const official=(Array.isArray(saved.official_postings)?saved.official_postings:failed_postings).find(row=>row.posting_number===postingNumber);
        return {posting_number:postingNumber,order_id:local?Number(local.order_id):null,shop_id:Number(ctx.shop.id),shop_name:ctx.shop.name,matched_local:Boolean(local),
          official_member:Number(accepted.includes(postingNumber)),official_status:text(official?.status,64),seller_error:text(official?.seller_error,500),
          ordered_at:local?.ordered_at||null,order_path:local?.order_path||null,platform_status:local?.platform_status||'',logistics_status:local?.logistics_status||'',tracking_stage:local?.tracking_stage||'',
          last_synced_at:local?.last_synced_at||null,online:Boolean(local?.online),delivered:Boolean(local?.delivered),cancelled:Boolean(local?.cancelled)};
      });
      const count=stored?accepted.length:carriage.postings_count??null,matched=members.filter(row=>row.matched_local&&row.official_member).length;
      return {carriage,members,local_members,failed_postings,summary:{official_members:count,matched_local:matched,unmatched_local:count==null?null:Math.max(0,count-matched),online:members.filter(row=>row.official_member&&row.online).length,
          failed_postings,local_members_count:local_members.length,local_only_count:local_members.filter(row=>!row.official_member).length},
        dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},departure_date:day,source:'snapshot',last_checked_at:carriage.snapshot_at,members_complete:Boolean(stored),
        notice:stored?'已保存的官方清单快照；本地订单轨迹单独显示当前记录':'旧快照只保存了已关联本地订单；完整官方清单需显式刷新后查看'};
    });
    await verifyOfficialReadScope(session,ctx);return result;
  }
  async function listOfficial(session,query={},internal=null) {
    if(query.source==='snapshot')return listOfficialSnapshots(session,query);
    const range=oglOfficialDateRange(query,now()); const ctx=internal?.ctx||await officialReadContext(session,true,query.shop_id);
    const byId=new Map();
    for(const day of range.days)for(const row of await officialRows(ctx,day)) {
      if(!byId.has(row.carriage_id))byId.set(row.carriage_id,row);
      if(byId.size>100)fail('此日期范围的官方申请超过 100 单，请缩小北京日期范围后查询',409);
    }
    const rows=[];
    for(const listed of byId.values()) {
      if(internal?.metadata===false){rows.push({...listed,created_at:null});continue;}
      try {
        const response=await externalRequest(ctx,'/v1/carriage/get',{carriage_id:Number(listed.carriage_id)});
        rows.push(officialCarriageRow(listed,response?.result||response));
      } catch(error) {
        if(monitorAuthorityFailure(error)||error.code==='OGL_OFFICIAL_SCOPE_MISMATCH')throw error;
        await verifyExternalContext(ctx);
        rows.push({...listed,created_at:null,metadata_error:'官方创建时间与数量待获取'});
      }
    }
    rows.sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0)||b.departure_date.localeCompare(a.departure_date)||Number(b.carriage_id)-Number(a.carriage_id));
    return transaction(async connection=>{
      const current=await scope(connection,session); await shop(connection,current,ctx.shop.id,true);
      // A default-shop change while the request was in flight must not display
      // one shop's response under another shop's current setting.
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(ctx.currentSettings&&Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有单',409,'OGL_SETTINGS_CHANGED');
      if(ctx.monitorSetting)await verifyMonitorSetting(connection,current,ctx.monitorSetting);
      const [batches]=await connection.execute(`SELECT b.id,b.batch_number,b.official_carriage_id,b.official_result_json,
        EXISTS(SELECT 1 FROM ogl_dispatch_members m JOIN orders mo ON mo.id=m.order_id AND mo.shop_id=m.shop_id AND mo.posting_number=m.posting_number
          JOIN shops ms ON ms.id=m.shop_id JOIN tenants mt ON mt.id=m.tenant_id
          WHERE m.tenant_id=b.tenant_id AND m.batch_id=b.id AND m.active_order_id=m.order_id AND m.withdrawn_at IS NULL AND m.dispatched_at IS NOT NULL
            AND (ms.tenant_id=m.tenant_id OR (ms.tenant_id IS NULL AND mt.slug='default'))) AS physically_dispatched
        FROM ogl_dispatch_batches b WHERE b.tenant_id = ? AND b.default_shop_id = ? AND b.official_carriage_id IS NOT NULL`,[current.id,ctx.shop.id]);
      const local=new Map(batches.map(row=>[String(row.official_carriage_id),row]));
      return {rows:rows.map(row=>{
        const linked=local.get(row.carriage_id),tracking=parsed(linked?.official_result_json).label_tracking||{};
        const valid=tracking.source==='official_container_label'&&!['cancelled','canceled'].includes(row.status);
        return {...row,dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},official_only:!linked,local_batch_id:linked?Number(linked.id):null,batch_id:linked?Number(linked.id):null,local_batch_number:linked?.batch_number||'',
          carrier_name:valid?tracking.carrier_name||null:null,master_tracking_number:valid?tracking.master_tracking_number||null:null,
          tracking_numbers:valid&&Array.isArray(tracking.tracking_numbers)?tracking.tracking_numbers:[],tracking_status:valid?tracking.status:'pending',tracking_source:valid?tracking.source:null,
          dispatch_stage:['cancelled','canceled'].includes(row.status)?'cancelled':Number(linked?.physically_dispatched)?'dispatched':'applied',
          dispatch_stage_label:['cancelled','canceled'].includes(row.status)?'官方已取消':Number(linked?.physically_dispatched)?'已实际交运':'已申请·待交接'};
      }),total:rows.length,dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},date_from:range.date_from,date_to:range.date_to,
        departure_date:range.days.length===1?range.date_from:null};
    });
  }
  async function officialDetail(session,query={},internal=null) {
    if(query.source==='snapshot'&&!internal)return officialSnapshotDetail(session,query);
    const day=beijingDay(query.date??query.departure_date,now); const carriageId=String(id(query.id??query.carriage_id,'官方发运编号'));
    const ctx=internal?.ctx||await officialReadContext(session,true,query.shop_id); const rows=internal?.listed?[internal.listed]:await officialRows(ctx,day); const listed=rows.find(row=>row.carriage_id===carriageId);
    if(!listed) fail('该官方发运不在所选原店铺和北京日期的已有申请中，请核对创建店铺及日期后重试',404);
    const data=await readOfficial(ctx,carriageId);
    if(data.info?.carriage_id!=null&&String(data.info.carriage_id)!==carriageId) fail('Ozon 返回的官方发运编号与查询编号不一致，请重新查询',502);
    if(data.info?.delivery_method_id!=null&&String(data.info.delivery_method_id)!==listed.delivery_method_id) fail('Ozon 官方详情与列表配送方式不一致，请重新查询',502);
    return transaction(async connection=>{
      const current=await scope(connection,session); await shop(connection,current,ctx.shop.id,true);
      const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
      if(ctx.currentSettings&&Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有单',409,'OGL_SETTINGS_CHANGED');
      if(ctx.monitorSetting)await verifyMonitorSetting(connection,current,ctx.monitorSetting);
      const numbers=[...new Set(data.list.map(row=>row.posting_number))]; const localOrders=[];
      // Match both shop and posting number. A number belonging to another shop
      // never becomes an authorized local member of this official manifest.
      for(let offset=0;offset<numbers.length;offset+=500) {
        const part=numbers.slice(offset,offset+500);
        const [orders]=await connection.execute(`SELECT o.id,o.posting_number,o.shop_id,o.ordered_at,o.status AS platform_status,o.logistics_status,o.tracking_stage,o.last_synced_at,s.name AS shop_name
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
          official_member:Number(!rawPosting?.seller_error),official_status:rawPosting?.status||'',seller_error:rawPosting?.seller_error||'',
          ordered_at:row?.ordered_at||null,order_path:row?`/orders?orderId=${Number(row.id)}&shopId=${Number(ctx.shop.id)}&searchType=order&searchQuery=${encodeURIComponent(postingNumber)}${row.ordered_at?`&dateFrom=${shanghaiDateKey(row.ordered_at)}&dateTo=${shanghaiDateKey(row.ordered_at)}`:''}`:null,
          platform_status:platformStatus,logistics_status:logisticsStatus,tracking_stage:row?.tracking_stage||'',last_synced_at:row?.last_synced_at||null,
          online:progress.online,delivered:progress.delivered,cancelled:progress.cancelled};
      });
      const [batches]=await connection.execute('SELECT id,batch_number FROM ogl_dispatch_batches WHERE tenant_id = ? AND default_shop_id = ? AND official_carriage_id = ?',[current.id,ctx.shop.id,carriageId]);
      const localDetail=batches[0]?await getDetail(connection,current,batches[0].id):{members:[]};
      const local_members=localManifestMembers(localDetail,ctx.shop.id,data.numbers);
      const status=text(data.info?.status||listed.status,64);
      const carriage={...officialCarriageRow(listed,data.info),dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},status,status_label:officialStatusLabel(status),postings_count:numbers.length,
        available_actions:Array.isArray(data.info?.available_actions)?data.info.available_actions.filter(value=>typeof value==='string'):listed.available_actions,
        first_mile_type:text(data.info?.first_mile_type,64),integration_type:text(data.info?.integration_type,64),
        official_only:!batches.length,local_batch_id:batches[0]?Number(batches[0].id):null,batch_id:batches[0]?Number(batches[0].id):null,local_batch_number:batches[0]?.batch_number||''};
      const accepted=members.filter(row=>row.official_member),matched=accepted.filter(row=>row.matched_local).length;
      return {carriage,members,local_members,failed_postings:data.failed_postings,summary:{official_members:accepted.length,matched_local:matched,unmatched_local:accepted.length-matched,online:accepted.filter(row=>row.online).length,
          failed_postings:data.failed_postings,local_members_count:local_members.length,local_only_count:local_members.filter(row=>!row.official_member).length},
        dispatch_shop:{id:Number(ctx.shop.id),name:ctx.shop.name},departure_date:day};
    });
  }
  async function verifyOfficialReadScope(session,ctx) {
    return transaction(async connection=>{
      const current=await scope(connection,session);await shop(connection,current,ctx.shop.id,true);
      if(current.id!==ctx.current.id)fail('当前企业已变化，请重新查询',403);
      if(ctx.currentSettings) {
        const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
        if(Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id)) fail('默认发运店铺已变更，请重新查询后台已有申请',409,'OGL_SETTINGS_CHANGED');
      }
    });
  }
  async function officialTracking(session,query={}) {
    const day=beijingDay(query.date??query.departure_date,now);const carriageId=String(id(query.id??query.carriage_id,'官方申请号'));
    const ctx=await officialReadContext(session,true,query.shop_id);
    // Validate the existing application and its exact default-shop/date scope.
    // This is a read-only detail lookup; it never imports or takes over a batch.
    const detail=await officialDetail(session,{id:carriageId,date:day,shop_id:query.shop_id});
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
      const file=await externalRequest(ctx,'/v2/posting/fbs/act/get-container-labels',{id:Number(carriageId)},{binary:true});
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
  async function discoveryTracking(ctx,carriage) {
    if(['cancelled','canceled'].includes(carriage.status))return null;
    try {
      const file=await externalRequest(ctx,'/v2/posting/fbs/act/get-container-labels',{id:Number(carriage.carriage_id)},{binary:true});
      if(!Buffer.isBuffer(file?.buffer)||file.contentType!=='application/pdf')return null;
      const extract=extractLabelTracking||(await import('./ogl-label-tracking.js')).extractOglLabelTracking;
      const tracking=await extract(file.buffer,{containersCount:carriage.containers_count});
      await verifyExternalContext(ctx);
      if(tracking?.source!=='official_container_label'||!['found','ambiguous'].includes(tracking.status)||!tracking.tracking_numbers?.length)return null;
      // Persist identifiers only, never label bytes, contact fields or PDF text.
      return {source:'official_container_label',status:tracking.status,carrier_name:text(tracking.carrier_name,128)||null,
        master_tracking_number:tracking.status==='found'?text(tracking.master_tracking_number,128)||null:null,
        tracking_numbers:[...new Set(tracking.tracking_numbers.map(value=>text(value,128)).filter(Boolean))].slice(0,1000)};
    } catch(error) {
      await verifyExternalContext(ctx);
      if(monitorAuthorityFailure(error))throw error;
      return null;
    }
  }
  async function associateOfficial(session,ctx,detail,tracking) {
    const carriage=detail.carriage;
    return transaction(async connection=>{
      const current=await scope(connection,session,true);await shop(connection,current,ctx.shop.id,true);
      if(ctx.monitorSetting)await verifyMonitorSetting(connection,current,ctx.monitorSetting);
      await connection.execute('SELECT id FROM tenants WHERE id = ? FOR UPDATE',[current.id]);
      if(ctx.currentSettings) {
        const [settings]=await connection.execute('SELECT default_shop_id FROM ogl_dispatch_settings WHERE tenant_id = ?',[current.id]);
        if(Number(settings[0]?.default_shop_id)!==Number(ctx.shop.id))fail('默认发运店铺已变更，请重新查询',409,'OGL_SETTINGS_CHANGED');
      }
      const [existing]=await connection.execute('SELECT * FROM ogl_dispatch_batches WHERE tenant_id = ? AND default_shop_id = ? AND official_carriage_id = ? FOR UPDATE',[current.id,ctx.shop.id,carriage.carriage_id]);
      let item=existing[0];
      if(item&&ctx.batch&&(Number(item.id)!==Number(ctx.batch.id)||(item.official_operation_token??null)!==ctx.operationToken))fail('官方操作已变化，请刷新批次',409);
      if(item&&['creating','confirming'].includes(item.official_status))fail('官方操作正在处理中，请稍后刷新',409);
      const previous=parsed(item?.official_result_json),imported=!item||previous.source==='official_discovery'&&item.official_status==='observed';
      const cancelled=['cancelled','canceled'].includes(carriage.status);
      const metadata={...previous,...(imported?{source:'official_discovery'}:{}),official_status:carriage.status,carriage:{...carriage,local_batch_id:undefined,batch_id:undefined},
        discovered_at:previous.discovered_at||now().toISOString(),last_observed_at:now().toISOString(),
        official_posting_numbers:detail.members.filter(row=>row.official_member!==0&&!row.seller_error).map(row=>row.posting_number),
        official_postings:detail.members.map(row=>({posting_number:row.posting_number,status:row.official_status||'',seller_error:row.seller_error||''})),failed_postings:detail.failed_postings||[],
        label_tracking:cancelled?null:tracking||previous.label_tracking||null};
      if(!item) {
        const [insert]=await connection.execute(`INSERT INTO ogl_dispatch_batches
          (tenant_id,batch_number,client_request_id,default_shop_id,containers_count,status,delivery_method_id,departure_date,
           official_carriage_id,official_status,official_result_json,created_by,created_at)
          VALUES (?,?,?,?,?,'preparing',?,?,?,'observed',?,?,?)`,[current.id,`OGL-${ctx.shop.id}-${carriage.carriage_id}`,`official:${ctx.shop.id}:${carriage.carriage_id}`,ctx.shop.id,carriage.containers_count??0,
          carriage.delivery_method_id,carriage.departure_at||carriage.departure_date,carriage.carriage_id,JSON.stringify(metadata),current.personId,carriage.created_at?sqlDate(carriage.created_at):timestamp()]);
        item={id:insert.insertId};
        await event(connection,current,item.id,'official-discovered',{carriage_id:carriage.carriage_id,postings_count:detail.members.length,physical_dispatch:false});
      } else {
        // A local batch keeps its reviewed create/approve status and member set.
        // Discovery cannot confirm or dispatch it. It still refreshes the
        // authoritative membership proof so rejected postings cannot retain a
        // stale success flag in order-list SQL.
        await connection.execute(`UPDATE ogl_dispatch_batches SET official_result_json = ?,
          containers_count = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE containers_count END,
          official_status=CASE WHEN ? = 1 AND ? = 0 THEN 'cancelled' ELSE official_status END,
          official_error = NULL WHERE tenant_id = ? AND id = ?`,[JSON.stringify(metadata),Number(imported),carriage.containers_count,carriage.containers_count,Number(cancelled),Number(imported),current.id,item.id]);
        if(!imported) {
          const [existingMembers]=await connection.execute('SELECT id,shop_id,posting_number FROM ogl_dispatch_members WHERE tenant_id=? AND batch_id=? FOR UPDATE',[current.id,item.id]);
          const accepted=new Set(metadata.official_posting_numbers);
          for(const member of existingMembers)await connection.execute('UPDATE ogl_dispatch_members SET official_member=? WHERE tenant_id=? AND id=?',
            [Number(!cancelled&&Number(member.shop_id)===Number(ctx.shop.id)&&accepted.has(member.posting_number)),current.id,member.id]);
        }
      }
      if(imported) {
        const wanted=cancelled?[]:detail.members.filter(row=>row.matched_local&&row.official_member!==0&&!row.seller_error).map(row=>Number(row.order_id));
        const [old]=await connection.execute('SELECT * FROM ogl_dispatch_members WHERE tenant_id = ? AND batch_id = ? FOR UPDATE',[current.id,item.id]);
        for(const member of old)if(!wanted.includes(Number(member.order_id))&&(cancelled||Number(member.shop_id)===Number(ctx.shop.id))) {
          await connection.execute(`UPDATE ogl_dispatch_members SET official_member=0,
            active_order_id=CASE WHEN dispatched_at IS NULL THEN NULL ELSE active_order_id END,
            withdrawn_at=CASE WHEN dispatched_at IS NULL THEN COALESCE(withdrawn_at,?) ELSE withdrawn_at END
            WHERE tenant_id=? AND id=?`,[timestamp(),current.id,member.id]);
        }
        const conflicts=[];
        for(const orderId of wanted) {
          const [owned]=await connection.execute(`SELECT o.*,raw.raw_json FROM orders o JOIN shops s ON s.id=o.shop_id AND ${shopScope(current)}
            LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number
            WHERE o.id=? AND o.shop_id=? FOR UPDATE`,[current.id,orderId,ctx.shop.id]);
          const order=owned[0];if(!order||!detail.members.some(row=>Number(row.order_id)===orderId&&row.posting_number===order.posting_number)||classifyOrderLogistics(order).logistics_carrier!=='ogl')continue;
          const [active]=await connection.execute('SELECT batch_id FROM ogl_dispatch_members WHERE tenant_id=? AND active_order_id=? FOR UPDATE',[current.id,orderId]);
          if(active[0]&&Number(active[0].batch_id)!==Number(item.id)){conflicts.push(orderId);continue;}
          const member=old.find(row=>Number(row.order_id)===orderId);
          if(member?.withdrawn_by){conflicts.push(orderId);continue;}
          if(member)await connection.execute('UPDATE ogl_dispatch_members SET official_member=1,active_order_id=order_id,withdrawn_at=NULL WHERE tenant_id=? AND id=?',[current.id,member.id]);
          else await connection.execute(`INSERT INTO ogl_dispatch_members (tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,official_member)
            VALUES (?,?,?,?,?,?,1)`,[current.id,item.id,orderId,orderId,ctx.shop.id,order.posting_number]);
        }
        if(conflicts.length)await connection.execute('UPDATE ogl_dispatch_batches SET official_error=? WHERE tenant_id=? AND id=?',[`${conflicts.length} 个订单已关联其他活动批次，请人工核对；未自动移动`,current.id,item.id]);
      }
      return Number(item.id);
    });
  }
  async function discover(session,query={},options={}) {
    await transaction(async connection=>scope(connection,session,true));
    const ctx=await officialReadContext(session,true,query.shop_id);ctx.write=true;
    if(options.monitorSetting)ctx.monitorSetting=options.monitorSetting;
    // Detail already reads metadata and manifest. Avoid an unbounded metadata
    // pre-pass that could fail before per-carriage recovery or repeat each GET.
    const listed=await listOfficial(session,{...query,source:'official'},{ctx,metadata:false});
    if(Number(listed.dispatch_shop.id)!==Number(ctx.shop.id))fail('默认发运店铺已变更，请重新查询',409,'OGL_SETTINGS_CHANGED');
    const discovered=[],failures=[];
    const key=row=>`${row.departure_date}:${row.carriage_id}`;
    const ordered=[...listed.rows].sort((a,b)=>key(a).localeCompare(key(b)));
    const cursor=String(options.cursor||'');
    const rotated=[...ordered.filter(row=>key(row)>cursor),...ordered.filter(row=>key(row)<=cursor)];
    const selected=options.monitorSetting?rotated.slice(0,20):ordered;
    let nextCursor=cursor;
    for(const row of selected) {
      nextCursor=key(row);
      if(typeof options.onAttempt==='function')options.onAttempt(nextCursor);
      try {
        const detail=await officialDetail(session,{id:row.carriage_id,date:row.departure_date},{ctx,listed:row});
        // Interactive refresh never reads label PDFs. Only the internal monitor
        // opts into extracting the separate, optional tracking identifiers.
        const tracking=options.readTracking===true?await discoveryTracking(ctx,detail.carriage):null;
        const batchId=await associateOfficial(session,ctx,detail,tracking);
        discovered.push({...row,...detail.carriage,batch_id:batchId,local_batch_id:batchId,official_only:false,
          carrier_name:tracking?.carrier_name||row.carrier_name,master_tracking_number:tracking?.master_tracking_number||row.master_tracking_number,
          tracking_numbers:tracking?.tracking_numbers||row.tracking_numbers,tracking_status:tracking?.status||row.tracking_status,tracking_source:tracking?.source||row.tracking_source});
      } catch(error) {
        if(monitorAuthorityFailure(error))throw error;
        // A network/item failure may coincide with revocation. Fresh authority
        // is mandatory before continuing to the next official application.
        await verifyExternalContext(ctx);
        failures.push(monitorFailure('discovery',{carriage_id:row.carriage_id,shop_id:Number(ctx.shop.id)},error));
      }
    }
    await verifyExternalContext(ctx);
    invalidateWorkflowCaches();return {...listed,rows:discovered,discovered:discovered.length,attempted:selected.length,failed:failures.length,
      partial:failures.length>0,failures,next_cursor:nextCursor,
      notice:failures.length?`已同步 ${discovered.length} 份申请，${failures.length} 份暂未同步，请稍后重试；成功记录已保留`:''};
  }
  async function monitorRecent() {
    if(monitorRunning)return {skipped:'running'};
    monitorRunning=true;
    try {
      // Internal scheduler inventory only. This query is never exposed by an API.
      let settings=await transaction(async connection=>(await connection.execute('SELECT tenant_id,default_shop_id,updated_by FROM ogl_dispatch_settings WHERE tenant_id > ? ORDER BY tenant_id LIMIT 20',[monitorCursor]))[0]);
      if(!settings.length){monitorCursor=0;settings=await transaction(async connection=>(await connection.execute('SELECT tenant_id,default_shop_id,updated_by FROM ogl_dispatch_settings ORDER BY tenant_id LIMIT 20'))[0]);}
      const results=[];
      for(const setting of settings) {
        const tenantId=Number(setting.tenant_id);monitorCursor=tenantId;
        const previous=monitorState.get(tenantId)||{};
        const progress={...previous,checked_at:now().toISOString()};
        const failures=[];let processed=0,skipped=0;
        try {
          const session=await restoreBusinessTaskSession(tenantId,setting.updated_by,async(sql,params)=>transaction(async connection=>(await connection.execute(sql,params))[0]));
          await verifyMonitorAuthority(session,setting,progress.paused_shop_id?[Number(progress.paused_shop_id)]:[]);
          delete progress.paused_shop_id;
          const days=['active','partial'].includes(previous.status)?2:7;
          const dateTo=shanghaiDateKey(now()),dateFrom=shanghaiDateKey(new Date(now().getTime()-(days-1)*86400000));
          if(Number(progress.discovery_shop_id)!==Number(setting.default_shop_id))progress.discovery_cursor='';
          progress.discovery_shop_id=Number(setting.default_shop_id);
          try {
            const found=await discover(session,{date_from:dateFrom,date_to:dateTo},{readTracking:true,monitorSetting:setting,cursor:progress.discovery_cursor,
              onAttempt:cursor=>{progress.discovery_cursor=cursor;monitorState.set(tenantId,{...progress});}});
            failures.push(...found.failures);
          } catch(error) {
            if(monitorAuthorityFailure(error))throw error;
            await verifyMonitorAuthority(session,setting);
            failures.push(monitorFailure('discovery',{},error));
          }
          const batches=await transaction(async connection=>{
            const current=await scope(connection,session,true),cursor=Number(progress.batch_cursor)||0;
            await verifyMonitorSetting(connection,current,setting);
            const sql="SELECT id,default_shop_id FROM ogl_dispatch_batches WHERE tenant_id=? AND official_carriage_id IS NOT NULL AND status IN ('preparing','ready','tracking') AND id>? ORDER BY id LIMIT 20";
            let [rows]=await connection.execute(sql,[current.id,cursor]);
            if(!rows.length&&cursor)[rows]=await connection.execute(sql,[current.id,0]);
            return rows;
          });
          for(const item of batches) {
            progress.batch_cursor=Number(item.id);monitorState.set(tenantId,{...progress});
            try {
              await verifyMonitorAuthority(session,setting,[Number(item.default_shop_id)]);
              const ctx=await context(session,item.id,true);ctx.monitorSetting=setting;
              if(['creating','confirming'].includes(ctx.batch.official_status)){skipped++;continue;}
              if(ctx.batch.official_status==='observed'&&parsed(ctx.batch.official_result_json).source==='official_discovery') {
                const raw=await readOfficial(ctx,ctx.batch.official_carriage_id);
                const saved=parsed(ctx.batch.official_result_json).carriage;
                if(!saved){skipped++;continue;}
                const listed=officialCarriageRow(saved,raw.info);
                const found=await officialDetail(session,{id:listed.carriage_id,date:listed.departure_date},{ctx,listed});
                await associateOfficial(session,ctx,found,await discoveryTracking(ctx,found.carriage));
              } else await recordOfficial(session,ctx,ctx.batch.official_carriage_id,await readOfficial(ctx,ctx.batch.official_carriage_id));
              if(typeof syncPostings==='function') {
                const refreshed=await refresh(session,{batch_id:item.id},setting);
                if(refreshed.refresh_results.some(row=>!row.ok))failures.push(monitorFailure('logistics',{batch_id:Number(item.id)},{code:'OGL_LOGISTICS_PARTIAL'}));
              }
              processed++;
            } catch(error) {
              if(monitorAuthorityFailure(error)){progress.paused_shop_id=Number(item.default_shop_id);throw error;}
              await verifyMonitorAuthority(session,setting,[Number(item.default_shop_id)]);
              failures.push(monitorFailure('batch',{batch_id:Number(item.id)},error));
            }
          }
          await verifyMonitorAuthority(session,setting);
          const status=failures.length?'partial':'active';
          const notice=failures.length?`自动跟踪部分完成：${failures.length} 项暂未更新，其他记录已继续处理；后台会轮转重试`:'';
          monitorState.set(tenantId,{...progress,status,notice,checked_at:now().toISOString()});
          results.push({tenant_id:tenantId,status,processed,skipped,failed:failures.length,failures});
        } catch(error) {
          const paused=monitorAuthorityFailure(error);
          monitorState.set(tenantId,{...progress,status:paused?'paused':'error',checked_at:now().toISOString(),notice:paused?'自动跟踪已暂停，请企业管理员检查默认发运店铺、保存设置人员的岗位和企业订阅后重新保存设置':'官方跟踪暂未更新，后台会重试；已尝试记录的轮转位置已保留'});
          results.push({tenant_id:tenantId,status:paused?'paused':'error',processed,skipped,failed:failures.length,failures});
        }
        while(monitorState.size>500)monitorState.delete(monitorState.keys().next().value);
      }
      return {tenants:results.length,results};
    } finally {monitorRunning=false;}
  }
  const memberSignature=rows=>rows.filter(row=>row.active).map(row=>`${Number(row.order_id)}:${Number(row.shop_id)}:${row.posting_number}`).sort().join('|');
  async function verifyObservedManagement(session,body,adopt=false) {
    const ctx=await context(session,body.batch_id,true);
    const saved=parsed(ctx.batch.official_result_json);
    if(ctx.batch.official_status!=='observed'||saved.source!=='official_discovery'||!ctx.batch.official_carriage_id)fail('仅已发现的官方申请可进行本地接管，请刷新申请详情',409);
    const result=await readOfficial(ctx,ctx.batch.official_carriage_id);
    officialCarriageRow(saved.carriage,result.info);
    if(result.failed_postings.length)fail('官方清单仍有未成功收录的货件，请先处理失败原因并同步，不能接管或登记整批实际交运',409,'OGL_POSTING_REJECTED');
    if(!['formed','sended','received','closed'].includes(String(result.info?.status||'').toLowerCase()))fail('官方申请尚未形成或已取消，不能登记实际交运，请在 Ozon 后台核对',409);
    const count=optionalCount(result.info?.containers_count);
    if(!count||count!==Number(ctx.batch.containers_count))fail('官方实际货位数未知或已变化，请刷新申请后核对实际装袋数量',409);
    if(adopt&&containers(body.container_count)!==count)fail('输入的实际货位数与官方数量不一致，请核对装袋和官方标签',409);
    const active=ctx.members.filter(row=>row.active);
    const own=active.filter(row=>Number(row.shop_id)===Number(ctx.shop.id));
    if(!own.length||own.some(row=>!row.official_member)||active.some(row=>Number(row.shop_id)!==Number(ctx.shop.id)&&row.official_member)
      ||own.length!==result.numbers.length||own.some(row=>!result.numbers.includes(row.posting_number)))fail('官方清单与本地本店订单未完全匹配，请先同步缺失订单或处理其他活动批次，再重新核对接管',409);
    const signature=memberSignature(active);
    if(!adopt&&(!saved.local_management?.adopted_at||saved.local_management.member_signature!==signature||Number(saved.local_management.container_count)!==count))fail('请先核对实际货位数并接管跟踪；清单变化后需要重新确认',409);
    if(adopt)return transaction(async connection=>{
      const current=await scope(connection,session,true);const item=await batch(connection,current,ctx.batch.id,true);await shop(connection,current,item.default_shop_id,true);
      const latest=await members(connection,current,item.id,true);
      if(item.official_status!=='observed'||(item.official_operation_token??null)!==ctx.operationToken||memberSignature(latest)!==signature||Number(item.containers_count)!==count)fail('申请或成员已变化，请刷新后重新核对',409);
      const metadata={...parsed(item.official_result_json),local_management:{adopted_at:now().toISOString(),adopted_by:current.personId,container_count:count,member_signature:signature}};
      await connection.execute('UPDATE ogl_dispatch_batches SET official_result_json=? WHERE tenant_id=? AND id=?',[JSON.stringify(metadata),current.id,item.id]);
      await event(connection,current,item.id,'official-adopt',{containers_count:count,physical_dispatch:false});return getDetail(connection,current,item.id);
    });
    return {signature,count,kind:'observed',carriageId:String(ctx.batch.official_carriage_id)};
  }
  async function verifyApprovedDispatch(session,body,ctx) {
    const result=await readOfficial(ctx,ctx.batch.official_carriage_id);
    if(result.info?.carriage_id!=null&&String(result.info.carriage_id)!==String(ctx.batch.official_carriage_id))fail('官方申请号核对失败，请重新查询',502);
    // Refresh the reviewed proof before any physical write. A changed manifest,
    // count or method is persisted as mismatch/pending, never accepted from the
    // old approved snapshot or a client-supplied verification object.
    const checked=await recordOfficial(session,ctx,ctx.batch.official_carriage_id,result);
    if(checked.batch.official_status!=='approved')fail('官方组成、货位数、配送方式或状态已变化，已更新核对结果；请先处理不一致，再登记实际交运',409);
    return {kind:'approved',signature:memberSignature(checked.members),count:Number(checked.batch.containers_count),carriageId:String(checked.batch.official_carriage_id)};
  }
  async function localAction(session, body,verifiedOfficial=null) {
    return transaction(async connection => {
      const current = await scope(connection,session,true); const item=await batch(connection,current,body.batch_id,true);
      if (['cancelled','closed'].includes(item.status)) fail('该批次已结束，不能继续修改',409);
      const all = await members(connection,current,item.id,true);
      let selected = all.filter(row=>row.active);
      if (body.order_ids !== undefined) { const wanted=ids(body.order_ids); selected=selected.filter(row=>wanted.includes(Number(row.order_id))); if(selected.length!==wanted.length) fail('所选订单不属于当前活动批次',409); }
      const action=body.action;
      if(['close','cancel'].includes(action)) selected=all.filter(row=>row.active);
      const why=['withdraw','exception','cancel'].includes(action)?reason(body.reason ?? body.exception_reason):text(body.reason);
      if (action==='assign-tracking') {
        if(!selected.length) fail('请先选择需要分配运单号的订单');
        if(!/^[1-9]\d*$/.test(String(item.official_carriage_id||''))) fail('请先创建或绑定官方发运单，再分配本地运单号',409);
        const trackingNumber=String(body.tracking_number??'').trim();
        if(trackingNumber&&!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(trackingNumber)) fail('运单号只支持 3–128 位字母、数字和 . _ / -，请核对快递标签');
        const cargoType=body.cargo_type||'normal';
        if(!['normal','special'].includes(cargoType))fail('请选择普通货物或特殊货物');
        for(const row of selected){
          if(row.dispatched_at||row.online||row.cancelled)fail('订单已交运或进入平台后续状态，不能重新分配运单号',409);
          if(row.tracking_assignment?.tracking_number===trackingNumber&&row.tracking_assignment?.cargo_type===cargoType)continue;
          await event(connection,current,item.id,'assign-tracking',{tracking_number:trackingNumber||null,cargo_type:cargoType,source:'manual',physical_dispatch:false},row.id,why);
        }
      } else if (action==='assign') {
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
        const marked=selected.filter(row=>!row.dispatched_at&&(text(row.mark_type)||text(row.mark_note)));
        if(marked.length){
          const [reviewEvents]=await connection.execute("SELECT detail_json FROM ogl_dispatch_events WHERE tenant_id=? AND batch_id=? AND action IN ('create','bind-orders') ORDER BY id",[current.id,item.id]);
          const reviewed=Object.assign({},...reviewEvents.map(row=>parsed(row.detail_json).review_signatures||{}));
          if(marked.some(row=>reviewed[row.order_id]!==oglOrderReviewSignature(row)))fail('订单标记或备注尚未复核、或复核后已变化，请重新核对后再确认实际交运',409,'OGL_ORDER_REVIEW_REQUIRED');
        }
        const waiting=row=>row.awaiting_delivery||String(row.platform_status||'')==='acceptance_in_progress'||String(row.tracking_stage||'')==='posting_acceptance_in_progress';
        if(selected.some(row=>row.shop_status!=='active'||!waiting(row)||row.online||row.cancelled||classifyOrderLogistics(row).logistics_carrier!=='ogl')) fail('部分订单已变更平台状态、物流方式或店铺已停用，请先刷新并核实',409);
        const verified=verifiedOfficial&&verifiedOfficial.signature===memberSignature(all)&&verifiedOfficial.count===Number(item.containers_count)
          &&verifiedOfficial.carriageId===String(item.official_carriage_id);
        const observed=item.official_status==='observed'&&parsed(item.official_result_json).local_management?.adopted_at&&verifiedOfficial?.kind==='observed';
        if(!verified||!(item.official_status==='approved'&&verifiedOfficial.kind==='approved'||observed)) fail('请先创建、核对并确认官方发运，或核对并接管已有申请，再显式登记实际交运',409);
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
    return transaction(async connection => { const current = await scope(connection,session,write); const item=await batch(connection,current,batchId); return { current,batch:item,shop:await shop(connection,current,item.default_shop_id,true),members:await members(connection,current,item.id),write,operationToken:item.official_operation_token??null }; });
  }
  async function officialOptions(session, body) {
    if(!api?.deliveryMethods) fail('当前环境未配置 Ozon 发运 API',503);
    const ctx=await context(session,body.batch_id,true);
    const options=await externalDeliveryMethods(ctx,{});
    return { options:options.map(option=>({...option,handover_type:normalizeOglHandoverType(option)})) };
  }
  async function saveOfficial(session,batchId,token,values,actionName,details={}) {
    return transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,batchId,true);
      await shop(connection,current,item.default_shop_id,true);
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
    const result=await externalRequest(ctx,'/v1/carriage/get',{carriage_id:Number(carriageId)});
    const postings=await externalRequest(ctx,'/v2/posting/fbs/act/get-postings',{id:Number(carriageId)});
    const rows=Array.isArray(postings?.result)?postings.result:Array.isArray(postings?.postings)?postings.postings:[];
    // Missing/malformed membership data is not an empty verified official manifest.
    if(!Array.isArray(postings?.result)&&!Array.isArray(postings?.postings)) fail('Ozon 官方组成响应缺少货件列表，不能确认已核对清单',502);
    if(rows.length>2000)fail('官方申请超过 2000 个货件，暂不能完整关联，请拆分后联系管理员核对',409);
    const list=rows.map(row=>({posting_number:text(typeof row==='string'?row:row?.posting_number,128),
      status:text(typeof row==='object'?row?.status:'',64),seller_error:text(typeof row==='object'?row?.seller_error:'',500)}));
    if(list.some(row=>!row.posting_number))fail('Ozon 官方组成响应有缺少货件编号的记录，不能确认完整清单，请在后台核对后同步',502);
    const failed_postings=list.filter(row=>row.seller_error);
    const numbers=list.filter(row=>!row.seller_error).map(row=>row.posting_number);
    const info=result?.result||result;
    if(info?.carriage_id!=null&&String(info.carriage_id)!==String(carriageId)) fail('Ozon 返回的官方发运编号与查询编号不一致，请重新查询',502);
    return { info,numbers,list,failed_postings };
  }
  async function recordOfficial(session,ctx,carriageId,result,token=null) {
    return transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,ctx.batch.id,true);
      await shop(connection,current,item.default_shop_id,true);
      if(ctx.monitorSetting)await verifyMonitorSetting(connection,current,ctx.monitorSetting);
      if(Number(item.default_shop_id)!==Number(ctx.shop.id)) fail('批次默认发运店铺已变更，请重新打开批次',409,'OGL_BATCH_SCOPE_CHANGED');
      if(token ? item.official_operation_token!==token : item.official_operation_token!==ctx.batch.official_operation_token||item.official_status!==ctx.batch.official_status) fail('官方操作已变化，请刷新',409);
      const officialState=text(result.info?.status,32).toLowerCase();
      const membersNow=await members(connection,current,item.id,true);
      for(const member of membersNow) await connection.execute('UPDATE ogl_dispatch_members SET official_member = ? WHERE tenant_id = ? AND id = ?', [Number(Number(member.shop_id)===Number(item.default_shop_id)&&result.numbers.includes(member.posting_number)),current.id,member.id]);
      const localSame=membersNow.filter(row=>row.active&&Number(row.shop_id)===Number(item.default_shop_id)).map(row=>row.posting_number);
      const extra=result.numbers.filter(number=>!localSame.includes(number));
      const missing=localSame.filter(number=>!result.numbers.includes(number));
      const isCancelled=['cancelled','canceled'].includes(officialState);
      // OGL can return formed after confirmation instead of the generic sended
      // state. File capability is only one part of the proof: exact members,
      // delivery method and a positive matching container count are checked below.
      const approved=officialConfirmationObserved(result.info);
      const failed=result.failed_postings||[];
      const exact=!failed.length&&localSame.length===result.numbers.length&&!extra.length&&!missing.length;
      const countValue=result.info?.containers_count;
      const missingCount=countValue==null||countValue==='';
      const actualCount=missingCount?null:Number(countValue);
      const countMismatch=approved&&(missingCount||!Number.isSafeInteger(actualCount)||actualCount<=0||actualCount!==Number(item.containers_count));
      const methodValue=result.info?.delivery_method_id;
      const missingMethod=methodValue==null||methodValue===''||!item.delivery_method_id;
      const methodMismatch=!isCancelled&&(missingMethod||String(methodValue)!==String(item.delivery_method_id));
      const proofMissing=(approved&&missingCount)||missingMethod;
      const nextStatus=isCancelled?'cancelled':proofMissing?'sync_required':!exact||countMismatch||methodMismatch?'mismatch':approved?'approved':item.official_status==='confirming'?'confirm_unknown':officialState==='new'?'created':'sync_required';
      const errors=[];
      if(failed.length&&!isCancelled) errors.push(`官方返回 ${failed.length} 个未成功收录的货件，请先在 Ozon 后台处理明细中的失败原因，再同步核对；不能按整批成功下载或交运`);
      if(!exact&&!isCancelled) errors.push('官方组成与本店所选订单不一致，请在 Ozon 后台修正后重新同步');
      if(countMismatch&&!isCancelled) errors.push(missingCount?`Ozon 未返回官方货位数量（containers_count），本地为 ${item.containers_count} 个；请重新核对官方单，核实前不能下载标签或交运`:`官方货位数量为 ${countValue} 个，本地批次为 ${item.containers_count} 个；请在 Ozon 后台核实并修正后重新同步`);
      if(methodMismatch) errors.push(missingMethod?'官方配送方式（delivery_method_id）或批次配送方式快照缺失，无法证明属于本批次；请重新核对官方单':`官方配送方式为 ${methodValue}，批次配置为 ${item.delivery_method_id}；请核对是否填错官方发运编号`);
      const previous=parsed(item.official_result_json);
      const summary={...(previous.source?{source:previous.source}:{}),capabilities:previous.capabilities,info:result.info,posting_numbers:result.numbers,official_postings:result.list,failed_postings:failed,extra,missing,last_observed_at:now().toISOString(),
        container_count_mismatch:countMismatch,container_count_expected:Number(item.containers_count),container_count_actual:actualCount,
        delivery_method_mismatch:methodMismatch,delivery_method_expected:item.delivery_method_id,delivery_method_actual:methodValue??null,
        cross_shop_local_only:membersNow.filter(row=>row.active&&Number(row.shop_id)!==Number(item.default_shop_id)).map(row=>row.posting_number)};
      if(isCancelled) await connection.execute('UPDATE ogl_dispatch_members SET official_member = 0 WHERE tenant_id = ? AND batch_id = ?',[current.id,item.id]);
      await connection.execute(`UPDATE ogl_dispatch_batches SET official_carriage_id = ?,official_status = ?,official_result_json = ?,official_error = ?,official_operation_token = NULL,
        status = CASE WHEN status = 'preparing' AND ? = 'approved' THEN 'ready' ELSE status END WHERE tenant_id = ? AND id = ?`,[String(carriageId),nextStatus,JSON.stringify(summary),errors.join('；')||null,nextStatus,current.id,item.id]);
      if(isCancelled||nextStatus==='approved') await connection.execute('DELETE FROM ogl_dispatch_official_locks WHERE tenant_id = ? AND batch_id = ?',[current.id,item.id]);
      else if(item.delivery_method_id) await connection.execute(`INSERT INTO ogl_dispatch_official_locks (tenant_id,default_shop_id,delivery_method_id,batch_id,operation_token)
        VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id)`,[current.id,item.default_shop_id,item.delivery_method_id,item.id,token||randomUUID()]);
      await event(connection,current,item.id,'official-sync',{carriage_id:String(carriageId),status:nextStatus,extra,missing,
        official_state:officialState,containers_count:actualCount,delivery_method_id:methodValue??null,
        posting_numbers:result.numbers,failed_postings:failed,official_error:errors.join('；')||null});
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
    const options=await externalDeliveryMethods(ctx,{delivery_method_id:Number(method),departure_date:selectedDay});
    const capability=options.find(row=>String(row.delivery_method_id??row.id)===method&&shanghaiDateKey(row.departure_date)===selectedDay);
    if(!capability) fail('默认店铺当前没有该配送方式与所选日期的可用组合，请重新获取官方发运选项',409);
    assertHandoverSelection(body,capability);
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
      await connection.execute("UPDATE ogl_dispatch_batches SET official_status = 'creating',official_operation_token = ?,delivery_method_id = ?,departure_date = ?,official_result_json = ?,official_error = NULL WHERE tenant_id = ? AND id = ?",[token,method,date,JSON.stringify({capabilities:{has_entrusted_acceptance:true,delivery_method_id:method,departure_date:date,warehouse_id:capability.warehouse_id??null,first_mile_type:capability.first_mile_type??null,integration_type:capability.integration_type??null,handover_type:normalizeOglHandoverType(capability)}}),current.id,item.id]);
      await event(connection,current,item.id,'official-create-start',{delivery_method_id:method,departure_date:date});
    });
    ctx.operationToken=token;
    let carriageId;
    try {
      const response=await externalRequest(ctx,'/v1/carriage/create',{delivery_method_id:Number(method),departure_date:date});
      carriageId=response?.carriage_id??response?.result?.carriage_id;
      if(!carriageId||!/^\d+$/.test(String(carriageId))||Number(carriageId)<=0) throw Object.assign(new Error('Ozon 未返回有效发运编号，需在后台查找后同步，不能直接重建'),{unknown:true});
      // Persist the returned ID before any subsequent network call can fail.
      await saveOfficial(session,ctx.batch.id,token,{official_carriage_id:String(carriageId)},'official-created',{carriage_id:String(carriageId)});
      // Only postings belonging to the authorized creation shop are sent. The
      // physical mixed-shop members remain explicitly local until API support is proven.
      const ownNumbers=ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id)).map(row=>row.posting_number);
      const initial=await readOfficial(ctx,carriageId);
      if(String(initial.info?.status||'').toLowerCase()==='new') {
        const response=await externalRequest(ctx,'/v1/carriage/set-postings',{carriage_id:Number(carriageId),posting_numbers:ownNumbers});
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
    const saved=parsed(ctx.batch.official_result_json);
    if(saved.source==='official_discovery'&&ctx.batch.official_status==='observed') {
      const found=await officialDetail(session,{id:carriageId,date:saved.carriage.departure_date},{ctx,listed:saved.carriage});
      await associateOfficial(session,ctx,found,await discoveryTracking(ctx,found.carriage));
      return detail(session,ctx.batch.id);
    }
    return recordOfficial(session,ctx,carriageId,await readOfficial(ctx,carriageId));
  }
  async function officialConfirm(session,body) {
    const ctx=await context(session,body.batch_id,true);
    if(['closed','cancelled'].includes(ctx.batch.status)) fail('已结束的内部批次不能确认官方发运',409);
    const saved=parsed(ctx.batch.official_result_json);
    const observed=ctx.batch.official_status==='observed'&&saved.source==='official_discovery';
    if((ctx.batch.official_status!=='created'&&!observed)||!ctx.batch.official_carriage_id) fail('请先创建官方发运，并确保官方组成核对一致；结果未知时先同步',409);
    const count=containers(body.container_count===undefined?ctx.batch.containers_count:body.container_count);
    if(ctx.members.some(row=>row.active&&Number(row.container_no)>count)) fail('已有订单分配的货位编号超过本次实际货位数量，请先核对并调整装袋分配，再确认官方单',409,'OGL_CONTAINER_ASSIGNMENT_CONFLICT');
    const verified=await readOfficial(ctx,ctx.batch.official_carriage_id);
    assertHandoverSelection(body,verified.info);
    if(String(verified.info?.status||'').toLowerCase()!=='new') {
      if(observed)fail('此后台申请已不处于待确认 new 状态，请刷新已有申请并核对；不会重复确认或自动接管实际交运',409);
      const current=await recordOfficial(session,ctx,ctx.batch.official_carriage_id,verified);
      if(current.batch.official_status==='approved') return current;
      fail('官方发运已不处于可确认的初始 new 状态，请核对最新官方状态',409);
    }
    let capabilities=saved.capabilities;
    if(observed) {
      const method=text(verified.info?.delivery_method_id,64);
      if(!method||method!==String(ctx.batch.delivery_method_id)) fail('后台待确认申请的官方配送方式与本地快照缺失或不一致，请按原店铺同步后核对',409,'OGL_PENDING_CONFIRMATION_UNVERIFIED');
      const value=saved.carriage?.departure_date||ctx.batch.departure_date;
      const day=/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?String(value):shanghaiDateKey(value);
      if(!day)fail('后台待确认申请缺少可信发运日期，请按原店铺同步后核对',409,'OGL_PENDING_CONFIRMATION_UNVERIFIED');
      const options=await externalDeliveryMethods(ctx,{delivery_method_id:id(method,'官方配送方式'),departure_date:day});
      const option=options.find(row=>String(row.delivery_method_id??row.id)===method&&shanghaiDateKey(row.departure_date)===day);
      if(!option||option.has_entrusted_acceptance!==true)fail('官方当前配送方式未确认支持按货位的信任验收（has_entrusted_acceptance），请在 Ozon 后台核对配置后重新同步；客户端选项不能代替官方证明',409,'OGL_PENDING_CONFIRMATION_UNVERIFIED');
      assertHandoverSelection(body,option);
      capabilities={has_entrusted_acceptance:true,delivery_method_id:method,departure_date:option.departure_date,
        warehouse_id:option.warehouse_id??null,first_mile_type:option.first_mile_type??null,integration_type:option.integration_type??null,handover_type:normalizeOglHandoverType(option)};
    }
    if(capabilities?.has_entrusted_acceptance!==true) fail('批次未保存按货位信任验收能力，不能确认货位数；请核对官方配置',409);
    const same=ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id)).map(row=>row.posting_number);
    if(verified.failed_postings.length||!same.length||same.length!==verified.numbers.length||same.some(number=>!verified.numbers.includes(number))) {
      if(!observed)await recordOfficial(session,ctx,ctx.batch.official_carriage_id,verified);
      if(verified.failed_postings.length)fail(`官方返回 ${verified.failed_postings.length} 个未成功收录的货件，请查看失败货件及原因，在 Ozon 后台处理后重新同步，暂不能确认整批`,409,'OGL_POSTING_REJECTED');
      fail('官方组成已经变化，请核对本店订单清单后再确认',409);
    }
    const contact=body.courier_contact||{};
    let contactPayload=null;
    if(normalizeOglHandoverType(verified.info)==='courier'&&String(verified.info?.integration_type||'').trim().toLowerCase()==='ozon_outsourced') {
      if(!text(contact.phone)) fail('此官方发运为 Ozon 外包上门取件，请在取件联系人区域填写联系电话（phone）后确认货位；自送申请无需填写',400,'OGL_COURIER_CONTACT_REQUIRED');
      const enteredPhone=text(contact.phone,128).replace(/[\s()-]/g,'');
      const phoneDigits=enteredPhone.startsWith('+86')?enteredPhone.slice(3):enteredPhone;
      if(!/^\d{11}$/.test(phoneDigits)) fail('请在联系人区域填写有效的 11 位中国取件联系电话（phone），可带 +86 国家区号');
      const phone=`+86(${phoneDigits.slice(0,3)})${phoneDigits.slice(3,7)}-${phoneDigits.slice(7)}`;
      const wechat=text(contact.wechat_nickname,128),comment=text(contact.comment,1000);
      if(wechat.length>50||comment.length>500) fail('取件微信号不得超过 50 字，备注不得超过 500 字，请在联系人区域修改');
      contactPayload={carriage_id:Number(ctx.batch.official_carriage_id),phone,...(wechat?{wechat_nickname:wechat}:{}),...(comment?{comment}:{})};
    }
    // A previous pickup form may still contain hidden contact values after the
    // operator opens a self-delivery application. They do not change its mode
    // and must never be sent to the pickup-only contact endpoint.
    const token=randomUUID();
    await transaction(async connection=>{
      const current=await scope(connection,session,true); const item=await batch(connection,current,ctx.batch.id,true);
      if(item.official_status!==ctx.batch.official_status||(item.official_operation_token??null)!==ctx.operationToken||observed&&parsed(item.official_result_json).source!=='official_discovery') fail('另一请求已修改官方单，请刷新',409);
      if(item.status!=='preparing') fail('内部批次已交运、取消或结束，不能确认官方发运',409);
      const currentMembers=await members(connection,current,item.id,true);
      const activeIds=list=>list.filter(row=>row.active).map(row=>Number(row.order_id)).sort((a,b)=>a-b).join(',');
      if(activeIds(currentMembers)!==activeIds(ctx.members)||currentMembers.some(row=>row.active&&(!row.awaiting_delivery||classifyOrderLogistics(row).logistics_carrier!=='ogl'))) fail('批次成员或平台物流已变化，请刷新后重新核对官方发运',409);
      if(currentMembers.some(row=>row.active&&Number(row.container_no)>count)) fail('已有订单分配的货位编号超过本次实际货位数量，请先核对并调整装袋分配，再确认官方单',409,'OGL_CONTAINER_ASSIGNMENT_CONFLICT');
      const metadata={...parsed(item.official_result_json),capabilities};
      await connection.execute("UPDATE ogl_dispatch_batches SET containers_count = ?,official_result_json = ?,official_status = 'confirming',official_operation_token = ? WHERE tenant_id = ? AND id = ?",[count,JSON.stringify(metadata),token,current.id,item.id]);
      await event(connection,current,item.id,'official-confirm-start',{containers_count:count,previous_containers_count:Number(item.containers_count)});
    });
    ctx.operationToken=token;
    try {
      if(contactPayload) await externalRequest(ctx,'/v1/carriage/courier-contact/set',contactPayload);
      const response=await externalRequest(ctx,'/v1/carriage/approve',{carriage_id:Number(ctx.batch.official_carriage_id),containers_count:count});
      if(response?.result===false||response?.error) throw new Error('Ozon 未确认发运，请检查官方返回结果');
      return recordOfficial(session,ctx,ctx.batch.official_carriage_id,await readOfficial(ctx,ctx.batch.official_carriage_id),token);
    } catch(error) {
      await saveOfficial(session,ctx.batch.id,token,{official_status:'confirm_unknown',official_error:text(error.message,2000),official_operation_token:null},'official-confirm-error');
      throw error;
    }
  }
  async function refresh(session,body,monitorSetting=null) {
    const ctx=await context(session,body.batch_id,true); if(typeof syncPostings!=='function') fail('当前环境未配置订单物流精确刷新',503);
    const groups=new Map(); for(const row of ctx.members.filter(row=>row.active&&!row.delivered&&!row.cancelled)) { if(!groups.has(Number(row.shop_id))) groups.set(Number(row.shop_id),[]); groups.get(Number(row.shop_id)).push(row); }
    const results=[];
    for(const [shopId,rows] of groups) {
      await transaction(async connection=>{
        const current=await scope(connection,session,true);await shop(connection,current,shopId,true);
        if(monitorSetting)await verifyMonitorSetting(connection,current,monitorSetting);
      });
      let result; let error='';
      try { result=await syncPostings(ctx.current.session,shopId,rows.map(row=>row.posting_number)); }
      catch(failure) { if(monitorAuthorityFailure(failure))throw failure;error=text(failure.message,2000); }
      await transaction(async connection=>{
        const current=await scope(connection,session,true); await batch(connection,current,ctx.batch.id,true);
        await shop(connection,current,shopId,true);
        if(monitorSetting)await verifyMonitorSetting(connection,current,monitorSetting);
        for(const row of rows) {
          const observed=result?.rows?.find(item=>item.posting_number===row.posting_number&&Number(item.shop_id)===shopId&&item.found!==false);
          const issue=error||(!observed?'未取得该订单的最新物流，请稍后刷新或检查来源店铺授权':'');
          await connection.execute(`UPDATE ogl_dispatch_members SET sync_error = ?,last_refresh_attempt_at = ?,last_synced_at = CASE WHEN ? = '' THEN ? ELSE last_synced_at END WHERE tenant_id = ? AND id = ?`,[issue||null,timestamp(),issue,timestamp(),current.id,row.id]);
          results.push({order_id:row.order_id,ok:!issue,error:issue});
        }
      });
    }
    await transaction(async connection=>{const current=await scope(connection,session,true); await batch(connection,current,ctx.batch.id,true);
      if(monitorSetting)await verifyMonitorSetting(connection,current,monitorSetting);
      if(results.every(row=>row.ok)) await connection.execute('UPDATE ogl_dispatch_batches SET last_refreshed_at = ? WHERE tenant_id = ? AND id = ?',[timestamp(),current.id,ctx.batch.id]);
      await event(connection,current,ctx.batch.id,'refresh',{results});
    });
    const result=await detail(session,ctx.batch.id); return {...result,refresh_results:results};
  }
  async function action(session,body={}) {
    let result;
    if(body.action==='refresh') result=await refresh(session,body);
    else if(body.action==='bind-orders') result=await bindOrders(session,body);
    else if(body.action==='official-options') return officialOptions(session,body);
    else if(body.action==='official-create') result=await officialCreate(session,body);
    else if(body.action==='official-confirm') result=await officialConfirm(session,body);
    else if(body.action==='official-sync') result=await officialSync(session,body);
    else if(body.action==='official-adopt')result=await verifyObservedManagement(session,body,true);
    else {
      let verified=null;
      if(body.action==='dispatch') {
        const ctx=await context(session,body.batch_id,true);
        if(ctx.batch.official_status==='observed')verified=await verifyObservedManagement(session,body);
        else if(ctx.batch.official_status==='approved'&&ctx.batch.official_carriage_id)verified=await verifyApprovedDispatch(session,body,ctx);
      }
      result=await localAction(session,body,verified);
    }
    invalidateWorkflowCaches(); return result;
  }
  async function file(session,queryOrId,typeArg) {
    const query=typeof queryOrId==='object'?queryOrId:{batch_id:queryOrId,type:typeArg};
    const ctx=await context(session,query.batch_id);
    const path={'container-labels':'/v2/posting/fbs/act/get-container-labels',barcode:'/v2/posting/fbs/act/get-barcode'}[query.type];
    if(!path) fail('文件类型必须为货位标签或发运条码');
    if(!ctx.batch.official_carriage_id)fail('官方申请号尚未取得，请先刷新申请详情',409);
    const observed=ctx.batch.official_status==='observed'&&parsed(ctx.batch.official_result_json).source==='official_discovery';
    if(!observed&&ctx.batch.official_status!=='approved')fail('官方发运尚未核实确认，暂不能下载有效标签',409);
    const response=observed?await externalRequest(ctx,'/v1/carriage/get',{carriage_id:Number(ctx.batch.official_carriage_id)}):null;
    const result=observed?{info:response?.result||response}:await readOfficial(ctx,ctx.batch.official_carriage_id);
    const info=result.info;
    if(info?.carriage_id!=null&&String(info.carriage_id)!==String(ctx.batch.official_carriage_id))fail('官方申请号核对失败，请重新查询',502);
    if(!observed) {
      const count=optionalCount(info?.containers_count);
      const same=ctx.members.filter(row=>row.active&&Number(row.shop_id)===Number(ctx.batch.default_shop_id)).map(row=>row.posting_number);
      if(result.failed_postings.length||!officialConfirmationObserved(info)||!count||count!==Number(ctx.batch.containers_count)
        ||!info?.delivery_method_id||String(info.delivery_method_id)!==String(ctx.batch.delivery_method_id)
        ||same.length!==result.numbers.length||same.some(number=>!result.numbers.includes(number)))
        fail('官方组成、实际货位数量、配送方式或确认状态已变化，请先同步官方发运并核对后重新下载标签',409,'OGL_FILE_CONFIRMATION_CHANGED');
    }
    const capability=oglFileCapabilities(info)[query.type==='container-labels'?'container_labels':'barcode'];
    if(capability.available!==true)fail(capability.reason,409,capability.available===false?'OGL_FILE_UNSUPPORTED':'OGL_FILE_CAPABILITY_UNKNOWN');
    ctx.requiredOfficialStatus=ctx.batch.official_status;
    const fileResult=await externalRequest(ctx,path,{id:Number(ctx.batch.official_carriage_id)},{binary:true});
    if(!fileResult?.buffer) fail('Ozon 尚未生成文件，请稍后重试',502);
    const extension=fileResult.contentType==='image/png'?'png':fileResult.contentType==='image/jpeg'?'jpg':'pdf';
    return {...fileResult,filename:`${ctx.batch.batch_number}-${query.type}.${extension}`};
  }
  return {bootstrap,saveSettings,preview,candidates,createBatch,listBatches,detail,listOfficial,officialDetail,officialTracking,discover,monitorRecent,action,file};
}
