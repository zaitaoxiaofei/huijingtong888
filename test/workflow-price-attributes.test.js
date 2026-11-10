import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowTemplateFields,applyWorkflowBindings,resolveWorkflowBindings,addDefaultWorkflowBindings} from '../src/shared/product-workflow-bindings.js';
import {categoryAttributeNodes,workflowDictionaryOptions,refreshWorkflowCategory,attributeSelectedValues,readableWorkflowValue} from '../src/shared/product-workflow-inputs.js';
import {buildWorkflowDraft,validateWorkflow} from '../src/shared/product-workflow.js';
function fixture(){
 const nodes=[{id:'listing',type:'listing',label:'类目',templateId:1,inputs:[]},...['price','old_price'].map(key=>({id:key,type:'field',label:key,inputs:[],required:false,valueSource:'user',inputFormat:'number'}))];
 const definition={schemaVersion:1,name:'模板',globalPrompt:'真实',nodes,bindings:{price:{sources:[{nodeId:'price',output:'value'}]},old_price:{sources:[{nodeId:'old_price',output:'value'}]}}};
 return {definition,variant:{id:'one',label:'产品',values:{price:456,old_price:599}}};
}
test('workflow includes sale and crossed-out prices with default RMB labels',()=>{
 const f=workflowTemplateFields();for(const key of ['price','old_price'])assert.match(f.find(f=>f.key===key).label,/人民币.*CNY/);
 assert.match(workflowTemplateFields({},'RUB').find(f=>f.key==='price').label,/RUB/);
});
test('both prices and CNY survive workflow output and draft editing without inheriting old SKU currency',()=>{
 const {definition,variant}=fixture();validateWorkflow(definition);
 const row=applyWorkflowBindings(definition,variant,{});assert.equal(row.price,'456');assert.equal(row.old_price,'599');assert.equal(row.currency_code,'CNY');
 const base={currency_code:'RUB',editable_payload:{currency_code:'RUB',price:{value:999,old_price:1999,currency_code:'RUB'}}};
 const draft=buildWorkflowDraft(definition,[variant],{one:{}},base,'test-run');
 assert.deepEqual(draft.template_payload.editable_payload.price,{value:456,old_price:599,currency_code:'CNY'});
 assert.equal(draft.template_payload.currency_code,'CNY');assert.equal(draft.template_payload.editable_payload.currency_code,'CNY');assert.equal(draft.template_payload.editable_payload.variants[0].old_price,'599');assert.equal(base.editable_payload.price.value,999);
});
test('crossed-out price accepts zero to disable it and rejects invalid or smaller prices',()=>{
 const {definition,variant}=fixture();variant.values.old_price=0;assert.equal(resolveWorkflowBindings(definition,variant,{}).old_price,0);
 for(const n of [-1,400,456,'oops']){variant.values.old_price=n;assert.throws(()=>resolveWorkflowBindings(definition,variant,{}));}
 definition.currencyCode='RUB';variant.values.old_price=599;assert.equal(applyWorkflowBindings(definition,variant,{}).currency_code,'RUB');
});
test('translated country option beats stale selected China while preserving dictionary ID and platform value',()=>{
 const schema=[{id:4389,name_zh:'原产国',dictionary_id:99,is_collection:true,values:[{id:90296,value:'China',display_value_zh:'中国'}]}];
 const template={attributes:[{attribute_id:4389,dictionary_id:99,selected_values:[{dictionary_value_id:90296,value:'China'}]}]};
 const [node]=categoryAttributeNodes(template,schema);assert.deepEqual(node.options,[{id:90296,label:'中国',value:'China'}]);assert.deepEqual(node.defaultValue,[90296]);assert.deepEqual(attributeSelectedValues(node,[90296]),[{dictionary_value_id:90296,value:'China'}]);assert.equal(readableWorkflowValue(node,[90296]),'中国');
 const live=workflowDictionaryOptions([{id:90296,value:'China'}],node.options,4389);assert.equal(live[0].label,'中国');
 assert.equal(workflowDictionaryOptions([{id:1,value:'China'}],[],85)[0].label,'China');
});
test('all official fields remain present, including optional numbers and fields beyond initial dictionary page',()=>{
 const schema=Array.from({length:85},(_,i)=>({id:1000+i,name_zh:`属性${i}`,attribute_type:'Integer',dictionary_id:0,is_required:false}));
 const nodes=categoryAttributeNodes({},schema);assert.equal(nodes.length,85);assert.equal(nodes[84].inputFormat,'number');
 assert.equal(workflowTemplateFields({attributes:nodes}).filter(f=>f.key.startsWith('attribute_')).length,85);
});
test('refresh adds new category fields and corrects display without overwriting authored values or references',()=>{
 const definition={category:{descriptionCategoryId:1,typeId:2,attributes:[]},nodes:[{id:'origin',type:'attribute',attributeId:4389,dictionaryId:99,label:'原产国',defaultValue:[90296],options:[{id:90296,label:'China'}]}],bindings:{attribute_4389:{sources:[{nodeId:'origin',output:'value'}]}}};
 const before=structuredClone(definition.bindings);
 refreshWorkflowCategory(definition,{descriptionCategoryId:1,typeId:2,attributes:[{attributeId:4389,label:'原产国',dictionaryId:99,options:[{id:90296,label:'中国',value:'China'}]},{attributeId:999,label:'新属性',dictionaryId:0}]});
 assert.equal(definition.category.attributes.length,2);assert.equal(definition.nodes[0].options[0].label,'中国');assert.deepEqual(definition.nodes[0].defaultValue,[90296]);assert.deepEqual(definition.bindings,before);
});
test('authoritative zero dictionary metadata and false collection flags do not inherit stale flags',()=>{
 const nodes=categoryAttributeNodes({attributes:[{id:8,dictionary_id:9,is_collection:true,selected_values:[{value:'saved text'}]}]},[{id:8,name:'Text',dictionary_id:0,is_collection:false}]);
 assert.equal(nodes[0].dictionaryId,0);assert.equal(nodes[0].multiple,false);assert.equal(nodes[0].defaultValue,'saved text');
});

test('opening an old workflow fixes the generated price label but preserves its number and custom labels',()=>{
 const {definition}=fixture();definition.nodes.find(n=>n.id==='price').label='售价（RUB）';definition.nodes.find(n=>n.id==='price').defaultValue=456;definition.nodes.find(n=>n.id==='old_price').label='自定义活动原价';
 addDefaultWorkflowBindings(definition);assert.equal(definition.nodes.find(n=>n.id==='price').defaultValue,456);assert.match(definition.nodes.find(n=>n.id==='price').label,/人民币/);assert.equal(definition.nodes.find(n=>n.id==='old_price').label,'自定义活动原价');
});
