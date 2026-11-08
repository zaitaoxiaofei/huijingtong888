export function collectionDayState(day,instanceId=''){
 if(day?.status==='complete'){
  const ids=day.progress?.collector_instance_ids||[];
  return {kind:'complete',label:ids.length&&instanceId&&!ids.includes(instanceId)?'其他浏览器已同步':'已入库',detail:day.product_count===null||day.product_count===undefined?'':`${day.product_count} 个SKU`};
 }
 const p=day?.progress;
 if(day?.status==='failed'||day?.status==='partial')return {kind:'failed',label:day.status==='partial'?'未覆盖完整':'采集失败',detail:day.message||'可重新采集'};
 if(p?.active_requests>0)return {kind:'running',label:'采集中',detail:`${p.completed_requests} / ${p.total_requests} 个请求完成`};
 if(p?.total_requests>0&&p.completed_requests===p.total_requests)return {kind:'publishing',label:'采集完成，待入库',detail:'尚未确认为完整日数据'};
 if(p?.cancelled_requests>0)return {kind:'failed',label:'采集已取消',detail:'尚未确认为完整日数据，可重新启动'};
 if(p?.stale_requests>0)return {kind:'stale',label:'领取已超时，等待重试',detail:'不计为正在采集'};
 if(p?.failed_requests>0)return {kind:'failed',label:'部分请求失败',detail:`${p.failed_requests} 个失败请求`};
 if(p?.completed_requests>0)return {kind:'running',label:'已采部分数据',detail:`${p.completed_requests} / ${p.total_requests} 个请求完成`};
 if(day?.status==='pending')return {kind:'queued',label:'已排队，等待插件领取',detail:'尚未开始采集'};
 return {kind:'missing',label:'未采集',detail:''};
}
export function verifiedCollectionShop(shops,selection,identity){
 if(!identity?.ok||!identity.companyId)throw new Error('本机尚未验证当前Ozon店铺，请先识别并打开对应分析页');
 const shop=shops.find(s=>String(s.store_id)===String(identity.companyId));
 if(!shop)throw new Error('本机Ozon店铺不属于当前企业已配置店铺，不能发起采集');
 if(selection!=='all'&&String(selection)!==String(shop.id))throw new Error(`请先在Ozon后台切换到ERP所选店铺，再点击重新识别；本机当前是${shop.name}`);
 return shop;
}
