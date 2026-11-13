import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderWorkflowKeyCard,composeWorkflowKeyImage,clearLightKeyBackground } from '../src/services/product-workflow-key-composition.js';
import { validateWorkflow } from '../src/shared/product-workflow.js';
import { advanceProductWorkflow } from '../src/services/product-workflow-execution.js';

function fixture(url='https://example.test/own-key.png') {
  const definition={schemaVersion:1,name:'适配测试',globalPrompt:'',reviewMode:'manual',nodes:[
    {id:'listing',type:'listing',label:'类目',inputs:[],templateId:1},
    {id:'key',type:'images',label:'适配原图',inputs:[],count:1,slots:['裸钥匙'],referenceRole:'compatibility'},
    {id:'fitment',type:'image',role:'detail',label:'适配图',imageMode:'compose',composeInput:'key',ratio:'3:4',inputs:['key']}
  ],bindings:{images:{sources:[{nodeId:'fitment',output:'image'}]}}};
  return {id:'run',payload:{definition,variants:[{id:'v1',label:'产品1',values:{key:[url]}}],outputs:{}}};
}
test('3:4 composition preserves input pixels and does not redraw buttons or markings',async()=>{
  const data=Buffer.alloc(90*150*3);for(let i=0;i<data.length;i++)data[i]=(i*17+31)%100;
  const input=await sharp(data,{raw:{width:90,height:150,channels:3}}).extend({top:2,bottom:2,left:2,right:2,background:'white'}).png().toBuffer();
  const output=await renderWorkflowKeyCard(input),meta=await sharp(output).metadata();
  assert.equal(meta.width,750);assert.equal(meta.height,1000);
  const crop=await sharp(output).extract({left:330,top:445,width:90,height:150}).removeAlpha().raw().toBuffer();
  assert.deepEqual(crop,data);
  const white=await sharp(output).extract({left:100,top:300,width:20,height:20}).removeAlpha().raw().toBuffer();assert.ok(white.every(v=>v===255));
});
test('composition schema refuses another product source, multiple keys or wrong ratios',()=>{
  const d=fixture().payload.definition;validateWorkflow(d);
  for(const patch of [{ratio:'1:1'},{composeInput:'missing'},{role:'main'}]){
    const bad=structuredClone(d);Object.assign(bad.nodes[2],patch);assert.throws(()=>validateWorkflow(bad),/原图合成/);
  }
  const bad=structuredClone(d);bad.nodes[1].referenceRole='product';assert.throws(()=>validateWorkflow(bad),/原图合成/);
});
test('background composition uses the current variant, runs guard and never creates an AI task',async()=>{
  const run=fixture();let compose=0,guard=0,commit=0;
  const deps={guard:async()=>guard++,commit:async()=>commit++,composeImage:async({variant,node})=>{compose++;assert.equal(variant.values[node.composeInput][0],'https://example.test/own-key.png');return 'https://example.test/composed.png';},createTask:()=>assert.fail('must not call AI')};
  assert.equal((await advanceProductWorkflow(run,deps)).status,'running');
  assert.equal((await advanceProductWorkflow(run,deps)).status,'awaiting_review');
  assert.equal(compose,1);assert.equal(commit,1);assert.equal(guard,2);
  assert.equal(run.payload.outputs.v1.fitment.source,'composition');
});
test('a failed composition stops without substituting a generated image',async()=>{
  const run=fixture();const deps={guard:async()=>{},commit:async()=>{},composeImage:async()=>{throw Error('source missing');},createTask:()=>assert.fail('must not call AI')};
  assert.equal((await advanceProductWorkflow(run,deps)).status,'failed');
  assert.equal((await advanceProductWorkflow(run,deps)).status,'failed');
  assert.match(run.payload.outputs.v1.fitment.error,/source missing/);
});
test('composition storage receives enterprise context and never reads private local URLs',async()=>{
  const f=fixture(),variant=f.payload.variants[0],node=f.payload.definition.nodes[2],session={tenant:{id:1}};
  const png=await sharp({create:{width:40,height:60,channels:3,background:'#123456'}}).extend({top:2,bottom:2,left:2,right:2,background:'white'}).png().toBuffer();
  const url=await composeWorkflowKeyImage({runId:'r',variant,node,session,guard:async()=>{}},{readImage:async source=>{assert.equal(source,variant.values.key[0]);return {buffer:png};},store:async(body,actor)=>{assert.equal(actor,session);assert.equal(body.source_id,'r:v1:fitment');assert.equal(body.width,750);return {publish_url:'https://example.test/output.png'};}});
  assert.equal(url,'https://example.test/output.png');
  variant.values.key=['http://127.0.0.1/private'];
  // Real public-image reader rejects loopback before any request.
  await assert.rejects(composeWorkflowKeyImage({runId:'r',variant,node,session,guard:async()=>{}}),/private network/);
  variant.values.key=['/api/private'];await assert.rejects(composeWorkflowKeyImage({runId:'r',variant,node,session,guard:async()=>{}}),/重新上传/);
});
test('white input stays unchanged and opaque dark scenes require a clean reference',()=>{
  const white=Buffer.alloc(36,255);white[16]=10;white[17]=10;white[18]=10;
  const same=Buffer.from(white);clearLightKeyBackground(white,3,3);assert.deepEqual(white,same);
  assert.throws(()=>clearLightKeyBackground(Buffer.alloc(16,255).map((v,i)=>i%4===3?255:20),2,2),/白底或透明底/);
});
test('lost authorization stops composition before image reads and storage',async()=>{
  const f=fixture();await assert.rejects(composeWorkflowKeyImage({runId:'r',variant:f.payload.variants[0],node:f.payload.definition.nodes[2],session:{},guard:async()=>{throw Error('access revoked');}},{readImage:()=>assert.fail('must not read'),store:()=>assert.fail('must not store')}),/access revoked/);
});
