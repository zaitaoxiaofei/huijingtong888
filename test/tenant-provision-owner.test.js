import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../src/auth-password.js';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_NAME ||= 'test_db';
process.env.DB_USER ||= 'test_user';
const { saveTenantLoginDelivery, decryptTenantLoginPassword } = await import('../src/services/tenant-login-delivery.js');
process.env.TENANT_LOGIN_ENCRYPTION_KEY = 'tenant-login-provision-test-key-32-characters';
import { tenantPlanMemberLimit } from '../src/services/tenant-plans.js';

const source = readFileSync(new URL('../src/services/tenants.js', import.meta.url), 'utf8');
const createSource = source.slice(source.indexOf('export async function createTenantMysql'), source.indexOf('export async function tenantActivationCodeStatusMysql')).replaceAll('export ', '');
function fixture(failAt = '') {
  let state = { tenants: [], people: [], members: [], codes: [], deliveries: [] };
  const calls = [];
  const connection = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (failAt && sql.startsWith(`INSERT INTO ${failAt}`)) throw new Error('Simulated insert failure');
    if (sql.startsWith('INSERT INTO tenants')) { state.tenants.push(params); return [{ insertId: 7 }]; }
    if (sql.startsWith('INSERT INTO people')) { state.people.push(params); return [{ insertId: 23 }]; }
    if (sql.startsWith('INSERT INTO tenant_login_deliveries')) { state.deliveries.push(params); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('INSERT INTO tenant_members')) { state.members.push(params); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('INSERT INTO tenant_activation_codes')) { state.codes.push(params); return [{ affectedRows: 1 }]; }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const context = vm.createContext({
    text: (value, max = 255) => String(value || '').trim().slice(0, max),
    randomBytes, createHash, hashPassword, tenantPlanMemberLimit, saveTenantLoginDelivery,
    ensureTenantLoginDeliverySchemaMysql: async () => {},
    ensureTenantSchemaMysql: async () => {},
    mysqlQuery: async () => [{ code: 'monthly_team', account_limit: 3, shop_limit: 10, duration_days: 30, subscription_status: 'active' }],
    withMysqlTransaction: async run => { const before = structuredClone(state); try { return await run(connection); } catch (error) { state = before; throw error; } }
  });
  vm.runInContext(createSource, context);
  return { create: context.createTenantMysql, calls, get state() { return state; } };
}

test('one-click enterprise creation provisions one isolated owner and returns only initial login credentials', async () => {
  const f = fixture();
  const result = await f.create({ name: 'Customer', provision_owner: true, plan_code: 'monthly_team' });
  assert.match(result.owner_credentials.username, /^admin_[a-f0-9]{16}$/);
  validatePasswordStrength(result.owner_credentials.password, { username: result.owner_credentials.username });
  assert.equal(verifyPassword(result.owner_credentials.password, f.state.people[0][2]), true);
  assert.equal(f.state.people[0].includes(result.owner_credentials.password), false);
  assert.deepEqual(Array.from(f.state.members[0]), [7, 23]);
  assert.equal(f.state.tenants[0][5], 2);
  assert.equal(f.state.tenants[0][6], 10);
  assert.equal(f.state.codes.length, 0);
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(decryptTenantLoginPassword(f.state.deliveries[0][2], 7, 23), result.owner_credentials.password);
  assert.equal(f.state.deliveries[0][2].includes(result.owner_credentials.password), false);
  assert.equal(result.activation_code, undefined);
  assert.equal(f.calls.some(call => /platform_grants|default/.test(call.sql)), false);
  assert.match(f.calls.find(call => call.sql.startsWith('INSERT INTO tenant_members')).sql, /'owner'/);
  const second = await f.create({ name: 'Another', provision_owner: true });
  assert.notEqual(second.owner_credentials.username, result.owner_credentials.username);
  assert.notEqual(second.owner_credentials.password, result.owner_credentials.password);
});

test('tenant, login identity and owner membership roll back together on failure', async () => {
  for (const failAt of ['tenants', 'people', 'tenant_members', 'tenant_login_deliveries']) {
    const f = fixture(failAt);
    await assert.rejects(f.create({ name: 'Customer', provision_owner: true }), /Simulated/);
    assert.deepEqual(f.state, { tenants: [], people: [], members: [], codes: [], deliveries: [] });
  }
});

test('automatic provisioning cannot import an existing default-enterprise owner', async () => {
  const f = fixture();
  await assert.rejects(f.create({ name: 'Customer', provision_owner: true, owner_person_id: 10 }));
  assert.equal(f.calls.length, 0);
});

test('legacy tenant creation retains explicit owner and activation-code API compatibility', async () => {
  const f = fixture();
  const result = await f.create({ name: 'Legacy', slug: 'legacy', owner_person_id: 10 });
  assert.match(result.activation_code, /^OZ-/);
  assert.equal(result.owner_credentials, undefined);
  assert.equal(f.state.people.length, 0);
  assert.deepEqual(Array.from(f.state.members[0]), [7, 10]);
});
