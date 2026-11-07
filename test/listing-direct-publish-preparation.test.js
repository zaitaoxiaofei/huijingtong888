import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import crypto from 'node:crypto';
import { parse } from 'acorn';

const source = readFileSync(new URL('../src/services/listing-automation.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(node => node.declaration || node);
function load(context, name) {
  const node = declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  vm.runInContext(source.slice(node.start, node.end), context);
}
const session = { personId: 7, tenant: { id: 2 } };
function fixture({ preparationFailure = false, persistenceConflict = false } = {}) {
  const records = new Map(), queued = [], calls = [];
  const context = vm.createContext({
    console: { info() {}, warn() {} }, Buffer, crypto,
    needsAiTenantSession: () => false,
    withAiTenantSession: (_session, task) => task(),
    authorizeBusinessTaskSession: async value => value,
    restoreBusinessTaskSession: async () => session,
    assertBusinessTaskPermission() {},
    listingTenantId: () => '2',
    ensureListingAutomationSchema: async () => {},
    LISTING_PUBLISH_SHOP_SELECT: 'SELECT shops', LISTING_PUBLISH_SHOP_CONCURRENCY: 2,
    mapWithConcurrency: async (items, _limit, task) => Promise.all(items.map(task)),
    all: async (sql, params) => sql.includes('JOIN shops') ? [structuredClone(records.get(params[0]))] : [{ id: 20, name: 'Own shop' }],
    row: async () => ({ id: 20, name: 'Own shop' }),
    cleanText: value => String(value || ''),
    parseJson: (value, fallback) => value ? JSON.parse(value) : fallback,
    validateListingTemplatePublishForShop: async () => ({ ok: true, payload: { items: [{ offer_id: 'stable', images: ['current.png'] }] }, warnings: [] }),
    resolveListingSourceProductId: async () => 200,
    normalizeShopTextVariantPolicy: value => value,
    shouldReusePreparedShopWatermarkMedia: body => Boolean(body.skip_publish_watermark),
    prepareSafeShopOfferIds: async payload => structuredClone(payload),
    preparePublishRecordForSubmit: async ({ shopPayload }) => {
      const id = records.size + 1;
      records.set(id, { id: 20, request_json: JSON.stringify(shopPayload), created_by_person_id: 7, task_tenant_id: '2', task_id: '', response_json: null });
      return id;
    },
    runBackgroundListingPublish: (_label, task) => queued.push(task),
    listingStoredShopTenantPredicate: () => '1=1', listingPublishExecutionGuards: new WeakMap(),
    buildShopPublishPayloadForOzon: async options => {
      calls.push({ type: 'prepare', options });
      if (preparationFailure) throw new Error('image download failed');
      assert.equal(options.basePayload._listing_preparation, undefined);
      return { shopPayload: { items: [{ ...options.basePayload.items[0], images: ['watermarked.png', 'tail.png'] }] },
        textVariantPayload: {}, watermarkedPayload: {}, tailImageUrl: 'tail.png', tailApplied: { appended: 1 }, mediaRepair: {} };
    },
    buildPublishRecordListSummary: payload => ({ images: payload.items[0].images }),
    run: async (sql, params) => {
      if (sql.includes('SET request_json = ?, list_summary_json')) {
        if (persistenceConflict) return { affectedRows: 0 };
        records.get(params[2]).request_json = params[0];
        calls.push({ type: 'persist' });
      }
      if (sql.includes('SET status = CASE')) calls.push({ type: 'failed' });
      return { affectedRows: 1 };
    },
    repairOzonPublishPayloadMedia: async payload => ({ payload }),
    prepareOzonSellerMediaForPublishPayload: async payload => ({ payload, jobs: [], pending: [] }),
    assertPublishPayloadHasOnlyPublicMedia() {}, assertPublishPayloadMediaReachable: async () => {},
    importOzonProducts: async (_shop, payload, options) => {
      await options.beforeRequest();
      assert.equal(payload._listing_preparation, undefined);
      calls.push({ type: 'import', payload });
      return { result: { task_id: 'receipt' } };
    },
    fetchOzonProductImportInfo: async () => ({}), normalizeOzonImportInfoErrors: () => ({ has_errors: false }),
    importInfoStatus: () => 'imported', updatePublishRecordAfterSubmit: async () => async () => {},
    refreshPublishRecordQuality: async () => {},
    buildOzonPublishErrorPayload: error => ({ message: error.message })
  });
  load(context, 'publishListingTemplateToOzon');
  load(context, 'submitPreparedListingPublishRecord');
  return { context, records, queued, calls };
}

test('direct submit responds before media preparation and persists recovery policy', async () => {
  const f = fixture();
  const result = await f.context.publishListingTemplateToOzon({ shop_ids: [20], text_variant_policy: { enabled: true } }, session);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].queued, true);
  assert.equal(f.calls.length, 0, 'no media preparation or Ozon mutation before returning');
  const snapshot = JSON.parse(f.records.get(1).request_json);
  assert.equal(snapshot._listing_preparation.textVariantPolicy.enabled, true);
  assert.equal(snapshot._listing_preparation.preparedMediaPolicy.skipTail, false);
  // Discard the queue, as after a process restart: only persisted data is needed.
  f.queued.length = 0;
  await f.context.submitPreparedListingPublishRecord({ recordId: 1 });
  assert.deepEqual(f.calls.map(call => call.type), ['prepare', 'persist', 'import']);
  assert.equal(f.calls[0].options.sourceRecordId, 1);
  assert.equal(f.calls[0].options.updateExisting, true);
  assert.deepEqual(Array.from(f.calls.at(-1).payload.items[0].images), ['watermarked.png', 'tail.png']);
  assert.equal(JSON.parse(f.records.get(1).request_json)._listing_preparation, undefined);
});

