import test from 'node:test';
import assert from 'node:assert/strict';
import { keyCaseWorkflow, workflowInputContext } from '../src/shared/product-workflow.js';
import { workflowGenerationInput } from '../src/services/product-workflow-execution.js';

function fixture() {
  const definition=keyCaseWorkflow();
  const variant={id:'chery',label:'Current product',fitments:[{brand:'CHERY',model:'TIGGO 7'}],values:{
    name:'Logo-customized key cover',brand:'CHERY',model:'CHERY TIGGO 7',material:'',color:'black',facts:'One black case',
    product:['https://example.test/current-product.png'],key:['https://example.test/current-key.png'],style:['https://example.test/tenet-style.png']
  }};
  const main=definition.nodes.find(node=>node.id==='main');
  return {definition,variant,main};
}
function promptJson(prompt,prefix) {
  const line=prompt.split('\n').find(line=>line.startsWith(prefix));
  assert.ok(line,`Missing ${prefix}`);
  return JSON.parse(line.slice(prefix.length));
}

test('style and compatibility library records never become confirmed product facts or copy facts',()=>{
  const {definition,variant,main}=fixture();
  definition.sharedMaterialRefs=[{id:'poster',revision:1},{id:'mold',revision:1},{id:'packaging',revision:1}];
  definition.materialSnapshots={
    poster:{name:'Reference poster',role:'style',brand:'TENET',model:'T4',material:'sample-only TPU',notes:'TENET vertical logo; silver type',images:['https://example.test/poster.png']},
    mold:{name:'Shared key shape',role:'compatibility',brand:'TENET',model:'T7',notes:'Keep four buttons; sample badge is TENET',images:['https://example.test/mold.png']},
    packaging:{name:'Confirmed packaging',role:'product',notes:'One black gift box',images:['https://example.test/box.png']}
  };
  const before=structuredClone(definition);
  const context=workflowInputContext(definition,variant,main,{});
  assert.equal(context.facts['品牌'],'CHERY');
  assert.doesNotMatch(JSON.stringify(context.facts),/TENET|sample-only TPU|T4|T7/);
  assert.equal(context.facts['参考资料：Confirmed packaging'],'One black gift box');
  assert.deepEqual(context.referenceNotes,[
    {role:'style',purpose:'Reference poster',notes:'TENET vertical logo; silver type'},
    {role:'compatibility',purpose:'Shared key shape',notes:'Keep four buttons; sample badge is TENET'}
  ]);
  assert.equal(context.refs.find(ref=>ref.url.endsWith('/poster.png')).role,'style');
  assert.equal(context.refs.find(ref=>ref.url.endsWith('/mold.png')).role,'compatibility');
  const copy=definition.nodes.find(node=>node.type==='copy');
  const input=workflowGenerationInput(definition,variant,copy,{});
  assert.doesNotMatch(JSON.stringify(input.sourceContext.workflowFacts),/TENET|sample-only TPU|T4|T7/);
  assert.match(input.summary,/One black gift box/);
  assert.deepEqual(definition,before);
});

test('image-only detail nodes still receive each current variant fitment explicitly',()=>{
  const {definition,variant}=fixture();
  const detail=definition.nodes.find(node=>node.id==='detail_1');
  detail.inputs=['product','style'];
  const other={...structuredClone(variant),id:'geely',fitments:[{brand:'GEELY',model:'MONJARO'}]};
  const first=workflowGenerationInput(definition,variant,detail,{});
  const second=workflowGenerationInput(definition,other,detail,{});
  assert.deepEqual(promptJson(first.finalPrompt,'CONFIRMED FITMENTS: '),variant.fitments);
  assert.deepEqual(promptJson(second.finalPrompt,'CONFIRMED FITMENTS: '),other.fitments);
  assert.doesNotMatch(second.finalPrompt,/CHERY|TIGGO/);
});

test('legacy model text remains available without inventing a customization target',()=>{
  const {definition,variant,main}=fixture();
  delete variant.fitments;
  variant.values.model='CHERY TIGGO 7；CHERY TIGGO 8';
  const input=workflowGenerationInput(definition,variant,main,{});
  assert.deepEqual(promptJson(input.finalPrompt,'CONFIRMED FITMENTS: '),[{model:'CHERY TIGGO 7'},{model:'CHERY TIGGO 8'}]);
  assert.match(input.finalPrompt,/fitment alone does not authorize adding its badge/i);
});

test('logo identity rules take priority over named template examples and preserve actual product marks',()=>{
  const {definition,variant,main}=fixture();
  definition.globalPrompt='Reusable TENET template: keep the TENET logo';
  main.prompt='Put TENET on the back panel';
  const input=workflowGenerationInput(definition,variant,main,{});
  assert.ok(input.finalPrompt.startsWith('PRODUCT IDENTITY AND LOGO RULES (override conflicting template instructions):'));
  assert.match(input.finalPrompt,/Named brands or logo text in reusable template prompts are examples/i);
  assert.match(input.finalPrompt,/Preserve existing marks on the real product/i);
  assert.match(input.finalPrompt,/logo customization is explicitly requested and the exact target is confirmed for this variant/i);
  assert.match(input.finalPrompt,/Compatibility references define key shape and buttons only; their branding must not be transferred/i);
  assert.equal(promptJson(input.finalPrompt,'CONFIRMED FACTS: ')['品牌'],'CHERY');
  assert.deepEqual(promptJson(input.finalPrompt,'CONFIRMED FITMENTS: '),variant.fitments);
  assert.equal(main.prompt,'Put TENET on the back panel'); // Saved templates are not rewritten during execution.
});

