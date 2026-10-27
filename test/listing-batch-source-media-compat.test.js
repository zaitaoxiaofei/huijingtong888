import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { resolveDevelopmentMeta } from "../src/services/product-development-meta.js";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const frontendSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const declarations = source => parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
  .map(node => source.slice(node.start, node.end)).join("\n");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const images = ["a", "b", "c", "old"].map(name => `https://source.example/${name}.jpg`);
const [A, B, C, OLD] = images;
const ready = sources => sources.map((source_url, index) => ({ source_url, publishUrl: `https://published.example/${index}.jpg` }));

function service() {
  const context = vm.createContext({ URL, Buffer, console, resolveDevelopmentMeta, listingTenantLookup,
    LOCAL_DICTIONARY_DISPLAY_ZH: new Map(), PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish",
    config: { listingMediaPublicBaseUrl: "https://erp.example" } });
  // Evaluate real declarations only: no module startup, database access or provider calls.
  vm.runInContext(declarations(serviceSource), context);
  return context;
}

function row(payload) {
  return { id: 101, tenant_id: "2", product_name: "Fixture", source_images_json: JSON.stringify([OLD]),
    source_urls_json: "[]", manual_facts_json: "{}", ai_payload_json: "{}", shop_copies_json: "[]",
    template_payload_json: JSON.stringify(payload) };
}

function payloadFromVariants(context, variants) {
  return context.buildOzonImportPreviewPayload({ title: "Fixture", description: "Fixture description", images: [{ url: A }, { url: B }],
    variants, attributes: [], tags: [], price: { value: 10 }, dimensions: { length_cm: 10, width_cm: 10, height_cm: 10, weight_g: 100 },
    descriptionCategoryId: 1, typeId: 2 }, {});
}

test("batch media includes distinct SKU images without changing the first SKU display or mixing old collected media", () => {
  const context = service();
  const variants = [{ offer_id: "SKU-A", images: [A, B] }, { offer_id: "SKU-B", images: [A, C] }];
  const draft = context.normalizeDraftRow(row({ editable_payload: { variants } }));
  assert.deepEqual(clone(draft.effective_images), [A, B]);
  assert.deepEqual(clone(draft.publish_images), [A, B, C]);
  const result = context.applyPreparedDraftShopMedia(payloadFromVariants(context, variants), ready(draft.publish_images), draft.publish_images);
  assert.equal(result.reused, true);
  assert.deepEqual(clone(result.payload.items.map(item => [item.primary_image, ...item.images])), [
    ["https://published.example/0.jpg", "https://published.example/1.jpg"],
    ["https://published.example/0.jpg", "https://published.example/2.jpg"]
  ]);
});

test("legacy camel-case and top-level variant payloads keep their authoritative publish image sets", () => {
  const context = service();
  for (const payload of [{ editablePayload: { variants: [{ images: [A, B] }, { images: [C] }] } },
    { variants: [{ images: [A, B] }, { images: [C] }] }]) {
    const draft = context.normalizeDraftRow(row(payload));
    assert.deepEqual(clone(draft.effective_images), [A, B]);
    assert.deepEqual(clone(draft.publish_images), [A, B, C]);
    assert.ok(!draft.publish_images.includes(OLD));
  }
});

test("front-end batch preparation uses publish media while list display keeps its own image set", () => {
  const script = frontendSource.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const context = vm.createContext({});
  vm.runInContext(declarations(script), context);
  assert.equal(typeof context.draftPublishImages, "function");
  const draft = { effective_images: [A, B], publish_images: [A, B, C], source_images: [OLD] };
  assert.deepEqual(clone(context.draftListImages(draft)), [A, B]);
  assert.deepEqual(clone(context.draftPublishImages(draft)), [A, B, C]);
  assert.deepEqual(clone(context.draftPublishImages({ publish_images: [], effective_images: [A], source_images: [OLD] })), []);
});

