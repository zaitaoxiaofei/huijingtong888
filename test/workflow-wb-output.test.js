import test from 'node:test';
import assert from 'node:assert/strict';
import {keyCaseWorkflow,validateWorkflow} from '../src/shared/product-workflow.js';
import {workflowWbOutput} from '../src/shared/workflow-platform-output.js';
import {wbRichContent,wbRichFromProduct} from '../src/shared/wb-rich-content.js';
import {wbListingVariants} from '../src/shared/wb-listing-variants.js';
import {wbListingCard} from '../src/shared/wb-listing-validation.js';
import {generateProductWorkflowText} from '../src/services/product-workflow-text.js';
import {wbDraftTemplate} from '../frontend/admin/utils/wb-draft-template.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {createProductWorkflowRoutes}=await import('../src/server/routes/productWorkflows.js');
function fixture(){
 const definition=keyCaseWorkflow();definition.nodes[0].templateId=7;definition.wbOutput={shopId:22,subjectId:333,categoryName:'Key covers'};
 const variants=['a','b'].map(id=>({id,label:id,fitments:[{brand:'TENET',model:'PLUS L6'}],values:Object.fromEntries(definition.nodes.filter(n=>['field','images'].includes(n.type)).map(n=>[n.id,n.type==='images'?Array.from({length:n.count},(_,i)=>`https://media.example/${id}-${n.id}-${i}.png`):`${id}-${n.label}`]))}));
 const outputs=Object.fromEntries(variants.map(v=>[v.id,Object.fromEntries(definition.nodes.filter(n=>['image','copy','approval'].includes(n.type)).map(n=>[n.id,n.type==='image'?{url:`https://media.example/${v.id}-${n.id}.png`,approved:true}:n.type==='copy'?{text:{title:`Cover ${v.id}`,tags:['#key_cover'],description:`Description ${v.id}`},approved:true}:{approved:true}]))]));
 return {id:'run-1',payload:{definition,variants,outputs,listingSnapshot:{editable_payload:{description:'Old wrong text',variants:[{title:'Old',images:['https://old.example/wrong.png']}]}}}};
}
test('one approved generation exports independent WB variants without inherited category attributes or prices',()=>{
 const record=fixture(),before=structuredClone(record),out=workflowWbOutput(record);
 assert.equal(out.workflow_run_id,'run-1');assert.equal(out.workflow_output.subjectId,333);assert.equal(out.subject_id,null);
 assert.equal(out.variants.length,2);assert.equal(out.variants[1].card.description,'Description b');assert.equal(out.variants[0].images[0],'https://media.example/a-main.png');assert.equal(out.variants[1].images[0],'https://media.example/b-main.png');
 for(const row of out.variants){assert.deepEqual(row.card.characteristics,[]);assert.deepEqual(row.card.sizes[0].skus,[]);assert.equal(row.card.sizes[0].price,null);assert.equal(row.card.brand,'');assert.deepEqual(row.tags,['#key_cover']);assert.deepEqual(row.confirmed_fitments,[{brand:'TENET',model:'PLUS L6'}]);assert.ok(row.rich_content.blocks.some(b=>b.type==='text'&&b.text===row.card.description));}
 assert.deepEqual(record,before);
 record.payload.outputs.a.main.approved=false;assert.throws(()=>workflowWbOutput(record),/检查通过/);
});
test('WB export uses the existing scoped run lookup and cannot read another enterprise record',async()=>{
 let calls=0;const record=fixture(),session={tenant:{id:9}};
 const store={get:async(kind,id,actor)=>{calls++;assert.equal(kind,'run');assert.equal(id,'run-1');if(actor!==session)throw Object.assign(Error('not owned'),{status:404});return record;}};
 const route=createProductWorkflowRoutes({store,services:{},readJson:async()=>({})})['GET /api/product-workflows/runs'];
 assert.equal((await route({query:{id:'run-1',output:'wb'},_session:session})).variants.length,2);
 await assert.rejects(route({query:{id:'run-1',output:'wb'},_session:{tenant:{id:10}}}),/not owned/);assert.equal(calls,2);
});
test('local rich material edits round-trip through variants and copied drafts, excluded from WB API card',()=>{
 const rich=wbRichFromProduct(['https://media.example/main.jpg'],'Confirmed text');
 assert.deepEqual(wbRichContent(rich),rich);assert.throws(()=>wbRichContent({version:1,blocks:[{type:'image',url:'javascript:alert(1)'}]}),/HTTPS/);assert.throws(()=>wbRichContent({version:1,blocks:Array.from({length:11},()=>({type:'text',text:'a'}))}),/10/);
 const payload={rich_content:rich,tags:['#key_cover'],card:{title:'Cover',vendorCode:'A',description:'Description',dimensions:{length:1,width:1,height:1,weightBrutto:0.1},sizes:[{price:100,skus:['1234567890123']}]},images:['https://media.example/main.jpg']};
 assert.deepEqual(wbListingVariants(payload)[0].rich_content,rich);
 const copy=wbDraftTemplate({id:2,payload});assert.deepEqual(copy.payload.variants[0].rich_content,rich);assert.deepEqual(copy.payload.variants[0].tags,['#key_cover']);
 const card=wbListingCard(payload);assert.equal(card.rich_content,undefined);assert.equal(card.tags,undefined);assert.equal(card.description,'Description');
});
test('WB text generation uses WB rules, retries an overlong title and preserves fitment identity',async()=>{
 const prompts=[];const input={workflowOutput:'title',workflowPlatform:'wb',sourceContext:{workflowFitments:[{brand:'TENET',model:'PLUS L6'}]}};
 const output=await generateProductWorkflowText(input,async p=>{prompts.push(JSON.parse(p.messages[1].content));return {content:JSON.stringify({value:prompts.length===1?'TENET PLUS L6 '+ 'x'.repeat(65):'Чехол для ключа TENET PLUS L6'}),provider:'test'};});
 assert.equal(prompts.length,2);assert.match(prompts[0].rules[0],/60/);assert.match(prompts[1].rules.at(-1),/60/);assert.equal(output.title,'Чехол для ключа TENET PLUS L6');
});
test('invalid WB settings cannot enter a saved workflow',()=>{const r=fixture();r.payload.definition.wbOutput.subjectId=-1;assert.throws(()=>validateWorkflow(r.payload.definition),/WB/);});

test('WB source keeps each variant packaging units and an explicitly empty description',async()=>{
 const {wbListingSource}=await import('../src/shared/wb-listing-source.js');
 const out=wbListingSource({id:1,internal_code:'X',weight_g:999,length_cm:99,template_payload:{editable_payload:{description:'Stale',variants:[{title:'A',description:'First',weight_g:110,length_mm:101,images:[]},{title:'B',description:'',weight_g:220,length_mm:205,images:[]}]}}});
 assert.equal(out.variants[0].card.dimensions.weightBrutto,0.11);assert.equal(out.variants[0].card.dimensions.length,11);
 assert.equal(out.variants[1].card.dimensions.weightBrutto,0.22);assert.equal(out.variants[1].card.dimensions.length,21);assert.equal(out.variants[1].card.description,'');
});
