const fail=message=>Object.assign(new Error(message),{code:'OZON_RETURNS_INCOMPLETE'});
const pick=(x,keys)=>x&&typeof x==='object'?Object.fromEntries(keys.filter(k=>x[k]!==undefined).map(k=>[k,x[k]])):null;
export function safeOzonReturn(x,endpoint) {
  const id=x?.return_id??x?.id;
  const posting=x?.posting_number??x?.posting?.posting_number;
  if(!['string','number'].includes(typeof id)||!String(id).match(/^[1-9]\d*$/)||!posting
    || (typeof id==='number'&&!Number.isSafeInteger(id)))throw fail('Ozon退货编号或订单编号无效，停止本店同步');
  return {return_id:String(id),posting_number:String(posting),source_endpoint:endpoint,
    created_at:x.created_at||null,state:pick(x.state,['state','state_name','group_state','money_return_state_name']),
    product:pick(x.product,['sku','offer_id','name','quantity','price','currency_code']),
    visual:pick(x.visual,['status','status_name','change_moment'])};
}
// Complete both lists before callers can persist any observation for this shop.
export async function fetchOzonReturns(shop,{request,beforeRequest,signal,maxPages=100}={}) {
  if(typeof request!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw fail('退货读取参数无效');
  const rows=[],keys=new Map();let requests=0;
  for(const endpoint of ['/v2/returns/rfbs/list','/v1/returns/list']) {
    let cursor=0;const cursors=new Set();
    for(let page=0;page<maxPages;page++) {
      signal?.throwIfAborted();const authorized=await beforeRequest?.(shop)||shop;
      const body=await request(endpoint,{filter:{},limit:500,last_id:cursor},{shop:authorized,signal,beforeRequest});requests++;
      signal?.throwIfAborted();const data=Array.isArray(body?.returns)?body:body?.result;
      if(!Array.isArray(data?.returns))throw fail('Ozon退货列表结构变化，未将读取失败视为无退货');
      for(const item of data.returns){const row=safeOzonReturn(item,endpoint),key=endpoint+':'+row.return_id;
        const fingerprint=JSON.stringify(row);if(keys.has(key)){if(keys.get(key)!==fingerprint)throw fail('Ozon退货记录重复且状态冲突，请重试');continue;}keys.set(key,fingerprint);rows.push(row);}
      if(data.has_next===false||(data.has_next==null&&data.returns.length<500))break;
      const next=data.last_id??data.returns.at(-1)?.return_id??data.returns.at(-1)?.id;
      if(next==null||String(next)===String(cursor)||cursors.has(String(next)))throw fail('Ozon退货分页游标未前进');
      if(page+1===maxPages)throw fail('Ozon退货分页超过上限，本店未保存不完整结果');
      cursors.add(String(next));cursor=next;
    }
  }
  return {rows,requests,complete:true};
}