test('preparation failure retains recovery marker and never submits raw images', async () => {
  const f = fixture({ preparationFailure: true });
  await f.context.publishListingTemplateToOzon({ shop_ids: [20] }, session);
  await f.queued[0]();
  assert.deepEqual(f.calls.map(call => call.type), ['prepare', 'failed']);
  assert.ok(JSON.parse(f.records.get(1).request_json)._listing_preparation);
});

test('losing preparation worker cannot submit or fail the winning record', async () => {
  const f = fixture({ persistenceConflict: true });
  await f.context.publishListingTemplateToOzon({ shop_ids: [20] }, session);
  await f.queued[0]();
  assert.deepEqual(f.calls.map(call => call.type), ['prepare']);
});

test('failed preparation retry queues persisted policy instead of importing unprepared media', async () => {
  const f = fixture();
  await f.context.publishListingTemplateToOzon({ shop_ids: [20], skip_publish_watermark: true }, session);
  const record = f.records.get(1);
  const policy = JSON.parse(record.request_json)._listing_preparation.preparedMediaPolicy;
  assert.equal(policy.reuse, true);
  assert.equal(policy.skipTail, false, 'explicit watermark skip still appends the configured tail');
  Object.assign(record, { shop_id: 20, status: 'failed' });
  f.context.row = async sql => sql.includes('SELECT r.*') ? structuredClone(record) : { id: 20 };
  f.context.normalizePublishRecordRow = value => value;
  f.context.listingPublishRecordNotFoundError = () => new Error('not found');
  load(f.context, 'retryListingPublishRecord');
  f.queued.length = 0;
  await f.context.retryListingPublishRecord(1, {}, session);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queued.length, 1);
  await f.queued[0]();
  assert.deepEqual(f.calls.map(call => call.type), ['prepare', 'persist', 'import']);
});

test('existing prepared records remain compatible without another watermark pass', async () => {
  const f = fixture();
  await f.context.publishListingTemplateToOzon({ shop_ids: [20] }, session);
  const record = f.records.get(1);
  const payload = JSON.parse(record.request_json);
  delete payload._listing_preparation;
  record.request_json = JSON.stringify(payload);
  await f.context.submitPreparedListingPublishRecord({ recordId: 1 });
  assert.deepEqual(f.calls.map(call => call.type), ['import']);
});

test('restart recovery prepares edited records even when their old offer already exists on Ozon', async () => {
  const f = fixture();
  await f.context.publishListingTemplateToOzon({ shop_ids: [20] }, session);
  const record = { ...f.records.get(1), id: 1, tenant_id: '2', offer_id: 'stable' };
  f.context.all = async () => [record];
  f.context.normalizeArray = value => Array.isArray(value) ? value : [];
  f.context.firstOfferId = payload => payload.items[0].offer_id;
  f.context.fetchOzonProductInfoAttributes = async () => { throw new Error('must not treat an older offer as this pending edit'); };
  f.context.retryListingInventoryBindings = async () => ({ total: 0, bound: 0 });
  let resumed = 0;
  f.context.submitPreparedListingPublishRecord = async ({ recordId }) => { assert.equal(recordId, 1); resumed++; };
  load(f.context, 'recoverDirectListingPublishesOnStartup');
  const result = await f.context.recoverDirectListingPublishesOnStartup();
  assert.equal(resumed, 1);
  assert.equal(result.discovered, 0);
  assert.equal(result.resubmitted, 1);
});

test('retrying public-media failures responds before the slow download checks and verifies in background', async () => {
  const f = fixture();
  await f.context.publishListingTemplateToOzon({ shop_ids: [20] }, session);
  const record = f.records.get(1), payload = JSON.parse(record.request_json);
  delete payload._listing_preparation;
  Object.assign(record, { shop_id: 20, status: 'failed', request_json: JSON.stringify(payload),
    error_json: JSON.stringify({ raw_message: 'Public media is not fully downloadable; Ozon submit was blocked' }) });
  f.context.row = async sql => sql.includes('SELECT r.*') ? structuredClone(record) : { id: 20 };
  f.context.normalizePublishRecordRow = value => value;
  f.context.listingPublishRecordNotFoundError = () => new Error('not found');
  f.context.assertPublishPayloadMediaReachable = async () => f.calls.push({ type: 'full_media_check' });
  load(f.context, 'retryListingPublishRecord');
  f.queued.length = 0;
  await f.context.retryListingPublishRecord(1, {}, session);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queued.length, 1);
  await f.queued[0]();
  assert.deepEqual(f.calls.map(call => call.type), ['full_media_check', 'import']);
});
