import test from 'node:test';
import assert from 'node:assert/strict';
import { planWorkflowProductImport, workflowProductImageInput } from '../frontend/admin/utils/workflow-product-import.js';
import { keyCaseWorkflow } from '../src/shared/product-workflow.js';
import { keyCaseProductionWorkflow } from '../src/shared/key-case-production-workflow.js';
import { starterWorkflow } from '../src/shared/workflow-starter.js';

const file = name => ({ name });
const files = (...names) => names.map(file);
const row = (id, product = [''], extra = {}) => ({ id, label: `产品 ${id}`, values: { product }, promptOverrides: {}, ...extra });
const plan = (variants, selected = files('one.png'), extra = {}) => planWorkflowProductImport({ definition: keyCaseWorkflow(), variants, files: selected, ...extra });

test('bulk product upload uses the same input for both key-case presets and the starter sample', () => {
  for (const definition of [keyCaseWorkflow(), keyCaseProductionWorkflow({ templateId: 1, attributes: [] }), starterWorkflow(null, { sample: true })]) {
    const result = planWorkflowProductImport({ definition, variants: [row('first')], files: files('one.png', 'two.jpg', 'three.webp') });
    assert.equal(result.node.id, 'product');
    assert.deepEqual(result.placements.map(item => [item.file.name, item.rowId, item.slot]), [
      ['one.png', 'first', 0], ['two.jpg', null, 0], ['three.webp', null, 0]
    ]);
  }
});

test('custom product-input IDs work without accidentally routing to style or compatibility references', () => {
  const definition = keyCaseWorkflow();
  definition.nodes.find(node => node.id === 'product').id = 'actual_product_photo';
  definition.nodes.unshift({ type: 'images', id: 'custom_style', scope: 'variant', referenceRole: 'style', count: 1, slots: ['风格'] });
  const result = planWorkflowProductImport({ definition, variants: [{ id: 'first', values: { actual_product_photo: [''] } }], files: files('one.png') });
  assert.equal(result.node.id, 'actual_product_photo');
  assert.equal(result.placements[0].rowId, 'first');
});

test('old product inputs without an explicit reference role remain supported', () => {
  const definition = keyCaseWorkflow();
  delete definition.nodes.find(node => node.id === 'product').referenceRole;
  assert.equal(workflowProductImageInput(definition).id, 'product');
});

test('engineer, generated, shared and final-listing inputs are excluded even when named product', () => {
  for (const override of [{ valueSource: 'engineer' }, { valueSource: 'generated' }, { scope: 'shared' }, { inputGroup: 'listing-final' }, { referenceRole: 'compatibility' }]) {
    const definition = keyCaseWorkflow();
    Object.assign(definition.nodes.find(node => node.id === 'product'), override);
    assert.equal(workflowProductImageInput(definition), undefined);
    assert.throws(() => planWorkflowProductImport({ definition, variants: [], files: files('one.png') }), /可编辑的逐件产品图/);
  }
});

test('bulk upload fills blank main-image cards in order while preserving facts, remarks and extra angles', () => {
  const first = row('first', ['', '/uploads/back.png'], { values: { product: ['', '/uploads/back.png'], color: '蓝色', model: 'H3' }, label: '人工备注', promptOverrides: { main: '保留挂绳' } });
  const second = row('second', ['/uploads/existing.png']);
  const third = row('third');
  const variants = [first, second, third];
  const before = structuredClone(variants);
  const result = plan(variants, files('one.png', 'two.png', 'three.png'));
  assert.deepEqual(result.placements.map(item => item.rowId), ['first', 'third', null]);
  assert.deepEqual(variants, before);
});

test('a selected main slot receives the first file and further pictures create separate product main slots', () => {
  const variants = [row('one', ['/uploads/previous.png']), row('two', ['', '/uploads/back.png'])];
  const result = plan(variants, files('front.png', 'other-front.png', 'third-front.png'), { rowId: 'one' });
  assert.deepEqual(result.placements.map(item => [item.rowId, item.slot]), [['one', 0], ['two', 0], [null, 0]]);
});

