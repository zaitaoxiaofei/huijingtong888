import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { hashPassword, verifyPassword } from '../src/auth-password.js';
const source = readFileSync(new URL('../src/services/mysql-auth-session.js', import.meta.url), 'utf8');
const updateSource = source.slice(source.indexOf('export async function updateOwnProfileMysql'), source.indexOf('export async function findPersonByWechatIdentityMysql')).replaceAll('export ', '');
const passwordHash = hashPassword('Original#9382');
function fixture(duplicate = false) {
  let state = { person: { id: 7, username: 'admin_123', name: 'Owner', password_hash: passwordHash }, session: { person_id: 7, username: 'admin_123', name: 'Owner' } };
  const ids = [];
  const connection = { execute: async (sql, params) => {
    ids.push(params.at(-1));
    if (sql.startsWith('SELECT')) return [[state.person]];
    if (sql.startsWith('UPDATE people')) {
      if (duplicate) throw Object.assign(new Error('Private duplicate detail'), { code: 'ER_DUP_ENTRY' });
      Object.assign(state.person, { name: params[0], username: params[1], avatar_url: params[2] });
    } else if (sql.startsWith('UPDATE sessions')) Object.assign(state.session, { name: params[0], username: params[1] });
    else throw new Error(sql);
    return [{ affectedRows: 1 }];
  } };
  const context = vm.createContext({
    ensureMysqlAuthSessionEnabled() {}, verifyPassword,
    findPersonByIdMysql: async () => state.person,
    withMysqlTransaction: async run => { const before = structuredClone(state); try { return await run(connection); } catch (error) { state = before; throw error; } }
  });
  vm.runInContext(updateSource, context);
  return { update: context.updateOwnProfileMysql, ids, get state() { return state; } };
}
const body = { name: 'Owner', username: 'my-company-admin', current_password: 'Original#9382' };
test('self-service username edit checks the current password and synchronizes only the authenticated person sessions', async () => {
  const f = fixture();
  const result = await f.update(7, { ...body, person_id: 999, tenant_role: 'super_admin' });
  assert.equal(result.username, body.username);
  assert.equal(f.state.session.username, body.username);
  assert.ok(f.ids.every(id => id === 7));
  assert.equal(result.tenant_role, undefined);
  assert.equal(result.password_hash, passwordHash);
});
test('invalid or conflicting username and wrong current password leave identity and sessions unchanged', async () => {
  for (const [payload, duplicate] of [[{ ...body, username: 'a b' }, false], [{ ...body, current_password: '' }, false], [{ ...body, current_password: 'Wrong#123' }, false], [body, true]]) {
    const f = fixture(duplicate);
    await assert.rejects(f.update(7, payload), error => [400, 409].includes(error.statusCode) && !error.message.includes('Private'));
    assert.equal(f.state.person.username, 'admin_123');
    assert.equal(f.state.session.username, 'admin_123');
  }
});
