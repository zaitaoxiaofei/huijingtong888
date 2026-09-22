import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness() {
  const settings = new Map([['procurement_daily', null], ['shipping_daily', null]]);
  const terms = new Map();
  const tasks = [
    { type: 'procurement_daily', date: '2026-09-15', owner: 3 },
    { type: 'procurement_daily', date: '2026-09-16', owner: null },
    { type: 'shipping_daily', date: '2026-09-16', owner: 9 }
  ];
  tasks.forEach((row, index) => { row.id = index + 1; });
  const writes = [];
  const context = vm.createContext({
    isMysqlPrimaryEnabled: () => true,
    mysqlQuery: async (sql, params) => {
      if (sql.includes('SELECT id, automation_key FROM team_tasks')) {
        const row = tasks.find(row => row.id === params[0]);
        return row ? [{ id: row.id, automation_key: `${row.type}:${row.date}` }] : [];
      }
      if (sql.includes('FROM people')) return params[0] === 404 ? [] : [{ id: params[0] }];
      if (sql.includes('FROM team_operational_owners')) return [...settings].map(([type, owner_person_id]) => ({ type, owner_person_id, term_until: terms.get(type) || null, term_expired: terms.get(type) && terms.get(type) < '2026-09-16' ? 1 : 0 }));
      throw new Error(sql);
    },
    mysqlExecute: async (sql, params) => {
      writes.push({ sql, params });
      assert.match(sql, /owner_manually_assigned=1/);
      const row = tasks.find(row => row.id === params[1]);
      row.owner = params[0]; row.manual = true;
      return { affectedRows: 1 };
    },
    withMysqlTransaction: async callback => callback({ execute: async (sql, params) => {
      writes.push({ sql, params });
      if (sql.startsWith('SELECT owner_person_id')) return [[{ owner_person_id: settings.get(params[0]) }]];
      if (sql.startsWith('UPDATE team_operational_owners')) { settings.set(params[3], params[0]); if (params[1]) terms.set(params[3], params[2]); }
      else if (sql.includes('UPDATE team_tasks')) {
        assert.match(sql, /due_at >= DATE\(DATE_ADD\(UTC_TIMESTAMP\(\), INTERVAL 8 HOUR\)\)/);
        assert.match(sql, /automation_key LIKE/);
        assert.match(sql, /owner_manually_assigned=0/);
        for (const row of tasks) if (row.type === params[1] && row.date >= '2026-09-16' && !row.manual) row.owner = params[0];
      } else if (sql.includes('INSERT INTO team_tasks')) {
        const row = tasks.find(row => row.type === params[1] && row.date === params[8]);
        assert.match(sql, /IF\(owner_manually_assigned=1 OR \? IS NULL/);
        if (row) { if (params[11] !== null && !row.manual) row.owner = params[2]; }
        else tasks.push({ type: params[1], date: params[8], owner: params[2] });
      }
      return [{ affectedRows: 1 }];
    } })
  });
  const source = fs.readFileSync(new URL('../src/services/team-tasks.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export async function', 'async function');
  vm.runInContext(`${source}\nteamTasksSchemaReady=true;`, context);
  return { context, tasks, settings, terms, writes };
}

test('fixed owners persist by type, update today, preserve history and carry into subsequent days', async () => {
  const { context, tasks } = harness();
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 7 });
  assert.deepEqual(tasks.map(row => row.owner), [3, 7, 9]);
  await context.setTeamOperationalOwnerMysql({ type: 'shipping_daily', owner_person_id: 8 });
  for (const type of ['procurement_daily', 'shipping_daily']) {
    await context.upsertAutomatedTask({ key: `${type}:2026-09-17`, type, date: '2026-09-17', title: type });
  }
  assert.deepEqual(tasks.map(row => row.owner), [3, 7, 8, 7, 8]);
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 10 });
  await context.upsertAutomatedTask({ key: 'procurement_daily:2026-09-18', type: 'procurement_daily', date: '2026-09-18', title: '采购' });
  assert.deepEqual(tasks.map(row => row.owner), [3, 10, 8, 10, 8, 10]);
  const read = await context.teamOperationalOwnersMysql();
  assert.equal(read.rows.find(row => row.type === 'procurement_daily').owner_person_id, 10);
});

test('missing or inactive owners and unsupported types do not write settings', async () => {
  const { context, writes } = harness();
  for (const body of [{type:'custom',owner_person_id:7},{type:'procurement_daily'},{type:'shipping_daily',owner_person_id:404}]) {
    await assert.rejects(context.setTeamOperationalOwnerMysql(body));
  }
  assert.equal(writes.length,0);
});

test('refresh preserves a legacy daily owner until fixed owner is explicitly configured', async () => {
  const { context, tasks } = harness();
  await context.upsertAutomatedTask({key:'shipping_daily:2026-09-16',type:'shipping_daily',date:'2026-09-16',title:'发货'});
  assert.equal(tasks[2].owner,9);
});


