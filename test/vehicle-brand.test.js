import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVehicleBrand, vehicleBrandAliases } from '../src/shared/vehicle-brand.js';
test('canonical brands merge exact English and Chinese aliases without changing brand families', () => {
  for (const value of ['chery', 'Chery', '奇瑞', '奇瑞|Chery', '无品牌|Chery']) assert.equal(normalizeVehicleBrand(value), 'CHERY');
  assert.equal(normalizeVehicleBrand('起亚 KIA'), 'KIA');
  assert.equal(normalizeVehicleBrand('  HiCar-X  '), 'HICAR-X');
  assert.equal(normalizeVehicleBrand('无品牌'), '');
  assert.equal(normalizeVehicleBrand('LEXUS'), 'LEXUS');
  assert.equal(normalizeVehicleBrand('TOYOTA'), 'TOYOTA');
  assert.throws(() => normalizeVehicleBrand('未知中文品牌'), /汽车品牌/);
  assert.ok(vehicleBrandAliases('toyota').includes('丰田'));
});

test('inventory structured naming stores canonical brands and keeps the selected models', async () => {
  const { readFileSync } = await import('node:fs');
  const { default: vm } = await import('node:vm');
  const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8').match(/export function normalizeStructuredNamingMysql\(body = \{\}\) \{[\s\S]*?\n\}/)[0].replace('export ', '');
  const context = vm.createContext({ normalizeVehicleBrand });
  vm.runInContext(source, context);
  for (const brand of ['chery','Chery','奇瑞','奇瑞|CHERY']) {
    const result = context.normalizeStructuredNamingMysql({ structured_naming: { category: '钥匙壳', vehicle_brand: brand, vehicle_models: ['TIGGO 7', 'TIGGO 8'] } });
    assert.equal(result.vehicleBrand, 'CHERY');
    assert.deepEqual(Array.from(result.vehicleModels), ['TIGGO 7', 'TIGGO 8']);
  }
  assert.throws(() => context.normalizeStructuredNamingMysql({ structured_naming: { category: '钥匙壳', vehicle_brand: '未知中文品牌' } }), /汽车品牌/);
});
