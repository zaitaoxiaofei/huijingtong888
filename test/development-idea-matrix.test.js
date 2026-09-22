import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable } from '../src/services/development-task-plan.js';
import { buildDevelopmentHeatmap } from '../frontend/admin/utils/development-heatmap.js';

const model = (brand = 'BYD', category = '钥匙壳', id = 1, target = 10) => ({ brand, category, scope: 'automotive', model_id: id, model: id === 1 ? '豹3' : 'H6', target, draft_ids: [] });
const group = (key, models) => ({ key, models });
const body = groups => ({ title: '组合开发', development_tasks: groups, assignee_person_id: 7, development_due_at: '2026-09-30' });
function harness() {
  let state = { ideas: [], tasks: [], legacyDrafts: [], nextIdea: 1, nextTask: 11 };
  let failAfterTaskWrite = false;
  const drafts = [{ id: 101, product_name: '原成果', created_by_person_id: 7, sku_count: 3 }];
  const writes = [];
  const execute = async (sql, params = []) => {
    writes.push({ sql, params });
    if (sql.startsWith('SELECT id,development_matrix_enabled')) return [state.ideas.filter(row => row.id === params[0])];
    if (sql.startsWith('SELECT id,automation_key')) return [state.tasks.filter(row => row.automation_key.startsWith(`idea_scope:${params[0]}:`) || row.automation_key === `development_idea:${params[0]}`)];
    if (sql.startsWith('SELECT draft_id')) return [state.legacyDrafts];
    if (sql.startsWith('INSERT INTO product_development_ideas')) { const id = state.nextIdea++; state.ideas.push({ id, title: params[0] }); return [{ insertId: id }]; }
    if (sql.startsWith('UPDATE product_development_ideas SET title=')) {
      Object.assign(state.ideas.find(row => row.id === params[11]), { development_matrix_enabled: 1, assignee_person_id: params[6], development_due_at: params[8], target_product_count: params[7] }); return [{}];
    }
    if (sql.startsWith('UPDATE team_tasks SET active=0')) { state.tasks.find(row => row.id === params[0]).active = 0; return [{}]; }
    if (sql.startsWith('INSERT INTO team_tasks') || sql.startsWith('UPDATE team_tasks SET title=')) {
      const row = sql.startsWith('INSERT') ? { id: state.nextTask++ } : state.tasks.find(task => task.id === params[9]);
      Object.assign(row, { title: params[0], owner_person_id: params[1], target_count: params[2], done_count: params[3], status: params[4], due_at: params[5], related_object: params[6], automation_key: params[8], active: 1 });
      if (sql.startsWith('INSERT')) state.tasks.push(row);
      if (failAfterTaskWrite) throw new Error('模拟数据库写入失败');
      return [{ insertId: row.id }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const context = vm.createContext({ Buffer, Date, Map, Set, console,
    isMysqlPrimaryEnabled: () => true, readDevelopmentPlan, normalizeDevelopmentPlan, developmentPlanProgress, developmentPlanDeliverable,
    aiVehicleCatalog: async () => ({ brands: [{ name: 'BYD', models: [{ id: 1, name: '豹3' }] }, { name: 'HAVAL', models: [{ id: 2, name: 'H6' }] }] }),
    inventoryProductNamingOptions: async () => ({ rows: [{ value: '钥匙壳' }, { value: '脚垫' }] }),
    mysqlQuery: async (sql, params) => {
      if (sql.includes('FROM people')) return [{ id: 7 }];
      if (sql.includes('FROM listing_drafts')) return drafts.filter(row => params.includes(row.id));
      throw new Error(sql);
    },
    withMysqlTransaction: async callback => { const before = structuredClone(state); try { return await callback({ execute }); } catch (error) { state = before; throw error; } }
  });
  const source = fs.readFileSync(new URL('../src/services/team-tasks.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export async function', 'async function');
  vm.runInContext(`${source}\nteamTasksSchemaReady = true;`, context);
  return { context, get state() { return state; }, writes, fail: () => { failAfterTaskWrite = true; } };
}

test('one inspiration creates multiple tasks atomically; repeat edit reuses original task IDs', async () => {
  const h = harness();
  const request = body([group('first', [model()]), group('second', [model('HAVAL', '脚垫', 2, 20)])]);
  const result = await h.context.createDevelopmentIdeaMysql(request, 7);
  assert.equal(result.task_count, 2);
  assert.equal(h.state.tasks.length, 2);
  assert.equal(h.state.ideas[0].target_product_count, 30);
  const ids = h.state.tasks.map(row => row.id);
  await h.context.updateDevelopmentIdeaMysql(result.id, request);
  assert.deepEqual(h.state.tasks.map(row => row.id), ids);
  assert.equal(h.state.tasks.filter(row => row.active).length, 2);
});

test('merging and splitting preserve model results; inactive archived plans cannot restore removed links', async () => {
  const h = harness();
  const first = model(); const second = model('BYD', '脚垫');
  await h.context.createDevelopmentIdeaMysql(body([group('first', [first]), group('second', [second])]), 7);
  const original = JSON.parse(h.state.tasks[1].related_object); original.models[0].draft_ids = [101];
  h.state.tasks[1].related_object = JSON.stringify(original);
  await h.context.updateDevelopmentIdeaMysql(1, body([group('first', [first, second])]));
  let plan = JSON.parse(h.state.tasks[0].related_object);
  assert.deepEqual(plan.models.map(row => row.draft_ids), [[], [101]]);
  assert.equal(h.state.tasks[1].active, 0);
  assert.equal(h.state.tasks[0].done_count, 3);
  plan.models[1].draft_ids = []; h.state.tasks[0].related_object = JSON.stringify(plan);
  await h.context.updateDevelopmentIdeaMysql(1, body([group('first', [first]), group('second', [second])]));
  assert.deepEqual(JSON.parse(h.state.tasks[1].related_object).models[0].draft_ids, []);
  assert.equal(h.state.tasks.length, 2);
});

test('old task ID and historical drafts survive conversion without inventing a model assignment', async () => {
  const h = harness();
  h.state.ideas.push({ id: 8, assignee_person_id: 7, development_due_at: '2026-09-30' });
  h.state.tasks.push({ id: 88, active: 1, owner_person_id: 7, due_at: '2026-09-30', automation_key: 'development_idea:8', related_object: '{}' });
  h.state.legacyDrafts.push({ draft_id: 101 });
  await h.context.updateDevelopmentIdeaMysql(8, body([group('first', [model()])]));
  assert.equal(h.state.tasks.length, 1); assert.equal(h.state.tasks[0].id, 88);
  const plan = JSON.parse(h.state.tasks[0].related_object);
  assert.deepEqual(plan.unallocated_draft_ids, [101]); assert.deepEqual(plan.models[0].draft_ids, []);
  const progress = developmentPlanProgress(plan, [{ id: 101, sku_count: 3 }]);
  assert.equal(progress.unallocated_drafts[0].count, 3); assert.equal(progress.done, 0);
});

test('removed model results stay in allocation tray and independently edited owner/due survive note edits', async () => {
  const h = harness();
  await h.context.createDevelopmentIdeaMysql(body([group('first', [model(), model('BYD', '脚垫')])]), 7);
  const row = h.state.tasks[0]; const plan = JSON.parse(row.related_object); plan.models[1].draft_ids = [101]; row.related_object = JSON.stringify(plan);
  row.owner_person_id = 9; row.due_at = '2026-10-01';
  await h.context.updateDevelopmentIdeaMysql(1, body([group('first', [model()])]));
  assert.deepEqual(JSON.parse(row.related_object).unallocated_draft_ids, [101]);
  assert.equal(row.owner_person_id, 9); assert.equal(row.due_at, '2026-10-01');
});

test('failed child write rolls back inspiration and tasks, and repeated coordinates are rejected before writes', async () => {
  const h = harness();
  await assert.rejects(h.context.createDevelopmentIdeaMysql(body([group('a', [model()]), group('b', [model()])])), /不能拆进多个任务/);
  assert.equal(h.writes.length, 0);
  h.fail(); await assert.rejects(h.context.createDevelopmentIdeaMysql(body([group('a', [model()])])), /模拟数据库/);
  assert.equal(h.state.ideas.length, 0); assert.equal(h.state.tasks.length, 0);
});

test('merged plans count each category and brand separately in the heatmap, with one unique task', () => {
  const plan = normalizeDevelopmentPlan({ kind: 'development_matrix', brand: 'BYD', category: '钥匙壳', models: [model(), model('BYD', '脚垫'), model('HAVAL', '脚垫', 2, 20)] }, { type: 'product_development', owner_person_id: 7, due_at: '2026-09-30' });
  const map = buildDevelopmentHeatmap([{ id: 1, type: 'product_development', development_plan: plan }], { metric: 'planned' });
  assert.equal(map.taskCount, 1); assert.equal(map.total, 40); assert.equal(map.rows.length, 2); assert.equal(map.columns.length, 2);
  const byd = map.rows.find(row => row.label.includes('BYD'));
  assert.equal(map.cell(byd, '钥匙壳').value, 10); assert.equal(map.cell(byd, '脚垫').value, 10);
});

test('matrix inspirations may be unassigned, and Date-valued database deadlines survive later edits', async () => {
  const h = harness();
  const request = { ...body([group('first', [model()])]), assignee_person_id: null, development_due_at: '' };
  await h.context.createDevelopmentIdeaMysql(request, 7);
  assert.equal(h.state.tasks[0].owner_person_id, null); assert.equal(h.state.tasks[0].due_at, null);
  h.state.ideas[0].development_due_at = new Date('2026-09-30T00:00:00Z');
  h.state.tasks[0].due_at = new Date('2026-10-01T00:00:00Z');
  await h.context.updateDevelopmentIdeaMysql(1, { ...request, development_due_at: '2026-09-30' });
  assert.equal(h.state.tasks[0].due_at, '2026-10-01');
});
