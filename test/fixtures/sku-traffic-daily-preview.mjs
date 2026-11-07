import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import mysql from 'mysql2/promise';
import {randomBytes} from 'node:crypto';
import {createSkuTrafficDailyService} from '../../src/services/sku-traffic-daily.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';
const database='ozon_sku_preview_'+randomBytes(6).toString('hex');
const admin=await mysql.createConnection({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root'});
const [[network]]=await admin.query('SELECT @@skip_networking disabled');if(Number(network.disabled)!==1)throw Error('Preview requires socket-only MySQL');
await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
const pool=mysql.createPool({socketPath:process.env.TENANT_TEST_MYSQL_SOCKET,user:'root',database,connectionLimit:5,timezone:'Z'});
const query=async(sql,args=[])=> (await pool.query(sql,args))[0];
const execute=async(sql,args=[])=> (await pool.execute(sql,args))[0];
const transaction=async callback=>{const c=await pool.getConnection();try{await c.beginTransaction();const value=await callback(c);await c.commit();return value;}catch(e){await c.rollback();throw e;}finally{c.release();}};
await query('CREATE TABLE tenants(id BIGINT PRIMARY KEY,slug VARCHAR(80),status VARCHAR(32),subscription_status VARCHAR(32),subscription_expires_at DATETIME)');
await query('CREATE TABLE shops(id BIGINT PRIMARY KEY,tenant_id BIGINT,name VARCHAR(255),status VARCHAR(32),ozon_client_id VARCHAR(80))');
await query('CREATE TABLE online_products(shop_id BIGINT,ozon_sku VARCHAR(128),name VARCHAR(255),image_url TEXT,offer_id VARCHAR(255),PRIMARY KEY(shop_id,ozon_sku))');
await query("INSERT INTO tenants VALUES(1,'default','active','active',NULL)");await query("INSERT INTO shops VALUES(11,1,'测试店铺 A','active','111111'),(22,1,'测试店铺 B','active','222222')");
const service=createSkuTrafficDailyService({query,execute,transaction});await service.ensureSchema();
const days=trafficDays(),runs=new Map();
for(const shop of [11,22]){
 for(let index=0;index<36;index++){
  const sku=index===0?'5800000000':String(shop*100000000+index);
  await execute('INSERT INTO online_products VALUES(?,?,?,?,?)',[shop,sku,index===0?'TENET T4L 汽车门槛保护条 · 黑色 4件套':`汽车配件样品 ${index+1} · 防刮装饰 ${shop===11?'黑色':'银色'}`,'/api/fixture/image','AUTO-'+index]);
  for(const [i,day] of days.entries()){
   if(index===0&&[4,8].includes(i))continue;
   const exposure=index===1?0:Math.round(70+index*17+(i+1)**2*(shop===11?5:2));
   await execute('INSERT INTO seller_sku_traffic_daily(tenant_id,shop_id,sku,date_key,total_views,search_views,pdp_views,total_hits_to_cart,ordered_units,conv_views_to_order,conv_total_views_to_cart,conv_hits_to_cart_to_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',['admin',shop,sku,day,exposure,Math.floor(exposure*.7),Math.floor(exposure*.15),Math.floor(exposure*.025),Math.floor(exposure*.008),.8,2.5,32]);
  }
 }
 for(const day of days)await execute("INSERT INTO seller_sku_traffic_days(tenant_id,shop_id,date_key,status,requested_at,last_success_at,product_count) VALUES('admin',?,?,'complete',UTC_TIMESTAMP(),UTC_TIMESTAMP(),36)",[shop,day]);
}
await execute("UPDATE seller_sku_traffic_days SET status='partial',message='演示分页上限：保留上次完整数据' WHERE shop_id=22 AND date_key=?",[days.at(-1)]);
const entry=`import {createApp} from 'vue';import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import View from '/frontend/admin/views/analytics/SkuTrafficMonitorView.vue';const app=createApp(View);app.use(ElementPlus,{locale:zhCn});window.skuTrafficErrors=[];app.config.errorHandler=e=>window.skuTrafficErrors.push(e.message);app.mount('#adminApp');`;
const server=await createServer({configFile:false,root:process.cwd(),publicDir:false,cacheDir:'/tmp/sku-traffic-vite-cache',logLevel:'error',plugins:[vue(),{name:'sku-daily-fixture',resolveId(id){if(id==='/__sku_preview.js')return id;},load(id){if(id==='/__sku_preview.js')return entry;},configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/admin.html'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SKU流量监控 · 本地测试数据</title><body><div style="background:#fff3ce;padding:8px 24px;font:13px system-ui">本地验证 · 全部为合成测试数据，未连接真实店铺</div><div id="adminApp"></div><script type="module" src="/__sku_preview.js"></script></body></html>');}
 if(url.pathname==='/api/fixture/image'){res.setHeader('content-type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#edf2f7"/><rect x="10" y="28" width="45" height="9" rx="3" fill="#455b6b" transform="rotate(-20 30 40)"/><rect x="8" y="47" width="45" height="7" rx="3" fill="#738ca0" transform="rotate(-20 30 40)"/></svg>');}
 if(!url.pathname.startsWith('/api/'))return next();
 try{
  let data;
  if(url.pathname==='/api/db/seller-analytics/sku-daily'){
   if(url.searchParams.get('query')==='error-fixture')throw Object.assign(Error('演示接口失败，请刷新重试'),{statusCode:503});
   data=await service.read(Object.fromEntries(url.searchParams),'admin');
  }else if(url.pathname==='/api/db/seller-analytics/sku-daily/collect'){
   let raw='';for await(const chunk of req)raw+=chunk;
   data={success:true,data:await service.queue(JSON.parse(raw||'{}'),'admin',{createRun:async()=>{const run={id:'preview-'+randomBytes(6).toString('hex'),status:'pending'};runs.set(run.id,run);return run;},loadRun:async id=>runs.get(id)})};
  }else data={};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
 }catch(e){res.statusCode=e.statusCode||500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:e.message}));}
 });}}],server:{host:'127.0.0.1',port:8788,strictPort:true}});
await server.listen();console.log('SKU traffic real component + isolated MySQL preview ready at http://localhost:8788/admin.html#/sku-traffic-monitor');
let closing=false;
async function close(){if(closing)return;closing=true;await server.close();await pool.end();await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);await admin.end();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
