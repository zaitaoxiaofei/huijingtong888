import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const frontend = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const extract = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
const clone = (value) => JSON.parse(JSON.stringify(value));

function editorFixture({ saveFails = false, batch = true } = {}) {
  const ids = [5321, 5169, 5378];
  const calls = [];
  const errors = [];
  const routes = [];
  const saved = new Map();
  const context = vm.createContext({
    isBatchDraftEdit: { value: batch }, routeDraftIds: { value: ids },
    route: { query: { draftId: 5321 } },
    templateEditor: { variants: ids.map((id, index) => ({
      id: `draft-variant-${id}`, _draft_id: id, _template_id: 100 + index,
      _draft_updated_at: 'old-version', name: `edited-${id}`, offer_id: `edited-offer-${id}`,
      price: 400 + index, images: [{ url: `https://example.com/${id}.png` }]
    })) },
    draftForm: { shop_ids: [6, 7], id: 5321 },
    textVariantPolicy: { enabled: false, fields: ["title"], shopStyles: {} },
    publishingToOzon: { value: false }, state: { drafts: [] },
    publishSubmit: {}, publishValidation: {}, collectorSourceSku: { value: "" },
    ElMessageBox: { confirm: async () => {} },
    ElMessage: { success() {}, warning() {}, error: (message) => errors.push(message) },
    applyOzonAttributeMappings() {}, saveListingWorkbenchDraft() {},
    normalizeEditorImages: (images) => images, dedupeImages: (images) => images,
    normalizeColorForPayload: () => "",
    apiClient: { post: async (url, body) => {
      calls.push({ url, body: clone(body) });
      if (url.endsWith('/batch-update')) {
        if (saveFails) throw Error('save failed');
        for (const item of body.items) saved.set(item.id, clone(item));
        return { items: body.items.map((item) => ({ id: item.id, updated_at: 'new-version' })) };
      }
      if (url.endsWith('/batch-publish')) return { ok: true, task: { id: 42 }, summary: { queued: 6 } };
      return { ok: true, results: [] };
    } },
    router: { push: async (route) => routes.push(clone(route)) }
  });
  context.buildTemplatePayload = () => ({ source_raw: { listing_draft_id: 5321 }, editable_payload: { variants: clone(context.templateEditor.variants) } });
  for (const name of ['stripBatchDraftMetadata', 'buildBatchDraftUpdateItems', 'saveBatchListingDrafts', 'publishTemplateToOzon']) {
    vm.runInContext(extract(frontend, name), context);
  }
  return { context, calls, errors, routes, saved, ids };
}

