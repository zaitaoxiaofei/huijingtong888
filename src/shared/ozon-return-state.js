// Source: Ozon for developers, /community/1105-Statusy-vozvratov/;
// observed Seller API state/state_name pairs. Workflow labels never post money or stock.
const registry = {};
function register(codes, status, label, group, {refund='unknown',goods='unknown',rank=1,owner='none',next='无需在 ERP 手动确认，系统会继续同步 Ozon 的进度。'}={}) {
  for(const code of codes) registry[code]=Object.freeze({status,label,group,refund,goods,rank,action_owner:owner,next_action:next});
}
register(['MoneyReturned','MoneyReturnedBySystem'],'refunded','已退款','refunded',{refund:'returned',rank:5});
register(['Utilized','UtilizedByOzon'],'disposed','退货已销毁','disposed',{goods:'disposed',rank:6,next:'官方已记录销毁，无需再次确认销毁；货损与退款金额以账单和凭证核对。'});
register(['Utilizing','UtilizingByOzon'],'disposing','退货销毁中','disposing',{goods:'disposing',rank:4});
register(['ArrivedAtWarehouse','ReturnedToOzon'],'returned_to_warehouse','退货已到仓','return_received',{goods:'warehouse',rank:3,next:'官方记录退货已到仓；是否可重新销售、是否已入我方库存，需要仓库凭证，不能仅凭此状态恢复库存。'});
register(['ReceivedBySeller'],'return_received','退货已收货','return_received',{goods:'received_by_seller',rank:3,next:'官方记录卖家已收货；重新入库和可售数量以仓库验收凭证为准。'});
register(['OnWay','MovingToSeller','ReturningToSellerByCourier','MovingToOzon'],'return_in_transit','退货运输中','return_transit',{rank:2});
register(['ArrivedAtReturnPlace'],'awaiting_pickup','退货到取货点','return_transit',{owner:'seller',next:'请到 Ozon 查看取货地点和要求，按官方通知安排取回。'});
register(['Approved','ApprovedByOzon','WaitingShipment'],'return_approved','退货已同意，等待退回','return_transit');
register(['PartialCompensationReturned','PartialCompensationReturnedByOzon'],'partial_compensation','已部分退款／补偿','partial_compensation',{refund:'partial',rank:2});
register(['ReturnMoneyApproved'],'refund_processing','退款已同意，等待到账','platform_processing',{refund:'approved'});
register(['PartialCompensationInProcess'],'refund_processing','部分退款处理中','platform_processing',{refund:'partial_approved'});
register(['OfferedPartialCompensation'],'awaiting_buyer','等待买家回复补偿方案','platform_processing');
register(['CheckingStatus'],'platform_checking','Ozon 核查中','platform_processing',{next:'Ozon 正在核查进度，无需在 ERP 确认已退货；如收到平台补充资料通知，请按通知处理。'});
register(['DisputeOpened','DisputeYouOpened','DisputeOpening'],'dispute_processing','售后争议处理中','platform_processing',{next:'请关注 Ozon 争议进度和平台消息；此状态不代表退款或退货已经完成。'});
register(['OnSellerApproval'],'seller_action_required','待卖家处理申请','seller_action',{owner:'seller',next:'请到 Ozon 查看退货申请并按平台要求处理，ERP 不会替你同意或拒绝申请。'});
register(['OnSellerClarification','OnSellerClarificationAfterPartialCompensation'],'seller_action_required','待卖家补充信息','seller_action',{owner:'seller',next:'Ozon 要求卖家补充信息。请打开此申请查看具体要求并回复，不需要在 ERP 确认“已退货”。'});
register(['CompensationOffered'],'seller_action_required','待卖家处理赔付方案','seller_action',{owner:'seller',next:'请到 Ozon 查看赔付方案并按官方要求作出选择。'});
register(['WaitingCompensation'],'compensation_processing','等待平台赔付','platform_processing');
register(['ReturnCompensated'],'seller_compensated','卖家已获赔付','compensated',{rank:2,next:'官方记录赔付已完成，金额和入账以财务账单为准；不等于货物已恢复库存。'});
register(['CompensationRejected','CompensationRejectedBySla','CompensationRejectedBySeller'],'compensation_closed','赔付申请已结束','platform_processing',{next:'请到 Ozon 查看赔付拒绝或超时的具体原因；这不等于买家的退款已完成。'});
register(['SendingError'],'platform_error','平台申请发送异常','seller_action',{owner:'seller',next:'请到 Ozon 查看申请发送失败原因，按平台提示重试或联系支持。'});
register(['Solved'],'closed_without_return','售后已答复','closed',{rank:0,next:'此记录只说明申请已答复，不足以证明已经退款或退回商品。'});
register(['Cancelled'],'request_cancelled','退货申请已取消','closed',{rank:0,next:'买家已取消这次申请，无需确认退货；其他申请和退款以各自记录为准。'});
register(['Rejected','CrmRejected','CancelledDisputeNotOpen'],'request_rejected','退货申请已拒绝','closed',{rank:0,next:'此申请已被拒绝，不作为已退款或已退货处理。'});
export const OZON_RETURN_STATES = Object.freeze(registry);
export const OZON_AFTERSALE_FILTER_OPTIONS = Object.freeze([
  ['all','全部售后进度'],['refunded','已退款'],['partial_compensation','部分退款／补偿'],
  ['return_transit','等待退回／运输中'],['return_received','已到仓／已收货'],['disposing','销毁中'],['disposed','已销毁'],
  ['platform_processing','Ozon／买家处理中'],['seller_action','需要我在 Ozon 处理'],['compensated','卖家已获赔付'],['system_review','系统待识别']
].map(([value,label])=>Object.freeze({value,label})));
export function ozonReturnState(record={}) {
  const officialState=String(record.state?.state??record.official_state??'').trim();
  const known=registry[officialState];
  return {official_state:officialState,...(known||{status:'possible_return',label:'售后状态待识别',group:'system_review',refund:'unknown',goods:'unknown',rank:1,action_owner:'system',next_action:'系统尚未识别 Ozon 返回的状态，需要核对映射；不需要你猜测或确认已退货。可查看官方申请了解当前进度。'}),needs_review:!known||known.action_owner==='seller'};
}
export function summarizeOzonReturns(records=[]) {
  const observations=records.map(record=>({...record,...ozonReturnState(record)}));if(!observations.length)return null;
  observations.sort((a,b)=>b.rank-a.rank||String(b.created_at||'').localeCompare(String(a.created_at||'')));
  const first=observations[0],needsAction=observations.some(r=>r.action_owner==='seller');
  return {status:first.status,label:first.label,group:first.group,needs_review:observations.some(r=>r.needs_review),
    requires_user_action:needsAction,system_review:observations.some(r=>r.action_owner==='system'),
    next_action:needsAction?'有申请需要卖家在 Ozon 处理，请查看下方每笔申请的要求。':first.next_action,
    refund_confirmed:observations.some(r=>r.refund==='returned'),partial_compensation:observations.some(r=>r.refund==='partial'),
    goods:observations.find(r=>r.goods!=='unknown')?.goods||'unknown',return_ids:[...new Set(observations.map(r=>String(r.return_id)))],
    official_states:[...new Set(observations.map(r=>r.official_state))],refund_completed_at:null,observations};
}
export function ozonReturnFilterSql(scope,kind='aftersale',orderAlias='o',stage='all') {
  if(!Number.isSafeInteger(scope?.id)||scope.id<=0||!/^\w+$/.test(orderAlias))throw Error('Invalid return tenant scope');
  if(!OZON_AFTERSALE_FILTER_OPTIONS.some(x=>x.value===stage))throw Object.assign(Error('售后进度筛选无效，请从售后进度列表重新选择。'),{statusCode:400});
  const list=codes=>codes.map(x=>`'${x}'`).join(',');
  const known=Object.keys(registry),closed=known.filter(k=>registry[k].group==='closed'),seller=known.filter(k=>registry[k].action_owner==='seller');
  const unknown=`r.official_state NOT IN (${list(known)})`;
  let condition=kind==='possible_return'?`(${unknown} OR r.official_state IN (${list(seller)}))`:`r.official_state NOT IN (${list(closed)})`;
  if(stage!=='all')condition+=` AND (${stage==='system_review'?unknown:`r.official_state IN (${list(known.filter(k=>stage==='seller_action'?registry[k].action_owner==='seller':registry[k].group===stage))})`})`;
  return `EXISTS (SELECT 1 FROM ozon_return_observations r WHERE r.tenant_id=${scope.id} AND r.order_id=${orderAlias}.id AND r.shop_id=${orderAlias}.shop_id AND BINARY r.posting_number=BINARY ${orderAlias}.posting_number AND ${condition})`;
}
export function ozonReturnOfficialUrl(record={}) {
  return /\/returns\/rfbs\//.test(String(record.source_endpoint||''))&&/^[1-9]\d*$/.test(String(record.return_id||''))
    ?`https://seller.ozon.ru/app/returns/details/rfbs/${record.return_id}`:'https://seller.ozon.ru/app/returns/main';
}
