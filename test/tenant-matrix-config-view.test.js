import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ShopAssetVariantCenter.vue", import.meta.url), "utf8");

test("tenant matrix mount loads configuration without restoring source data or generation jobs", async () => {
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

test("tenant matrix keeps rule and tail configuration while hiding generation UI and unrelated material operations", () => {
  assert.match(source, /const tenantConfigOnly = computed\(\(\) => authStore\.user\?\.tenant\?\.slug !== "default"\)/);
  assert.match(source, /<section v-if="!tenantConfigOnly" class="step-panel source-step"/);
  assert.match(source, /<section v-if="!tenantConfigOnly" class="step-panel step-results"/);
  for (const action of ["openMaterialCenter", "exportPackages", "generateCurrentShop", "generateAllShops", "goToListingAutomation", "syncOzonCategories", "previewGeneratedResult"]) {
    assert.match(source, new RegExp(`<el-button v-if="!tenantConfigOnly"[^>]*@click="${action}"`), action);
  }
  assert.match(source, /@click="saveRule\(shop\)"/);
  assert.match(source, /@click="openTailTemplateDialog\(\)"/);
  assert.match(source, /v-model="tailTemplateDialog\.visible" title="新增尾图模板"/);
});
