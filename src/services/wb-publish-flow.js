import {inspectWbPublishMedia} from './wb-publish-media.js';
import {createHash, randomUUID} from 'node:crypto';
import {wbListingVariants, wbVariantPayload} from '../shared/wb-listing-variants.js';
import {wbListingCard} from '../shared/wb-listing-validation.js';
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (message, statusCode=409) => Object.assign(new Error(message), {statusCode});
const positive = value => {const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw fail('缺少有效的 WB 草稿或发布记录编号。',400);return n;};
export function assertWbPublishToken(account) {
 let claims;try {claims=JSON.parse(Buffer.from(account.token.split('.')[1], 'base64url').toString());}catch {throw fail('无法核对 WB 密钥权限，请在企业店铺重新检查授权。');}
 let mask;try {mask=BigInt(claims.s);}catch {throw fail('WB 密钥缺少权限信息，请重新检查授权。');}
 if(!Number.isFinite(Number(claims.exp))||Number(claims.exp)*1000<=Date.now())throw fail('WB 密钥已过期，请更新店铺授权。');
 if(mask&(1n<<30n))throw fail('WB 密钥是只读权限，请在卖家后台创建允许写入的内容和价格密钥。');
 if(!(mask&2n)||!(mask&8n))throw fail('WB 密钥缺少商品内容或价格与折扣权限，请补齐后重新检查授权。');
}
const digest = (row,a) => createHash('sha256').update(JSON.stringify([Number(row.id),Number(row.revision),a.shop_id,a.environment,a.seller_id||'',parse(row.payload_json)])).digest('hex');
export function createWbPublishFlow({query, transaction, request, account, listing, actorId, enabled=true, verifyToken=assertWbPublishToken, inspectMedia=inspectWbPublishMedia, now=Date.now}) {
 const gate=()=>{if(!enabled)throw fail('WB 商品发布暂未开放。');};
 async function ownedDraft(tenantId,body){const a=await account(tenantId,body.shop_id);const [row]=await query('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=?',[positive(body.draft_id),a.tenant_id,a.shop_id]);if(!row)throw fail('草稿不存在或不属于当前企业和店铺。',404);return {a,row,payload:parse(row.payload_json)};}
 async function ownedJob(tenantId,body){const [job]=await query('SELECT * FROM wb_publish_jobs WHERE id=? AND tenant_id=?',[positive(body.job_id),positive(tenantId)]);if(!job)throw fail('发布记录不存在或不属于当前企业。',404);const a=await account(tenantId,job.shop_id);return {a,job};}
 function view(job){return {...job,payload:parse(job.payload_json),state:parse(job.state_json),payload_json:undefined,state_json:undefined,lease_token:undefined,lease_until:undefined};}
 async function reviewListingDraft(tenantId,body){
  gate();const {a,row,payload}=await ownedDraft(tenantId,body);verifyToken(a);
  if(row.status!=='draft')throw fail('该草稿已进入发布处理，请在上架记录查看结果，勿重复提交。');
  const validation=await listing.previewListingPayload(tenantId,{shop_id:a.shop_id,payload});
  const variants=wbListingVariants(payload);
  if(variants.some(item=>item.card.nmID))validation.errors.push('此入口用于创建新商品；已有 WB 商品请使用在线商品入口。');
  if(variants.some(item=>item.card.sizes.some(size=>size.chrtID)))validation.errors.push('新商品不能沿用已有 WB 商品的规格编号，请新建草稿。');
  if(validation.ok)validation.errors.push(...await inspectMedia(variants));
  const codes=variants.map(item=>String(item.card.vendorCode));
  const existing=await query('SELECT vendor_code FROM wb_product_cards WHERE tenant_id=? AND shop_id=?',[a.tenant_id,a.shop_id]);
  if(existing.some(item=>codes.includes(item.vendor_code)))validation.errors.push('当前店铺已有相同商家货号，请更换货号或查看在线商品。');
  return {ok:validation.errors.length===0,errors:validation.errors,draft_id:Number(row.id),revision:Number(row.revision),shop_id:a.shop_id,shop_name:a.name,currency:payload.currency,review_hash:digest(row,a),variants:variants.map(item=>({vendor_code:item.card.vendorCode,title:item.card.title,images:item.images,video_url:item.video_url||'',sizes:item.card.sizes.map(size=>({techSize:size.techSize||'',price:size.price,skus:size.skus}))})),message:'确认后创建商品并上传当前图片、视频和价格；不推送库存。'};
 }
 async function submitListingDraft(tenantId,body){
  gate();if(body.confirmed!==true||!Number.isSafeInteger(Number(actorId))||Number(actorId)<=0)throw fail('请由当前操作人员核对商品后确认发布。',400);
  // A duplicate request for the same reviewed revision returns the original operation.
  const {a,row}=await ownedDraft(tenantId,body);verifyToken(a);
  const [existing]=await query('SELECT * FROM wb_publish_jobs WHERE tenant_id=? AND shop_id=? AND draft_id=? AND draft_revision=?',[a.tenant_id,a.shop_id,row.id,Number(body.revision)]);
  if(existing){if(existing.review_hash!==body.review_hash)throw fail('发布确认内容不一致，请重新预览。');return {ok:true,job:view(existing),duplicate:true};}
  const review=await reviewListingDraft(tenantId,body);
  if(!review.ok)throw fail(review.errors.join('\n'),400);
  if(review.revision!==Number(body.revision)||review.review_hash!==body.review_hash)throw fail('草稿或店铺授权已变化，请重新预览并确认。');
  return transaction(async connection=>{
   const [drafts]=await connection.execute('SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=? FOR UPDATE',[row.id,a.tenant_id,a.shop_id]);const current=drafts[0];
   if(!current||current.status!=='draft'||Number(current.revision)!==review.revision||digest(current,a)!==review.review_hash)throw fail('草稿已被其他窗口保存或提交，请刷新上架记录。');
   const result=await connection.execute(`INSERT INTO wb_publish_jobs (tenant_id,shop_id,draft_id,draft_revision,person_id,environment,seller_id,review_hash,status,payload_json,state_json,message) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?)`,[a.tenant_id,a.shop_id,current.id,current.revision,Number(actorId),a.environment,a.seller_id||'',review.review_hash,JSON.stringify(parse(current.payload_json)),JSON.stringify({preflight:0,items:review.variants.map(item=>({vendor_code:item.vendor_code,phase:'card'}))}),'等待后台核对并创建商品卡']);
   await connection.execute("UPDATE wb_listing_drafts SET status='publishing' WHERE id=? AND tenant_id=? AND revision=?",[current.id,a.tenant_id,current.revision]);
   return {ok:true,job:{id:result[0].insertId,status:'queued',message:'发布任务已创建，尚未确认完成。'}};
  });
 }
 async function publishJobs(tenantId,body={}){const shop=body.shop_id?await account(tenantId,body.shop_id):null;const rows=await query(`SELECT j.*,s.name AS shop_name FROM wb_publish_jobs j JOIN shops s ON s.id=j.shop_id AND s.tenant_id=j.tenant_id WHERE j.tenant_id=?${shop?' AND j.shop_id=?':''} ORDER BY j.id DESC LIMIT 200`,shop?[positive(tenantId),shop.shop_id]:[positive(tenantId)]);return {rows:rows.map(view)};}
 async function publishJob(tenantId,body){return {job:view((await ownedJob(tenantId,body)).job)};}
 async function generateListingBarcodes(tenantId,body){gate();const a=await account(tenantId,body.shop_id);verifyToken(a);const count=positive(body.count);if(count>900)throw fail('每次最多生成 900 个条码。',400);const r=await request(a,'content','/content/v2/barcodes',{method:'POST',body:{count}});if(!Array.isArray(r.data)||r.data.length!==count||new Set(r.data).size!==count||r.data.some(v=>typeof v!=='string'||!/^\d{8,30}$/.test(v)))throw fail('WB 没有返回完整有效条码，请核对后重试。',502);return {barcodes:r.data};}
 async function resumePublishJob(tenantId,body){
  gate();const {a,job}=await ownedJob(tenantId,body);verifyToken(a);if(!['needs_review','paused'].includes(job.status))throw fail('此任务不需要人工恢复，请刷新结果。');
  if(Number(job.person_id)!==Number(actorId))throw fail('请由原发布操作人员恢复任务；其企业权限仍需有效。',403);
  const state=parse(job.state_json),item=state.items.find(item=>item.phase!=='done');
  if(body.retry===true){if(!item||!['media','price'].includes(item.phase))throw fail('创建商品结果不明时只允许核对，不能重复创建。');delete item.sent;delete item.task;delete item.sizeTask;delete item.sizeTaskSent;delete item.baseDone;}
  if(item)delete item.waitSince;
  const changed=await query("UPDATE wb_publish_jobs SET status='processing',state_json=?,message='等待后台继续核对',next_run_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=? AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP())",[JSON.stringify(state),job.id,a.tenant_id]);if(!changed.affectedRows)throw fail('任务仍在处理，请稍后刷新再继续。');return {ok:true};
 }
 async function runPublishJob(tenantId,body){
  gate();const {a,job}=await ownedJob(tenantId,body);verifyToken(a);
  if(!['queued','processing'].includes(job.status))return {job:view(job)};
  if(a.environment!==job.environment||(a.seller_id||'')!==job.seller_id)throw fail('发布任务的店铺环境或卖家身份已变化，请重新检查授权。');
  if(Number(job.person_id)!==Number(actorId))throw fail('后台任务操作人员不一致。',403);
  const lease=randomUUID(),claimed=await query("UPDATE wb_publish_jobs SET lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 180 SECOND) WHERE id=? AND tenant_id=? AND status IN ('queued','processing') AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP())",[lease,job.id,a.tenant_id]);
  if(!claimed.affectedRows)return {busy:true};
  const [fresh]=await query('SELECT * FROM wb_publish_jobs WHERE id=? AND tenant_id=?',[job.id,a.tenant_id]);
  const payload=parse(fresh.payload_json),state=parse(fresh.state_json),variants=wbListingVariants(payload);let status='processing',message='等待 WB 处理';
  const persist=async()=>{const args=[status,JSON.stringify(state),message.slice(0,255),job.id,a.tenant_id,lease];const sql='UPDATE wb_publish_jobs SET status=?,state_json=?,message=?,next_run_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 SECOND) WHERE id=? AND tenant_id=? AND lease_token=?';if(status==='failed'){await transaction(async c=>{const [r]=await c.execute(sql,args);if(!r.affectedRows)throw fail('发布任务锁已失效。');await c.execute("UPDATE wb_listing_drafts SET status='draft',revision=revision+1 WHERE id=? AND tenant_id=? AND revision=? AND status='publishing'",[job.draft_id,a.tenant_id,job.draft_revision]);});}else{const r=await query(sql,args);if(!r.affectedRows)throw fail('发布任务锁已失效，操作已停止。');}};
  const waiting=(item,text)=>{item.waitSince??=now();message=text;if(now()-item.waitSince>45*60*1000){status='needs_review';message=text+'；等待时间较长，请核对后继续。';}};
  const findCard=async code=>{const r=await request(a,'content','/content/v2/get/cards/list',{method:'POST',query:{locale:'zh'},body:{settings:{cursor:{limit:100},filter:{textSearch:code,withPhoto:-1}}}});if(!Array.isArray(r.cards))throw fail('WB 未返回有效商品卡列表，请稍后核对。',502);const found=r.cards.filter(card=>card.vendorCode===code);if(found.length>1)throw fail('WB 返回多个相同货号商品，请人工核对。');return found[0]||null;};
  const cacheCard=async card=>{await query('INSERT INTO wb_product_cards (tenant_id,shop_id,nm_id,vendor_code,title,raw_json,synced_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE title=VALUES(title),raw_json=VALUES(raw_json),synced_at=VALUES(synced_at)',[a.tenant_id,a.shop_id,card.nmID,card.vendorCode,card.title||'',JSON.stringify(card)]);};
  const readPrice=async nm=>{const r=await request(a,'prices','/api/v2/list/goods/filter',{query:{limit:100,offset:0,filterNmID:nm}});if(!Array.isArray(r.data?.listGoods))throw fail('WB 价格返回不完整。',502);return r.data.listGoods.find(item=>Number(item.nmID)===Number(nm));};
  const taskDone=async (task,item)=>{if(!task)return false;const r=await request(a,'prices','/api/v2/history/tasks',{query:{uploadID:task}});const value=Number(r.data?.status);if([4,5,6].includes(value)){status='needs_review';const details=await request(a,'prices','/api/v2/history/goods/task',{query:{uploadID:task,limit:100,offset:0}});item.price_errors=(details.data?.historyGoods||[]).filter(row=>Number(row.nmID)===Number(item.nm_id)).map(row=>({status:row.status,errors:row.errors||row.errorText||''}));message='WB 价格任务未全部成功，请在详情核对平台错误后重试。';return false;}return value===3;};
  try {
   // One vendor preflight per tick keeps account rate limits and lock duration bounded.
   if(!state.createStarted){
    if(state.preflight<variants.length){const card=await findCard(state.items[state.preflight].vendor_code);if(card){status='failed';message='WB 已有相同货号商品，未创建或覆盖，请更换货号。';}else{state.preflight++;message='正在核对商家货号是否重复';}await persist();return {status};}
    const validation=await listing.previewListingPayload(tenantId,{shop_id:a.shop_id,payload});if(!validation.ok){status='failed';message=validation.errors.join('；');await persist();return {status};}
    state.createStarted=true;state.submittedAt=now();message='正在提交商品卡；结果不明时不会重复创建';await persist();
    const cards=variants.map(row=>wbListingCard(wbVariantPayload(payload,row)));
    const groups=payload.strategy==='independent'?cards.map(card=>({subjectID:payload.subject_id,variants:[card]})):[{subjectID:payload.subject_id,variants:cards}];
    try{await request(a,'content','/content/v2/cards/upload',{method:'POST',body:groups});state.createAcknowledged=true;message='商品卡已提交，等待 WB 返回商品编号';}
    catch(error){if([400,401,403,409,413,422,429].includes(error.statusCode)&&error.code!=='WB_RESULT_UNKNOWN'){status='failed';state.createRejected=true;message=error.message;}else{message='商品创建请求结果待核对；不会自动重复提交。';}}
    await persist();return {status};
   }
   const index=state.items.findIndex(item=>item.phase!=='done');
   if(index<0){status='completed';message='商品卡、媒体和价格均已确认；未推送库存，是否可售请核对 WB 后台。';await transaction(async c=>{const [r]=await c.execute('UPDATE wb_publish_jobs SET status=?,state_json=?,message=? WHERE id=? AND tenant_id=? AND lease_token=?',[status,JSON.stringify(state),message,job.id,a.tenant_id,lease]);if(!r.affectedRows)throw fail('发布任务锁已失效。');const [draft]=await c.execute("UPDATE wb_listing_drafts SET status='published' WHERE id=? AND tenant_id=? AND revision=? AND status='publishing'",[job.draft_id,a.tenant_id,job.draft_revision]);if(!draft.affectedRows)throw fail('草稿发布状态已变化，请人工核对。');});return {status};}
   const item=state.items[index],variant=variants[index],card=await findCard(item.vendor_code);
   if(!card){
    const r=await request(a,'content','/content/v2/cards/error/list',{method:'POST',query:{locale:'zh'},body:{cursor:{limit:100},order:{ascending:false}}});
    const errors=(r.data?.items||[]).flatMap(batch=>batch.errors?.[item.vendor_code]||[]);
    if(errors.length){status='needs_review';message=item.vendor_code+'：'+errors.join('；');}else waiting(item,'等待 WB 创建商品卡并返回商品编号');
    await persist();return {status};
   }
   if(Number(card.subjectID)!==Number(payload.subject_id)||!Number.isSafeInteger(card.nmID)||card.nmID<=0)throw fail('WB 商品类目或编号与发布任务不一致，请人工核对。');
   const expectedBarcodes=variant.card.sizes.flatMap(size=>size.skus).sort(),actualBarcodes=(card.sizes||[]).flatMap(size=>size.skus||[]).sort();
   if(JSON.stringify(expectedBarcodes)!==JSON.stringify(actualBarcodes))throw fail('WB 商品条码与本次草稿不一致，已停止媒体和价格写入，请人工核对。');
   item.nm_id=card.nmID;await cacheCard(card);
   if(item.phase==='card'){item.phase='media';delete item.waitSince;message='商品卡已创建，等待提交图片和视频';await persist();return {status};}
   if(item.phase==='media'){
    if(!item.sent){item.sent=true;message='正在提交图片和视频';await persist();try{await request(a,'content','/content/v3/media/save',{method:'POST',body:{nmId:item.nm_id,data:[...variant.images,...(variant.video_url?[variant.video_url]:[])]}});}catch(error){if(error.code!=='WB_RESULT_UNKNOWN'&&!(error.statusCode>=500))status='needs_review';message='媒体提交结果待核对；不会自动重发，可核对后重试整组媒体。';}await persist();return {status};}
    if((card.photos?.length||0)!==variant.images.length||Boolean(card.video)!==Boolean(variant.video_url)){waiting(item,'等待 WB 图片和视频生效；请核对图片至少 700×900 像素及视频格式');await persist();return {status};}
    item.phase='price';delete item.sent;delete item.waitSince;message='媒体已确认，等待价格生效';await persist();return {status};
   }
   if(item.phase==='price'){
    const prices=await readPrice(item.nm_id);
    if(!prices){waiting(item,'等待 WB 同步商品到价格服务');await persist();return {status};}
    if(prices.currencyIsoCode4217!==payload.currency){status='needs_review';message='WB 返回币种与草稿人民币不一致，未继续设置价格。';await persist();return {status};}
    const desired=variant.card.sizes,matched=desired.map(size=>{const actual=(card.sizes||[]).find(row=>(size.skus||[]).some(sku=>(row.skus||[]).includes(sku)));return {size,actual,price:(prices.sizes||[]).find(row=>Number(row.sizeID)===Number(actual?.chrtID))};});
    if(matched.some(row=>!row.actual||!row.price)){waiting(item,'等待 WB 返回完整规格和价格');await persist();return {status};}
    const varied=new Set(desired.map(size=>Number(size.price))).size>1;
    if(varied&&prices.editableSizePrice!==true){status='needs_review';message='此 WB 商品不支持分尺码定价，请核对草稿各规格价格。';await persist();return {status};}
    if(matched.every(row=>Number(row.price.discountedPrice)===Number(row.size.price))&&Number(prices.discount)===0){item.phase='done';delete item.waitSince;message='此变体价格与媒体已确认';await persist();return {status};}
    if(!item.sent){item.sent=true;message='正在提交商品价格（不设置卖家折扣）';await persist();let r;try{r=await request(a,'prices','/api/v2/upload/task',{method:'POST',body:{data:[{nmID:item.nm_id,price:Number(desired[0].price),discount:0}]}});}catch(error){if(error.code!=='WB_RESULT_UNKNOWN'&&!(error.statusCode>=500))status='needs_review';message='价格提交结果待核对，不会自动重发。';await persist();return {status};}if(!Number.isSafeInteger(r.data?.id)||r.data.id<=0){message='价格请求结果待核对，请勿重复提交。';}else item.task=r.data.id;await persist();return {status};}
    if(!item.baseDone){if(await taskDone(item.task,item))item.baseDone=true;else{waiting(item,message==='等待 WB 处理'?'等待 WB 价格任务确认':message);await persist();return {status};}}
    if(varied&&!item.sizeTaskSent){item.sizeTaskSent=true;message='正在提交分尺码价格';await persist();let r;try{r=await request(a,'prices','/api/v2/upload/task/size',{method:'POST',body:{data:matched.map(row=>({nmID:item.nm_id,sizeID:row.actual.chrtID,price:Number(row.size.price)}))}});}catch(error){if(error.code!=='WB_RESULT_UNKNOWN'&&!(error.statusCode>=500))status='needs_review';message='分尺码价格结果待核对，不会自动重发。';await persist();return {status};}if(!Number.isSafeInteger(r.data?.id)||r.data.id<=0){message='分尺码价格结果待核对。';}else item.sizeTask=r.data.id;await persist();return {status};}
    if(varied)await taskDone(item.sizeTask,item);
    waiting(item,status==='needs_review'?message:'等待 WB 实际价格与草稿一致');await persist();return {status};
   }
  } catch(error){status=state.createStarted?'needs_review':'paused';message=String(error.message||'WB 发布处理暂未完成，请核对后继续。');await persist();return {status};}
  finally {
   await query('UPDATE wb_publish_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND tenant_id=? AND lease_token=?',[job.id,a.tenant_id,lease]);
  }
 }
 return {reviewListingDraft,submitListingDraft,publishJobs,publishJob,generateListingBarcodes,resumePublishJob,runPublishJob};
}