test("three edited drafts save separately then publish by original IDs across two shops", async () => {
  const f = editorFixture();
  await f.context.publishTemplateToOzon();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.calls.map((call) => call.url), ['/api/listing/drafts/batch-update', '/api/listing/drafts/batch-publish']);
  for (const id of f.ids) {
    const item = f.saved.get(id);
    assert.equal(item.product_name, `edited-${id}`);
    assert.equal(item.template_payload.editable_payload.variants.length, 1);
    assert.equal(item.template_payload.editable_payload.variants[0].offer_id, `edited-offer-${id}`);
    assert.deepEqual(item.source_images, [`https://example.com/${id}.png`]);
  }
  assert.deepEqual(f.calls[1].body.draft_ids, f.ids);
  assert.deepEqual(f.calls[1].body.shop_ids, [6, 7]);
  assert.equal(f.calls[1].body.source_draft_id, undefined);
  assert.equal(f.calls[1].body.text_variant_policy.failure_mode, 'keep_original');
  assert.deepEqual(f.routes, [{ name: 'listing-publish-records', query: { tab: 'tasks', taskId: '42' } }]);
  assert.equal(f.context.publishingToOzon.value, false);

  // Execute the production batch worker with network/database boundaries stubbed.
  const links = [];
  const shops = [{ id: 6 }, { id: 7 }];
  const pairs = f.ids.flatMap((draftId) => shops.map((shop) => ({ draft_id: draftId, shop_id: shop.id })));
  const worker = vm.createContext({
    LISTING_PUBLISH_DRAFT_CONCURRENCY: 2, LISTING_PUBLISH_SHOP_CONCURRENCY: 2,
    mapWithConcurrency: async (items, limit, fn) => Promise.all(items.map(fn)),
    restoreListingPublishTaskSession: async () => ({ tenant: { id: 1 } }),
    listingDraft: async (id) => f.saved.get(id),
    buildPublishTemplateFromListingDraft: async (draft) => ({ id: draft.id, ...draft.template_payload }),
    listingPublishTaskShop: async (task, id) => shops.find((shop) => shop.id === id),
    validateListingTemplatePublishForShop: async (template) => ({ errors: [], payload: { items: template.editable_payload.variants } }),
    assertListingPublishExecution: async () => {}, normalizeArray: (value) => value || [],
    resolveListingSourceProductId: async () => 0, normalizeShopTextVariantPolicy: (value) => value,
    claimListingPublishTaskItemForSubmit: async (id) => ({ claimed: true, item: { ...pairs[id - 1], publish_task_id: 42 } }),
    applyPreparedDraftShopMedia: (payload) => ({ payload }),
    buildShopPublishPayloadForOzon: async ({ basePayload }) => ({ shopPayload: basePayload }),
    prepareOzonSellerMediaForPublishPayload: async (payload) => ({ payload }),
    preparePublishRecordForSubmit: async ({ draftId, shop, shopPayload }) => {
      links.push({ draftId, shopId: shop.id, items: clone(shopPayload.items) });
      return links.length;
    },
    updateListingPublishTaskItem: async () => {}, assertPublishPayloadHasOnlyPublicMedia() {},
    runBackgroundListingPublish() {}, refreshListingPublishTaskStats: async () => {},
    buildOzonPublishErrorPayload: (error) => ({ message: error.message })
  });
  vm.runInContext(extract(backend, 'processAuthorizedListingDraftBatchPublishTask'), worker);
  const result = await worker.processAuthorizedListingDraftBatchPublishTask({
    draftIds: f.ids, shopIds: [6, 7], shops,
    publishTask: { id: 42, tenant_id: '1', itemByPair: new Map(pairs.map((pair, index) => [`${pair.draft_id}:${pair.shop_id}`, index + 1])) }
  });
  assert.equal(result.summary.queued, 6);
  assert.equal(result.summary.failed, 0);
  assert.deepEqual(links.map((link) => `${link.draftId}:${link.shopId}`).sort(), pairs.map((pair) => `${pair.draft_id}:${pair.shop_id}`).sort());
  for (const link of links) {
    assert.equal(link.items.length, 1);
    assert.equal(link.items[0].offer_id, `edited-offer-${link.draftId}`);
    assert.equal(link.items[0].images[0].url, `https://example.com/${link.draftId}.png`);
  }
});

test("failed batch save does not submit stale drafts", async () => {
  const f = editorFixture({ saveFails: true });
  await f.context.publishTemplateToOzon();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, ['save failed']);
  assert.equal(f.routes.length, 0);
  assert.equal(f.context.publishingToOzon.value, false);
});

test("duplicate draft rows cannot overwrite the first draft or start a task", async () => {
  const f = editorFixture();
  f.context.templateEditor.variants[1]._draft_id = 5321;
  await f.context.publishTemplateToOzon();
  assert.equal(f.calls.length, 0);
  assert.match(f.errors[0], /批量编辑行与原草稿已不一致/);
});

test("single draft submission retains the existing direct publish path", async () => {
  const f = editorFixture({ batch: false });
  await f.context.publishTemplateToOzon();
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/listing/templates/publish-to-ozon');
  assert.equal(f.calls[0].body.source_draft_id, 5321);
});