test('manual binding covers old unassigned tasks and survives fixed-owner updates and refresh', async () => {
  const { context, tasks, settings } = harness();
  tasks[0].owner = null;
  for (const [id, owner] of [[1, 7], [3, 8]]) {
    await context.updateTeamTaskMysql(id, { title: '历史任务', owner_person_id: owner });
  }
  assert.equal(tasks[0].owner, 7);
  assert.equal(tasks[2].owner, 8);
  assert.equal(settings.get('shipping_daily'), null);
  await context.setTeamOperationalOwnerMysql({ type: 'shipping_daily', owner_person_id: 10 });
  await context.upsertAutomatedTask({ key: 'shipping_daily:2026-09-16', type: 'shipping_daily', date: '2026-09-16', title: '发货' });
  assert.equal(tasks[2].owner, 8);
  await context.upsertAutomatedTask({ key: 'shipping_daily:2026-09-17', type: 'shipping_daily', date: '2026-09-17', title: '发货' });
  assert.equal(tasks.at(-1).owner, 10);
  await context.updateTeamTaskMysql(3, { title: '历史任务', owner_person_id: 11 });
  assert.equal(tasks[2].owner, 11);
});

test('manual daily owner rejects missing and inactive people without changing task', async () => {
  const { context, writes } = harness();
  for (const owner_person_id of [null, 404]) {
    await assert.rejects(context.updateTeamTaskMysql(1, { title: '历史任务', owner_person_id }), /负责人/);
  }
  assert.equal(writes.length, 0);
});


test('owner term persists and can be renewed or cleared without affecting other types', async () => {
  const { context, terms, settings } = harness();
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 7, term_until: '2099-10-16' });
  assert.equal(terms.get('procurement_daily'), '2099-10-16');
  assert.equal((await context.teamOperationalOwnersMysql()).rows[0].term_until, '2099-10-16');
  await context.setTeamOperationalOwnerMysql({ type: 'shipping_daily', owner_person_id: 8, term_until: '2099-12-01' });
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 7, term_until: '2099-11-16' });
  assert.equal(terms.get('procurement_daily'), '2099-11-16');
  assert.equal(terms.get('shipping_daily'), '2099-12-01');
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 9 });
  assert.equal(terms.get('procurement_daily'), '2099-11-16', 'old clients do not erase a deadline');
  await context.setTeamOperationalOwnerMysql({ type: 'procurement_daily', owner_person_id: 9, term_until: null });
  assert.equal(terms.get('procurement_daily'), null);
  assert.equal(settings.get('procurement_daily'), 9);
});

test('expired owner remains responsible for newly generated tasks until reconfirmed', async () => {
  const { context, settings, terms, tasks } = harness();
  settings.set('procurement_daily', 7); terms.set('procurement_daily', '2026-09-15');
  const current = (await context.teamOperationalOwnersMysql()).rows[0];
  assert.equal(current.term_expired, 1);
  assert.equal(current.owner_person_id, 7);
  await context.upsertAutomatedTask({ key:'procurement_daily:2026-09-17', type:'procurement_daily', date:'2026-09-17', title:'采购' });
  assert.equal(tasks.at(-1).owner, 7);
  assert.equal(terms.get('procurement_daily'), '2026-09-15', 'generation does not silently renew the term');
});

test('invalid and past deadlines cannot overwrite a responsible person', async () => {
  const { context, writes } = harness();
  for (const term_until of ['2000-01-01', '2099-02-29', '2099-04-31', '2099-13-01', '2099-1-01', '2099-10-01T00:00:00Z', {}, false]) {
    await assert.rejects(context.setTeamOperationalOwnerMysql({ type:'procurement_daily',owner_person_id:7,term_until }), /负责截止日期/);
  }
  assert.equal(writes.length, 0);
});

test('one-month shortcut clamps month ends and handles year boundaries in Beijing time', async () => {
  const { shanghaiDateKey } = await import('../frontend/admin/utils/shanghai-date.js');
  const source = fs.readFileSync(new URL('../frontend/admin/components/team/TaskCreationDialog.vue', import.meta.url), 'utf8');
  const implementation = source.match(/function setOneMonth\(\) \{[\s\S]*?\n\}/)[0];
  for (const [today, expected] of [['2027-01-31','2027-02-28'],['2028-01-31','2028-02-29'],['2026-12-31','2027-01-31'],['2026-09-16','2026-10-16']]) {
    const context=vm.createContext({dailyTermUntil:{value:null},shanghaiDateKey:value=>value ? shanghaiDateKey(value) : today});
    vm.runInContext(`${implementation}\nsetOneMonth();`,context);
    assert.equal(context.dailyTermUntil.value,expected);
  }
});
