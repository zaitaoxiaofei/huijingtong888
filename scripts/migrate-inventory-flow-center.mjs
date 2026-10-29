import mysql from 'mysql2/promise';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { INVENTORY_FLOW_SCHEMA } from '../src/services/inventory-flow-schema.js';

const definitions = INVENTORY_FLOW_SCHEMA.map(sql => {
  const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
  const columns = [...sql.matchAll(/(?:\(|,)\s*(\w+)\s+(BIGINT UNSIGNED|VARCHAR\(\d+\)|JSON|INT|TINYINT|DATETIME)(?=\s)([^,]*)/g)]
    .map(([, name, type, rest]) => ({ name, type: type.toLowerCase(), nullable: !/NOT NULL|PRIMARY KEY/.test(rest), primary: /PRIMARY KEY/.test(rest) }));
  const indexes = [...sql.matchAll(/(PRIMARY KEY|UNIQUE KEY \w+|KEY \w+)\s*\(([^)]+)\)/g)]
    .map(([,kind,cols])=>({name:kind==='PRIMARY KEY'?'PRIMARY':kind.split(' ').at(-1),columns:cols.split(',').map(v=>v.trim()).join(','),unique:kind.startsWith('PRIMARY')||kind.startsWith('UNIQUE')}));
  const primary = columns.filter(c=>c.primary).map(c=>c.name).join(',');
  if(primary) indexes.push({name:'PRIMARY',columns:primary,unique:true});
  return {name,columns,indexes,sql};
});

export async function inspectInventoryFlowSchema(query) {
  const names = definitions.map(t=>t.name), marks=names.map(()=>'?').join(',');
  const tables = await query(`SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks})`,names);
  const columns = await query(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks})`,names);
  const indexes = await query(`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS column_names
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) GROUP BY TABLE_NAME,INDEX_NAME,NON_UNIQUE`,names);
  const missing_tables=[],problems=[];
  for(const definition of definitions){
    const table=tables.find(t=>t.TABLE_NAME===definition.name);
    if(!table){missing_tables.push(definition.name);continue;}
    if(table.ENGINE!=='InnoDB'||!String(table.TABLE_COLLATION).startsWith('utf8mb4_'))problems.push(`${definition.name}:engine-or-charset`);
    for(const expected of definition.columns){
      const actual=columns.find(c=>c.TABLE_NAME===definition.name&&c.COLUMN_NAME===expected.name);
      if(!actual||actual.COLUMN_TYPE.toLowerCase()!==expected.type||(actual.IS_NULLABLE==='YES')!==expected.nullable)problems.push(`${definition.name}:column:${expected.name}`);
    }
    for(const expected of definition.indexes){
      const actual=indexes.find(i=>i.TABLE_NAME===definition.name&&i.INDEX_NAME===expected.name);
      if(!actual||actual.column_names!==expected.columns||Boolean(Number(actual.NON_UNIQUE))===expected.unique)problems.push(`${definition.name}:index:${expected.name}`);
    }
    for(const index of indexes.filter(i=>i.TABLE_NAME===definition.name&&!Number(i.NON_UNIQUE)&&i.INDEX_NAME!=='PRIMARY')){
      if(!definition.indexes.some(i=>i.unique&&i.columns===index.column_names)&&!index.column_names.split(',').includes('tenant_id'))problems.push(`${definition.name}:unscoped-unique:${index.INDEX_NAME}`);
    }
  }
  return {ready:!missing_tables.length&&!problems.length,missing_tables,problems};
}

export async function migrateInventoryFlowCenter(connection,{apply=false}={}){
  const query=async(sql,args=[])=>(await connection.query(sql,args))[0];let locked=false;
  try{
    if(apply){const [lock]=await query("SELECT GET_LOCK(CONCAT('inventory_flow_',LEFT(SHA2(DATABASE(),256),32)),10) AS acquired");if(Number(lock.acquired)!==1)throw Error('Inventory flow migration lock unavailable');locked=true;}
    const before=await inspectInventoryFlowSchema(query);
    if(!apply)return {mode:'dry-run',changes_database:false,...before};
    if(before.problems.length)throw Error('Existing inventory flow schema is incompatible; reviewed repair required');
    for(const definition of definitions)if(before.missing_tables.includes(definition.name))await query(definition.sql);
    const after=await inspectInventoryFlowSchema(query);
    if(!after.ready)throw Error('Inventory flow schema verification failed');
    return {mode:'apply',changes_database:before.missing_tables.length>0,...after};
  }finally{if(locked)await query("SELECT RELEASE_LOCK(CONCAT('inventory_flow_',LEFT(SHA2(DATABASE(),256),32)))");}
}

async function main(){
  const value=key=>process.argv.find(arg=>arg.startsWith(key+'='))?.slice(key.length+1);
  const database=value('--database'),socketPath=value('--mysql-admin-socket');
  if(!/^[A-Za-z0-9_]{1,64}$/.test(database||'')||!path.isAbsolute(socketPath||''))throw Error('Explicit database and local administrator socket are required');
  const connection=await mysql.createConnection({database,socketPath,user:'root',timezone:'Z'});
  try{console.log(JSON.stringify(await migrateInventoryFlowCenter(connection,{apply:process.argv.includes('--apply')})));}finally{await connection.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
