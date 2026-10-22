const ONLINE = /(^|\s)(delivering|delivered|posting_delivered|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^\s]*|posting_in_courier_service|posting_in_pickup_point|posting_received_by_buyer)(\s|$)/;
const TERMINAL = /cancel|return|reject|not_accepted|arbitration|dispute/;

function platformText(order = {}) {
  return [order.order_status ?? order.platform_status ?? order.status,
    order.order_tracking_stage ?? order.tracking_stage, order.substatus,
    order.order_logistics_status ?? order.logistics_status].map(value => String(value || '').toLowerCase()).join(' ');
}

export function isOglPlatformOnline(order = {}) {
  const text = platformText(order);
  return !TERMINAL.test(text) && ONLINE.test(text);
}

export function hasOglPlatformHandover(order = {}) {
  const text = platformText(order);
  return isOglPlatformOnline(order) || /(^|\s)(driver_pickup|posting_driver_pick_up|posting_received|posting_acceptance_in_progress)(\s|$)/.test(text);
}

export function oglOrderDisplayStatus(order = {}, member = order.ogl_dispatch) {
  if (order.logistics_carrier && order.logistics_carrier !== 'ogl') return '';
  if (!member || !(member.dispatched_at || member.tracking) || member.withdrawn_at || TERMINAL.test(platformText(order)) || isOglPlatformOnline(order)) return '';
  return 'ogl_dispatched';
}

function oglPlatformDisplayStatus(order, member) {
  if (!member.tracking || member.withdrawn_at || (order.logistics_carrier && order.logistics_carrier !== 'ogl')) return '';
  const text = platformText(order);
  if (/cancel|return|reject|not_accepted/.test(text)) return 'cancelled';
  if (/arbitration|dispute/.test(text)) return 'dispute';
  if (/(^|\s)(delivered|posting_delivered|posting_received_by_buyer)(\s|$)/.test(text)) return 'delivered';
  return isOglPlatformOnline(order) ? 'delivering' : '';
}

export function withOglDispatch(order, member) {
  if (!member) return order;
  const active=!member.withdrawn_at&&(member.active_order_id === undefined || Number(member.active_order_id) === Number(order.id));
  const applied=Boolean(active&&Number(member.official_member)===1&&member.official_carriage_id
    &&Number(member.default_shop_id)===Number(order.shop_id)&&!['cancelled','closed'].includes(member.batch_status)
    &&['observed','created','approved','sync_required','confirm_unknown','mismatch'].includes(member.official_status));
  const dispatch = {
    batch_id: Number(member.batch_id), batch_number: member.batch_number || '',
    container_no: member.container_no == null ? null : Number(member.container_no),
    dispatched_at: member.dispatched_at || null, withdrawn_at: member.withdrawn_at || null,
    dispatched: Boolean(member.dispatched_at && active), applied,
    tracking: Boolean(active&&(member.dispatched_at||applied)),
    exception_code: member.exception_code || '', exception_note: member.exception_note || '',
    official_member: Boolean(member.official_member)
  };
  const status = oglPlatformDisplayStatus(order, dispatch) || (dispatch.tracking?oglOrderDisplayStatus(order, dispatch):'');
  dispatch.stage=status==='delivered'?'delivered':status==='cancelled'||status==='dispute'?'cancelled':status==='delivering'?'in_transit':dispatch.dispatched?'dispatched':applied?'applied':'preparing';
  dispatch.stage_label={delivered:'已签收',cancelled:'平台已取消或异常',in_transit:'运输中',dispatched:'已实际交运',applied:'已申请·待交接',preparing:'准备中'}[dispatch.stage];
  return { ...order, ogl_dispatch: dispatch, ...(status ? { display_status: status } : {}) };
}

