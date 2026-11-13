import test from 'node:test';
import assert from 'node:assert/strict';
import {createWbListingWorkflow} from '../src/services/wb-listing-workflow.js';
import {createWbPublishFlow} from '../src/services/wb-publish-flow.js';

function fixture(status='published') {
 const card={vendorCode:'SOURCE-RED',title:'Key cover',brand:'Brand',characteristics:[{id:7,value:'Leather'}],dimensions:{length:12,width:22,height:11,weightBrutto:0.22},sizes:[{techSize:'0',price:258,skus:['1234567890123']}]};
 const payload={template_id:1,subject_id:3373,currency:'CNY',strategy:'grouped',card,images:['https://example.test/red.jpg'],video_url:'https://example.test/red.mp4',variants:[{card:structuredClone(card),images:['https://example.test/red.jpg'],video_url:'https://example.test/red.mp4'},{card:{...structuredClone(card),vendorCode:'SOURCE-BLUE'},images:['https://example.test/blue.jpg'],video_url:'https://example.test/blue.mp4'}]};
 const source={id:10,tenant_id:2,shop_id:20,template_id:1,vendor_code:card.vendorCode,payload_json:JSON.stringify(payload),revision:4,status};
 const history={id:30,tenant_id:2,shop_id:20,draft_id:10,draft_revision:4,status:status==='published'?'completed':'processing',payload_json:JSON.stringify(payload),state_json:JSON.stringify({createStarted:true,items:[{vendor_code:'SOURCE-RED',nm_id:100},{vendor_code:'SOURCE-BLUE',nm_id:101}]})};
 let state={drafts:[source],jobs:[history]};
 const templates=[{id:1,tenant_id:2,subject_id:3373,name:'Key covers',attributes_json:'[{"charcID":7}]',defaults_json:'{"currency":"CNY","environment":"production"}',revision:1},{id:2,tenant_id:2,subject_id:3374,name:'Other category',attributes_json:'[{"charcID":8}]',defaults_json:'{"currency":"CNY","environment":"production"}',revision:2},{id:3,tenant_id:3,subject_id:3373,name:'Foreign template',attributes_json:'[]',defaults_json:'{"currency":"CNY","environment":"production"}',revision:1}];
 const calls=[];
 async function execute(db,sql,args) {
  calls.push({sql,args});
  if(sql==='SELECT * FROM wb_listing_templates WHERE id=? AND tenant_id=?')return templates.filter(row=>row.id===args[0]&&row.tenant_id===args[1]);
  if(sql==='SELECT id FROM shops WHERE id=? AND tenant_id=? FOR UPDATE')return [{id:args[0]}];
  if(sql==='SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=? FOR UPDATE')return db.drafts.filter(row=>row.id===args[0]&&row.tenant_id===args[1]&&row.shop_id===args[2]);
  if(sql==='SELECT * FROM wb_listing_drafts WHERE id=? AND tenant_id=? AND shop_id=?')return db.drafts.filter(row=>row.id===args[0]&&row.tenant_id===args[1]&&row.shop_id===args[2]);
  if(sql==="SELECT payload_json FROM wb_publish_jobs WHERE tenant_id=? AND shop_id=? AND status IN ('queued','processing','needs_review','paused')")return db.jobs.filter(row=>row.tenant_id===args[0]&&row.shop_id===args[1]&&['queued','processing','needs_review','paused'].includes(row.status));
  if(sql.startsWith('SELECT payload_json FROM wb_product_operations '))return [];
  if(sql==='SELECT vendor_code FROM wb_product_cards WHERE tenant_id=? AND shop_id=?')return [];
  if(sql==='SELECT id,payload_json FROM wb_listing_drafts WHERE tenant_id=? AND shop_id=? AND id<>?')return db.drafts.filter(row=>row.tenant_id===args[0]&&row.shop_id===args[1]&&row.id!==args[2]);
  if(sql.startsWith('UPDATE wb_listing_drafts SET vendor_code=')){
   const row=db.drafts.find(row=>row.id===args[3]&&row.tenant_id===args[4]&&row.shop_id===args[5]&&row.revision===args[6]);
   if(!row)return {affectedRows:0};
   Object.assign(row,{vendor_code:args[0],template_id:args[1],payload_json:args[2],revision:row.revision+1,status:'draft'});return {affectedRows:1};
  }
  if(sql.startsWith('INSERT INTO wb_listing_drafts ')){
   const inserted={id:Math.max(...db.drafts.map(row=>row.id))+1,tenant_id:args[0],shop_id:args[1],template_id:args[2],vendor_code:args[3],payload_json:args[4],revision:1,status:'draft'};
   db.drafts.push(inserted);return {insertId:inserted.id};
  }
  throw Error('Unexpected database operation: '+sql);
 }
 const dependencies={
  query:async(sql,args)=>structuredClone(await execute(state,sql,args)),
  account:async(tenant,shop)=>{if(Number(tenant)!==2||![20,21].includes(Number(shop)))throw Object.assign(Error('Shop does not belong to tenant'),{statusCode:404});return{tenant_id:2,shop_id:Number(shop),environment:'production'};},
  transaction:async work=>{const pending=structuredClone(state);const result=await work({execute:async(sql,args)=>[structuredClone(await execute(pending,sql,args))]});state=pending;return result;},
  request:async()=>{throw Error('Draft saving must not call WB');}
 };
 const service=createWbListingWorkflow(dependencies);
 const publishing=createWbPublishFlow({...dependencies,listing:{previewListingPayload:async()=>({ok:true,errors:[]})},verifyToken:()=>{},inspectMedia:async()=>[]});
 return {service,publishing,payload,calls,state:()=>structuredClone(state)};
}