test("actual batch and failed-task retry handlers send all SKU sources to browser preparation", async () => {
  const script = frontendSource.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  const draft = { id: 101, effective_images: [A, B], publish_images: [A, B, C], source_images: [OLD] };
  const preparedJobs = [], posted = [];
  const context = vm.createContext({
    selectedDraftRows: { value: [draft] }, batchListing: { shopIds: [4], shopStyles: {}, textVariantFields: [] },
    taskRetryingId: { value: null }, taskDrawer: { visible: false }, router: { push: async () => {} },
    ElMessageBox: { confirm: async () => {} },
    ElMessage: { success() {}, warning() {}, error(message) { throw new Error(message); } },
    apiClient: {
      get: async path => {
        if (path === "/api/asset-variant-engine/bootstrap") return { shops: [{ id: 4, watermarkPath: "/watermark.png" }] };
        if (path === "/api/listing/publish-tasks/8") return { items: [{ id: 81, draft_id: 101, shop_id: 4, status: "failed" }] };
        if (path === "/api/listing/drafts/101") return draft;
        throw new Error(`Unexpected fixture GET ${path}`);
      },
      post: async (path, body) => { posted.push({ path, body: clone(body) }); return { summary: { queued: 1 } }; }
    },
    prepareBrowserWatermarkJobs: async ({ jobs }) => {
      preparedJobs.push(clone(jobs));
      return Object.fromEntries(jobs.map(job => [job.productId, { 4: ready(job.images) }]));
    }
  });
  vm.runInContext(declarations(script), context);
  context.loadPublishTasks = async () => {};
  await context.publishBatchListingDrafts();
  await context.retryPublishTask({ id: 8, failed_count: 1 });
  assert.deepEqual(preparedJobs.map(jobs => jobs[0].images), [[A, B, C], [A, B, C]]);
  assert.deepEqual(posted.map(item => item.path), ["/api/listing/drafts/batch-publish", "/api/listing/publish-tasks/8/retry"]);
  for (const request of posted) {
    assert.deepEqual(request.body.prepared_media_by_draft_shop["101:4"].map(item => item.source_url), [A, B, C]);
  }
});

test("source protection still rejects missing or reordered prepared media", () => {
  const context = service(), sources = [A, B, C];
  const payload = payloadFromVariants(context, [{ offer_id: "SKU-A", images: [A, B] }, { offer_id: "SKU-B", images: [A, C] }]);
  for (const prepared of [ready([A, B]), ready([B, A, C])]) {
    assert.throws(() => context.applyPreparedDraftShopMedia(payload, prepared, sources), { code: "LISTING_PREPARED_MEDIA_CHANGED", status: 409 });
  }
  const draft = context.normalizeDraftRow(row({ editable_payload: { variants: [{ images: [], image_edit_intent: "manual" }] } }));
  assert.deepEqual(clone(draft.effective_images), []);
  assert.deepEqual(clone(draft.publish_images), []);
});

test("actual paged lightweight SQL preserves all SKU media and legacy payload aliases inside one enterprise", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const fixture = await createTenantMysqlFixture("batch_source");
  const originalFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    globalThis.fetch = async () => { throw new Error("External network forbidden in batch media compatibility test"); };
    ({ closeMysqlPool } = await import("../src/mysql-pool.js"));
    const listing = await import("../src/services/listing-automation.js");
    await listing.ensureListingAutomationSchema();
    const q = fixture.query;
    await q("INSERT INTO tenants (id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people (id,name,role) VALUES (7,'Operator','operations')");
    await q("INSERT INTO tenant_members (tenant_id,person_id,business_roles_json) VALUES (2,7,JSON_ARRAY('operations'))");
    const cases = [
      { editable_payload: { variants: [{ images: [A, B] }, { images: [A, C] }] } },
      { editablePayload: { variants: [{ images: [A, B] }, { images: [C] }] } },
      { variants: [{ images: [A, B] }, { images: [C] }] }
    ];
    for (const [index, payload] of cases.entries()) {
      await q("INSERT INTO listing_drafts (id,tenant_id,product_name,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json,created_by_person_id) VALUES (?, '2','Fixture','[]',?,?,'{}','{}',7)", [101 + index, JSON.stringify([OLD]), JSON.stringify(payload)]);
    }
    await q("INSERT INTO listing_drafts (id,tenant_id,product_name,source_urls_json,source_images_json,template_payload_json,manual_facts_json,ai_payload_json) VALUES (301,'3','Foreign','[]',?,?,'{}','{}')", [JSON.stringify([OLD]), JSON.stringify(cases[0])]);
    const session = { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "a", role: "member" } };
    const page = await listing.listingDrafts({ paged: "1", lightweight: "1", pageSize: "20" }, session);
    assert.equal(page.rows.length, 3);
    assert.ok(!page.rows.some(draft => Number(draft.id) === 301));
    for (const draft of page.rows) {
      await t.test(`draft ${draft.id}: projection and full detail agree before any edit`, async () => {
        const detail = await listing.listingDraftDetail(draft.id, session);
        assert.deepEqual(draft.effective_images, [A, B]);
        assert.deepEqual(draft.publish_images, [A, B, C]);
        assert.deepEqual(draft.effective_images, detail.effective_images);
        assert.deepEqual(draft.publish_images, detail.publish_images);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    await closeMysqlPool?.();
    await fixture.cleanup();
  }
});
