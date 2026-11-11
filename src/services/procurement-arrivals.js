import {assertWholeBundleReview} from './purchase-bundle-review.js';
import {createHash} from 'node:crypto';
import {planPartialReceipt} from './order-procurement-coverage.js';
import {loadInventoryComposition} from './inventory-composition.js';
import {bundleReviewContentRevision} from '../shared/purchase-bundle-review.js';
import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {inventoryProductSearch} from './inventory-product-search.js';
import {inventoryAliasSearch,inventoryIdentifierSearch,isInventoryIdentifier,inventoryNamePattern,inventoryNumberQueryMode} from './inventory-search.js';
import {hasPermission} from '../shared/permissions.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {procurementDayRange} from './procurement-daily-report.js';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export const procurementArrivalState=r=>r.status==='approved'?'received':r.status==='cancelled'?'cancelled':r.received_at?'arrived':r.arrival_reminder||r.reminder_id?'reminded':'open';
const purchaseTime='COALESCE(po.purchased_at,ir.created_at)';
const emptySummary=()=>({pending:0,open:0,reminded:0,arrived:0,pending_quantity:0,open_quantity:0,reminded_quantity:0,arrived_quantity:0,pending_unknown_batches:0,open_unknown_batches:0,reminded_unknown_batches:0,arrived_unknown_batches:0});

export function procurementArrivalDateFilters(params={}){
 const mode=String(params.day_mode||''),day=String(params.purchase_day||''),start=String(params.start_date||''),end=String(params.end_date||'');
 if(mode&&mode!=='pending')throw fail('请选择有效的采购日期查看方式');
 try{
  const dayRange=day&&day!=='all'?procurementDayRange(day):null;
  const from=start?procurementDayRange(start)[0]:null,to=end?procurementDayRange(end)[1]:null;
  if(start&&end&&start>end)throw fail('采购开始日期不能晚于结束日期');
  return{grouped:mode==='pending',day,dayRange,from,to};
 }catch(error){throw fail(error.message);}
}