test('published and submitted WB drafts remain editable without mutating frozen publication identity',async t=>{
 for(const status of ['published','submitted'])await t.test(status,async()=>{
  const f=fixture(status),before=f.state(),edited=structuredClone(f.payload);
  edited.template_id=2;edited.subject_id=3374;edited.card.vendorCode='EDITED-RED';edited.variants[0].card.vendorCode='EDITED-RED';edited.variants[1].card.vendorCode='EDITED-BLUE';
  const result=await f.service.saveListingDraft(2,{shop_id:20,draft_id:10,revision:4,payload:edited});
  assert.deepEqual(result,{ok:true,draft_id:10,revision:5});
  const saved=f.state().drafts[0],roundTrip=JSON.parse(saved.payload_json);
  assert.equal(saved.status,'draft');assert.equal(saved.template_id,2);assert.equal(saved.vendor_code,'EDITED-RED');assert.equal(roundTrip.subject_id,3374);assert.equal(roundTrip.template_revision,2);
  assert.deepEqual(roundTrip.variants.map(v=>[v.images,v.video_url,v.card.sizes]),edited.variants.map(v=>[v.images,v.video_url,v.card.sizes]));
  assert.deepEqual(f.state().jobs,before.jobs);
 });
});

test('same-shop reuse saves an independent draft while preserving per-variant materials and source history',async()=>{
 const f=fixture(),before=f.state(),copy=structuredClone(f.payload);
 copy.card.vendorCode='COPY-RED';copy.variants[0].card.vendorCode='COPY-RED';copy.variants[1].card.vendorCode='COPY-BLUE';
 for(const row of copy.variants)for(const size of row.card.sizes)size.skus=[];copy.card=structuredClone(copy.variants[0].card);
 const result=await f.service.saveListingDraft(2,{shop_id:20,payload:copy});
 assert.notEqual(result.draft_id,10);assert.equal(result.revision,1);
 const saved=f.state().drafts.find(row=>row.id===result.draft_id);
 assert.deepEqual(JSON.parse(saved.payload_json).variants,copy.variants);assert.deepEqual(f.state().drafts[0],before.drafts[0]);assert.deepEqual(f.state().jobs,before.jobs);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:20,payload:copy}),e=>e.statusCode===409&&e.message.includes('COPY-RED'));
});

test('cross-shop reuse creates a new tenant-owned draft and never relocates the published source',async()=>{
 const f=fixture(),before=f.state();
 const result=await f.service.saveListingDraft(2,{shop_id:21,payload:structuredClone(f.payload)});
 assert.equal(f.state().drafts.find(row=>row.id===result.draft_id).shop_id,21);assert.deepEqual(f.state().drafts[0],before.drafts[0]);assert.deepEqual(f.state().jobs,before.jobs);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:21,draft_id:10,revision:4,payload:f.payload}),e=>e.statusCode===404);
});

test('reused drafts retain tenant, revision and every-variant uniqueness boundaries',async()=>{
 const f=fixture(),before=f.state();
 await assert.rejects(f.service.saveListingDraft(3,{shop_id:20,payload:f.payload}),e=>e.statusCode===404);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:22,payload:f.payload}),e=>e.statusCode===404);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:20,payload:{...f.payload,template_id:3}}),e=>e.statusCode===404);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:20,draft_id:999,revision:4,payload:f.payload}),e=>e.statusCode===404);
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:20,draft_id:10,revision:3,payload:f.payload}),e=>e.statusCode===409&&e.message.includes('其他窗口'));
 const duplicate=structuredClone(f.payload);duplicate.card.vendorCode='NEW-RED';duplicate.variants[0].card.vendorCode='NEW-RED';
 await assert.rejects(f.service.saveListingDraft(2,{shop_id:20,payload:duplicate}),e=>e.statusCode===409&&e.message.includes('SOURCE-BLUE'));
 assert.deepEqual(f.state(),before);
});

test('new vendor codes can be reviewed while the original frozen publication continues, without bypassing conflicts',async()=>{
 const f=fixture('submitted'),before=f.state();
 const blocked=await f.publishing.reviewListingDraft(2,{shop_id:20,draft_id:10});
 assert.equal(blocked.ok,false);assert.ok(blocked.errors.some(error=>error.includes('未完成的上架记录')));
 const edited=structuredClone(f.payload);edited.card.vendorCode='NEW-RED';edited.variants[0].card.vendorCode='NEW-RED';edited.variants[1].card.vendorCode='NEW-BLUE';
 await f.service.saveListingDraft(2,{shop_id:20,draft_id:10,revision:4,payload:edited});
 const review=await f.publishing.reviewListingDraft(2,{shop_id:20,draft_id:10});
 assert.equal(review.ok,true);assert.equal(review.revision,5);assert.deepEqual(review.variants.map(row=>row.vendor_code),['NEW-RED','NEW-BLUE']);assert.deepEqual(f.state().jobs,before.jobs);
 const partial=structuredClone(edited);partial.variants[1].card.vendorCode='SOURCE-BLUE';
 await f.service.saveListingDraft(2,{shop_id:20,draft_id:10,revision:5,payload:partial});
 assert.equal((await f.publishing.reviewListingDraft(2,{shop_id:20,draft_id:10})).ok,false);
});
