import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness() {
  const tasks = [{ id: 1, type: 'product_development', active: true, priority: 'medium' }, { id: 2, type: 'product_development', active: true, priority: 'low' }];
  const writes = [];
  const context = vm.createContext({
    isMysqlPrimaryEnabled: () => true,
    withMysqlTransaction: async callback => callback({ execute: async (sql, params) => {
      writes.push({ sql, params });
      if (sql.startsWith('SELECT id FROM team_tasks')) {
        return [tasks.filter(task => params.includes(task.id) && task.active && task.type === 'product_development').map(task => ({ id: task.id }))];
      }
      if (sql.startsWith('UPDATE team_tasks SET priority=')) {
        for (const task of tasks) if (params.slice(1).includes(task.id) && task.active && task.type === 'product_development') task.priority = params[0];
        return [{ affectedRows: params.length - 1 }];
      }
      throw new Error(sql);
    } })
  });
  const source = fs.readFileSync(new URL('../src/services/team-tasks.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export async function', 'async function');
  vm.runInContext(`${source}\nteamTasksSchemaReady=true;`, context);
  return { context, tasks, writes };
}

test('heatmap priority change deduplicates task IDs and updates them atomically', async () => {
  const { context, tasks, writes } = harness();
  const result = await context.updateDevelopmentTaskPriorityMysql({ task_ids: [1, 1, 2], priority: 'urgent_important' });
  assert.equal(result.updated, 2);
  assert.deepEqual(tasks.map(task => task.priority), ['urgent_important', 'urgent_important']);
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /work_type='product_development'.*FOR UPDATE/);
  assert.match(writes[1].sql, /work_type='product_development'/);
});

test('heatmap priority change rejects invalid priorities and stale task IDs before writing', async () => {
  const { context, writes } = harness();
  await assert.rejects(context.updateDevelopmentTaskPriorityMysql({ task_ids: [1], priority: 'not-a-priority' }));
  await assert.rejects(context.updateDevelopmentTaskPriorityMysql({ task_ids: [1, 404], priority: 'urgent_important' }), /已不存在或不可调整/);
  assert.equal(writes.length, 1, 'stale task IDs are checked under the transaction before the update');
});
