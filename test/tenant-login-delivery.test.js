import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { hashPassword, verifyPassword } from '../src/auth-password.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_NAME ||= 'test_db';
process.env.DB_USER ||= 'test_user';
const { encryptTenantLoginPassword, decryptTenantLoginPassword, refreshTenantLoginDeliveries } = await import('../src/services/tenant-login-delivery.js');
const keyNames = ['TENANT_LOGIN_ENCRYPTION_KEY', 'TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY', 'SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY'];
async function withKeys(values, run) {
  const previous = keyNames.map(name => process.env[name]);
  for (const name of keyNames) { if (values[name]) process.env[name] = values[name]; else delete process.env[name]; }
  try { return await run(); } finally {
    keyNames.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
}
const testKey = 'stable-test-enterprise-login-key-at-least-32';
const testPassword = 'Admin#9382';
const source = readFileSync(new URL('../src/services/tenant-login-delivery.js', import.meta.url), 'utf8');
const readSource = source.slice(source.indexOf('export async function readTenantLoginDeliveryMysql')).replaceAll('export ', '');
const platform = { personId: 1, platform_role: 'super_admin' };
function fixture({ grant = true, rows = [] } = {}) {
  const calls = [];
  const context = vm.createContext({
    getPlatformGrantMysql: async () => grant ? { person_id: 1 } : null,
    ensureTenantLoginDeliverySchemaMysql: async () => {}, decryptTenantLoginPassword, verifyPassword,
    mysqlQuery: async (sql, params) => { calls.push({ sql, params }); return rows; }
  });
  vm.runInContext(readSource, context);
  return { read: context.readTenantLoginDeliveryMysql, calls };
}

test('login ciphertext supports repeated decryption and cannot be moved to another enterprise or person', async () => {
  await withKeys({ TENANT_LOGIN_ENCRYPTION_KEY: testKey }, () => {
    const encrypted = encryptTenantLoginPassword(testPassword, 7, 23);
    assert.equal(encrypted.includes(testPassword), false);
    assert.equal(decryptTenantLoginPassword(encrypted, 7, 23), testPassword);
    assert.equal(decryptTenantLoginPassword(encrypted, 7, 23), testPassword);
    assert.throws(() => decryptTenantLoginPassword(encrypted, 8, 23));
    assert.throws(() => decryptTenantLoginPassword(encrypted, 7, 24));
    const parts = encrypted.split(':');
    parts[2] = Buffer.alloc(16).toString('base64');
    assert.throws(() => decryptTenantLoginPassword(parts.join(':'), 7, 23));
  });
});

test('login delivery reuses established stable keys, handles rotation and refuses to store without a key', async () => {
  const encrypted = await withKeys({ TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY: testKey }, () => encryptTenantLoginPassword(testPassword, 7, 23));
  await withKeys({ TENANT_LOGIN_ENCRYPTION_KEY: 'new-key-that-is-also-longer-than-32-characters', TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY: testKey }, () => {
    assert.equal(decryptTenantLoginPassword(encrypted, 7, 23), testPassword);
  });
  await withKeys({}, () => assert.throws(() => encryptTenantLoginPassword(testPassword, 7, 23), { statusCode: 503 }));
});

test('only an active platform grant can retrieve a current password, scoped to an active owner in the target enterprise', async () => {
  await withKeys({ TENANT_LOGIN_ENCRYPTION_KEY: testKey }, async () => {
    const f = fixture({ rows: [{ person_id: 23, username: 'latest-owner', enterprise: 'Customer', password_hash: hashPassword(testPassword), password_ciphertext: encryptTenantLoginPassword(testPassword, 7, 23) }] });
    for (let i = 0; i < 2; i++) {
      const info = await f.read(7, platform);
      assert.equal(info.username, 'latest-owner');
      assert.equal(info.password, testPassword);
      assert.equal(info.password_hash, undefined);
      assert.equal(info.password_ciphertext, undefined);
    }
    assert.deepEqual(Array.from(f.calls[0].params), [7]);
    assert.match(f.calls[0].sql, /tm\.active = 1 AND tm\.role = 'owner'/);
    assert.match(f.calls[0].sql, /p\.active = 1/);
    const revoked = fixture({ grant: false });
    await assert.rejects(revoked.read(7, platform), { statusCode: 403 });
    assert.equal(revoked.calls.length, 0);
    for (const role of ['owner', 'admin', 'member']) {
      const session = { personId: 23, roles: ['admin'], tenant: { id: 7, role } };
      await assert.rejects(f.read(7, session), { statusCode: 403 });
      assert.equal(authorizeApiRequest({ method: 'POST', _session: session }, ['api', 'tenants', 'login-info']).allowed, false);
    }
  });
});

test('missing delivery records and password resets through other paths never return obsolete login information', async () => {
  await withKeys({ TENANT_LOGIN_ENCRYPTION_KEY: testKey }, async () => {
    await assert.rejects(fixture().read(7, platform), { statusCode: 404 });
    const f = fixture({ rows: [{ person_id: 23, password_hash: hashPassword('Changed#9382'), password_ciphertext: encryptTenantLoginPassword(testPassword, 7, 23) }] });
    await assert.rejects(f.read(7, platform), { statusCode: 409 });
  });
});

test('personal password changes refresh only previously delivered accounts and bind the new ciphertext to each enterprise', async () => {
  await withKeys({ TENANT_LOGIN_ENCRYPTION_KEY: testKey }, async () => {
    const writes = [];
    const connection = { execute: async (sql, params) => {
      if (sql.startsWith('SELECT')) { assert.deepEqual(params, [23]); return [[{ tenant_id: 7 }]]; }
      writes.push({ sql, params }); return [{ affectedRows: 1 }];
    } };
    await refreshTenantLoginDeliveries(connection, 23, 'Changed#9382');
    assert.deepEqual(writes[0].params.slice(1), [7, 23]);
    assert.equal(decryptTenantLoginPassword(writes[0].params[0], 7, 23), 'Changed#9382');
    await refreshTenantLoginDeliveries({ execute: async () => [[]] }, 24, 'Ordinary#9382');
    assert.equal(writes.length, 1);
  });
});

test('personal password hash and recoverable delivery commit together, and roll back together if refreshing fails', async () => {
  const authSource = readFileSync(new URL('../src/services/mysql-auth-session.js', import.meta.url), 'utf8');
  const passwordSource = authSource.slice(authSource.indexOf('export async function updatePersonPasswordMysql'), authSource.indexOf('export async function updateOwnProfileMysql')).replaceAll('export ', '');
  for (const shouldFail of [false, true]) {
    let state = { hash: 'old-hash', delivery: 'old-delivery' };
    const connection = { execute: async (_sql, params) => { state.hash = params[0]; } };
    const context = vm.createContext({
      ensureMysqlAuthSessionEnabled() {}, ensureTenantLoginDeliverySchemaMysql: async () => {},
      withMysqlTransaction: async work => { const before = { ...state }; try { return await work(connection); } catch (error) { state = before; throw error; } },
      refreshTenantLoginDeliveries: async (conn, personId, password) => {
        assert.equal(conn, connection); assert.equal(personId, 23); assert.equal(password, 'Changed#9382');
        if (shouldFail) throw new Error('refresh failed');
        state.delivery = 'new-delivery';
      }
    });
    vm.runInContext(passwordSource, context);
    const operation = context.updatePersonPasswordMysql(23, 'new-hash', 'Changed#9382');
    if (shouldFail) {
      await assert.rejects(operation, /refresh failed/);
      assert.deepEqual(state, { hash: 'old-hash', delivery: 'old-delivery' });
    } else {
      await operation;
      assert.deepEqual(state, { hash: 'new-hash', delivery: 'new-delivery' });
    }
  }
});