export function createProcurementArrivals({query=mysqlQuery,transaction=withMysqlTransaction}={}){
 async function arrivalTransaction(operation){
  for(let attempt=0;;attempt++){
   try{return await transaction(operation);}
   catch(error){if(attempt>=2||!(error.code==='ER_LOCK_DEADLOCK'||Number(error.errno)===1213))throw error;}
  }
 }
 async function list(params,session){
  const current=await authorizeBusinessTaskSession(session,query);if(!hasPermission(current,'inventory.read'))throw fail('请由本企业库存或采购人员查看到货情况',403);
  const dateFilters=procurementArrivalDateFilters(params);
  const scope=await resolveInventoryTenantScope(current.tenant.id,query),where=[inventoryTenantSql(scope,'ir'),inventoryTenantSql(scope,'p'),"(po.purchased_at IS NOT NULL OR pr.status='purchased')"],args=[];
  const status=params.status||'open',statusFilters={pending:"ir.status='pending_arrival'",open:"ir.status='pending_arrival' AND ir.received_at IS NULL",reminded:"ir.status='pending_arrival' AND ir.received_at IS NULL AND reminder.id IS NOT NULL",arrived:"ir.status='pending_arrival' AND ir.received_at IS NOT NULL",inspection:"ir.status='pending_arrival' AND (ir.received_at IS NOT NULL OR po.purchased_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 72 HOUR))",received:"ir.status='approved'"};
  const stateFilter=statusFilters[status];if(stateFilter)where.push(stateFilter);else if(status!=='all')throw fail('请选择全部待处理、待到货、已提醒、待验收、已入库或全部记录');
  const graph=await loadInventoryComposition(query,scope);
  const search=inventoryProductSearch(params,scope),productWhere=[inventoryTenantSql(scope,'p')],productArgs=[];
  if(search.sql){productWhere.push(search.sql);productArgs.push(...search.params);}
  if(params.product_id){await assertInventoryRecord(scope,'product',Number(params.product_id),query);productWhere.push('p.id=?');productArgs.push(Number(params.product_id));}
  const expand=ids=>{const leaves=new Set(ids);for(const id of ids){try{for(const p of graph.components(id))leaves.add(Number(p.id));}catch{}}
    const allowed=new Set(leaves);for(const id of graph.products.keys()){try{if(graph.components(id).some(p=>leaves.has(Number(p.id))))allowed.add(id);}catch{}}
    return [...allowed];};
  // No product filter means all owned batches already covered by SQL scope.
  // Expanding every owned product into itself and every parent is redundant.
  if(search.sql||params.product_id){
   const matched=await query(`SELECT p.id FROM products p WHERE ${productWhere.map(w=>'('+w+')').join(' AND ')}`,productArgs);
   const allowed=expand(matched.map(p=>Number(p.id)));
   where.push(allowed.length?`ir.product_id IN (${allowed.map(()=>'?').join(',')})`:'1=0');args.push(...allowed);
  }
  const text=String(params.query||'').trim();
  if(text&&(!params.searchMode||params.searchMode==='auto')&&!inventoryNumberQueryMode(text)){
   const match=isInventoryIdentifier(text)?inventoryIdentifierSearch(text,'inventory_id'):null;
   const numberAlias=inventoryAliasSearch(text,'p',{fuzzy:true});
   const textSql=match?`p.id IN (${match.sql})`:`(p.name LIKE ? ESCAPE '=' OR ${numberAlias.sql})`;
   const matching=await query(`SELECT p.id FROM products p WHERE ${productWhere.map(w=>'('+w+')').join(' AND ')} AND ${textSql}`,[...productArgs,...(match?match.params:[inventoryNamePattern(text),...numberAlias.params])]);
   const ids=expand(matching.map(p=>Number(p.id)));
   where.push(`(${ids.length?`ir.product_id IN (${ids.map(()=>'?').join(',')})`:'1=0'} OR po.order_no LIKE ? ESCAPE '=')`);args.push(...ids,inventoryNamePattern(text));
  }
  if(params.recent==='1')where.push("(ir.status='pending_arrival' OR po.purchased_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MONTH))");
  if(dateFilters.from){where.push(`${purchaseTime}>=?`);args.push(dateFilters.from);}
  if(dateFilters.to){where.push(`${purchaseTime}<?`);args.push(dateFilters.to);}
  const reviews=await query("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND action='purchase_bundle_review' ORDER BY id DESC",[scope.id]);
  const lineage=new Map();const reviewed=new Map();for(const row of reviews){const v=typeof row.detail_json==='string'?JSON.parse(row.detail_json):row.detail_json;if(v?.result?.mode==='whole'&&!reviewed.has(Number(v.result.inbound_id)))reviewed.set(Number(v.result.inbound_id),v.content_revision);for(const child of v?.result?.created||[])if(!lineage.has(Number(child.inbound_id)))lineage.set(Number(child.inbound_id),{id:Number(v.result.inbound_id),product_id:Number(v.source?.product_id),source_purchase_order_id:Number(v.source?.purchase_order_id)||null,child_product_id:Number(child.product_id),child_purchase_order_id:Number(child.purchase_order_id)});}
  const sourceIds=[...new Set([...lineage.values()].map(source=>source.id).filter(id=>Number.isSafeInteger(id)&&id>0))];
  const sourceRows=sourceIds.length?await query(`SELECT source.id,source.product_id,original.id AS purchase_order_id,original.order_no
    FROM inbound_records source JOIN products source_product ON source_product.id=source.product_id AND ${inventoryTenantSql(scope,'source_product')}
    LEFT JOIN purchase_orders original ON original.id=source.purchase_order_id AND ${inventoryTenantSql(scope,'original')}
    WHERE source.id IN (${sourceIds.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'source')}`,sourceIds):[];
  const sources=new Map(sourceRows.map(source=>[Number(source.id),source]));
  for(const [id,line] of lineage){
   const source=sources.get(line.id);
   if(!source||Number(source.product_id)!==line.product_id){lineage.delete(id);continue;}
   const validPurchase=source.purchase_order_id!=null&&(!line.source_purchase_order_id||Number(source.purchase_order_id)===line.source_purchase_order_id);
   line.purchase_order_id=validPurchase?Number(source.purchase_order_id):null;line.order_no=validPurchase?source.order_no:null;
  }
  const financial=hasPermission(current,'procurement');
  const project=(row,details=true)=>{
   const {amount,shipping_amount,purchase_note,reminder_id,reminder_person_id,reminder_person_name,reminder_created_at,reminder_note,...safe}=row;
   safe.arrival_reminder=reminder_id?{id:Number(reminder_id),person_id:Number(reminder_person_id),person_name:reminder_person_name||null,created_at:reminder_created_at,note:reminder_note||''}:null;
   if(financial)Object.assign(safe,{amount,shipping_amount,purchase_note});
   try{
    const components=graph.components(Number(row.product_id)).map(part=>({...part,quantity:Number(row.quantity)*Number(part.per_set_quantity)}));
    const bundle=graph.isBundle(row.product_id),needsReview=bundle&&reviewed.get(Number(row.id))!==bundleReviewContentRevision(row,components);
    const line=lineage.get(Number(row.id)),sourceBundle=line&&line.child_product_id===Number(row.product_id)&&line.child_purchase_order_id===Number(row.purchase_order_id)
      ?{id:line.id,product_id:line.product_id,purchase_order_id:line.purchase_order_id,order_no:line.order_no}:null;
    return{...safe,source_bundle_batch:sourceBundle,components,is_bundle:bundle,review_required:needsReview,physical_quantity:needsReview?null:components.reduce((n,c)=>n+c.quantity,0),affected_bundles:!details?[]:bundle?[{...graph.products.get(Number(row.product_id)),per_set_quantity:1}]:graph.affected(row.product_id)};
   }catch(e){return{...safe,components:[],is_bundle:true,review_required:true,physical_quantity:null,composition_error:e.message,affected_bundles:[]};}
  };
  const joins=`FROM inbound_records ir JOIN products p ON p.id=ir.product_id
    LEFT JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
    LEFT JOIN procurement_requests pr ON pr.id=ir.procurement_request_id AND ${inventoryTenantSql(scope,'pr')}
    LEFT JOIN purchase_order_items poi ON poi.id=ir.purchase_order_item_id AND poi.product_id=ir.product_id AND poi.purchase_order_id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'poi')}
    LEFT JOIN people buyer ON buyer.id=ir.person_id AND EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=buyer.id AND tm.active=1)
    LEFT JOIN (SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.inbound_id')) AS UNSIGNED) AS inbound_id,MAX(id) AS id
      FROM inventory_flow_events WHERE tenant_id=${scope.id} AND action='purchase_arrival_reminder'
      GROUP BY CAST(JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.inbound_id')) AS UNSIGNED)) reminders ON reminders.inbound_id=ir.id
    LEFT JOIN inventory_flow_events reminder ON reminder.id=reminders.id AND reminder.tenant_id=${scope.id} AND reminder.product_id=ir.product_id
    LEFT JOIN people reminder_person ON reminder_person.id=reminder.person_id AND EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=reminder_person.id AND tm.active=1)
    WHERE ${where.map(w=>'('+w+')').join(' AND ')}`;
  let page=Math.max(1,Math.min(1000000,Math.trunc(Number(params.page)||1)));const pageSize=Math.min(100,Math.max(1,Math.trunc(Number(params.pageSize)||20)));
  const summaryFilter=[...where.filter(w=>w!==stateFilter),"ir.status='pending_arrival'"];
  const summaryJoins=joins.slice(0,joins.indexOf('WHERE '+where.map(w=>'('+w+')').join(' AND ')))+'WHERE '+summaryFilter.map(w=>'('+w+')').join(' AND ');
  const summaryRows=await query(`SELECT ir.id,ir.product_id,ir.quantity,ir.amount,ir.shipping_amount,ir.status,ir.received_at,reminder.id AS reminder_id,
    DATE_FORMAT(CONVERT_TZ(${purchaseTime},'+00:00','+08:00'),'%Y-%m-%d') AS purchase_day ${summaryJoins}`,args);
  const summary=emptySummary(),byDay=new Map();
  for(const raw of summaryRows){
   const row=project(raw,false),key=row.received_at?'arrived':'open';
   const date=String(row.purchase_day||'');
   if(!byDay.has(date))byDay.set(date,{date,...emptySummary(),total:0});
   const day=byDay.get(date);day.total++;
   for(const target of [summary,day])for(const bucket of ['pending',key,...(!row.received_at&&row.arrival_reminder?['reminded']:[])]){target[bucket]++;if(row.physical_quantity==null)target[bucket+'_unknown_batches']++;else target[bucket+'_quantity']+=row.physical_quantity;}
  }
  const days=[...byDay.values()].sort((a,b)=>dateFilters.grouped?a.date.localeCompare(b.date):b.date.localeCompare(a.date));
  const pending=day=>['pending','open','reminded','arrived'].includes(status)?day[status]>0:day.total>0;
  const completedDay=dateFilters.grouped&&['pending','open','reminded','arrived'].includes(status)&&dateFilters.day&&dateFilters.day!=='all'&&!pending(byDay.get(dateFilters.day)||emptySummary());
  const selectedDay=completedDay?days.find(pending)?.date||'':dateFilters.day||(dateFilters.grouped?days.find(pending)?.date||'':'all');
  if(completedDay)page=1;
  const daySummary=selectedDay&&selectedDay!=='all'?byDay.get(selectedDay)||emptySummary():summary;
  const dateResult={days,selected_day:selectedDay,day_summary:daySummary};
  if(params.summary_only==='1')return{rows:[],total:0,page,pageSize,summary,...dateResult};
  let detailJoins=joins;const detailArgs=[...args];
  const selectedRange=selectedDay&&selectedDay!=='all'?procurementDayRange(selectedDay):null;
  const order=dateFilters.grouped?'ASC':'DESC';
  if(selectedRange){detailJoins+=` AND ${purchaseTime}>=? AND ${purchaseTime}<?`;detailArgs.push(...selectedRange);}
  const [counts,rows]=await Promise.all([query(`SELECT COUNT(*) AS n ${detailJoins}`,detailArgs),query(`SELECT ir.id,ir.product_id,ir.amount,ir.shipping_amount,p.name AS product_name,p.inventory_number,ir.quantity,ir.status,ir.received_at,ir.approved_at,ir.updated_at,ir.note,ir.receipt_images_json,ir.courier_company,ir.tracking_number,po.note AS purchase_note,po.id AS purchase_order_id,po.order_no,${purchaseTime} AS purchased_at,poi.id AS purchase_order_item_id,poi.actual_quantity AS ordered_quantity,buyer.name AS buyer_name,reminder.id AS reminder_id,reminder.person_id AS reminder_person_id,reminder_person.name AS reminder_person_name,reminder.created_at AS reminder_created_at,JSON_UNQUOTE(JSON_EXTRACT(reminder.detail_json,'$.note')) AS reminder_note ${detailJoins} ORDER BY ${purchaseTime} ${order},ir.id ${order} LIMIT ? OFFSET ?`,[...detailArgs,pageSize,(page-1)*pageSize])]);
  const itemIds=[...new Set(rows.map(row=>Number(row.purchase_order_item_id)).filter(id=>Number.isSafeInteger(id)&&id>0))];
  const progressRows=itemIds.length?await query(`SELECT ir.purchase_order_item_id,ir.product_id,poi.actual_quantity AS ordered_quantity,
    SUM(CASE WHEN ir.status='pending_arrival' AND ir.received_at IS NULL THEN ir.quantity ELSE 0 END) AS unarrived_quantity,
    SUM(CASE WHEN ir.status='pending_arrival' AND ir.received_at IS NOT NULL THEN ir.quantity ELSE 0 END) AS arrived_quantity,
    SUM(CASE WHEN ir.status='approved' THEN ir.quantity ELSE 0 END) AS received_quantity
    FROM inbound_records ir JOIN purchase_order_items poi ON poi.id=ir.purchase_order_item_id AND poi.product_id=ir.product_id AND poi.purchase_order_id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'poi')}
    WHERE ir.purchase_order_item_id IN (${itemIds.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'ir')}
    GROUP BY ir.purchase_order_item_id,ir.product_id,poi.actual_quantity`,itemIds):[];
  const progress=new Map(progressRows.map(row=>[`${row.purchase_order_item_id}:${row.product_id}`,Object.fromEntries(['ordered_quantity','unarrived_quantity','arrived_quantity','received_quantity'].map(key=>[key,Number(row[key])]))]));
  return{rows:rows.map(r=>{const row=project(r);return{...row,arrival_state:procurementArrivalState(row),purchase_progress:progress.get(`${row.purchase_order_item_id}:${row.product_id}`)||null};}),total:Number(counts[0]?.n)||0,page,pageSize,summary,...dateResult};
 }
 async function logistics(body,session){
  const id=Number(body.id),courier=String(body.courier_company||'').trim(),tracking=String(body.tracking_number||'').trim();
  if(!Number.isSafeInteger(id)||id<=0||courier.length>128||tracking.length>128||!body.expected_updated_at)throw fail('请选择采购批次并填写不超过128字的快递信息；请先刷新最新记录');
  return transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'procurement'))throw fail('只有本企业采购岗位可以修改采购物流',403);
   const scope=await resolveInventoryTenantScope(current.tenant.id,q),before=await assertInventoryRecord(scope,'inbound',id,q);
   await assertInventoryRecord(scope,'product',Number(before.product_id),q,{lock:true});
   const row=await assertInventoryRecord(scope,'inbound',id,q,{lock:true});
   if(Number(row.product_id)!==Number(before.product_id)||row.status!=='pending_arrival')throw fail('采购批次已经变化或关闭，请刷新后重试',409);
   const [purchased]=await q(`SELECT id FROM purchase_orders po WHERE id=? AND purchased_at IS NOT NULL AND status NOT IN('cancelled','pending_purchase') AND ${inventoryTenantSql(scope,'po')} FOR UPDATE`,[row.purchase_order_id||0]);
   const [legacy]=purchased?[]:await q(`SELECT id FROM procurement_requests pr WHERE id=? AND product_id=? AND status='purchased' AND ${inventoryTenantSql(scope,'pr')} FOR UPDATE`,[row.procurement_request_id||0,row.product_id]);
   if(!purchased&&!legacy)throw fail('此批次尚未登记真实采购，不能修改到货物流',409);
   if(String(row.courier_company||'')===courier&&String(row.tracking_number||'')===tracking)return{ok:true,duplicate:true};
   const stamp=v=>new Date(typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v).getTime();
   if(stamp(row.updated_at)!==stamp(body.expected_updated_at)||String(row.courier_company||'')!==String(body.expected_courier_company||'')||String(row.tracking_number||'')!==String(body.expected_tracking_number||''))throw fail('采购物流已被修改，请刷新后重新填写',409);
   await c.execute(`UPDATE inbound_records SET courier_company=?,tracking_number=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[courier||null,tracking||null,id]);
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,row.product_id,current.personId,'purchase_logistics',JSON.stringify({inbound_id:id,courier_company:courier,tracking_number:tracking,before:{courier_company:row.courier_company,tracking_number:row.tracking_number}})]);
   return{ok:true};
  });
 }
 async function remind(body,session){
  const id=Number(body.id),quantity=Number(body.expected_quantity),note=String(body.note||'').trim(),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(quantity)||quantity<1||!body.expected_updated_at||note.length>500||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))throw fail('请读取最新采购批次后提醒到货；备注可选，最多500字');
  const stamp=v=>new Date(typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v).getTime();
  const hash=createHash('sha256').update(JSON.stringify({id,quantity,note,updated_at:stamp(body.expected_updated_at)})).digest('hex');
  return arrivalTransaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],initial=await authorizeBusinessTaskSession(session,q);
   const scope=await resolveInventoryTenantScope(initial.tenant.id,q),before=await assertInventoryRecord(scope,'inbound',id,q);
   await assertInventoryRecord(scope,'product',Number(before.product_id),q,{lock:true});
   const current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'procurement'))throw fail('提醒到货需要本企业采购权限',403);
   const row=await assertInventoryRecord(scope,'inbound',id,q,{lock:true});
   if(Number(row.product_id)!==Number(before.product_id))throw fail('批次库存归属已变化，请刷新核对',409);
   const [prior]=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND action='purchase_arrival_reminder' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1 FOR UPDATE",[scope.id,key]);
   if(prior){const saved=typeof prior.detail_json==='string'?JSON.parse(prior.detail_json):prior.detail_json;if(saved.hash!==hash)throw fail('此提醒标识已提交，不能修改批次或内容；请刷新后重试',409);return{...saved.result,duplicate:true};}
   if(row.status!=='pending_arrival'||row.received_at)throw fail('此批次已到货或关闭，无需再次提醒；请刷新记录',409);
   if(stamp(row.updated_at)!==stamp(body.expected_updated_at)||Number(row.quantity)!==quantity)throw fail('采购批次已变化，请刷新后重新提醒到货',409);
   const [purchase]=await q(`SELECT id FROM purchase_orders po WHERE id=? AND purchased_at IS NOT NULL AND status NOT IN('cancelled','pending_purchase') AND ${inventoryTenantSql(scope,'po')} FOR UPDATE`,[row.purchase_order_id||0]);
   const [legacy]=purchase?[]:await q(`SELECT id FROM procurement_requests pr WHERE id=? AND product_id=? AND status='purchased' AND ${inventoryTenantSql(scope,'pr')} FOR UPDATE`,[row.procurement_request_id||0,row.product_id]);
   if(!purchase&&!legacy)throw fail('此批次尚未登记真实采购，不能提醒到货',409);
   const [existing]=await q("SELECT id FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action='purchase_arrival_reminder' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.inbound_id'))=? ORDER BY id DESC LIMIT 1",[scope.id,row.product_id,String(id)]);
   if(existing)return{ok:true,duplicate:true,inbound_id:id};
   const result={ok:true,duplicate:false,inbound_id:id};
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,row.product_id,current.personId,'purchase_arrival_reminder',JSON.stringify({inbound_id:id,note,request_key:key,hash,result})]);
   await c.execute(`UPDATE inbound_records SET updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[id]);
   return result;
  });
 }
 async function confirm(body,session){
  if(body.operation==='logistics')return logistics(body,session);
  if(body.operation==='remind')return remind(body,session);
  const id=Number(body.id),note=String(body.note||'').trim(),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||note.length>500||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)||!body.expected_updated_at)throw fail('请选择采购批次并读取最新记录后确认；到货说明可选，最多500字');
  const quantity=body.quantity==null?null:Number(body.quantity),expected=body.expected_quantity==null?null:Number(body.expected_quantity);
  if(quantity!==null&&(!Number.isSafeInteger(quantity)||quantity<1||!Number.isSafeInteger(expected)||expected<1))throw fail('请填写本次实际到货件数（quantity）和原待到货件数（expected_quantity），均须为正整数；采购总数录错请先编辑采购批次');
  const stamp=v=>new Date(typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v).getTime();
  const hash=createHash('sha256').update(JSON.stringify({id,note,quantity,expected,updated_at:stamp(body.expected_updated_at)})).digest('hex');
  const result=await arrivalTransaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],initial=await authorizeBusinessTaskSession(session,q);
   const scope=await resolveInventoryTenantScope(initial.tenant.id,q),before=await assertInventoryRecord(scope,'inbound',id,q);
   await assertInventoryRecord(scope,'product',Number(before.product_id),q,{lock:true});
   const current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'procurement')&&!hasPermission(current,'packing'))throw fail('确认实物到货需要本企业采购或仓库打包权限',403);
   const row=await assertInventoryRecord(scope,'inbound',id,q,{lock:true});if(Number(row.product_id)!==Number(before.product_id))throw fail('批次库存归属已变化，请刷新核对',409);
   const [prior]=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND action='purchase_arrival' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1 FOR UPDATE",[scope.id,key]);
   if(prior){const saved=typeof prior.detail_json==='string'?JSON.parse(prior.detail_json):prior.detail_json;if(saved.hash?saved.hash!==hash:Number(saved.inbound_id)!==id||quantity!==null&&quantity!==Number(saved.quantity))throw fail('此到货登记已提交，不能用相同标识修改数量或内容；请刷新批次后重新登记',409);return{...(saved.result||{ok:true}),duplicate:true};}
   if(row.received_at||row.status==='approved'){if(quantity!==null)throw fail('此批次已到货或入库，请刷新后选择剩余待到货批次',409);return{ok:true,duplicate:true};}
   if(row.status!=='pending_arrival')throw fail('此批次已关闭或取消，请刷新到货记录',409);
   const [purchase]=await q(`SELECT po.id FROM purchase_orders po WHERE po.id=? AND po.purchased_at IS NOT NULL AND po.status NOT IN('cancelled','pending_purchase') AND ${inventoryTenantSql(scope,'po')} FOR UPDATE`,[row.purchase_order_id||0]);
   const [legacy]=purchase?[]:await q(`SELECT id FROM procurement_requests pr WHERE pr.id=? AND pr.product_id=? AND pr.status='purchased' AND ${inventoryTenantSql(scope,'pr')} FOR UPDATE`,[row.procurement_request_id||0,row.product_id]);
   if(!purchase&&!legacy)throw fail('此批次尚未登记真实采购，不能确认到货',409);
   await assertWholeBundleReview(q,scope,row);
   if(stamp(row.updated_at)!==stamp(body.expected_updated_at)||expected!==null&&expected!==Number(row.quantity))throw fail('采购批次已变化，请刷新后重新确认到货',409);
   if(quantity!==null&&quantity>Number(row.quantity))throw fail(`本次到货件数不能超过当前待到货 ${row.quantity} 件；采购总数录错请先更正采购记录`);
   const plan=planPartialReceipt(row,quantity??Number(row.quantity),Number(row.quantity));
   let remainingId=null;
   if(plan.remaining){
    const [insert]=await c.execute(`INSERT INTO inbound_records
      (tenant_id,product_id,person_id,quantity,amount,unit_cost,shipping_amount,purchase_url,status,note,
       purchase_order_id,purchase_order_item_id,procurement_request_id,qc_status,courier_company,tracking_number,created_at)
      VALUES(?,?,?,?,?,?,?,?,'pending_arrival',?,?,?,?,'pending',?,?,?)`,[
      scope.id,row.product_id,row.person_id,plan.remaining,plan.remainingAmount,(plan.remainingAmount+plan.remainingShipping)/plan.remaining,plan.remainingShipping,row.purchase_url||'',
      `${row.note||''}；批次 #${id} 分批到货后剩余 ${plan.remaining} 件待到货`,row.purchase_order_id??null,row.purchase_order_item_id??null,row.procurement_request_id??null,row.courier_company??null,row.tracking_number??null,row.created_at]);
    remainingId=Number(insert.insertId);
   }
   await c.execute(`UPDATE inbound_records SET quantity=?,amount=?,shipping_amount=?,unit_cost=?,received_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[plan.received,plan.amount,plan.shippingAmount,(plan.amount+plan.shippingAmount)/plan.received,id]);
   const saved={ok:true,duplicate:false,inbound_id:id,quantity:plan.received,remaining_quantity:plan.remaining,remaining_inbound_id:remainingId};
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,row.product_id,current.personId,'purchase_arrival',JSON.stringify({inbound_id:id,note,auto_note:`本次到货 ${plan.received} 件；剩余 ${plan.remaining} 件继续待到货`,request_key:key,hash,quantity:plan.received,before:{quantity:Number(row.quantity),amount:Number(row.amount),shipping_amount:Number(row.shipping_amount||0)},result:saved})]);
   return saved;
  });invalidateOrderProcurementCoverage();return result;
 }
 return{list,confirm};
}
export const procurementArrivals=createProcurementArrivals();
