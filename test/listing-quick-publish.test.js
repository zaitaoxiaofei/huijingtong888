import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const records = readFileSync(new URL('../frontend/admin/views/listing/ListingPublishRecordsView.vue', import.meta.url), 'utf8');
const variant = readFileSync(new URL('../frontend/admin/views/listing/AiVariantLabView.vue', import.meta.url), 'utf8');
const extract = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

test('quick publish waits for saved drafts and routes only successful IDs', async () => {
  const rows = [{}, {}, {}];
  const routes = [];
  const monitor = new Function('apiClient', 'router', 'ElMessage', 'window', 'draftSaveProgress', `let draftSaveBatchPollTimer = 0; ${extract(variant, 'monitorDraftSaveBatches')}; return monitorDraftSaveBatches;`)(
    { get: async () => ({ status: 'partial', success_count: 2, failed_count: 1, total_count: 3, items: [
      { status: 'completed', result_draft_id: 31 }, { status: 'failed' }, { status: 'completed', result_draft_id: 33 }
    ] }) }, { push: async (route) => routes.push(route) }, { success() {}, warning() {} }, { setTimeout() { throw Error('finished batch must not poll'); } }, {}
  );
  await monitor([{ batchNo: 'test', rows }], true);
  assert.deepEqual(routes, [{ name: 'listing-records', query: { draftIds: '31,33', quickPublish: '1' } }]);
  routes.length = 0;
  await monitor([{ batchNo: 'test', rows }]);
  assert.equal(routes.length, 0, 'ordinary save stays on the current page');
});

test('batch publish resets AI policy on every opening', () => {
  const batchListing = { textVariantEnabled: true, textVariantFailureMode: 'block' };
  const open = new Function('selectedDraftRows', 'ElMessage', 'batchListing', 'state', 'createListingPublishRequestId', 'ensureBatchTextVariantBaseShop', `${extract(records, 'openBatchListingDialog')}; return openBatchListingDialog;`)(
    { value: [{ id: 1 }] }, {}, batchListing, { shops: [{ id: 7 }] }, () => 'request', () => {}
  );
  open();
  assert.equal(batchListing.textVariantEnabled, false);
  assert.equal(batchListing.textVariantFailureMode, 'keep_original');
  assert.equal(batchListing.visible, true);
});

test('failed record retry uses stored payload and releases the lock after failure', async () => {
  const calls = [];
  const errors = [];
  const lock = { value: null };
  const retry = new Function('retryingRecordId', 'apiClient', 'ElMessage', 'loadRecords', `${extract(records, 'retryFailedRecord')}; return retryFailedRecord;`)(
    lock, { post: async (...args) => { calls.push(args); throw Error('shop unavailable'); } }, { error: (message) => errors.push(message) }, async () => {}
  );
  await retry({ id: 8, updated_at: 'version' });
  assert.deepEqual(calls, [['/api/listing/publish-records/8/retry', { updated_at: 'version' }]]);
  assert.deepEqual(errors, ['shop unavailable']);
  assert.equal(lock.value, null);
});
