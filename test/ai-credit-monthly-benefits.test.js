import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAiCreditLedger } from "../src/services/ai-credit-ledger.js";
import { readAiCreditModeFromQuery } from "../src/services/ai-credit-provider-context.js";
import { runAiCreditMonthlyBenefits } from "../src/services/ai-credit-monthly-benefits.js";
import { aiCreditPoints, aiCreditPointsValue, aiCreditPointsText, aiCreditYuanText } from "../src/shared/ai-credit-points.js";
import { createAiCreditSqlFixture, aiCreditSqlFixtureAvailable } from "./helpers/ai-credit-sql-fixture.js";

const sqlTest = (name, run) => test(name, { skip: !aiCreditSqlFixtureAvailable && "Native SQLite with exact integer reads requires a newer Node runtime" }, run);
const actor = (id = 2, personId = 7) => ({ personId, roles: ['operations'], tenant: { id, slug: id === 1 ? 'default' : id === 2 ? 'customer-a' : 'customer-b' } });
function fixture(t) {
  const db = createAiCreditSqlFixture(); db.seed(); t.after(db.close);
  let now = new Date('2026-11-30T15:59:59Z');
  const ledger = createAiCreditLedger({ transaction: db.transaction, clock: () => now });
  return { ...db, ledger, setNow: value => { now = new Date(value); } };
}

test('precise points and currency survive values above JavaScript safe integers', () => {
  assert.equal(aiCreditPointsValue(10000000000000000n), '10000000000000000');
  assert.equal(aiCreditPointsValue(9999999999999990n), '9999999999999990');
  assert.equal(aiCreditPointsText('9999999999999991'), '9,999,999,999,999,991');
  assert.equal(aiCreditYuanText('9999999999999991'), '99999999999999.91');
  assert.throws(() => aiCreditPoints(Number('9999999999999991')), { code: 'AI_CREDIT_INVALID' });
  assert.throws(() => aiCreditPoints('9223372036854775808'), { code: 'AI_CREDIT_INVALID' });
});

sqlTest('employees share one monthly grant; Beijing month rollover accumulates exactly once', async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.ledger.wallet(actor(2, index % 2 ? 7 : 8))));
  assert.equal((await f.ledger.wallet(actor())).available_points, 100);
  assert.equal((await f.query("SELECT COUNT(*) n FROM ai_credit_entries WHERE tenant_id=2"))[0].n, 1);
  f.setNow('2026-11-30T16:00:00Z');
  await Promise.all([f.ledger.wallet(actor()), f.ledger.wallet(actor(2,8))]);
  assert.equal((await f.ledger.wallet(actor())).available_points, 200);
  const rows = await f.ledger.entries(actor());
  assert.deepEqual(rows.map(row => row.entry_key), ['monthly:2026-12', 'monthly:2026-11']);
  assert.ok(rows.every(row => row.kind === 'monthly_grant'));
  assert.equal((await f.ledger.wallet(actor(3))).available_points, 100);
  assert.equal((await f.ledger.audit(actor())).consistent, true);
});

sqlTest('default enterprise starts at exactly 10^16 and ten-point image settlement never resets or rounds it', async t => {
  const f = fixture(t), session = actor(1);
  assert.equal((await f.ledger.wallet(session)).available_points, '10000000000000000');
  const input = { idempotencyKey: 'persisted-image', inputSha256: createHash('sha256').update('image').digest('hex'), priceKey: 'image.generate' };
  const task = await f.ledger.reserve(session, input);
  assert.equal((await f.ledger.wallet(session)).available_points, '9999999999999990');
  assert.equal((await f.ledger.wallet(session)).frozen_points, 10);
  const attempt = await f.ledger.startAttempt(session, task.id, { attemptKey: '1', provider: 'offline', model: 'fixture' });
  await f.ledger.recordOutcome(session, task.id, { attemptId: attempt.id, outcome: 'succeeded', successfulResults: 1,
    outcomeSha256: 'a'.repeat(64), resultReference: 'private:fixture', resultSha256: 'b'.repeat(64) });
  assert.equal((await f.ledger.wallet(session)).available_points, '9999999999999990');
  assert.equal((await f.ledger.wallet(session)).frozen_points, 0);
  assert.equal((await f.ledger.reserve(session, input)).charged_points, 10);
  const restarted = createAiCreditLedger({ transaction: f.transaction, clock: () => new Date('2026-11-30T15:59:59Z') });
  assert.equal((await restarted.wallet(session)).available_points, '9999999999999990');
  f.setNow('2026-11-30T16:00:00Z');
  assert.equal((await f.ledger.wallet(session)).available_points, '10000000000000090');
  assert.equal((await f.ledger.audit(session)).consistent, true);
  assert.ok(f.queries.filter(q => q.sql.includes('FROM ai_credit_accounts')).every(q => q.sql.includes('CAST(available_points AS CHAR)')));
});