test('approved main cannot propagate a conflicting badge into logo and no-logo comparisons',()=>{
  const {definition,variant}=fixture();
  const detail=definition.nodes.find(node=>node.id==='detail_1');
  detail.prompt='Compare the same cover with a logo and without a logo';
  const input=workflowGenerationInput(definition,variant,detail,{main:{url:'https://example.test/generated-tenet-main.png'},approve:{approved:true}});
  assert.match(input.finalPrompt,/approved_visual is a generated style anchor, not independent evidence of branding/i);
  assert.match(input.finalPrompt,/Correct any logo that conflicts with the current real product or confirmed customization target/i);
  assert.match(input.finalPrompt,/logo side may show only the authorized current target/i);
  assert.match(input.finalPrompt,/no-logo side must have a blank marking area/i);
  assert.match(input.finalPrompt,/target is unknown or ambiguous, leave the marking area blank/i);
  assert.match(input.finalPrompt,/never substitute the template brand, invent a logo, or print placeholder text/i);
  assert.equal(promptJson(input.finalPrompt,'REFERENCE ORDER: ').find(ref=>ref.purpose==='主图').role,'approved_visual');
});

test('all real product references occupy the product section before style and key references',()=>{
  const {definition,variant,main}=fixture();
  const product=definition.nodes.find(node=>node.id==='product');
  product.count=2;product.slots=['Front of current product','Back of current product'];
  variant.values.product.push('https://example.test/current-product-back.png');
  main.inputs=['style','key','product'];
  const input=workflowGenerationInput(definition,variant,main,{});
  assert.equal(input.productImageCount,2);
  assert.equal(input.sourceImageUrl,variant.values.product[0]);
  assert.deepEqual(input.sourceImageUrls.slice(0,2),variant.values.product);
  const order=promptJson(input.finalPrompt,'REFERENCE ORDER: ');
  assert.deepEqual(order.slice(0,2).map(ref=>ref.role),['product','product']);
  assert.deepEqual(order.map(ref=>ref.index),[1,2,3,4]);
});

test('a shared product/style URL keeps product authority in either input order',()=>{
  for(const inputs of [['style','product'],['product','style']]) {
    const {definition,variant,main}=fixture();
    main.inputs=inputs;
    variant.values.style=[variant.values.product[0]];
    const input=workflowGenerationInput(definition,variant,main,{});
    assert.deepEqual(input.sourceImageUrls,variant.values.product);
    assert.equal(input.productImageCount,1);
    assert.equal(promptJson(input.finalPrompt,'REFERENCE ORDER: ')[0].role,'product');
  }
});

test('reused product and key-card image keeps extraction purpose and product authority',()=>{
  for(const inputs of [['key','product'],['product','key']]) {
    const {definition,variant,main}=fixture();
    main.inputs=inputs;
    definition.nodes.find(node=>node.id==='key').slots=['Extract only the original key from the right-bottom key card'];
    variant.values.key=[variant.values.product[0]];
    const input=workflowGenerationInput(definition,variant,main,{});
    assert.deepEqual(input.sourceImageUrls,variant.values.product);
    assert.equal(input.productImageCount,1);
    const reference=promptJson(input.finalPrompt,'REFERENCE ORDER: ')[0];
    assert.equal(reference.role,'product');
    assert.match(reference.purpose,/Extract only the original key from the right-bottom key card/);
    assert.match(reference.purpose,/当前变体的真实产品主图/);
  }
});

test('legacy image inputs without roles remain real products ahead of style references',()=>{
  const {definition,variant,main}=fixture();
  const product=definition.nodes.find(node=>node.id==='product');
  delete product.referenceRole;
  product.count=2;product.slots=['Legacy product front','Legacy product back'];
  variant.values.product.push('https://example.test/current-product-back.png');
  main.inputs=['style','product'];
  const input=workflowGenerationInput(definition,variant,main,{});
  assert.equal(input.productImageCount,2);
  assert.deepEqual(input.sourceImageUrls,[...variant.values.product,...variant.values.style]);
  const order=promptJson(input.finalPrompt,'REFERENCE ORDER: ');
  assert.deepEqual(order.map(ref=>ref.role),['product','product','style']);
  assert.deepEqual(order.slice(0,2).map(ref=>ref.purpose),product.slots);
});

test('a genuine TENET product remains supported instead of a blanket brand blacklist',()=>{
  const {definition,variant,main}=fixture();
  variant.values.brand='TENET';variant.values.model='TENET T4';variant.fitments=[{brand:'TENET',model:'T4'}];
  const input=workflowGenerationInput(definition,variant,main,{});
  assert.equal(promptJson(input.finalPrompt,'CONFIRMED FACTS: ')['品牌'],'TENET');
  assert.deepEqual(promptJson(input.finalPrompt,'CONFIRMED FITMENTS: '),variant.fitments);
  assert.match(input.finalPrompt,/Preserve existing marks on the real product/i);
});
