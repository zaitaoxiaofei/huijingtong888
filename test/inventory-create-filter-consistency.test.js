import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue', import.meta.url), 'utf8');
const matchFunction = source.slice(source.indexOf('function componentFieldMatches('), source.indexOf('\nfunction componentMatchReasons('));
const context = vm.createContext({});
vm.runInContext(matchFunction, context);
test('child product material filters match individual structured materials and reject a different material', () => {
  const matches = context.componentFieldMatches;
  for (const material of ['皮革/锌合金', '皮革、锌合金', '皮革,锌合金']) {
    assert.equal(matches({material}, 'material', '锌合金'), true);
    assert.equal(matches({material}, 'material', '硅胶'), false);
  }
  assert.equal(matches({surface_process:'激光'}, 'surface_process', '激光'), true);
  assert.equal(matches({surface_process:'磨砂'}, 'surface_process', '激光'), false);
  assert.equal(matches({material:'皮革'}, 'material', ''), true);
});
test('create product filters expose identity and specification fields without obsolete fitment or packaging inputs', () => {
  const section = source.slice(source.indexOf('<div class="form-section composition-section">'), source.indexOf('<div v-if="componentDirectoryRows.length"'));
  for (const field of ['category','brand','vehicle_model','accessory','color','material','process']) assert.ok(section.includes(`componentDirectory.${field}`));
  for (const field of ['fitment_type','quantity']) assert.ok(!section.includes(`v-model="componentDirectory.${field}"`));
  assert.ok(!source.includes('label="采购数量"'));
});
test('core name counts explicitly normalize historical column collations', () => {
  const naming = readFileSync(new URL('../src/services/inventory-product-naming.js', import.meta.url), 'utf8');
  assert.ok(!naming.includes('p.inventory_category = o.value'));
  assert.equal((naming.match(/p\.inventory_category COLLATE utf8mb4_unicode_ci = o\.value COLLATE utf8mb4_unicode_ci/g) || []).length, 2);
});
