import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { parse } from "acorn";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declaration = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
  .map(node => node.declaration || node).find(node => node.id?.name === "processListingMediaWatermark");
const imageUrl = hash => `https://own.example/listing-media/aa/${hash.repeat(64)}.png`;
function fixture() {
  const state = { logo: Buffer.from("logo"), options: { scalePercent: 22 }, downloads: [], assets: [], renders: 0, fail: "", revoked: false };
  const context = vm.createContext({ crypto, path, Buffer,
    authorizeBusinessTaskSession: async session => { if (state.revoked) throw Object.assign(new Error("revoked"), { status: 403 }); return session; },
    assertBusinessTaskPermission() {}, ensureListingAutomationSchema: async () => {},
    normalizeArray: value => Array.isArray(value) ? value : [], listingTenantId: session => String(session.tenant.id),
    listingWatermarkShop: async (id, session) => ({ id, name: `shop-${id}`, tenant: session.tenant.id }),
    resolveListingShopWatermarkPath: async () => "logo.png", listingShopWatermarkOptions: () => state.options,
    fs: { readFile: async () => state.logo }, isManagedOssObjectUrl: value => value.startsWith("https://own.example/listing-media/"),
    row: async (sql, [tenant, shop, url, signature]) => {
      assert.match(sql, /tenant_id = \? AND shop_id = \? AND source_path = \?/);
      assert.match(sql, /status = 'public_ready'/);
      return state.assets.findLast(asset => asset.tenant === tenant && asset.shop_id === shop && asset.source_path === url
        && asset.metadata.watermark_signature === signature && asset.status === "public_ready") || null;
    },
    readListingImageBuffer: async url => {
      state.downloads.push(url);
      if (url === state.fail) throw new Error("download failed");
      return { buffer: Buffer.from("original") };
    },
    applyListingWatermark: async buffer => { state.renders++; return buffer; },
    optimizeListingImageForPublish: async buffer => ({ buffer, extension: ".png", contentType: "image/png" }),
    sanitizeListingMediaFilename: name => name,
    writeListingMediaFile: async () => ({ localPath: "", previewUrl: imageUrl("b"), publishUrl: imageUrl("b"), storageName: "output" }),
    registerListingMediaAsset: async (asset, session) => {
      const saved = { ...asset, id: state.assets.length + 1, tenant: String(session.tenant.id) };
      state.assets.push(saved);
      return saved;
    }
  });
  vm.runInContext(source.slice(declaration.start, declaration.end), context);
  const run = (shop = 4, tenant = 2, images = [imageUrl("a")]) => context.processListingMediaWatermark({ shop_id: shop, images }, { tenant: { id: tenant } });
  return { state, run };
}

test("same shop, immutable source, logo and settings reuse the persisted result without another download", async () => {
  const f = fixture();
  await f.run();
  const second = await f.run();
  assert.equal(f.state.renders, 1);
  assert.equal(f.state.downloads.length, 1);
  assert.equal(second.images[0].reused, true);
});

test("shop, enterprise, logo, settings, source and deleted-result changes cannot reuse a stale watermark", async () => {
  const f = fixture();
  await f.run();
  await f.run(7);
  await f.run(4, 3);
  f.state.logo = Buffer.from("new logo");
  await f.run();
  f.state.options = { scalePercent: 30 };
  await f.run();
  await f.run(4, 2, [imageUrl("c")]);
  f.state.assets.at(-1).status = "deleted";
  await f.run(4, 2, [imageUrl("c")]);
  assert.equal(f.state.renders, 7);
});

test("preparation retry resumes after the last successfully persisted image", async () => {
  const f = fixture();
  f.state.fail = imageUrl("c");
  await assert.rejects(f.run(4, 2, [imageUrl("a"), imageUrl("c")]), /download failed/);
  f.state.fail = "";
  await f.run(4, 2, [imageUrl("a"), imageUrl("c")]);
  assert.deepEqual(f.state.downloads, [imageUrl("a"), imageUrl("c"), imageUrl("c")]);
  assert.equal(f.state.renders, 2);
});

test("mutable external source URLs are never reused and cached hits still enforce access", async () => {
  const f = fixture();
  await f.run(4, 2, ["https://external.example/source.png"]);
  await f.run(4, 2, ["https://external.example/source.png"]);
  assert.equal(f.state.renders, 2);
  await f.run();
  f.state.revoked = true;
  await assert.rejects(f.run(), { status: 403 });
  assert.equal(f.state.renders, 3);
});
