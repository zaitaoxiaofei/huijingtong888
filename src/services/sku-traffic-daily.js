import {randomUUID} from 'node:crypto';
import {mysqlQuery, mysqlExecute, withMysqlTransaction} from '../mysql-pool.js';
import {normalizeTrafficMonitorQuery} from '../shared/sku-traffic-monitor-query.js';
import {SKU_TRAFFIC_DAILY_SCHEMA, inspectSkuTrafficDailySchema} from './sku-traffic-daily-schema.js';
import {COLLECT_REQUEST_STALE_MS, SKU_TRAFFIC_METRICS, trafficToday, trafficDays, trafficDate, shiftTrafficDate, dailyTrafficCoverage, normalizeDailyTrafficMetric, dailyTrafficSeries} from '../shared/sku-traffic-daily.js';
const metricKeys = SKU_TRAFFIC_METRICS.map(([key]) => key);
const error = (message, statusCode = 400) => Object.assign(new Error(message), {statusCode});
const sqlTime = value => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
const shopSql = `SELECT s.id,s.name,s.ozon_client_id store_id,t.id tenant_pk,t.slug,
  CASE WHEN t.slug='default' THEN 'admin' ELSE CAST(t.id AS CHAR) END tenant_key
  FROM shops s JOIN tenants t ON (s.tenant_id=t.id OR (s.tenant_id IS NULL AND t.slug='default'))
  WHERE s.status='active' AND t.status='active' AND t.subscription_status IN ('active','trial')
  AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at>UTC_TIMESTAMP())`;

