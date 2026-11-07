import test from 'node:test';
import assert from 'node:assert/strict';
import {createTenantMysqlFixture} from './helpers/tenant-mysql-fixture.js';
import {vehicleCatalogSeedingContext,native} from './helpers/vehicle-catalog-seeding.js';
import {AI_VEHICLE_CATALOG_SCHEMA,migrateAiVehicleCatalogSchema} from '../src/services/ai-vehicle-catalog-schema.js';

test('batched vehicle seeds preserve legacy full rows, scoped IDs and recovery in real MySQL',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Requires an independent socket-only MySQL',timeout:120000
},async t=>{
  const fixture=await createTenantMysqlFixture('vehicle_seed_batch');
  const {connection,query}=fixture;
  const baseRows=[
    [1001,'builtin','haval','HAVAL OLD','jolion','Jolion old','builtin',0,'basic'],
    [1002,'builtin','jeland','JELAND OLD','j7','J7 old','builtin',0,'anchor'],
    [1003,'2','haval','Private A','jolion','Private A model','user',0,'private-a'],
    [1004,'3','jeland','Private B','j7','Private B model','custom',1,'private-b'],
    [1005,'builtin','tenet','TENET legacy source','t7','T7 legacy','user',0,'legacy-source'],
    [1006,'builtin','exlantix','EXLANTIX legacy source','et','ET legacy','user',0,'legacy-anchor-source'],
    [1007,'builtin','jeland','JELAND brand old','__brand__','','builtin',0,'brand']
  ];
  const tableNames=['seed_legacy','seed_batched','seed_retry'];
  function service(table,{legacy=false,failSecondBatch=false}={}){
    const state={statements:[],seedStatements:[],migrations:0,batchAttempts:0,fail:failSecondBatch};
    const sqlFor=sql=>sql.replace(/\bai_vehicle_catalog\b/g,table);
    const direct=async(sql,params=[])=>{state.statements.push(sql);return connection.query(sqlFor(sql),params);};
    const q=async(sql,params=[])=>{state.statements.push(sql);return(await connection.execute(sqlFor(sql),params))[0];};
    const context=vehicleCatalogSeedingContext({legacy,query:q,execute:async(sql,params=[])=>{
      state.seedStatements.push({sql,params});
      if(params.length>11&&++state.batchAttempts===2&&state.fail)throw Error('isolated second seed batch failed');
      return q(sql,params);
    },transaction:async action=>{
      await connection.beginTransaction();try{const value=await action({query:direct});await connection.commit();return value;}catch(error){await connection.rollback();throw error;}
    },migrate:async(target,options)=>{state.migrations++;return migrateAiVehicleCatalogSchema(target,options);}});
    return{context,state};
  }
  const allRows=table=>query(`SELECT * FROM ${table} ORDER BY tenant_id,brand_key,model_key`);
  try{
    // One fixed isolated-session clock makes timestamp columns comparable too.
    await query("SET timestamp=1794000000");
    for(const table of tableNames){
      await query(AI_VEHICLE_CATALOG_SCHEMA.replace(/\bai_vehicle_catalog\b/g,table));
      for(const [id,tenant,brandKey,brandName,modelKey,modelName,source,enabled,marker]of baseRows)await query(`INSERT INTO ${table}
        (id,tenant_id,brand_key,brand_name,model_key,model_name,tags_json,aliases_json,supply_anchor,search_keywords_json,recommended_products_json,ozon_competition,user_priority,vehicle_reference_image_url,source,enabled,created_by_person_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,JSON_ARRAY(?),JSON_ARRAY(?),?,JSON_ARRAY(?),JSON_ARRAY(?),?,?,?,?,?,7,'2020-01-01 01:02:03','2020-02-01 01:02:03')`,
      [id,tenant,brandKey,brandName,modelKey,modelName,marker+'-tag',marker+'-alias',marker+'-anchor',marker+'-search',marker+'-recommend',marker+'-competition',marker+'-priority',`https://example.invalid/${marker}.jpg`,source,enabled]);
    }
    const before=await allRows('seed_legacy'),old=service('seed_legacy',{legacy:true}),current=service('seed_batched');
    await t.test('all columns equal the row-at-a-time fixture without added DDL',async()=>{
      await old.context.ensureVehicleCatalogSchema();await current.context.ensureVehicleCatalogSchema();
      const expected=await allRows('seed_legacy'),actual=await allRows('seed_batched');
      // Multi-row duplicate handling can reserve different unused AUTO_INCREMENT
      // gaps. Existing referenced IDs must remain exact; newly inserted entities
      // have no prior ID contract. Every other column (timestamps too) must match.
      const withoutNewIds=rows=>rows.map(row=>baseRows.some(([id])=>id===Number(row.id))?row:Object.fromEntries(Object.entries(row).filter(([key])=>key!=='id')));
      assert.deepEqual(withoutNewIds(actual),withoutNewIds(expected),'all data columns and every existing ID match the original seeding');
      assert.equal(current.state.migrations,1);assert.ok(current.state.seedStatements.length<old.state.seedStatements.length/2);
      assert.deepEqual(current.state.statements.filter(sql=>/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)),old.state.statements.filter(sql=>/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)));
      for(const row of before){const saved=actual.find(item=>item.tenant_id===row.tenant_id&&item.brand_key===row.brand_key&&item.model_key===row.model_key);assert.ok(saved);assert.equal(Number(saved.id),Number(row.id),'existing scoped identity keeps its ID');assert.equal(saved.source,row.source);assert.equal(saved.enabled,row.enabled);assert.equal(saved.vehicle_reference_image_url,row.vehicle_reference_image_url);assert.equal(saved.created_by_person_id,row.created_by_person_id);assert.equal(saved.created_at.getTime(),row.created_at.getTime());}
      assert.deepEqual(actual.filter(row=>['2','3'].includes(row.tenant_id)),before.filter(row=>['2','3'].includes(row.tenant_id)),'private enterprise rows stay byte-for-byte unchanged');
      const basic=actual.find(row=>Number(row.id)===1001),basicBefore=before.find(row=>Number(row.id)===1001);
      for(const field of ['brand_name','model_name','aliases_json','supply_anchor','search_keywords_json','recommended_products_json','ozon_competition','user_priority'])assert.deepEqual(basic[field],basicBefore[field]);
      assert.notDeepEqual(basic.tags_json,basicBefore.tags_json,'builtin regular tags refresh');
      const anchored=actual.find(row=>Number(row.id)===1002);assert.notDeepEqual(anchored.aliases_json,before.find(row=>Number(row.id)===1002).aliases_json,'original anchored metadata refresh remains');
      assert.deepEqual(actual.find(row=>Number(row.id)===1005).tags_json,before.find(row=>Number(row.id)===1005).tags_json,'non-builtin source tags are not overwritten');
      assert.deepEqual(actual.find(row=>Number(row.id)===1006).tags_json,before.find(row=>Number(row.id)===1006).tags_json,'anchored duplicate retains the original source-specific tag guard');
      t.diagnostic(`seed writes: ${old.state.seedStatements.length} row statements -> ${current.state.seedStatements.length} bounded statements`);
    });
    await t.test('warm/concurrent callers do not reseed or rewrite current records',async()=>{
      const state=await allRows('seed_batched'),queries=current.state.statements.length;
      await Promise.all(Array.from({length:16},()=>current.context.ensureVehicleCatalogSchema()));
      assert.equal(current.state.statements.length,queries);assert.equal(current.state.migrations,1);assert.deepEqual(await allRows('seed_batched'),state);
    });
    await t.test('concurrent first callers share one initialization and recover after a partially committed batch',async()=>{
      const retry=service('seed_retry',{failSecondBatch:true});
      const first=await Promise.allSettled(Array.from({length:12},()=>retry.context.ensureVehicleCatalogSchema()));assert.ok(first.every(result=>result.status==='rejected'));assert.equal(retry.state.migrations,1);
      const partial=await allRows('seed_retry');assert.ok(partial.length>before.length);assert.ok(partial.length<(await allRows('seed_legacy')).length);
      retry.state.fail=false;await Promise.all(Array.from({length:12},()=>retry.context.ensureVehicleCatalogSchema()));assert.equal(retry.state.migrations,2);
      const actual=await allRows('seed_retry'),expected=await allRows('seed_legacy');
      // Retrying existing rows can consume new AUTO_INCREMENT reservations. No
      // new row has an external identity before creation; all old IDs stay fixed.
      const data=rows=>rows.map(({id,...row})=>row);assert.deepEqual(data(actual),data(expected));
      for(const row of before)assert.equal(Number(actual.find(item=>item.tenant_id===row.tenant_id&&item.brand_key===row.brand_key&&item.model_key===row.model_key).id),Number(row.id));
      assert.equal(new Set(actual.map(row=>[row.tenant_id,row.brand_key,row.model_key].join('|'))).size,actual.length);
    });
    await t.test('duplicate keys across a batch boundary retain last-write tags and existing IDs',async()=>{
      for(const table of ['seed_legacy','seed_batched'])await query(`INSERT INTO ${table}(id,tenant_id,brand_key,brand_name,model_key,model_name,source,enabled,vehicle_reference_image_url) VALUES(900001,'builtin','same_brand','Old display name','same_model','Old display model','builtin',0,'https://example.invalid/preserved.jpg')`);
      const rows=Array.from({length:205},(_,index)=>['SAME BRAND','same model',[String(index)]]);
      for(const row of rows)await old.context.seedRow(...row);await current.context.seedRows(rows);
      const expected=(await allRows('seed_legacy')).find(row=>Number(row.id)===900001),actual=(await allRows('seed_batched')).find(row=>Number(row.id)===900001);
      assert.deepEqual(actual,expected);assert.deepEqual(native(actual.tags_json),['204']);assert.equal(actual.enabled,0);assert.equal(actual.brand_name,'Old display name');
    });
  }finally{await fixture.cleanup();}
});
