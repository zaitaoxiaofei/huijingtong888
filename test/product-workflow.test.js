import test from "node:test";
import assert from "node:assert/strict";
import { keyCaseWorkflow, createWorkflowNode, validateWorkflow, validateWorkflowVariants, workflowInputContext, buildWorkflowDraft } from "../src/shared/product-workflow.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "workflow_unit_test";
process.env.DB_USER ||= "workflow_unit_test";
const { createProductWorkflowStore, importProductWorkflowDraft } = await import("../src/services/product-workflows.js");

function material(definition,id="one") {
  return {id,label:id,values:Object.fromEntries(definition.nodes.filter(n=>["field","images"].includes(n.type)).map(n=>[n.id,n.type==="images"?Array.from({length:n.count},(_,i)=>`https://example.test/${id}/${n.id}/${i}.png`):`${id}-${n.label}`]))};
}
function ready(definition,variant) {
  return Object.fromEntries(definition.nodes.filter(n=>["image","copy","approval"].includes(n.type)).map(n=>[n.id,n.type==="image"?{url:`https://example.test/${variant.id}/${n.id}.png`,approved:true}:n.type==="copy"?{text:{title:`Title ${variant.id}`,tags:["#tag"],description:`Description ${variant.id}`},approved:true}:{approved:true}]));
}

test("portable nodes support other product families and arbitrary detail counts",()=>{
  const definition=keyCaseWorkflow();definition.name="门槛条";
  const extra={...createWorkflowNode("image","another_detail"),inputs:["approve"],label:"新分镜"};definition.nodes.push(extra);
  assert.deepEqual(validateWorkflow(JSON.parse(JSON.stringify(definition))),definition);
  definition.nodes[0].inputs=[extra.id];assert.throws(()=>validateWorkflow(definition),/前面/);
});
test("missing reference slots and product facts block each variant with business labels",()=>{
  const definition=keyCaseWorkflow(),a=material(definition),b=material(definition,"two");
  b.values.product[0]="";assert.throws(()=>validateWorkflowVariants(definition,[a,b]),/two.*变体产品主图/);
  b.values.product[0]="https://example.test/second.png";b.values.brand="";
  assert.throws(()=>validateWorkflowVariants(definition,[a,b]),/two.*品牌/);
  b.values.brand="Confirmed";assert.equal(validateWorkflowVariants(definition,[a,b]).length,2);
});
test("detail references require approval and preserve separate product/style roles",()=>{
  const definition=keyCaseWorkflow(),variant=material(definition),outputs=ready(definition,variant);
  const detail=definition.nodes.find(n=>n.id==="detail_1");delete outputs.approve;
  assert.throws(()=>workflowInputContext(definition,variant,detail,outputs),/人工确认/);
  outputs.approve={approved:true};
  const context=workflowInputContext(definition,variant,detail,outputs);
  assert.equal(context.refs.find(r=>r.role==="approved_visual").url,outputs.main.url);
  const main=workflowInputContext(definition,variant,definition.nodes.find(n=>n.id==="main"),{});
  assert.equal(main.refs.filter(r=>r.role==="style").length,1);
  assert.equal(main.refs.filter(r=>r.role==="product").length,definition.nodes.find(n=>n.id==='product').count);
});
test("draft mapping isolates variants, orders main first, converts units and replaces template media",()=>{
  const definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==="listing").templateId=23;
  definition.nodes.push({...createWorkflowNode("price","price"),value:870},createWorkflowNode("package","pack"));
  const variants=[material(definition),material(definition,"two")];
  const outputs=Object.fromEntries(variants.map(v=>[v.id,ready(definition,v)]));
  const draft=buildWorkflowDraft(definition,variants,outputs,{editable_payload:{variants:[{offer_id:"OLD",images:["old.png"]}]}},"abc12345-run");
  const rows=draft.template_payload.editable_payload.variants;
  assert.equal(rows.length,2);assert.equal(rows[0].images[0].url,outputs.one.main.url);
  assert.ok(rows[1].images.every(i=>i.url.includes("/two/")));
  assert.equal(rows[0].price,"870");assert.equal(rows[0].weight,50);assert.equal(rows[0].depth,100);
  assert.notEqual(rows[0].offer_id,rows[1].offer_id);assert.ok(!JSON.stringify(draft).includes("old.png"));
  outputs.two.detail_1.approved=false;assert.throws(()=>buildWorkflowDraft(definition,variants,outputs,{},"abc"),/two.*尚未检查/);
});

