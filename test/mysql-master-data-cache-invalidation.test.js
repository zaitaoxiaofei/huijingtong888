import assert from 'node:assert/strict';
import test from 'node:test';
import { getCachedMasterData, invalidateMasterDataCache } from '../src/services/mysql-master-data-cache.js';

test('invalidated in-flight loader cannot overwrite a newer cache fill', async () => {
  const key = 'test:invalidated-inflight';
  let resolveOld;
  let resolveFresh;
  let unexpectedLoads = 0;
  invalidateMasterDataCache(key);
  const old = getCachedMasterData(key, () => new Promise((resolve) => { resolveOld = resolve; }));
  await Promise.resolve();
  invalidateMasterDataCache(key);
  const fresh = getCachedMasterData(key, () => new Promise((resolve) => { resolveFresh = resolve; }));
  await Promise.resolve();

  resolveOld('stale');
  assert.equal(await old, 'stale');
  const joined = getCachedMasterData(key, () => { unexpectedLoads += 1; return 'unexpected'; });
  resolveFresh('fresh');
  assert.equal(await fresh, 'fresh');
  assert.equal(await joined, 'fresh');
  assert.equal(await getCachedMasterData(key, () => { unexpectedLoads += 1; return 'unexpected'; }), 'fresh');
  assert.equal(unexpectedLoads, 0);
  invalidateMasterDataCache(key);
});
