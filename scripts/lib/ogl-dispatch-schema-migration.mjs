import { createHash } from 'node:crypto';
import { OGL_DISPATCH_SCHEMA_SQL, inspectOglDispatchSchema, assertOglDispatchSchemaReady } from '../../src/services/ogl-dispatch-schema.js';

export async function migrateOglDispatchSchema(query,{database,apply=false}={}) {
  if(!database||!/^[A-Za-z0-9_]+$/.test(database))throw new Error('An explicit valid database is required');
  const [selected]=await query('SELECT DATABASE() AS database_name');
  if(selected?.database_name!==database)throw new Error('Selected database differs from the explicit database');
  const lockName=`ogl_schema_v1:${createHash('sha256').update(database).digest('hex').slice(0,32)}`;
  let locked=false;
  try {
    if(apply){const [lock]=await query('SELECT GET_LOCK(?,60) AS acquired',[lockName]);if(Number(lock?.acquired)!==1)throw new Error('OGL schema migration lock unavailable');locked=true;}
    const before=await inspectOglDispatchSchema(query);
    // Never infer ownership or rewrite a partially installed workflow.
    if(before.invalid.length)throw new Error(`Existing OGL schema requires explicit review; no DDL applied: ${before.invalid.join('; ')}`);
    if(!apply)return {ok:true,mode:'dry-run',database,changes_database:false,before};
    for(const sql of OGL_DISPATCH_SCHEMA_SQL) {
      const table=sql.match(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/)?.[1];
      if(before.missing_tables.includes(table))await query(sql);
    }
    const after=await assertOglDispatchSchemaReady(query);
    return {ok:true,mode:'apply',database,created_tables:before.missing_tables,data_rows_changed:0,after};
  }finally{if(locked)await query('SELECT RELEASE_LOCK(?)',[lockName]);}
}
