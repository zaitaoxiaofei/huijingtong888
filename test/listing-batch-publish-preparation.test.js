import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
function functionSource(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, `Missing ${name}`);
  return match[0];
}
function fixture({ get, media, post } = {}) {
  const calls = { configuration: 0, media: 0, posts: [], errors: [], routes: [] };
  const batchListing = { visible: true, shopIds: [2], requestId: "same-reviewed-batch", publishing: false, browserPreparing: false, browserStage: "", browserCompleted: 0, browserTotal: 0, error: "", result: null };
  const bootstrap = { shops: [{ id: 2, name: "Own shop", watermarkPath: "" }] };
  const context = vm.createContext({
    Number, String, Object, Array, Set, Promise,
    selectedDraftRows: { value: [{ id: 11, images: ["https://fixture.invalid/own.png"] }] }, batchListing,
    draftListImages: row => row.images,
    buildBatchTextVariantPolicy: () => ({ enabled: false }),
    ElMessageBox: { confirm: async () => {} },
    ElMessage: { warning() {}, success() {}, error: value => calls.errors.push(value) },
    router: { push: async route => calls.routes.push(route) },
    apiClient: {
      get: async () => { calls.configuration++; return get ? get(calls.configuration) : bootstrap; },
      post: async (path, body) => { calls.posts.push({ path, body }); return post ? post(calls.posts.length) : { ok: true, summary: { queued: 1, failed: 0 }, task: { id: 7 } }; }
    },
    prepareBrowserWatermarkJobs: async options => {
      calls.media++;
      if (media) return media(options);
      options.onProgress({ completed: 0, total: 0 });
      return {};
    }
  });
  vm.runInContext(["publishBatchListingDrafts", "batchListingProgressTitle"].map(functionSource).join("\n"), context);
  return { calls, state: batchListing, run: () => context.publishBatchListingDrafts(), title: () => context.batchListingProgressTitle(), bootstrap };
}

test("batch publish labels configuration loading separately from image progress", async () => {
  let resolveConfiguration;
  const pending = new Promise(resolve => { resolveConfiguration = resolve; });
  const f = fixture({ get: () => pending });
  const running = f.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.publishing, true);
  assert.equal(f.state.browserPreparing, true);
  assert.match(f.title(), /加载目标店铺素材配置/);
  assert.doesNotMatch(f.title(), /0\/0|并发/);
  assert.equal(f.calls.media, 0);
  assert.equal(f.calls.posts.length, 0);
  resolveConfiguration(f.bootstrap);
  await running;
  assert.equal(f.state.browserPreparing, false);
  assert.equal(f.state.publishing, false);
  assert.equal(f.state.browserStage, "");
  assert.equal(f.calls.posts.length, 1, "only the mocked transport runs after preparation");
});

for (const [label, failure] of [
  ["forbidden", Object.assign(new Error("当前岗位无权访问素材配置"), { status: 403 })],
  ["isolation pending", Object.assign(new Error("该企业的数据隔离尚未完成，此功能暂不可用"), { status: 403, payload: { code: "TENANT_ISOLATION_PENDING" } })],
  ["network failure", new TypeError("Failed to fetch")]
]) test(`batch ${label} exposes the actual error, stops before submission, and can retry`, async () => {
  const f = fixture({ get: count => count === 1 ? Promise.reject(failure) : f.bootstrap });
  await f.run();
  assert.match(f.state.error, /素材准备失败，尚未提交上架任务/);
  assert.ok(f.state.error.includes(failure.message));
  assert.deepEqual(f.calls.errors, [f.state.error]);
  assert.equal(f.calls.media, 0);
  assert.equal(f.calls.posts.length, 0);
  assert.equal(f.state.browserPreparing, false);
  assert.equal(f.state.publishing, false);
  await f.run();
  assert.equal(f.state.error, "");
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.posts[0].body.request_id, "same-reviewed-batch");
});

test("watermark/upload rejection is visible and cannot create a publish task", async () => {
  const f = fixture({ media: async options => {
    options.onProgress({ completed: 0, total: 2 });
    throw Object.assign(new Error("本企业无权读取店铺水印"), { status: 403 });
  } });
  await f.run();
  assert.match(f.state.error, /尚未提交上架任务.*无权读取店铺水印/);
  assert.equal(f.calls.posts.length, 0);
  assert.equal(f.state.publishing, false);
  assert.equal(f.state.browserPreparing, false);
});

test("submission network failures retain the request ID and ask the operator to verify records before retrying", async () => {
  const f = fixture({ post: count => count === 1 ? Promise.reject(new TypeError("Failed to fetch")) : { ok: true, summary: { queued: 1 } } });
  await f.run();
  assert.match(f.state.error, /提交未确认.*先检查上架记录/);
  assert.doesNotMatch(f.state.error, /尚未提交上架任务/);
  assert.equal(f.state.publishing, false);
  await f.run();
  assert.equal(f.state.error, "");
  assert.deepEqual(f.calls.posts.map(call => call.body.request_id), ["same-reviewed-batch", "same-reviewed-batch"]);
});

test("no-watermark preparation resolves immediately rather than remaining at 0/0", async () => {
  const context = vm.createContext({ Number, String, Object, Array, Promise, Set });
  const browserSource = readFileSync(new URL("../frontend/admin/utils/browser-watermark-batch.js", import.meta.url), "utf8");
  vm.runInContext(browserSource.replace(/^import[^;]+;\r?\n/gm, "").replaceAll("export ", ""), context);
  const progress = [];
  const prepared = await context.prepareBrowserWatermarkJobs({ jobs: [{ productId: "draft-11", images: ["https://fixture.invalid/own.png"], shops: [{ id: 2, watermarkPath: "" }] }], onProgress: value => progress.push(value) });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].total, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), { "draft-11": {} });
  const f = fixture();
  assert.doesNotMatch(f.title(), /0\/0/);
});

test("batch dialog reuses its existing result alert for errors", () => {
  assert.match(source, /v-if="batchListing\.error \|\| batchListing\.result"/);
  assert.match(source, /:title="batchListing\.error \|\|/);
});