// Only validated OGL members can create this evidence. Match the source shop
// ownership as well as the batch tenant so damaged references cannot cross it.
export function oglPhysicalDispatchSql(alias = 'o') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid order alias');
  return `EXISTS (SELECT 1 FROM ogl_dispatch_members ogl_member
    JOIN ogl_dispatch_batches ogl_batch ON ogl_batch.id = ogl_member.batch_id AND ogl_batch.tenant_id = ogl_member.tenant_id
    JOIN shops ogl_shop ON ogl_shop.id = ${alias}.shop_id
    JOIN tenants ogl_tenant ON ogl_tenant.id = ogl_member.tenant_id
    WHERE ogl_member.order_id = ${alias}.id AND ogl_member.active_order_id = ${alias}.id
      AND ogl_member.shop_id = ${alias}.shop_id
      AND ogl_member.dispatched_at IS NOT NULL AND ogl_member.withdrawn_at IS NULL
      AND (ogl_shop.tenant_id = ogl_member.tenant_id OR (ogl_shop.tenant_id IS NULL AND ogl_tenant.slug = 'default')))`;
}

export function oglDispatchedStatusSql(alias = 'o') {
  const evidence = `(${oglPhysicalDispatchSql(alias)} OR ${oglAppliedDispatchSql(alias)})`;
  const text = `LOWER(CONCAT_WS(' ', ${alias}.status, ${alias}.tracking_stage, ${alias}.logistics_status))`;
  return `(${evidence} AND ${text} NOT REGEXP 'cancel|return|reject|not_accepted|arbitration|dispute'
    AND ${text} NOT REGEXP '(^| )(delivering|delivered|posting_delivered|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^ ]*|posting_in_courier_service|posting_in_pickup_point|posting_received_by_buyer)( |$)')`;
}

// Application tracking is a display/filter boundary only. It must never be
// substituted for oglPhysicalDispatchSql in inventory or procurement evidence.
export function oglAppliedDispatchSql(alias = 'o') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid order alias');
  return `EXISTS (SELECT 1 FROM ogl_dispatch_members ogl_member
    JOIN ogl_dispatch_batches ogl_batch ON ogl_batch.id=ogl_member.batch_id AND ogl_batch.tenant_id=ogl_member.tenant_id
    JOIN shops ogl_shop ON ogl_shop.id=${alias}.shop_id JOIN tenants ogl_tenant ON ogl_tenant.id=ogl_member.tenant_id
    WHERE ogl_member.order_id=${alias}.id AND ogl_member.active_order_id=${alias}.id AND ogl_member.shop_id=${alias}.shop_id AND ogl_member.posting_number=${alias}.posting_number
      AND ogl_member.withdrawn_at IS NULL AND ogl_member.official_member=1
      AND ogl_batch.default_shop_id=ogl_member.shop_id AND ogl_batch.official_carriage_id IS NOT NULL
      AND ogl_batch.status NOT IN ('cancelled','closed')
      AND ogl_batch.official_status IN ('observed','created','approved','sync_required','confirm_unknown','mismatch')
      AND (ogl_shop.tenant_id=ogl_member.tenant_id OR (ogl_shop.tenant_id IS NULL AND ogl_tenant.slug='default')))`;
}

export function oglOnlineStatusSql(alias = 'o') {
  const evidence = `(${oglPhysicalDispatchSql(alias)} OR ${oglAppliedDispatchSql(alias)})`;
  const text = `LOWER(CONCAT_WS(' ', ${alias}.status, ${alias}.tracking_stage, ${alias}.logistics_status))`;
  return `(${evidence} AND ${text} NOT REGEXP 'cancel|return|reject|not_accepted|arbitration|dispute'
    AND ${text} REGEXP '(^| )(delivering|delivered|posting_delivered|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^ ]*|posting_in_courier_service|posting_in_pickup_point|posting_received_by_buyer)( |$)')`;
}

export function oglTerminalStatusSql(alias = 'o') {
  const evidence = `(${oglPhysicalDispatchSql(alias)} OR ${oglAppliedDispatchSql(alias)})`;
  const text = `LOWER(CONCAT_WS(' ', ${alias}.status, ${alias}.tracking_stage, ${alias}.logistics_status))`;
  return `(${evidence} AND ${text} REGEXP 'cancel|return|reject|not_accepted|arbitration|dispute|(^| )(delivered|posting_delivered|posting_received_by_buyer)( |$)')`;
}
