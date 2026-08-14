import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const poolSource = readFileSync(new URL("../src/services/collector-seller-pool.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../ozon-erp-collector-plugin/background.js", import.meta.url), "utf8");
const contentSource = readFileSync(new URL("../ozon-erp-collector-plugin/content.js", import.meta.url), "utf8");
const sellerBridgeSource = readFileSync(new URL("../ozon-erp-collector-plugin/seller-bridge-content.js", import.meta.url), "utf8");
const manifestSource = readFileSync(new URL("../ozon-erp-collector-plugin/manifest.json", import.meta.url), "utf8");
const analyticsSource = readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
const authCryptoSource = readFileSync(new URL("../src/services/seller-auth-session-crypto.js", import.meta.url), "utf8");

test("collector seller pool uses independent bound shops with a six-worker cap", () => {
  assert.match(poolSource, /seller_analytics_auth_binding:/);
  assert.match(poolSource, /const concurrency = Math\.min\(6, Math\.max\(1, normalized\.length\)\)/);
  assert.match(poolSource, /withBindingLock/);
  assert.match(poolSource, /source_shop_id/);
  assert.match(poolSource, /source_company_id/);
  assert.match(poolSource, /decryptSellerAuthSession\(stored\.cookie_encrypted\)/);
});

test("collector seller pool cools only the affected binding on rate limits", () => {
  assert.match(poolSource, /Number\(status\) === 429/);
  assert.match(poolSource, /cooldown_until = Date\.now\(\) \+ state\.delay_ms/);
  assert.match(poolSource, /if \(status === 429\) disabledBindings\.add\(binding\.company_id\)/);
});

test("collector seller pool invalidates rejected bindings until they are rebound", () => {
  assert.match(poolSource, /\[401, 403\]\.includes\(lastStatus\)/);
  assert.match(poolSource, /async function invalidateBinding/);
  assert.match(poolSource, /last_status: Number\(status \|\| 0\)/);
  assert.match(poolSource, /await invalidateBinding\(binding, tenantId, status, lastResult\.error/);
  assert.match(analyticsSource, /\[401, 403\]\.includes\(Number\(binding\.last_status \|\| 0\)\)/);
});

test("collector seller pool fails over immediately after rejected authorization", () => {
  assert.match(poolSource, /if \(\[401, 403\]\.includes\(Number\(error\?\.status \|\| 0\)\)\) throw error/);
  assert.match(poolSource, /for \(let attempt = 0; attempt < bindings\.length; attempt \+= 1\)/);
  assert.match(poolSource, /disabledBindings\.add\(binding\.company_id\)/);
  assert.match(poolSource, /withBindingLock/);
});

test("local plugin exposes batch lookup and seller pool endpoints", () => {
  assert.match(serverSource, /collected-products" && parts\[3\] === "lookup-batch/);
  assert.match(serverSource, /collector-seller-pool" && parts\[3\] === "collect/);
  assert.match(serverSource, /collectorSellerPoolStatus/);
});

test("collector plugin prefers backend pool and keeps legacy fallback", () => {
  assert.match(backgroundSource, /collector-seller-pool\/collect/);
  assert.match(backgroundSource, /buildSellerCollectedProductFieldsFromPool/);
  assert.match(backgroundSource, /fetchSellerCollectedProductFields\(sku\)/);
  assert.match(backgroundSource, /if \(poolItem\?\.success\)/);
  assert.doesNotMatch(backgroundSource, /if \(poolAttempted && \(!poolItem \|\| !poolItem\.success\)\) \{\s*throw/);
  assert.match(backgroundSource, /Seller pool fallback:/);
  assert.match(backgroundSource, /collected-products\/lookup-batch/);
});

test("automatic list collection keeps ERP writes bounded and archives only one preview image", () => {
  const importStart = backgroundSource.indexOf("async function importCollectedProductPayloadToErpDb");
  const importEnd = backgroundSource.indexOf("async function lookupCollectedProductCache", importStart);
  const importSource = backgroundSource.slice(importStart, importEnd);
  assert.match(importSource, /\}, 30000\);/);

  const payloadStart = backgroundSource.indexOf("function buildSellerOnlyCollectedProductPayload");
  const payloadEnd = backgroundSource.indexOf("function buildCollectedProductDisplayPayload", payloadStart);
  const payloadSource = backgroundSource.slice(payloadStart, payloadEnd);
  assert.match(payloadSource, /payload\.images = mainImage \? \[mainImage\] : \[\]/);
  assert.match(backgroundSource, /Math\.min\(Number\(message\?\.concurrency \|\| 3\), 3\)/);
});

