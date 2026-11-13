import {createHash} from 'node:crypto';
import {findWbCard} from './wb-find-card.js';
import {createWbPublishFlow,assertWbPublishToken} from './wb-publish-flow.js';
import {wbListingVariants,wbPayloadVendorCodes} from '../shared/wb-listing-variants.js';
import {wbUpdatedCard,wbExistingFingerprint} from '../shared/wb-existing-card.js';
import {inspectWbPublishMedia} from './wb-publish-media.js';
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw fail('请选择有效的上架记录或草稿。',400);return n;};
export function createWbProductOperations({query,transaction,request,account,listing,actorId,enabled=true,inspectMedia=inspectWbPublishMedia,verifyToken=assertWbPublishToken,now=Date.now}){
 const flow=createWbPublishFlow({query,transaction,request,account,listing,actorId,enabled,inspectMedia,verifyToken,now,jobTable:'wb_product_operations'});
 async function source(tenantId,body){if(!enabled)throw fail('WB 商品操作暂未开放。');const [job]=await query('SELECT * FROM wb_publish_jobs WHERE id=? AND tenant_id=?',[id(body.source_job_id),id(tenantId)]);if(!job)throw fail('上架记录不存在或不属于当前企业。',404);const a=await account(tenantId,job.shop_id);verifyToken(a,{prices:body.action!=='archive'});if(a.environment!==job.environment||(a.seller_id||'')!==(job.seller_id||''))throw fail('原记录店铺环境或卖家身份已变化，请重新检查授权。');return{a,job};}
 async function prepare(tenantId,body){
  const{a,job}=await source(tenantId,body),action=body.action;if(!['archive','republish'].includes(action))throw fail('请选择归档或恢复原商品。',400);
  const [draft]=await query('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=?',[id(body.draft_id||job.draft_id),a.tenant_id,a.shop_id]);if(!draft)throw fail('请先保存当前店铺的商品草稿。',404);
  const original=parse(job.payload_json),originalRows=wbListingVariants(original),desired=parse(draft.payload_json),rows=wbListingVariants(desired),state=parse(job.state_json),targets=[],errors=[];
  if(action==='republish'&&(rows.length!==originalRows.length))errors.push('恢复原商品需保留原类目和商品组合；换类目或调整组合请选择按新品上架。');
  const schema=action==='republish'?await request(a,'content',`/content/v2/object/charcs/${desired.subject_id}`,{query:{locale:'zh'}}):null;
  for(const[index,row]of originalRows.entries()){
   const nm=state.items?.[index]?.nm_id,live=await findWbCard(request,a,row.card.vendorCode,{nmId:nm,matchById:true}),trashed=live?null:await findWbCard(request,a,row.card.vendorCode,{nmId:nm,trash:true,matchById:true}),card=live||trashed;
   if(!card)throw fail('WB 尚未返回此商品卡，请先在原上架记录继续核对；不会重复创建商品。');
   if(nm&&Number(card.nmID)!==Number(nm)||row.card.sizes.flatMap(s=>s.skus||[]).some(b=>!card.sizes?.some(s=>s.skus?.includes(b))))throw fail('WB 商品编号、类目或条码与原记录不一致，未执行平台写入。');
   const target={nm_id:card.nmID,vendor_code:card.vendorCode,location:live?'live':'trash',before_hash:wbExistingFingerprint(card),before_version:createHash('sha256').update(JSON.stringify([card.subjectID,card.updatedAt,card.photos,card.video,card.trashedAt,card.imtID])).digest('hex'),before_card:card};
   if(action==='republish'&&Number(card.subjectID)!==Number(desired.subject_id))errors.push('恢复原商品的类目需与 WB 当前类目一致；更换类目请选择按新品上架。');
   if(action==='republish'&&rows[index]){try{target.update_card=wbUpdatedCard(card,rows[index].card,schema.data||[]);}catch(e){errors.push(e.message);}}
   if(action==='republish'&&rows[index]){const r=await request(a,'prices','/api/v2/list/goods/filter',{query:{limit:100,offset:0,filterNmID:card.nmID}});const price=r.data?.listGoods?.find(p=>Number(p.nmID)===Number(card.nmID));if(!price)errors.push('WB 尚未返回原商品的币种和价格，请稍后核对。');else{if(price.currencyIsoCode4217!==desired.currency)errors.push('原商品币种与草稿不一致，请核对店铺币种。');if(new Set(rows[index].card.sizes.map(s=>Number(s.price))).size>1&&price.editableSizePrice!==true)errors.push('此 WB 商品不支持分尺码定价，请调整价格。');target.price_before=price;}}
   targets.push(target);
  }
  if(action==='republish'&&!errors.length){const validation=await listing.previewListingPayload(tenantId,{shop_id:a.shop_id,payload:desired});errors.push(...validation.errors);if(!errors.length)errors.push(...await inspectMedia(rows));}
  const snapshot={...(action==='archive'?original:desired),operation_action:action,source_publish_job_id:Number(job.id),targets};
  if(action==='archive'){snapshot.variants=targets.map(t=>({card:t.before_card,images:(t.before_card.photos||[]).map(p=>p.big||p.c516x688||p.hq).filter(Boolean),video_url:t.before_card.video||''}));snapshot.card=snapshot.variants[0].card;snapshot.images=snapshot.variants[0].images;snapshot.video_url=snapshot.variants[0].video_url;}
  const reviewHash=createHash('sha256').update(JSON.stringify([a.tenant_id,a.shop_id,a.environment,a.seller_id,Number(actorId),action,job.id,draft.id,draft.revision,desired,targets.map(t=>[t.nm_id,t.location,t.before_hash,t.before_version,t.price_before])])).digest('hex');
  const view={ok:!errors.length,errors,action,source_job_id:Number(job.id),draft_id:Number(draft.id),revision:Number(draft.revision),shop_id:a.shop_id,shop_name:a.name,review_hash:reviewHash,strategy:desired.strategy||'grouped',targets:targets.map(t=>({nm_id:t.nm_id,vendor_code:t.vendor_code,location:t.location})),variants:action==='republish'?rows:snapshot.variants,message:action==='archive'?'确认后移入 WB 回收站。无库存且超过 30 天会被 WB 自动清理；本次不清库存，有库存的商品仍可能销售。':'确认后恢复原 WB 商品编号，并提交当前草稿的内容、图片、视频和价格；不推送库存。'};
  return{a,job,draft,snapshot,view};
 }
 async function reviewProductOperation(tenantId,body){return(await prepare(tenantId,body)).view;}
 async function submitProductOperation(tenantId,body){
  if(body.confirmed!==true||!Number.isSafeInteger(Number(actorId))||Number(actorId)<=0)throw fail('请核对商品资料并确认平台操作。',400);
  const{a,job}=await source(tenantId,body);
  const[duplicate]=await query('SELECT * FROM wb_product_operations WHERE tenant_id=? AND review_hash=?',[a.tenant_id,String(body.review_hash||'')]);if(duplicate){if(Number(duplicate.shop_id)!==Number(a.shop_id)||Number(duplicate.person_id)!==Number(actorId))throw fail('操作确认身份不一致。',403);return{ok:true,job:(await flow.publishJob(tenantId,{job_id:duplicate.id})).job,duplicate:true};}
  const review=await prepare(tenantId,body);if(!review.view.ok)throw fail(review.view.errors.join('\n'),400);if(review.view.review_hash!==body.review_hash||review.view.revision!==Number(body.revision))throw fail('草稿或 WB 商品已变化，请重新预览确认。');
  return transaction(async c=>{
   await c.execute('SELECT id FROM shops WHERE id=? AND tenant_id=? FOR UPDATE',[a.shop_id,a.tenant_id]);
   const[duplicates]=await c.execute('SELECT id,status FROM wb_product_operations WHERE tenant_id=? AND review_hash=? FOR UPDATE',[a.tenant_id,body.review_hash]);if(duplicates[0])return{ok:true,job:duplicates[0],duplicate:true};
   const[drafts]=await c.execute('SELECT revision FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=? FOR UPDATE',[review.draft.id,a.tenant_id,a.shop_id]);if(Number(drafts[0]?.revision)!==review.view.revision)throw fail('草稿已变化，请重新预览。');
   const[jobs]=await c.execute('SELECT *, (lease_until>UTC_TIMESTAMP()) AS leased FROM wb_publish_jobs WHERE id=? AND tenant_id=? FOR UPDATE',[job.id,a.tenant_id]);const fresh=jobs[0];if(Number(fresh.leased))throw fail('原发布任务正在处理，请稍后重新确认归档或恢复。');
   const[active]=await c.execute("SELECT id,payload_json FROM wb_product_operations WHERE tenant_id=? AND shop_id=? AND status IN ('queued','processing','needs_review','paused') FOR UPDATE",[a.tenant_id,a.shop_id]);const ids=new Set(review.snapshot.targets.map(t=>Number(t.nm_id)));if(active.some(r=>parse(r.payload_json).targets.some(t=>ids.has(Number(t.nm_id)))))throw fail('这些商品已有未完成的平台操作，请先在上架记录核对该操作。');
   const[otherJobs]=await c.execute("SELECT payload_json FROM wb_publish_jobs WHERE tenant_id=? AND shop_id=? AND id<>? AND status IN ('queued','processing','needs_review','paused') FOR UPDATE",[a.tenant_id,a.shop_id,job.id]);const codes=wbPayloadVendorCodes(review.snapshot);if(otherJobs.some(j=>wbPayloadVendorCodes(parse(j.payload_json)).some(code=>codes.includes(code))))throw fail('此商品另有正在处理的上架任务，请先在上架记录核对。');
   const initial={createStarted:true,items:review.snapshot.targets.map(t=>({vendor_code:t.vendor_code,nm_id:t.nm_id,phase:body.action==='archive'?'archive':'recover'}))};
   const[result]=await c.execute("INSERT INTO wb_product_operations(tenant_id,shop_id,draft_id,draft_revision,person_id,environment,seller_id,review_hash,status,payload_json,state_json,message) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)",[a.tenant_id,a.shop_id,review.draft.id,review.view.revision,Number(actorId),a.environment,a.seller_id||'',body.review_hash,JSON.stringify(review.snapshot),JSON.stringify(initial),'等待后台核对平台商品状态']);
   const sourceState=parse(fresh.state_json);for(const[index,target]of review.snapshot.targets.entries())if(sourceState.items?.[index])sourceState.items[index].nm_id=target.nm_id;await c.execute('UPDATE wb_publish_jobs SET state_json=? WHERE id=? AND tenant_id=?',[JSON.stringify(sourceState),job.id,a.tenant_id]);
   if(['queued','processing','needs_review','paused'].includes(fresh.status))await c.execute("UPDATE wb_publish_jobs SET status='superseded',lease_token=NULL,lease_until=NULL,message='已由后续商品操作接替；原提交资料保留' WHERE id=? AND tenant_id=?",[job.id,a.tenant_id]);
   return{ok:true,job:{id:result.insertId,status:'queued'}};
  });
 }
 return{reviewProductOperation,submitProductOperation,productOperations:flow.publishJobs,productOperation:flow.publishJob,resumeProductOperation:flow.resumePublishJob,runProductOperation:flow.runPublishJob};
}
