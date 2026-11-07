// Explicit socket-only synthetic capacity measurement; always drops its own DB.
import mysql from 'mysql2/promise';
import {randomBytes} from 'node:crypto';
import {SKU_TRAFFIC_DAILY_SCHEMA} from '../../src/services/sku-traffic-daily-schema.js';
import {createSkuTrafficDailyService} from '../../src/services/sku-traffic-daily.js';
import {trafficDays} from '../../src/shared/sku-traffic-daily.js';
const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET;if(!socketPath)throw Error('Isolated test socket required');
const db=await mysql.createConnection({socketPath,user:'root'}),database='ozon_sku_size_'+randomBytes(6).toString('hex');let created=false;
try{
 const [[network]]=await db.query('SELECT @@skip_networking disabled');if(Number(network.disabled)!==1)throw Error('Network-enabled database refused');
 await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;await db.changeUser({database});
 for(const sql of SKU_TRAFFIC_DAILY_SCHEMA)await db.query(sql);
 const started=performance.now();
 for(const day of trafficDays())for(let offset=0;offset<10000;offset+=1000){
  const values=Array.from({length:1000},(_,i)=>['admin',1,String(1000000000000+offset+i),day,1000,700,150,25,8,.8,2.5,32]);
  await db.query(`INSERT INTO seller_sku_traffic_daily(tenant_id,shop_id,sku,date_key,total_views,search_views,pdp_views,total_hits_to_cart,ordered_units,conv_views_to_order,conv_total_views_to_cart,conv_hits_to_cart_to_order,updated_at) VALUES ${values.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())').join(',')}`,values.flat());
 }
 await db.query('ANALYZE TABLE seller_sku_traffic_daily');
 const [[count]]=await db.query('SELECT COUNT(*) n FROM seller_sku_traffic_daily');
 const [[size]]=await db.query('SELECT DATA_LENGTH data_bytes,INDEX_LENGTH index_bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[database,'seller_sku_traffic_daily']);
 const query=async(sql,args=[])=> (await db.query(sql,args))[0];
 await db.query('CREATE TABLE tenants(id BIGINT PRIMARY KEY,slug VARCHAR(80),status VARCHAR(32),subscription_status VARCHAR(32),subscription_expires_at DATETIME)');
 await db.query('CREATE TABLE shops(id BIGINT PRIMARY KEY,tenant_id BIGINT,name VARCHAR(255),status VARCHAR(32),ozon_client_id VARCHAR(80))');
 await db.query('CREATE TABLE online_products(shop_id BIGINT,ozon_sku VARCHAR(128),name VARCHAR(255),image_url TEXT,offer_id VARCHAR(255),PRIMARY KEY(shop_id,ozon_sku))');
 await db.query("INSERT INTO tenants VALUES(1,'default','active','active',NULL)");await db.query("INSERT INTO shops VALUES(1,1,'Synthetic capacity store','active','111111')");
 const readStart=performance.now();const page=await createSkuTrafficDailyService({query,execute:query}).read({},'admin');const readMs=performance.now()-readStart;
 if(page.total!==150000/15||page.rows.length!==30||page.rows[0].series.length!==15)throw Error('Capacity query did not return the expected bounded page');
 console.log(JSON.stringify({synthetic:true,read_page_ms:Number(readMs.toFixed(2)),page_rows:page.rows.length,points_per_sku:15,sku_count:10000,days:15,rows:count.n,...size,total_mib:(Number(size.data_bytes)+Number(size.index_bytes))/1048576,insert_seconds:Number(((performance.now()-started)/1000).toFixed(2)),scope:'Daily facts with primary and series indexes only; no images, product metadata, raw JSON, backups, binary logs or staging included'},null,2));
}finally{if(created)await db.query(`DROP DATABASE IF EXISTS \`${database}\``);await db.end();}