export function createSkuTrafficDailyService({query = mysqlQuery, execute = mysqlExecute, transaction = withMysqlTransaction, clock = () => new Date()} = {}) {
  let schema;
  async function ensureSchema() {
    if (!schema) schema = (async () => { const before=await inspectSkuTrafficDailySchema(query);if(before.problems.length)throw error("每日流量表结构或企业唯一键不兼容，请先执行迁移检查",409);for (const sql of SKU_TRAFFIC_DAILY_SCHEMA) await execute(sql); })().catch(e => {schema = null; throw e;});
    return schema;
  }
  function tenant(value) {
    const key = String(value || '');
    if (key !== 'admin' && !/^[1-9]\d*$/.test(key)) throw error('缺少有效企业上下文', 403);
    return key;
  }
  async function shops(tenantId, shopId) {
    const key = tenant(tenantId);
    const rows = await query(shopSql + " AND (CASE WHEN t.slug='default' THEN 'admin' ELSE CAST(t.id AS CHAR) END)=? ORDER BY s.id", [key]);
    if (shopId !== undefined && shopId !== '' && shopId !== 'all') {
      const found = rows.filter(s => String(s.id) === String(shopId));
      if (!found.length) throw error('店铺不存在、已停用或不属于当前企业', 404);
      return found;
    }
    return rows;
  }
  function dayInWindow(day) {
    const days = trafficDays(clock());
    if (!trafficDate(day) || !days.includes(day)) throw error('请选择最近30个完整报表日；今天尚未结束，不能作为完整日数据');
    return day;
  }
  async function mark(run, key, status, message) {
    const day = run.current_period?.date_from;
    if (!trafficDate(day)) return;
    await execute('UPDATE seller_sku_traffic_days SET status=?,message=? WHERE tenant_id=? AND date_key=? AND run_id=?', [status, String(message || '').slice(0,512), tenant(key), day, run.id]);
  }
  async function publish(run, tenantId, metricRows) {
    await ensureSchema();
    const key = tenant(tenantId), coverage = dailyTrafficCoverage(run,{allowPartial:true});
    if (!coverage.ok) {await mark(run,key,'partial',coverage.error);return {published:false,error:coverage.error};}
    if (!trafficDays(clock()).includes(coverage.day)) return {published:false,error:'报表日已超出30天窗口'};
    const owned = (await shops(key)).filter(s => String(s.store_id) === String(run.store_id));
    if (owned.length !== 1) throw error('店铺分析ID（ozon_client_id）缺失或重复，请在店铺管理核对本店Client ID，再回到流量监控补采；未保存每日数据',409);
    const shop = owned[0];
    const rows = metricRows.map(normalizeDailyTrafficMetric);
    if (rows.length !== coverage.expectedRows || new Set(rows.map(r => r.sku)).size !== rows.length) {
      const message = 'SKU明细缺失或跨页重复，保留上次成功日数据';
      await mark(run,key,'partial',message);return {published:false,error:message};
    }
    const updated = sqlTime(clock());
    return transaction(async connection => {
      const [owners] = await connection.query(shopSql + " AND s.id=? AND (CASE WHEN t.slug='default' THEN 'admin' ELSE CAST(t.id AS CHAR) END)=? FOR UPDATE",[shop.id,key]);
      if (owners.length !== 1 || String(owners[0].store_id) !== String(run.store_id)) throw error('采集期间店铺授权发生变化，未替换日数据',409);
      const [days] = await connection.query('SELECT run_id,last_success_at FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key=? FOR UPDATE',[key,shop.id,coverage.day]);
      if (days[0]?.run_id !== run.id) return {published:false,ignored:true,error:'已有更新的采集任务，忽略迟到结果'};
      if (!coverage.complete && days[0].last_success_at) {
        await connection.execute("UPDATE seller_sku_traffic_days SET status='partial',message=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",['本次采集触及分页上限，保留上次完整日数据',key,shop.id,coverage.day,run.id]);
        return {published:false,partial:true,preserved_complete:true};
      }
      if (coverage.complete) await connection.execute('DELETE FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',[key,shop.id,coverage.day]);
      for (let offset=0;offset<rows.length;offset+=100) {
        const batch=rows.slice(offset,offset+100), columns=['tenant_id','shop_id','sku','date_key',...metricKeys,'updated_at'];
        const values=batch.flatMap(r=>[key,shop.id,r.sku,coverage.day,...metricKeys.map(k=>r[k]),updated]);
        await connection.query(`INSERT INTO seller_sku_traffic_daily (${columns.join(',')}) VALUES ${batch.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',')}${coverage.complete?'':' ON DUPLICATE KEY UPDATE '+[...metricKeys,'updated_at'].map(k=>`${k}=VALUES(${k})`).join(',')}`,values);
      }
      if (!coverage.complete) {
        const [[count]] = await connection.query('SELECT COUNT(*) total FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id=? AND date_key=?',[key,shop.id,coverage.day]);
        await connection.execute("UPDATE seller_sku_traffic_days SET status='partial',message=?,product_count=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",[`已保存 ${count.total} 个SKU日指标；接口分页上限，未覆盖全店。未采到的SKU保持缺失`,count.total,key,shop.id,coverage.day,run.id]);
        return {published:true,partial:true,shop_id:shop.id,day:coverage.day,products:Number(count.total)};
      }
      await connection.execute("UPDATE seller_sku_traffic_days SET status='complete',message=NULL,last_success_at=?,product_count=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",[updated,rows.length,key,shop.id,coverage.day,run.id]);
      return {published:true,shop_id:shop.id,day:coverage.day,products:rows.length};
    });
  }
  async function queue(body, tenantId, {createRun,loadRun,publishRun} = {}) {
    await ensureSchema();
    const key=tenant(tenantId), owned=await shops(key,body.shop_id), days=trafficDays(clock()), today=trafficToday(clock());
    if(body.range_days!==undefined&&![1,7,15,30].includes(Number(body.range_days)))throw error('补采范围请选择1天、7天、15天或30天');
    if(body.date&&body.range_days!==undefined)throw error('请选择补采单日或补齐区间');
    const target=body.date?[dayInWindow(body.date)]:body.range_days?[...days.slice(-Number(body.range_days))].reverse():[...days].reverse();
    const missingOnly=body.missing_only===true||String(body.missing_only)==='1';
    const result={queued:[],waiting:[],completed:[],skipped:0};
    for(const shop of owned) {
      if(!String(shop.store_id||'').trim()) continue;
      const states=await query("SELECT *,DATE_FORMAT(date_key,'%Y-%m-%d') date_key FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key>=?",[key,shop.id,days[0]]);
      const byDay=new Map(states.map(s=>[s.date_key,s]));let pending=0,added=0;
      for(const state of states.filter(s=>s.status==='pending')) {
        if(state.run_id?.startsWith('reserve:')) {if(clock().getTime()-new Date(state.requested_at).getTime()<300000)pending++;continue;}
        const run=state.run_id?await loadRun(state.run_id,key):null;
        if(run&&['pending','running'].includes(run.status)){pending++;result.waiting.push({shop_id:shop.id,day:state.date_key,run_id:run.id});}
        else if(run?.status==='success'&&publishRun){await publishRun(run,key);pending++;}
        else {await execute("UPDATE seller_sku_traffic_days SET status='failed',message=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",['采集失败或任务已失效，等待补采',key,shop.id,state.date_key,state.run_id]);state.status='failed';}
      }
      for(const day of target) {
        const state=byDay.get(day), recent=days.slice(-3).includes(day);
        if(state?.status==='pending'&&(clock().getTime()-new Date(state.requested_at).getTime()<300000||!state.run_id?.startsWith('reserve:')))continue;
        if(missingOnly&&state?.status==='complete'){result.skipped++;result.completed.push({shop_id:shop.id,day,last_success_at:state.last_success_at});continue;}
        if(pending+added>=3)break;
        if(!missingOnly&&!body.date&&(state?.status==='complete'||state?.status==='partial'&&state.product_count!==null)&&(!recent||trafficToday(new Date(state.last_success_at||state.requested_at))===today)){result.skipped++;continue;}
        const reservation='reserve:'+randomUUID(), requested=sqlTime(clock());
        const reserved=await transaction(async connection=>{
          await connection.execute("INSERT IGNORE INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,requested_at) VALUES(?,?,?,'missing',?)",[key,shop.id,day,requested]);
          const [current]=await connection.query('SELECT * FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key=? FOR UPDATE',[key,shop.id,day]);
          const active=current[0];
          if(active.status==='pending'&&(clock().getTime()-new Date(active.requested_at).getTime()<300000||!active.run_id?.startsWith('reserve:')))return false;
          if(missingOnly&&active.status==='complete')return false;
          if(!missingOnly&&!body.date&&(active.status==='complete'||active.status==='partial'&&active.product_count!==null)&&(!recent||trafficToday(new Date(active.last_success_at||active.requested_at))===today))return false;
          await connection.execute("UPDATE seller_sku_traffic_days SET status='pending',run_id=?,requested_at=?,message='等待在线插件采集' WHERE tenant_id=? AND shop_id=? AND date_key=?",[reservation,requested,key,shop.id,day]);return true;
        });
        if(!reserved)continue;
        try{
          const run=await createRun({daily_traffic:true,period_key:'custom',date_from:day,date_to:day,store_id:String(shop.store_id),company_id:String(shop.store_id),source_keys:['all_metrics'],full_store:true,auto_all_pages:true,limit:30,max_pages:500},key);
          await execute('UPDATE seller_sku_traffic_days SET run_id=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?',[run.id,key,shop.id,day,reservation]);
          result.queued.push({shop_id:shop.id,shop_name:shop.name,day,run_id:run.id});added++;
        }catch(e){await execute("UPDATE seller_sku_traffic_days SET status='failed',message=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",[String(e.message).slice(0,512),key,shop.id,day,reservation]);throw e;}
      }
    }
    return result;
  }
  async function readCoverage(key,ids,days,includeProgress){
    const marks=ids.map(()=>'?').join(',');
    const coverage=await query(`SELECT shop_id,DATE_FORMAT(date_key,'%Y-%m-%d') date_key,status,message,last_success_at,product_count,run_id FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id IN(${marks}) AND date_key>=? AND date_key<=? ORDER BY shop_id,date_key`,[key,...ids,days[0],days.at(-1)]);
    const runIds=[...new Set(coverage.map(day=>day.run_id).filter(id=>id&&!id.startsWith('reserve:')))];
    if(includeProgress&&runIds.length){
      const progress=await query(`SELECT p.*,CASE WHEN JSON_VALID(s.value) THEN JSON_EXTRACT(s.value,'$.collector_instance_ids') ELSE NULL END collector_instance_ids FROM (SELECT run_id,COUNT(*) total_requests,SUM(status='success') completed_requests,SUM(status='failed') failed_requests,SUM(status='running' AND claimed_at>=?) active_requests,SUM(status='running' AND (claimed_at IS NULL OR claimed_at<?)) stale_requests,SUM(status='cancelled') cancelled_requests FROM seller_analytics_collect_requests WHERE tenant_id=? AND run_id IN(${runIds.map(()=>'?').join(',')}) GROUP BY run_id) p LEFT JOIN settings s ON s.tenant_id=? AND s.\`key\`=CONCAT('seller_analytics_collect_run:',p.run_id)`,[sqlTime(new Date(clock().getTime()-COLLECT_REQUEST_STALE_MS)),sqlTime(new Date(clock().getTime()-COLLECT_REQUEST_STALE_MS)),key,...runIds,key]);
      for(const day of coverage){const row=progress.find(p=>p.run_id===day.run_id);if(row){let instances=[];try{instances=typeof row.collector_instance_ids==='string'?JSON.parse(row.collector_instance_ids):row.collector_instance_ids||[];}catch{};day.progress={total_requests:Number(row.total_requests),completed_requests:Number(row.completed_requests),failed_requests:Number(row.failed_requests),active_requests:Number(row.active_requests),stale_requests:Number(row.stale_requests),cancelled_requests:Number(row.cancelled_requests),collector_instance_ids:Array.isArray(instances)?instances:[]};}}
    }
    return coverage;
  }
  async function read(body={},tenantId) {
    await ensureSchema();
    const key=tenant(tenantId),owned=await shops(key,body.shop_id),days=trafficDays(clock()),options=normalizeTrafficMonitorQuery(body);
    const requestedDate=body.date?dayInWindow(body.date):null,includeSeries=body.include_series!==false&&String(body.include_series)!=='0';
    if(body.date_mode&&!['latest_report_day'].includes(body.date_mode))throw error('统计日期模式无效');
    const matrix=body.series_format==='matrix';
    if(body.series_format&&!['object','matrix'].includes(body.series_format))throw error('趋势数据格式无效');
    const page=Math.min(100000,Math.max(1,Math.floor(Number(body.page)||1))),pageSize=Math.min(100,Math.max(1,Math.floor(Number(body.pageSize)||30)));
    const ids=owned.map(s=>s.id);
    if(!ids.length)return{rows:[],total:0,shops:[],coverage:[],days,date:requestedDate||days.at(-1),latest_available_date:null,report_end_date:days.at(-1),selected_count:0,page,pageSize};
    const marks=ids.map(()=>'?').join(',');
    if(String(body.metadata_only)==='1')return {shops:owned.map(s=>({id:s.id,name:s.name,store_id:String(s.store_id||'')})),days,date:requestedDate||days.at(-1),report_end_date:days.at(-1),coverage:await readCoverage(key,ids,days,true)};
    const dayCounts=await query(`SELECT DATE_FORMAT(date_key,'%Y-%m-%d') date_key,COUNT(*) sku_count FROM seller_sku_traffic_daily WHERE tenant_id=? AND shop_id IN(${marks}) AND date_key>=? AND date_key<=? GROUP BY date_key ORDER BY date_key`,[key,...ids,days[0],days.at(-1)]);
    const latest=dayCounts.at(-1)?.date_key||null,date=requestedDate||(body.date_mode==='latest_report_day'?days.at(-1):latest)||days.at(-1),fromDate=[days[0],shiftTrafficDate(date,1-options.rangeDays)].sort().at(-1);
    const seriesDays=days.filter(day=>day>=fromDate&&day<=date);
    const inventoryFrom=`FROM sku_mappings sm JOIN shops bs ON bs.id=sm.shop_id JOIN tenants bt ON (bt.id=bs.tenant_id OR (bs.tenant_id IS NULL AND bt.slug='default'))
      LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id=sm.shop_id AND recipe.ozon_sku=sm.ozon_sku AND recipe.active=1 AND recipe.mode='combo'
      LEFT JOIN sku_inventory_recipe_items recipe_item ON recipe_item.recipe_id=recipe.id
      JOIN products ip ON ip.id=COALESCE(recipe_item.product_id,sm.product_id) AND ip.active=1
        AND (ip.tenant_id=bt.id OR (bt.slug='default' AND ip.tenant_id IS NULL))
      WHERE sm.active=1 AND (sm.tenant_id=bt.id OR (bt.slug='default' AND sm.tenant_id IS NULL))`;
    const where=[`d.tenant_id=? AND d.shop_id IN(${marks}) AND d.date_key>=? AND d.date_key<=?`],params=[key,...ids,fromDate,date];
    if(options.keyword){
      const op=options.exact?'=':'LIKE',value=options.exact?options.keyword:'%'+options.keyword+'%',terms=[];
      if(['all','sku'].includes(options.searchBy)){terms.push(`d.sku ${op} ?`);params.push(value);}
      const fields=options.searchBy==='offer_id'?['p.offer_id']:options.searchBy==='product_name'?['p.name']:options.searchBy==='all'?['p.offer_id','p.name']:[];
      if(fields.length){terms.push(`EXISTS(SELECT 1 FROM online_products p WHERE p.shop_id=d.shop_id AND p.ozon_sku=d.sku COLLATE utf8mb4_0900_ai_ci AND (${fields.map(f=>`${f} ${op} ?`).join(' OR ')}))`);params.push(...fields.map(()=>value));}
      if(['all','inventory','inventory_id','inventory_name'].includes(options.searchBy)){
        const inventoryFields=options.searchBy==='inventory_id'?['CAST(ip.id AS CHAR)']:options.searchBy==='inventory_name'?['ip.name']:options.searchBy==='inventory'?['ip.inventory_number','ip.code','CAST(ip.id AS CHAR)']:['ip.name','ip.inventory_number','ip.code','CAST(ip.id AS CHAR)'];
        terms.push(`EXISTS(SELECT 1 ${inventoryFrom} AND sm.shop_id=d.shop_id AND sm.ozon_sku=d.sku COLLATE utf8mb4_0900_ai_ci AND (${inventoryFields.map(f=>`${f} ${options.searchBy==='inventory_id'?'=':op} ?`).join(' OR ')}))`);params.push(...inventoryFields.map(()=>options.searchBy==='inventory_id'?options.keyword:value));
      }
      where.push('('+terms.join(' OR ')+')');
    }
    const sum=metric=>`CASE WHEN COUNT(d.${metric})=COUNT(*) THEN SUM(d.${metric}) ELSE NULL END`;
    const ratio=(numerator,denominator,official)=>`${official?`CASE WHEN COUNT(*)=1 THEN MAX(d.${official}) ELSE `:''}CASE WHEN COUNT(d.${numerator})=COUNT(*) AND COUNT(d.${denominator})=COUNT(*) AND SUM(d.${denominator})>0 THEN SUM(d.${numerator})/SUM(d.${denominator})*100 ELSE NULL END${official?' END':''}`;
    const counts=['total_views','search_views','pdp_views','total_hits_to_cart','ordered_units'];
    const metrics=[...counts.map(k=>`${sum(k)} ${k}`),`${ratio('ordered_units','total_views','conv_views_to_order')} conv_views_to_order`,`${ratio('total_hits_to_cart','total_views','conv_total_views_to_cart')} conv_total_views_to_cart`,`${ratio('ordered_units','total_hits_to_cart','conv_hits_to_cart_to_order')} conv_hits_to_cart_to_order`,`${ratio('pdp_views','total_views')} detail_view_rate`,`${ratio('search_views','total_views')} search_share`,`${ratio('ordered_units','pdp_views')} pdp_order_rate`];
    const grouped=`SELECT d.shop_id,d.sku,DATE_FORMAT(MAX(d.date_key),'%Y-%m-%d') latest_day,COUNT(*) available_days,${metrics.join(',')} FROM seller_sku_traffic_daily d WHERE ${where.join(' AND ')} GROUP BY d.shop_id,d.sku`;
    const operators={gt:'>',gte:'>=',lt:'<',lte:'<=',eq:'='};
    const conditions=options.filters.map(rule=>`q.\`${rule.metric}\` ${operators[rule.op]} ?`).join(' AND ')||'1=1';
    const filteredParams=[...params,...options.filters.map(rule=>rule.value)];
    const [count]=await query(`SELECT COUNT(*) total FROM (${grouped}) q WHERE ${conditions}`,filteredParams);
    const products=await query(`SELECT q.* FROM (${grouped}) q WHERE ${conditions} ORDER BY (q.\`${options.sort}\` IS NULL),q.\`${options.sort}\` ${options.direction.toUpperCase()},q.shop_id,q.sku LIMIT ? OFFSET ?`,[...filteredParams,pageSize,(page-1)*pageSize]);
    let history=[],metadata=[],inventory=[];
    if(products.length){
      const pairs=products.flatMap(p=>[p.shop_id,p.sku]),filter=products.map(()=>'(shop_id=? AND sku=?)').join(' OR ');
      if(includeSeries)history=await query(`SELECT shop_id,sku,DATE_FORMAT(date_key,'%Y-%m-%d') date_key,${metricKeys.join(',')},updated_at FROM seller_sku_traffic_daily WHERE tenant_id=? AND date_key>=? AND date_key<=? AND (${filter}) ORDER BY date_key`,[key,matrix?fromDate:days[0],matrix?date:days.at(-1),...pairs]);
      const metadataFilter=products.map(()=>'(shop_id=? AND ozon_sku=? COLLATE utf8mb4_0900_ai_ci)').join(' OR ');
      metadata=await query(`SELECT shop_id,ozon_sku,MAX(name) product_name,MAX(image_url) image_url,MAX(offer_id) offer_id FROM online_products WHERE ${metadataFilter} GROUP BY shop_id,ozon_sku`,pairs);
      const bindingFilter=products.map(()=>'(sm.shop_id=? AND sm.ozon_sku=? COLLATE utf8mb4_0900_ai_ci)').join(' OR ');
      inventory=await query(`SELECT DISTINCT sm.shop_id,sm.ozon_sku,ip.id,ip.name,ip.code,ip.inventory_number ${inventoryFrom} AND (${bindingFilter})`,pairs);
    }
    const details=new Map(metadata.map(p=>[`${p.shop_id}:${p.ozon_sku}`,p]));
    const coverage=await readCoverage(key,ids,days,String(body.include_progress)==='1');
    return {rows:products.map(p=>{
      const observed=history.filter(r=>r.shop_id===p.shop_id&&r.sku===p.sku),byDay=new Map(observed.map(r=>[r.date_key,r]));
      const series=includeSeries&&!matrix?dailyTrafficSeries(days,observed):[],info=details.get(`${p.shop_id}:${p.sku}`)||{};
      return {shop_id:p.shop_id,sku:p.sku,latest_day:p.latest_day,
        summary:Object.fromEntries([...counts,'conv_views_to_order','conv_total_views_to_cart','conv_hits_to_cart_to_order','detail_view_rate','search_share','pdp_order_rate','available_days'].map(k=>[k,p[k]??null])),
        inventory:inventory.filter(i=>i.shop_id===p.shop_id&&i.ozon_sku===p.sku).map(({id,name,code,inventory_number})=>({id,name,code,inventory_number})),
        product_name:info.product_name||null,image_url:info.image_url||null,offer_id:info.offer_id||null,shop_name:owned.find(s=>s.id===p.shop_id)?.name,
        series,...(matrix&&includeSeries?{trend_values:seriesDays.map(day=>{const row=byDay.get(day);return row?metricKeys.map(k=>row[k]===null||row[k]===undefined?null:Number(row[k])):null;})}:{}),
        selected:series.find(s=>s.date_key===date),previous:series.find(s=>s.date_key===shiftTrafficDate(date,-1))||null};
    }),total:Number(count.total),shops:owned.map(s=>({id:s.id,name:s.name,store_id:String(s.store_id||'')})),coverage,days,date,range_days:options.rangeDays,range_from:fromDate,latest_available_date:latest,report_end_date:days.at(-1),selected_count:Number(dayCounts.find(d=>d.date_key===date)?.sku_count||0),page,pageSize,
      ...(matrix?{series_days:seriesDays,series_columns:metricKeys}:{})};
  }
  async function cleanup() {
    await ensureSchema();const oldest=trafficDays(clock())[0];
    let deletedFacts=0,deletedDays=0;
    for(let i=0;i<10;i++){const r=await execute('DELETE FROM seller_sku_traffic_daily WHERE date_key<? LIMIT 1000',[oldest]);deletedFacts+=Number(r.affectedRows||0);if(!r.affectedRows)break;}
    const r=await execute('DELETE FROM seller_sku_traffic_days WHERE date_key<? LIMIT 1000',[oldest]);deletedDays+=Number(r.affectedRows||0);
    // The original daily response is staged once, without duplicate metric-row JSON.
    const snapshots=await query("SELECT id FROM seller_analytics_snapshots WHERE source='sku-traffic-daily-stage' AND captured_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) ORDER BY captured_at LIMIT 100");
    if(snapshots.length){const ids=snapshots.map(s=>s.id),marks=ids.map(()=>'?').join(',');await execute(`DELETE FROM seller_analytics_product_metrics WHERE snapshot_id IN(${marks})`,ids);await execute(`DELETE FROM seller_analytics_snapshots WHERE source='sku-traffic-daily-stage' AND id IN(${marks})`,ids);}
    const expiredRuns=await query(`SELECT tenant_id,\`key\` FROM settings
      WHERE \`key\` LIKE 'seller_analytics_collect_run:%' AND JSON_VALID(value)
      AND CASE WHEN JSON_VALID(value) THEN JSON_EXTRACT(value,'$.daily_traffic') ELSE NULL END=true
      AND (CASE WHEN JSON_VALID(value) THEN JSON_UNQUOTE(JSON_EXTRACT(value,'$.current_period.date_from')) ELSE NULL END<?
        OR (updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) AND CASE WHEN JSON_VALID(value) THEN JSON_UNQUOTE(JSON_EXTRACT(value,'$.status')) ELSE NULL END IN ('success','failed','cancelled')))
      ORDER BY updated_at LIMIT 100`,[oldest]);
    for(const run of expiredRuns) {
      const id=run.key.slice('seller_analytics_collect_run:'.length);
      await transaction(async connection=>{
        const [locked]=await connection.query('SELECT value,updated_at FROM settings WHERE tenant_id=? AND `key`=? FOR UPDATE',[run.tenant_id,run.key]);
        if(!locked.length)return;
        let current;try{current=JSON.parse(locked[0].value);}catch{return;}
        const expiredDate=trafficDate(current.current_period?.date_from)&&current.current_period.date_from<oldest;
        const expiredFinished=['success','failed','cancelled'].includes(current.status)&&clock().getTime()-new Date(locked[0].updated_at).getTime()>=86400000;
        if(current.daily_traffic!==true||(!expiredDate&&!expiredFinished))return;
        await connection.execute('DELETE FROM seller_analytics_collect_requests WHERE tenant_id=? AND run_id=?',[run.tenant_id,id]);
        await connection.execute('DELETE FROM seller_analytics_collect_runs WHERE tenant_id=? AND id=?',[run.tenant_id,id]);
        await connection.execute('DELETE FROM settings WHERE tenant_id=? AND `key`=?',[run.tenant_id,run.key]);
      });
    }
    return {deletedFacts,deletedDays,deletedStagePages:snapshots.length,deletedTemporaryRuns:expiredRuns.length};
  }
  return {ensureSchema,shops,queue,publish,read,cleanup,mark};
}
export const skuTrafficDaily = createSkuTrafficDailyService();