test("frontend entrypoint enrichment is bounded instead of serial", () => {
  assert.match(contentSource, /Math\.min\(6, list\.length \|\| 1\)/);
  assert.match(contentSource, /await Promise\.all/);
});

test("successful bindings remain reusable until Ozon actually rejects them", () => {
  assert.doesNotMatch(analyticsSource, /DIRECT_COLLECT_AUTH_TTL_MS/);
  assert.match(analyticsSource, /\[401, 403\]\.includes\(Number\(binding\.last_status \|\| 0\)\) \|\| !binding\.last_ok_at/);
});

test("seller auth sessions are encrypted at rest and legacy plaintext rows migrate", () => {
  assert.match(authCryptoSource, /aes-256-gcm/);
  assert.match(authCryptoSource, /SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY/);
  assert.match(analyticsSource, /cookie_encrypted/);
  assert.match(analyticsSource, /cookies_encrypted/);
  assert.match(analyticsSource, /const \{ cookie, cookies,/);
  assert.match(analyticsSource, /storedValue\?\.cookie && !storedValue\?\.cookie_encrypted/);
  assert.doesNotMatch(analyticsSource, /value: stringifyJson\(binding\)/);
});

test("new and legacy plugins cannot reactivate a rejected cookie without a real probe", () => {
  assert.match(analyticsSource, /probe = await probeCollectorPoolAuth/);
  assert.match(analyticsSource, /what_to_sell\/data\/v3/);
  assert.match(analyticsSource, /if \(!probe\?\.ok && preservedBinding\?\.cookie && preservedBinding\?\.last_ok_at\)/);
  assert.match(analyticsSource, /return publicAuthBinding\(preservedBinding\)/);
  assert.match(analyticsSource, /!binding\.last_ok_at/);
  assert.match(analyticsSource, /last_status: Number\(probe\?\.status \|\| 0\)/);
  assert.match(analyticsSource, /Seller authorization probe failed/);
  assert.match(analyticsSource, /sameRejectedCookie/);
  assert.match(analyticsSource, /Seller authorization was already rejected for collector pool use/);
  assert.match(analyticsSource, /Seller authorization was rejected while binding was being verified/);
});

test("collector plugin can bind the seller pool without a second extension", () => {
  assert.match(backgroundSource, /chrome\.cookies\.getAll\(\{ domain: 'seller\.ozon\.ru' \}\)/);
  assert.match(backgroundSource, /seller-analytics\/plugin-prepare\/next/);
  assert.match(backgroundSource, /seller-analytics\/auth-bindings/);
  assert.match(backgroundSource, /seller-analytics\/auth-probe/);
  assert.match(backgroundSource, /cookies: cookieInfo\.cookies/);
  assert.match(backgroundSource, /plugin_version: PLUGIN_VERSION/);
  assert.match(sellerBridgeSource, /OZON_ERP_SELLER_AUTH_SYNC/);
  assert.match(manifestSource, /"cookies"/);
});

test("collector cards expose pool routing, fallback, worker count, shop and duration", () => {
  assert.match(backgroundSource, /mode: 'pool'/);
  assert.match(backgroundSource, /mode: 'browser_fallback'/);
  assert.match(backgroundSource, /workerCount: poolWorkerCount/);
  assert.match(contentSource, /ozon-erp-collection-route/);
  assert.match(contentSource, /collectionRoute: result\.collectionRoute/);
  assert.match(contentSource, /号池 \$\{collectionRoute\.workerCount/);
  assert.match(contentSource, /浏览器回退/);
});
