import {pathToFileURL} from 'node:url';
import mysql from 'mysql2/promise';
import {SKU_TRAFFIC_DAILY_SCHEMA,inspectSkuTrafficDailySchema} from '../src/services/sku-traffic-daily-schema.js';
export async function migrateSkuTrafficDaily(query,{apply=false}={}){
 const before=await inspectSkuTrafficDailySchema(query);
 if(before.problems.length)throw Error('Existing SKU daily schema is incompatible; no changes applied');
 if(apply)for(const sql of SKU_TRAFFIC_DAILY_SCHEMA)await query(sql);
 const after=apply?await inspectSkuTrafficDailySchema(query):before;
 return{ok:true,mode:apply?'apply':'dry-run',changes_database:apply,...after};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const options=new Map();
 for(const value of process.argv.slice(2)){const match=/^--(database|mysql-admin-socket)=(.+)$/.exec(value);if(match&&!options.has(match[1]))options.set(match[1],match[2]);else if(value==='--apply'&&!options.has('apply'))options.set('apply',true);else throw Error('Unknown or duplicate migration argument');}
 const database=options.get('database'),socketPath=options.get('mysql-admin-socket');
 if(!/^[A-Za-z0-9_]{1,64}$/.test(database||'')||!socketPath)throw Error('Explicit database and local administrator socket required');
 const connection=await mysql.createConnection({socketPath,user:'root',database});
 try{await connection.query('SET SESSION lock_wait_timeout=10');if(!options.has('apply'))await connection.query('START TRANSACTION READ ONLY');const report=await migrateSkuTrafficDaily(async(sql,args=[])=> (await connection.query(sql,args))[0],{apply:options.has('apply')});console.log(JSON.stringify(report));}
 finally{if(!options.has('apply'))await connection.rollback();await connection.end();}
}
