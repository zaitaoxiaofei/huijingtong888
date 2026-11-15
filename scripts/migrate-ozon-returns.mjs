import mysql from 'mysql2/promise';
import {OZON_RETURN_SCHEMA} from '../src/services/ozon-return-schema.js';
const arg=name=>process.argv.find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const socketPath=arg('--mysql-admin-socket'),database=arg('--database');
if(!socketPath||!database)throw Error('Explicit --mysql-admin-socket and --database required');
const c=await mysql.createConnection({socketPath,user:'root',database});
try{
  const tables=await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('ozon_return_observations','ozon_return_history')");
  if(!process.argv.includes('--apply'))console.log(JSON.stringify({mode:'dry-run',tables:tables[0],changes_database:false}));
  else{for(const statement of OZON_RETURN_SCHEMA.split(';').map(x=>x.trim()).filter(Boolean))await c.query(statement);
    console.log(JSON.stringify({mode:'apply',tables_created_or_verified:2,order_profit_inventory_rows_changed:0}));}
}finally{await c.end();}
