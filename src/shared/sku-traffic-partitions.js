// These filter names and tree levels are verified against the Seller graphs API.
export function trafficCategoryPartitions(response) {
 const tree=response?.result;
 if(!tree||Array.isArray(tree)||typeof tree!=='object')throw Error('店铺类目树格式无效，保留部分采集状态');
 let count=0;
 function nodes(source,level=0){
  if(level>2||!source||typeof source!=='object'||Array.isArray(source))throw Error('店铺类目树层级异常');
  return Object.values(source).map(node=>{
   if(++count>5000)throw Error('店铺类目树过大');
   const id=String(level===2?node.descriptionTypeId:node.descriptionCategoryId);
   if(!/^[1-9]\d*$/.test(id))throw Error('店铺类目编号无效');
   return {id,level,children:level<2?nodes(node.nodes||{},level+1):[]};
  });
 }
 const roots=nodes(tree);if(!roots.length)throw Error('店铺类目树为空，不能证明全店覆盖');return roots;
}
export function trafficPartitionFilters(node) {
 const filters={desc_type_ids:[],category_3_ids:[],category_2_ids:[]};
 filters[['category_2_ids','category_3_ids','desc_type_ids'][node.level]]=[node.id];return filters;
}
export function dailyPartitionCoverage(run) {
 const pages=(run.requests||[]).filter(r=>r.source_key==='all_metrics'&&r.endpoint_type==='by_sku'&&!r.partition_replaced);
 const expected=run.daily_partition_leaves;
 if(!Array.isArray(expected)||!expected.length)return {ok:false,error:'分批采集计划不完整'};
 if(pages.some(p=>!expected.includes(p.partition_key)))return {ok:false,error:'分批采集包含计划外页面'};
 let complete=true;const ids=[];let expectedRows=0;
 for(const key of expected){
  const chain=pages.filter(p=>p.partition_key===key).sort((a,b)=>a.page_index-b.page_index);
  if(!chain.length)return {ok:false,error:'分批采集缺少类目分区'};
  for(const [index,page] of chain.entries()){
   const limit=Number(page.limit||30);
   if(page.status!=='success'||page.page_index!==index||!page.auto_all_pages||!page.snapshot_id||!Number.isInteger(page.returned_count)||page.returned_count<0||page.returned_count>limit||(index<chain.length-1&&page.returned_count!==limit))return {ok:false,error:'类目分区分页不完整'};
   ids.push(page.snapshot_id);expectedRows+=page.returned_count;
  }
  const last=chain.at(-1);if(last.reported_has_more||last.returned_count>=Number(last.limit||30))complete=false;
 }
 return {ok:true,complete,snapshotIds:ids,expectedRows};
}
export function reconcileDailyTotals(rows,totals){
 const metric=totals?.metrics||totals?.result?.metrics;
 if(!metric)throw Error('缺少全店汇总，无法核验分区覆盖');
 for(const key of ['total_views','search_views','pdp_views','total_hits_to_cart','ordered_units']){
  const alias=key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
  const raw=metric[key]??metric[alias],value=raw&&typeof raw==='object'?raw.value:raw;
  if(value===null||value===undefined||!Number.isFinite(Number(value))||rows.some(r=>r[key]===null||r[key]===undefined)||Math.abs(rows.reduce((n,r)=>n+Number(r[key]),0)-Number(value))>.01)throw Error('分区SKU指标与全店汇总不一致，保留原完整数据，请重新补采');
 }
}
