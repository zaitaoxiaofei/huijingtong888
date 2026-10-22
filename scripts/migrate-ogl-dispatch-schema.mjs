import mysql from 'mysql2/promise';
import { migrateOglDispatchSchema } from './lib/ogl-dispatch-schema-migration.mjs';
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const database=option('database'),socketPath=option('mysql-admin-socket');
if(!database||!socketPath)throw new Error('OGL schema requires explicit --database and --mysql-admin-socket; default mode is read-only');
const connection=await mysql.createConnection({database,socketPath,user:'root'});
try {
  console.log(JSON.stringify(await migrateOglDispatchSchema(async(sql,params=[])=>(await connection.query(sql,params))[0],{database,apply:process.argv.includes('--apply')})));
}finally{await connection.end();}
