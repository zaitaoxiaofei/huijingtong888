import {randomUUID} from 'node:crypto';
import {mysqlQuery, mysqlExecute, withMysqlTransaction} from '../mysql-pool.js';
import {SKU_TRAFFIC_DAILY_SCHEMA, inspectSkuTrafficDailySchema} from './sku-traffic-daily-schema.js';
import {SKU_TRAFFIC_METRICS, trafficToday, trafficDays, trafficDate, shiftTrafficDate, dailyTrafficCoverage, normalizeDailyTrafficMetric, dailyTrafficSeries} from '../shared/sku-traffic-daily.js';
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
    if (!trafficDate(day) || !days.includes(day)) throw error('请选择最近15个完整报表日；今天尚未结束，不能作为完整日数据');
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
    if (!trafficDays(clock()).includes(coverage.day)) return {published:false,error:'报表日已超出15天窗口'};
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
    const target=body.date ? [dayInWindow(body.date)] : [...days.slice(-3).reverse(),...days.slice(0,-3)];
    const result={queued:[],waiting:[],skipped:0};
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
        if(pending+added>=3)break;
        const state=byDay.get(day), recent=days.slice(-3).includes(day);
        if(state?.status==='pending'&&(clock().getTime()-new Date(state.requested_at).getTime()<300000||!state.run_id?.startsWith('reserve:')))continue;
        if(!body.date&&(state?.status==='complete'||state?.status==='partial'&&state.product_count!==null)&&(!recent||trafficToday(new Date(state.last_success_at||state.requested_at))===today)){result.skipped++;continue;}
        const reservation='reserve:'+randomUUID(), requested=sqlTime(clock());
        const reserved=await transaction(async connection=>{
          await connection.execute("INSERT IGNORE INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,requested_at) VALUES(?,?,?,'missing',?)",[key,shop.id,day,requested]);
          const [current]=await connection.query('SELECT * FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id=? AND date_key=? FOR UPDATE',[key,shop.id,day]);
          const active=current[0];
          if(active.status==='pending'&&(clock().getTime()-new Date(active.requested_at).getTime()<300000||!active.run_id?.startsWith('reserve:')))return false;
          if(!body.date&&(active.status==='complete'||active.status==='partial'&&active.product_count!==null)&&(!recent||trafficToday(new Date(active.last_success_at||active.requested_at))===today))return false;
          await connection.execute("UPDATE seller_sku_traffic_days SET status='pending',run_id=?,requested_at=?,message='等待在线插件采集' WHERE tenant_id=? AND shop_id=? AND date_key=?",[reservation,requested,key,shop.id,day]);return true;
        });
        if(!reserved)continue;
        try{
          const run=await createRun({daily_traffic:true,period_key:'custom',date_from:day,date_to:day,store_id:String(shop.store_id),company_id:String(shop.store_id),source_keys:['all_metrics'],full_store:true,auto_all_pages:true,limit:100,max_pages:500},key);
          await execute('UPDATE seller_sku_traffic_days SET run_id=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?',[run.id,key,shop.id,day,reservation]);
          result.queued.push({shop_id:shop.id,shop_name:shop.name,day,run_id:run.id});added++;
        }catch(e){await execute("UPDATE seller_sku_traffic_days SET status='failed',message=? WHERE tenant_id=? AND shop_id=? AND date_key=? AND run_id=?",[String(e.message).slice(0,512),key,shop.id,day,reservation]);throw e;}
      }
    }
    return result;
  }
  async function read(body={},tenantId) {
    await ensureSchema();
    const key=tenant(tenantId),owned=await shops(key,body.shop_id),days=trafficDays(clock()),date=dayInWindow(body.date||days.at(-1));
    const page=Math.min(100000,Math.max(1,Math.floor(Number(body.page)||1))),pageSize=Math.min(100,Math.max(1,Math.floor(Number(body.pageSize)||30)));
    const ids=owned.map(s=>s.id);if(!ids.length)return{rows:[],total:0,shops:[],coverage:[],days,date,page,pageSize};
    const scope=`d.tenant_id=? AND d.shop_id IN(${ids.map(()=>'?').join(',')}) AND d.date_key>=? AND d.date_key<=?`;
    const keyword=String(body.query||'').trim().slice(0,128),params=[key,...ids,days[0],days.at(-1)];
    const search=keyword?' AND (d.sku LIKE ? OR p.name LIKE ? OR p.offer_id LIKE ?)':'';
    if(keyword)params.push(...Array(3).fill('%'+keyword+'%'));
    const from=`FROM seller_sku_traffic_daily d LEFT JOIN online_products p ON p.shop_id=d.shop_id AND p.ozon_sku=d.sku COLLATE utf8mb4_0900_ai_ci WHERE ${scope}${search}`;
    const [count]=await query(`SELECT COUNT(DISTINCT d.shop_id,d.sku) total ${from}`,params);
    const products=await query(`SELECT d.shop_id,d.sku,MAX(p.name) product_name,MAX(p.image_url) image_url,MAX(p.offer_id) offer_id,DATE_FORMAT(MAX(d.date_key),'%Y-%m-%d') latest_day ${from} GROUP BY d.shop_id,d.sku ORDER BY d.shop_id,d.sku LIMIT ? OFFSET ?`,[...params,pageSize,(page-1)*pageSize]);
    let history=[];
    if(products.length){const filter=products.map(()=>'(shop_id=? AND sku=?)').join(' OR ');history=await query(`SELECT shop_id,sku,DATE_FORMAT(date_key,'%Y-%m-%d') date_key,${metricKeys.join(',')},updated_at FROM seller_sku_traffic_daily WHERE tenant_id=? AND date_key>=? AND date_key<=? AND (${filter}) ORDER BY date_key`,[key,days[0],days.at(-1),...products.flatMap(p=>[p.shop_id,p.sku])]);}
    const coverage=await query(`SELECT shop_id,DATE_FORMAT(date_key,'%Y-%m-%d') date_key,status,message,last_success_at,product_count,run_id FROM seller_sku_traffic_days WHERE tenant_id=? AND shop_id IN(${ids.map(()=>'?').join(',')}) AND date_key>=? AND date_key<=? ORDER BY shop_id,date_key`,[key,...ids,days[0],days.at(-1)]);
    return {rows:products.map(p=>{const series=dailyTrafficSeries(days,history.filter(r=>r.shop_id===p.shop_id&&r.sku===p.sku));return{...p,shop_name:owned.find(s=>s.id===p.shop_id)?.name,series,selected:series.find(s=>s.date_key===date),previous:series.find(s=>s.date_key===shiftTrafficDate(date,-1))||null};}),total:Number(count.total),shops:owned.map(s=>({id:s.id,name:s.name,store_id:String(s.store_id||'')})),coverage,days,date,page,pageSize};
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
