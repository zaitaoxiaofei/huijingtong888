import {createMysqlConnection,closeMysqlConnection} from './mysql-runtime.mjs';
import {INVENTORY_DEMAND_SNAPSHOT_SCHEMA} from '../src/services/inventory-demand-snapshot.js';
import {pathToFileURL} from 'node:url';

// Explicit create-only migration. No business-row backfill, ALTER or deletion.
export async function initializeInventoryDemandSnapshot(connection,{apply=false}={}){
  const [exists]=await connection.execute('SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',['inventory_demand_snapshots']);
  if(!exists.length&&!apply)return{create_required:true,applied:false};
  if(!exists.length)await connection.query(INVENTORY_DEMAND_SNAPSHOT_SCHEMA);
  await connection.query('SELECT tenant_id,version,payload_json,calculated_at FROM inventory_demand_snapshots LIMIT 0');
  const [keys]=await connection.execute("SELECT column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name='PRIMARY' ORDER BY seq_in_index",['inventory_demand_snapshots']);
  if(keys.length!==1||keys[0].COLUMN_NAME!=='tenant_id'&&keys[0].column_name!=='tenant_id')throw Error('库存需求快照主键必须是 tenant_id；停止初始化，请人工核对表结构，不自动改动历史表');
  return{create_required:!exists.length,applied:!exists.length&&apply,columns_verified:true,tenant_primary_key_verified:true};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  if(process.argv.slice(2).some(arg=>arg!=='--apply'))throw Error('仅支持 --apply；省略时仅检查，不修改数据库');
  const connection=await createMysqlConnection({multipleStatements:false});
  try{console.log(JSON.stringify(await initializeInventoryDemandSnapshot(connection,{apply:process.argv.includes('--apply')})));}
  finally{await closeMysqlConnection(connection);}
}