sqlTest('a disabled or unauthorized enterprise cannot mint grants or switch itself to internal mode', async t => {
  const f = fixture(t);
  await assert.rejects(f.ledger.wallet({ ...actor(2), tenant: { id: 2, slug: 'default' } }), { code: 'TENANT_TASK_ACCESS_DENIED' });
  await f.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2');
  await assert.rejects(f.ledger.wallet(actor()), { code: 'TENANT_TASK_ACCESS_DENIED' });
  assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_accounts'))[0].n, 0);
  await f.ledger.wallet(actor(1));
  await f.query("UPDATE ai_credit_accounts SET status='disabled' WHERE tenant_id=1");
  f.setNow('2026-12-01T00:00:00Z');
  assert.equal((await f.ledger.wallet(actor(1))).available_points, '10000000000000000');
  await assert.rejects(readAiCreditModeFromQuery(actor(1), f.query), { code: 'AI_CREDIT_ACCOUNT_DISABLED' });
  await assert.rejects(readAiCreditModeFromQuery(actor(3), f.query), { code: 'AI_CREDIT_ACCOUNT_NOT_CONFIGURED' });
});

sqlTest('the scheduled sweep initializes eligible enterprises once without paid provider calls', async t => {
  const f = fixture(t);
  await runAiCreditMonthlyBenefits({ query: f.query, transaction: f.transaction });
  await runAiCreditMonthlyBenefits({ query: f.query, transaction: f.transaction });
  assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_accounts'))[0].n, 3);
  assert.equal((await f.query("SELECT COUNT(*) n FROM ai_credit_entries WHERE kind='monthly_grant'"))[0].n, 3);
  assert.equal((await f.query("SELECT CAST(available_points AS CHAR) points FROM ai_credit_accounts WHERE tenant_id=1"))[0].points, '10000000000000000');
});

sqlTest('failed monthly/default grant journals roll back the account and retry without duplicated funds', async t => {
  for (const entryKey of ['monthly:2026-11','default-opening:20261110']) {
    const f = fixture(t);
    const broken = createAiCreditLedger({ clock: () => new Date('2026-11-10T00:00:00Z'), transaction: run => f.transaction(connection => run({ execute: async (sql, params) => {
      if (sql.includes('INSERT INTO ai_credit_entries') && params[1] === entryKey) throw new Error('fixture journal unavailable');
      return connection.execute(sql, params);
    } })) });
    await assert.rejects(broken.wallet(actor(1)), /fixture journal unavailable/);
    assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_accounts'))[0].n, 0);
    assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_entries'))[0].n, 0);
    const wallet = await f.ledger.wallet(actor(1));
    assert.equal(JSON.parse(JSON.stringify(wallet)).available_points, '10000000000000000');
    assert.equal((await f.ledger.audit(actor(1))).consistent, true);
  }
});

sqlTest('a customer gets ten image reservations from the monthly grant and cannot mint more by retrying', async t => {
  const f = fixture(t), tasks = [];
  for (let index = 0; index < 10; index++) tasks.push(await f.ledger.reserve(actor(), { idempotencyKey: `image-${index}`, inputSha256: 'c'.repeat(64), priceKey: 'image.generate' }));
  assert.equal((await f.ledger.wallet(actor())).available_points, 0);
  await assert.rejects(f.ledger.reserve(actor(), { idempotencyKey: 'image-extra', inputSha256: 'd'.repeat(64), priceKey: 'image.generate' }), { code: 'AI_CREDIT_INSUFFICIENT' });
  assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_tasks'))[0].n, 10);
  for (const task of tasks) await f.ledger.releaseUnsubmitted(actor(), task.id);
  assert.equal((await f.ledger.wallet(actor())).available_points, 100);
  assert.equal((await f.query("SELECT COUNT(*) n FROM ai_credit_entries WHERE kind='monthly_grant'"))[0].n, 1);
});

sqlTest('a missing historical wallet is never recreated over existing credit journal facts', async t => {
 const f=fixture(t);await f.ledger.wallet(actor(1));
 await f.query('DELETE FROM ai_credit_accounts WHERE tenant_id=1');
 await assert.rejects(f.ledger.wallet(actor(1)),{code:'AI_CREDIT_STORAGE_UNAVAILABLE'});
 assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_accounts'))[0].n,0);
 assert.equal((await f.query('SELECT COUNT(*) n FROM ai_credit_entries'))[0].n,2);
});
