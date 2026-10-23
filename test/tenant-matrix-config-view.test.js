import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { canAccessPage, hasPermission } from "../src/shared/permissions.js";

const source = readFileSync(new URL("../frontend/admin/views/listing/ShopAssetVariantCenter.vue", import.meta.url), "utf8");

test("matrix mount restores generation for permitted operators and keeps unauthorized sessions out", async () => {
  const mount = source.match(/onMounted\(async \(\) => \{([\s\S]*?)\n\}\);/)[1];
  for (const configOnly of [true, false]) {
    const calls = [];
    const context = vm.createContext({
      tenantConfigOnly: { value: configOnly },
      loadBootstrap: async () => calls.push("config"),
      loadRouteSource: async () => calls.push("source"),
      restoreGenerateJob: async () => calls.push("jobs")
    });
    vm.runInContext(`async function mount() {${mount}\n}`, context);
    await context.mount();
    assert.deepEqual(calls, configOnly ? ["config"] : ["config", "source", "jobs"]);
  }
});

test("tenant matrix entry points refuse source, media, jobs, generation and import before reading their dependencies", async () => {
  for (const name of ["loadMediaAssets", "loadRouteSource", "restoreGenerateJob", "generateVariants", "startGenerateAllShopsJob", "goToListingAutomation", "openMaterialCenter"]) {
    const fn = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(fn, name);
    const context = vm.createContext({ tenantConfigOnly: { value: true }, state: { selectedShopIds: [42] } });
    vm.runInContext(fn, context);
    assert.equal(await context[name](), undefined);
  }
});

test("matrix operators in default and A/B enterprises receive the same workbench without configuration writes", () => {
  const expression = source.match(/const tenantConfigOnly = computed\(\(\) => (.*)\);/)[1];
  for (const id of [1, 2, 3]) for (const roles of [['operations'], ['packing'], ['procurement']]) {
    const user = { id: 90 + id, roles, tenant: { id, slug: id === 1 ? 'default' : `customer-${id}`, role: 'member' } };
    const disabled = vm.runInNewContext(expression, { authStore: { user }, hasPermission });
    assert.equal(disabled, !roles.includes('operations'));
    assert.equal(canAccessPage(user, '/asset-variant-center'), roles.includes('operations'));
  }
  assert.match(source, /<section v-if="!tenantConfigOnly" class="step-panel source-step"/);
  assert.match(source, /<section v-if="!tenantConfigOnly" class="step-panel step-results"/);
  for (const action of ["exportPackages", "generateCurrentShop", "generateAllShops", "goToListingAutomation", "previewGeneratedResult"]) {
    assert.match(source, new RegExp(`<el-button v-if="!tenantConfigOnly"[^>]*@click="${action}"`), action);
  }
  assert.match(source, /<el-button v-if="canManageMatrix"[^>]*@click="saveRule\(shop\)"/);
  assert.match(source, /<el-button v-if="canManageMatrix"[^>]*@click="openTailTemplateDialog\(\)"/);
  assert.match(source, /<el-button v-if="canManagePlatform"[^>]*@click="syncOzonCategories"/);
  assert.match(source, /v-model="tailTemplateDialog\.visible" title="新增尾图模板"/);
});

test('a cached matrix workbench cannot send or accept requests after its account or enterprise changes', async () => {
  const boundary = source.slice(source.indexOf('const mountedAuthScope'), source.indexOf('const VIDEO_DURATION'));
  let scope = 'tenant-a:user-1:login-1', requests = 0, release;
  const context = vm.createContext({ DOMException, currentApiCacheScope: () => scope,
    sharedApiClient: { get: async () => { requests++; await new Promise(resolve => { release = resolve; }); return 'A'; },
      post: async () => { requests++; return 'write'; } } });
  vm.runInContext(`${boundary}\nglobalThis.matrixApi = apiClient;`, context);
  const pending = context.matrixApi.get('/api/asset-variant-engine/jobs/1');
  await Promise.resolve();
  scope = 'tenant-b:user-1:login-1';
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(context.matrixApi.post('/api/asset-variant-engine/generate', {}), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.match(source, /shop-asset-variant-active-job:\$\{tenantId\}:\$\{userId\}:\$\{scope\}/);
  const layout = readFileSync(new URL('../frontend/admin/layouts/AdminLayout.vue', import.meta.url), 'utf8');
  assert.match(layout, /\['asset-variant-center', 'ai-product-material-optimizer', 'ai-material-optimization-records'\]\.includes\(currentRoute\.name\) \? `:\$\{quickToolScope\}`/);
});
