import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndependentImageNode } from '../frontend/admin/utils/workflow-image-nodes.js';
import { keyCaseProductionWorkflow } from '../src/shared/key-case-production-workflow.js';
import { validateWorkflow } from '../src/shared/product-workflow.js';
import { expandWorkflowVariants } from '../src/shared/product-workflow-inputs.js';
import { workflowGenerationInput } from '../src/services/product-workflow-execution.js';

function fixture() {
  const definition = keyCaseProductionWorkflow({templateId:12,categoryName:'钥匙壳',attributes:[]});
  definition.nodes.find(n => n.id === 'style').defaultValue = ['https://example.test/old-main.png'];
  definition.nodes.find(n => n.id === 'style_details').defaultValue = Array.from({length:5},(_,i)=>`https://example.test/old-detail-${i}.png`);
  return definition;
}
function add(definition) {
  const created = createIndependentImageNode(definition.nodes);
  definition.nodes.splice(definition.nodes.findIndex(n=>n.type==='image'),0,created.reference);
  definition.nodes.push(created.node);
  return created;
}

test('new image has an independent empty reference, not the previous template style sheets', () => {
  const definition = fixture();
  const oldInputs = structuredClone(definition.nodes.find(n=>n.id==='detail_1').inputs);
  const first = add(definition), second = add(definition);
  assert.notEqual(first.reference.id, second.reference.id);
  assert.deepEqual(first.reference.defaultValue, ['']);
  assert.ok(first.node.inputs.includes(first.reference.id));
  assert.ok(first.node.inputs.includes('product'));
  assert.ok(first.node.inputs.includes('key'));
  assert.ok(!first.node.inputs.includes('style'));
  assert.ok(!first.node.inputs.includes('style_details'));
  assert.ok(!second.node.inputs.includes(first.reference.id));
  first.node.label = '新车赠礼'; first.node.prompt = '只生成本张赠礼场景';
  first.reference.defaultValue[0] = 'https://example.test/new-gift.png';
  assert.deepEqual(second.reference.defaultValue, ['']);
  assert.deepEqual(definition.nodes.find(n=>n.id==='detail_1').inputs, oldInputs);
  validateWorkflow(definition);
  const restored = JSON.parse(JSON.stringify(definition));
  const [variant] = expandWorkflowVariants(restored, [{id:'one',values:{product:['https://example.test/product.png']}}],{key:['https://example.test/key.png']});
  const generated = workflowGenerationInput(restored,variant,restored.nodes.find(n=>n.id===first.node.id),{});
  assert.ok(generated.sourceImageUrls.includes('https://example.test/new-gift.png'));
  assert.ok(generated.sourceImageUrls.includes('https://example.test/product.png'));
  assert.ok(!generated.sourceImageUrls.some(url=>url.includes('old-')));
  assert.ok(generated.finalPrompt.includes('只生成本张赠礼场景'));
});

test('existing per-shot references are preserved and old references can still be explicitly selected', () => {
  const definition = fixture();
  const {node,reference} = add(definition);
  node.inputs.push('style_details'); node.referenceSlots = {style_details:[1]};
  const [variant] = expandWorkflowVariants(definition,[{id:'one',values:{product:['https://example.test/product.png']}}],{});
  const generated = workflowGenerationInput(definition,variant,node,{});
  assert.ok(generated.sourceImageUrls.includes('https://example.test/old-detail-1.png'));
  assert.ok(!generated.sourceImageUrls.includes('https://example.test/old-detail-0.png'));
  node.inputs = node.inputs.filter(id=>id!==reference.id);
  assert.deepEqual(definition.nodes.find(n=>n.id==='style_details').defaultValue,Array.from({length:5},(_,i)=>`https://example.test/old-detail-${i}.png`));
});
