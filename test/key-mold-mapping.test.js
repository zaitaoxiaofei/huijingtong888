import test from 'node:test';
import assert from 'node:assert/strict';
import {exportMoldCsv,parseMoldCsv,normalizeMoldDetails,isReviewedMold} from '../src/shared/key-mold-mapping.js';
import {matchingKeyModels,normalizeWorkflowMaterial} from '../src/shared/workflow-key-models.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
const actor={personId:1,roles:['operations'],tenant:{id:1,slug:'tenant-1',role:'member'}};
const payload={name:'模具,"A"',moldCode:'M01',role:'compatibility',reviewStatus:'pending',images:['https://example.test/key.png'],notes:'说明\n第二行',listingCategory:{key:'100:200',name:'保护套'},bindings:[{brand:'A',models:['T4','T7']},{brand:'B',models:['X']}],buttonCount:3,sourceUrl:'https://example.test/source'};
const record={id:'one',kind:'material',revision:2,payload};
test('mapping CSV round trips multi-brand images, line breaks and formula-like values',()=>{
 const csv=exportMoldCsv([record]);const parsed=parseMoldCsv(csv);assert.equal(parsed.length,1);assert.deepEqual(parsed[0].patch.bindings,payload.bindings.map(b=>({...b,allModels:false})));assert.equal(parsed[0].patch.notes,payload.notes);assert.equal(parsed[0].patch.name,payload.name);assert.equal(parsed[0].revision,2);
 const formula={...record,payload:{...payload,name:'=not_a_formula'}};assert.match(exportMoldCsv([formula]),/"'=not_a_formula"/);assert.equal(parseMoldCsv(exportMoldCsv([formula]))[0].patch.name,'=not_a_formula');
});
test('CSV rejects incomplete and conflicting mappings without partial output',()=>{
 assert.throws(()=>parseMoldCsv('wrong,columns'),/列名/);const csv=exportMoldCsv([record]);assert.throws(()=>parseMoldCsv(csv+'\n"unterminated'),/引号/);assert.throws(()=>parseMoldCsv(csv.replace('"B"','"B","extra"')),/列数/);assert.throws(()=>parseMoldCsv(csv.replace('"100:200"','""')),/类目/);
 const changed=exportMoldCsv([{...record,payload:{...payload,name:'different'}}]).split('\r\n').slice(1).join('\r\n');assert.throws(()=>parseMoldCsv(csv+'\r\n'+changed),/不一致/);
});
test('pending mappings remain searchable but never automatically match; legacy records remain compatible',()=>{
 const legacy={id:'old',kind:'key_model',payload:{brand:'A',model:'T4',images:payload.images}};assert.equal(isReviewedMold(legacy),true);assert.equal(isReviewedMold(record),false);
 assert.equal(matchingKeyModels([legacy,{...legacy,id:'new',payload:{...legacy.payload,reviewStatus:'pending'}}],'A T4').length,1);
 const normalized=normalizeWorkflowMaterial(payload);assert.equal(normalized.moldCode,'M01');assert.equal(normalized.reviewStatus,'pending');assert.equal(normalized.buttonCount,3);
 assert.throws(()=>normalizeMoldDetails({buttonCount:1.2}),/数量/);assert.throws(()=>normalizeMoldDetails({sourceUrl:'http://example.test'}),/HTTPS/);
});
function fixture(){let rows=[{id:'one',tenant_id:'1',kind:'material',name:payload.name,revision:2,payload_json:JSON.stringify(payload)},{id:'foreign',tenant_id:'2',kind:'material',name:payload.name,revision:1,payload_json:JSON.stringify(payload)}];let transactionDdl=0;
 const execute=async(sql,p=[])=>{if(sql.startsWith('CREATE'))return {};if(sql.startsWith('SELECT'))return rows.filter(r=>r.tenant_id===p[0]&&r.kind===p[1]&&r.id===p[2]);if(sql.startsWith('UPDATE')){const [name,json,tenant,kind,id,revision]=p;const row=rows.find(r=>r.id===id&&r.kind===kind&&r.tenant_id===tenant&&r.revision===revision);if(!row)return {affectedRows:0};Object.assign(row,{name,payload_json:json,revision:row.revision+1});return {affectedRows:1};}if(sql.startsWith('INSERT')){rows.push({id:p[0],tenant_id:p[1],kind:p[2],name:p[3],payload_json:p[4],revision:1});return {affectedRows:1};}throw Error(sql);};
 const store=createProductWorkflowStore({loadCatalog:null,authorize:async s=>s,query:execute,execute});const transaction=async callback=>{const before=structuredClone(rows);try{return await callback({execute:async(sql,p)=>{if(sql.startsWith('CREATE'))transactionDdl++;return [await execute(sql,p)];}});}catch(error){rows=before;throw error;}};return {store,transaction,rows:()=>rows,ddl:()=>transactionDdl};}
test('mapping imports update one tenant atomically and reject stale or foreign records',async()=>{
 const f=fixture(),records=parseMoldCsv(exportMoldCsv([record]));const result=await f.store.importMappings(records,actor,f.transaction);assert.equal(result.count,1);assert.equal(result.items[0].revision,3);assert.equal(f.ddl(),0);
 await assert.rejects(f.store.importMappings(records,actor,f.transaction),{status:409});assert.equal(f.rows().find(r=>r.id==='one').revision,3);
 const current={...records[0],revision:3};await assert.rejects(f.store.importMappings([current,{...current,id:'foreign',revision:1}],actor,f.transaction),{status:404});assert.equal(f.rows().find(r=>r.id==='one').revision,3);
});
test('mapping routes preserve actor and filters; anonymous import fails authorization',async()=>{
 const {createProductWorkflowRoutes}=await import('../src/server/routes/productWorkflows.js');const calls=[];
 const routes=createProductWorkflowRoutes({readJson:async req=>req.body,services:{},store:{list:async(...args)=>{calls.push(args);return [];},importMappings:async(...args)=>{calls.push(args);return {count:1};}}});
 const query={category:'100:200',brand:'A',reviewStatus:'pending'};await routes['GET /api/product-workflows/mold-mappings']({_session:actor,query});assert.deepEqual(calls[0],['mapping',actor,query]);
 const records=parseMoldCsv(exportMoldCsv([record]));await routes['POST /api/product-workflows/mold-mappings']({_session:actor,body:{records}});assert.deepEqual(calls[1],[records,actor]);
 const store=createProductWorkflowStore({loadCatalog:null,ensureSchema:async()=>{}});await assert.rejects(store.importMappings(records,null),/登录|企业|会话/);
});
test('mapping batch cannot repurpose an ordinary packaging material',async()=>{
 const f=fixture();f.rows()[0].payload_json=JSON.stringify({...payload,role:'style'});
 await assert.rejects(f.store.importMappings(parseMoldCsv(exportMoldCsv([record])),actor,f.transaction),/其他生产资料/);assert.equal(f.rows()[0].revision,2);
});
