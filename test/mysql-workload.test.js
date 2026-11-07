import test from 'node:test';
import assert from 'node:assert/strict';
import { currentMysqlWorkload, withMysqlWorkload, mysqlWorkloadLimits, withMysqlTransactionPriority } from '../src/mysql-workload.js';

test('foreground reserve divides the existing connection budget, including deployment candidate and single-connection mode', () => {
  assert.deepEqual(mysqlWorkloadLimits(10), { foreground: 9, background: 1 });
  assert.deepEqual(mysqlWorkloadLimits(4), { foreground: 3, background: 1 });
  assert.deepEqual(mysqlWorkloadLimits(1), { foreground: 1, background: 0 });
  for (let budget = 1; budget <= 100; budget++) {
    const limits = mysqlWorkloadLimits(budget);
    assert.equal(limits.foreground + limits.background, budget);
    assert.ok(limits.foreground >= 1);
    assert.ok(limits.background <= 1, "background reconciliation must not run parallel scans");
  }
});

test('background priority survives awaits but does not leak across concurrent requests or failed nested transactions', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const background = withMysqlWorkload('background', async () => {
    assert.equal(currentMysqlWorkload(), 'background');
    await held;
    assert.equal(currentMysqlWorkload(), 'background');
    await assert.rejects(withMysqlWorkload('foreground', async () => {
      await Promise.resolve();
      assert.equal(currentMysqlWorkload(), 'foreground');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(currentMysqlWorkload(), 'background');
  });
  assert.equal(currentMysqlWorkload(), 'foreground');
  await Promise.resolve();
  release();
  await background;
  assert.equal(currentMysqlWorkload(), 'foreground');
});


test('scheduled transactions serialize without holding up interactive or nested transactions; failures do not poison the queue',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),events=[];
 const first=withMysqlWorkload('background',()=>withMysqlTransactionPriority(async()=>{events.push('first');assert.equal(currentMysqlWorkload(),'foreground');await gate;await withMysqlTransactionPriority(async()=>events.push('nested'));events.push('done');}));
 const second=withMysqlWorkload('background',()=>withMysqlTransactionPriority(async()=>{events.push('second');throw Error('rollback');}));
 const failed=assert.rejects(second,/rollback/);
 await withMysqlTransactionPriority(async()=>events.push('interactive'));
 await new Promise(setImmediate);assert.ok(events.includes('interactive'));assert.ok(!events.includes('second'));
 release();await first;await failed;
 await withMysqlWorkload('background',()=>withMysqlTransactionPriority(async()=>events.push('recovered')));
 assert.ok(events.indexOf('second')>events.indexOf('done'));assert.equal(events.at(-1),'recovered');assert.equal(currentMysqlWorkload(),'foreground');
});
