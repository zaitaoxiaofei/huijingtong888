import assert from 'node:assert/strict';
import test from 'node:test';
import { storeListingRecordDraft, readListingRecordDraft } from '../frontend/admin/utils/listing-record-draft.js';

test('online editor handoff rejects other accounts, enterprises, legacy caches and expired drafts', () => {
  const entries = new Map(), storage = { setItem: (key, value) => entries.set(key, value), getItem: key => entries.get(key) };
  const user = { id: 7, tenant: { id: 2 } }, draft = { template: { title: 'Own enterprise product' }, shop_id: 20 };
  const key = storeListingRecordDraft(draft, user, storage, 1000);
  assert.deepEqual(readListingRecordDraft(key, user, storage, 2000), draft);
  assert.throws(() => readListingRecordDraft(key, { id: 7, tenant: { id: 3 } }, storage, 2000));
  assert.throws(() => readListingRecordDraft(key, { id: 8, tenant: { id: 2 } }, storage, 2000));
  assert.throws(() => readListingRecordDraft(key, user, storage, 31 * 60 * 1000));
  assert.throws(() => readListingRecordDraft(key, user, storage, 999));
  storage.setItem('legacy', JSON.stringify(draft));
  assert.throws(() => readListingRecordDraft('legacy', user, storage, 2000));
});
