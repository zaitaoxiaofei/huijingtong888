import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const browserSource = fs.readFileSync(new URL("../frontend/admin/utils/browser-watermark-batch.js", import.meta.url), "utf8");
const selectionSource = fs.readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");
const engineSource = fs.readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const listingAutomationSource = fs.readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const collectorSource = fs.readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const publishRecordsSource = fs.readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const runtimeServicesSource = fs.readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");

test("browser watermark batch uses ten canvas workers and serialized retrying server fallback", () => {
  assert.match(browserSource, /BROWSER_WATERMARK_CONCURRENCY = 10/);
  assert.match(browserSource, /SERVER_WATERMARK_FALLBACK_CONCURRENCY = 1/);
  assert.match(browserSource, /withServerFallbackSlot\(\(\) => retry\(\(\) => watermarkListingMedia/);
  assert.match(browserSource, /Promise\.allSettled\(workers\)/);
  assert.match(browserSource, /草稿 \$\{task\.productId\} 的第 \$\{task\.index \+ 1\} 张图片处理失败/);
  assert.match(browserSource, /throw withFailureStage\(uploadError, "browser_upload"\)/);
  assert.match(browserSource, /if \(browserError\?\.watermarkStage === "browser_upload"\) throw browserError/);
  assert.match(browserSource, /watermarkFingerprint/);
  assert.match(browserSource, /localStorage\.setItem/);
  assert.match(browserSource, /watermarkListingMedia/);
  assert.match(browserSource, /canvas\.width = 1/);
  assert.match(browserSource, /MAX_EDGE = 2000/);
  assert.match(browserSource, /toCanvasReadableUrl\(sourceUrl\)/);
  assert.match(browserSource, /\/api\/image-proxy\?url=/);
  assert.match(browserSource, /\/api\/tools\/image-cropper\/shop-watermark\/\$\{encodeURIComponent\(shopId\)\}\/file/);
});

test("collector box reuses browser-prepared media for multi-shop publishing", () => {
  assert.match(collectorSource, /浏览器多店上架/);
  assert.match(collectorSource, /prepareBrowserWatermarkBatch/);
  assert.match(collectorSource, /create-selection/);
  assert.match(collectorSource, /selection-publish-shops/);
  assert.match(collectorSource, /preparedMediaByShop/);
  assert.match(collectorSource, /publish-selection/);
  assert.match(collectorSource, /beforeunload/);
});

test("selection publishing prepares browser media and backend reuses it", () => {
  assert.match(selectionSource, /prepareBrowserWatermarkBatch/);
  assert.match(selectionSource, /beforeunload/);
  assert.match(selectionSource, /preparedMediaByShop/);
  assert.match(selectionSource, /data\?\.productMedia\?\.detailImages/);
  assert.match(selectionSource, /图片处理失败，尚未创建上架任务/);
  assert.match(runtimeServicesSource, /watermarkListingMedia/);
  assert.match(engineSource, /preparedMediaByShop/);
  assert.match(engineSource, /preparedImages:/);
  assert.match(engineSource, /expectedPreparedCount/);
  assert.match(engineSource, /await readImageBuffer\(sourceUrl\)/);
  assert.match(listingAutomationSource, /const skipConfiguredTail = reusePreparedMedia && !body\.skip_publish_watermark/);
});

test("draft batch publishing prepares all draft-shop media in the browser", () => {
  assert.match(publishRecordsSource, /prepareBrowserWatermarkJobs/);
  assert.match(publishRecordsSource, /jobs: mediaJobs/);
  assert.match(publishRecordsSource, /prepared_media_by_draft_shop/);
  assert.match(publishRecordsSource, /浏览器正在以并发 10 处理批量素材/);
  assert.match(publishRecordsSource, /beforeunload/);
  assert.match(listingAutomationSource, /applyPreparedDraftShopMedia/);
  assert.match(listingAutomationSource, /preparedMediaByDraftShop\[`\$\{Number\(draftId\)\}:\$\{Number\(shop\.id\)\}`\]/);
  assert.match(listingAutomationSource, /skip_publish_watermark: preparedPayload\.reused/);
});

test("failed and interrupted task retries prepare media in the browser with ten workers", () => {
  assert.match(publishRecordsSource, /productId: `retry-\$\{item\.id\}`/);
  assert.match(publishRecordsSource, /mapFrontendConcurrency\(draftIds, 10/);
  assert.match(publishRecordsSource, /browser_prepared_media: true/);
  assert.match(listingAutomationSource, /LISTING_PUBLISH_RETRY_CONCURRENCY = 10/);
  assert.match(listingAutomationSource, /mapWithConcurrency\(candidates, LISTING_PUBLISH_RETRY_CONCURRENCY/);
  assert.match(listingAutomationSource, /已阻止服务器重复处理/);
});