function storeFixture(){
  const rows=[];
  const query=async(sql,params)=>{const [tenant,kind,id]=params;return rows.filter(r=>r.tenant_id===tenant&&r.kind===kind&&(!id||r.id===id)).map(r=>({...r}));};
  const execute=async(sql,p)=>{
    if(sql.startsWith("CREATE"))return {};
    if(sql.startsWith("INSERT")){const [id,tenant_id,kind,name,payload_json,created_by]=p;rows.push({id,tenant_id,kind,name,payload_json,created_by,revision:1});return {affectedRows:1};}
    const [name,payload_json,tenant,kind,id,revision]=p;const row=rows.find(r=>r.id===id&&r.tenant_id===tenant&&r.kind===kind&&r.revision===revision);
    if(!row)return {affectedRows:0};Object.assign(row,{name,payload_json,revision:revision+1});return {affectedRows:1};
  };
  return createProductWorkflowStore({query,execute,authorize:async s=>s});
}
const session=id=>({personId:id,roles:["operations"],tenant:{id,slug:`tenant-${id}`,role:"member"}});
test("template and run persistence isolate enterprises, reject stale writes and freeze run inputs",async()=>{
  const store=storeFixture(),a=session(1),b=session(2),definition=keyCaseWorkflow();
  const saved=await store.save("template",{payload:definition},a);
  assert.equal((await store.list("template",a)).length,1);assert.equal((await store.list("template",b)).length,0);
  await assert.rejects(store.get("template",saved.id,b),{status:404});
  await assert.rejects(store.save("template",{...saved,revision:0},a),{status:409});
  const variant=material(definition);const run=await store.save("run",{payload:{definition,variants:[variant],outputs:{}}},a);
  run.payload.variants[0].values.brand="Changed";await assert.rejects(store.save("run",run,a),/已锁定/);
});
test("only exact workflow routes with operations authority pass enterprise gates",()=>{
  for(const id of [1,2])for(const [method,path] of [["GET","templates"],["POST","runs"],["POST","import-draft"]]){
    const parts=["api","product-workflows",path];assert.equal(authorizeApiRequest({method,_session:session(id)},parts).allowed,true);assert.equal(tenantIsolationDecision(session(id),parts,method).allowed,true);
    assert.equal(authorizeApiRequest({method,_session:{...session(id),roles:["packing"]}},parts).allowed,false);
  }
  assert.equal(authorizeApiRequest({method:"DELETE",_session:session(1)},["api","product-workflows","templates"]).allowed,false);
});

test("draft import claims before writing and repeated import returns the same draft",async()=>{
  const definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==="listing").templateId=23;
  const variant=material(definition);let payload={definition,variants:[variant],outputs:{[variant.id]:ready(definition,variant)}};
  let creates=0;
  const execute=async(sql,p)=>{if(sql.startsWith("UPDATE")){payload=JSON.parse(p[0]);return [{}];}if(sql.includes("FROM product_workflow_documents"))return [[{payload_json:JSON.stringify(payload)}]];throw new Error("Unexpected SQL");};
  const deps={store:{scope:async()=>({tenant:"1",actor:session(1)})},transaction:async fn=>fn({execute}),execute};
  const services={listingCategoryTemplateDetail:async()=>({editable_payload:{}}),createListingDraft:async()=>{assert.equal(payload.draftImportStatus,"unknown");creates++;return {id:42};}};
  assert.deepEqual(await importProductWorkflowDraft("run-1",session(1),services,deps),{id:42});
  assert.deepEqual(await importProductWorkflowDraft("run-1",session(1),services,deps),{id:42});assert.equal(creates,1);
});
