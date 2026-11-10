const marks={
  quality:{label:'质检单',color:'red'},urgent:{label:'紧急订单',color:'red'},
  follow:{label:'待跟进',color:'orange'},issue:{label:'有问题',color:'yellow'},
  solved:{label:'已解决',color:'green'},vip:{label:'重要客户',color:'cyan'},
  special:{label:'特殊处理',color:'purple'},other:{label:'其他',color:'gray'}
};
export function orderHandlingContext(row={}){
  const has=key=>Object.prototype.hasOwnProperty.call(row,key);
  const mark=String(row.mark_type||'').trim();
  return {
    printed:!!row.printed_at,
    printLabel:has('printed_at')?(row.printed_at?'已打印':'未打印'):'打印待核',
    markLabel:mark?(marks[mark]?.label||`其他标记（${mark}）`):(has('mark_type')?'无标记':'标记待核'),
    markColor:marks[mark]?.color||'gray',
    marked:!!mark,
    note:String(row.mark_note??row.manual_note??'').trim()
  };
}

export function orderHandlingRow(orders=[],row={}){
  if(Number(row.order_id)>0)return orders.find(order=>Number(order.order_id)===Number(row.order_id))||row;
  if(Number(row.order_item_id)>0)return orders.find(order=>Number(order.order_item_id)===Number(row.order_item_id))||row;
  const matches=orders.filter(order=>row.posting_number&&order.posting_number===row.posting_number&&(!row.shop_id||Number(row.shop_id)===Number(order.shop_id)));
  return new Set(matches.map(order=>Number(order.order_id))).size===1?matches[0]:row;
}