test('supplementary-angle upload remains a single slot operation without making another product', () => {
  const definition = keyCaseWorkflow();
  Object.assign(definition.nodes.find(node => node.id === 'product'), { count: 2, slots: ['正面', '反面'] });
  const variants = [row('one', ['/uploads/front.png', ''])];
  const result = plan(variants, files('back.png'), { definition, rowId: 'one', slot: 1 });
  assert.deepEqual(result.placements.map(item => [item.rowId, item.slot]), [['one', 1]]);
  assert.throws(() => plan(variants, files('back1.png', 'back2.png'), { definition, rowId: 'one', slot: 1 }), /补充角度一次上传一张/);
});

test('submitted or submission-started rows are never reused or replaced', () => {
  const variants = [row('started', [''], { submissionStarted: true }), row('submitted', [''], { submittedId: 'run-id' }), row('free')];
  const result = plan(variants, files('one.png', 'two.png'));
  assert.deepEqual(result.placements.map(item => item.rowId), ['free', null]);
  for (const rowId of ['started', 'submitted']) assert.throws(() => plan(variants, files('one.png'), { rowId }), /已提交/);
});

test('twenty files are accepted when one empty card exists; the twenty-first is rejected atomically', () => {
  const variants = [row('one')];
  const selected = Array.from({ length: 20 }, (_, index) => file(`${index}.png`));
  assert.equal(plan(variants, selected).placements.length, 20);
  const before = structuredClone(variants);
  assert.throws(() => plan(variants, [...selected, file('overflow.png')]), /最多 20 件/);
  assert.deepEqual(variants, before);
});

test('capacity counts all cards and permits filling/replacing within a full batch', () => {
  const variants = Array.from({ length: 20 }, (_, index) => row(`v${index}`, index === 2 ? [''] : [`/uploads/${index}.png`]));
  assert.equal(plan(variants).placements[0].rowId, 'v2');
  assert.equal(plan(variants, files('replacement.png'), { rowId: 'v0' }).placements[0].rowId, 'v0');
  assert.throws(() => plan(variants, files('one.png', 'two.png')), /最多 20 件/);
});

test('folder sidecars are ignored and accepted file order and file objects are preserved', () => {
  const selected = files('notes.txt', '3.JPG', '1.PNG', 'desktop.ini', '2.WEBP');
  const result = plan([], selected);
  assert.deepEqual(result.placements.map(item => item.file.name), ['3.JPG', '1.PNG', '2.WEBP']);
  assert.equal(result.placements[0].file, selected[1]);
  assert.throws(() => plan([], files('notes.txt', 'vector.svg')), /JPG、PNG 或 WEBP/);
});

test('removed targets and out-of-range slots fail before uploading', () => {
  assert.throws(() => plan([row('one')], files('one.png'), { rowId: 'removed' }), /产品卡片已移除/);
  for (const slot of [-1, 1, 0.5]) assert.throws(() => plan([row('one')], files('one.png'), { rowId: 'one', slot }), /槽位无效/);
});

test('missing image arrays are treated as empty without touching row values or definition', () => {
  const definition = keyCaseWorkflow();
  const variants = [{ id: 'one', values: { color: '银色' } }, { id: 'two' }];
  const before = structuredClone({ definition, variants });
  const result = planWorkflowProductImport({ definition, variants, files: files('one.png', 'two.png') });
  assert.deepEqual(result.placements.map(item => item.rowId), ['one', 'two']);
  assert.deepEqual({ definition, variants }, before);
});

test('invalid product slot configuration is rejected with an actionable message', () => {
  for (const override of [{ count: 0 }, { count: 2 }, { slots: null }]) {
    const definition = keyCaseWorkflow();
    Object.assign(definition.nodes.find(node => node.id === 'product'), override);
    assert.throws(() => plan([], files('one.png'), { definition }), /流程编辑器核对图片数量与用途/);
  }
});
