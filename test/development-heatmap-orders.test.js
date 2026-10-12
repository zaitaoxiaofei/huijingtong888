import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

test('saving an occupied development sequence replaces the previous coordinate', async () => {
  const rows = new Map();
  const source = fs.readFileSync(new URL('../src/services/team-tasks.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export async function', 'async function');
  const context = vm.createContext({
    createHash,
    isMysqlPrimaryEnabled: () => true,
    withMysqlTransaction: async work => work({ execute: async (sql, params) => {
      if (sql.includes('SELECT dimension,coordinate_hash,sequence_number FROM product_development_heatmap_orders')) {
        return [[...rows.values()].filter(row => row.period === params[0]).map(row => ({ dimension: row.dimension, coordinate_hash: row.hash, sequence_number: row.sequence }))];
      }
      if (sql.includes('UPDATE product_development_heatmap_orders SET sequence_number=NULL')) {
        for (const row of rows.values()) {
          if (row.period !== params[0]) continue;
          if (params.length === 3 ? row.dimension === params[1] && row.hash === params[2]
            : row.sequence === params[1] && !(row.dimension === params[2] && row.hash === params[3])) row.sequence = null;
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO product_development_heatmap_orders')) {
        const [period, dimension, hash, coordinate, sequence, marked] = params;
        rows.set(hash, { period, dimension, hash, coordinate, sequence, marked });
        return [{ affectedRows: 1 }];
      }
      throw new Error(sql);
    } })
  });
  vm.runInContext(`${source}\nteamTasksSchemaReady=true;`, context);
  const period_key = 'month:2026-10';
  const dimension = 'brand';
  const first = JSON.stringify(['automotive', 'TENET', '挡风板', '']);
  const second = JSON.stringify(['automotive', 'TENET', '脚垫', '']);
  const save = (entries, grain = dimension) => context.saveDevelopmentHeatmapOrdersMysql({ period_key, dimension: grain, entries });

  await save([{ coordinate_key: first, sequence: 1 }]);
  await save([{ coordinate_key: second, sequence: 1 }]);
  assert.equal([...rows.values()].find(row => row.coordinate === first).sequence, null);
  assert.equal([...rows.values()].find(row => row.coordinate === second).sequence, 1);

  await save([{ coordinate_key: first, sequence: 1 }, { coordinate_key: second, sequence: 1 }]);
  assert.deepEqual([...rows.values()].filter(row => row.sequence === 1).map(row => row.coordinate), [second]);

  const model = JSON.stringify(['automotive', 'TENET', '脚垫', 'T7']);
  await save([{ coordinate_key: model, sequence: 1 }], 'model');
  assert.equal([...rows.values()].find(row => row.coordinate === second).sequence, null);
  assert.deepEqual([...rows.values()].filter(row => row.sequence === 1).map(row => row.coordinate), [model]);

  const legacy = JSON.stringify(['automotive', 'TENET', '门槛条', '']);
  const legacyHash = createHash('sha256').update(legacy).digest('hex');
  rows.set(legacyHash, { period: period_key, dimension, hash: legacyHash, coordinate: legacy, sequence: 1 });
  await save([{ coordinate_key: second, sequence: 2 }]);
  assert.equal([...rows.values()].filter(row => row.sequence === 1).length, 1, 'saving also clears an existing duplicate');
});
