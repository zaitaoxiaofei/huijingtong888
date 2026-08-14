import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");

test("direct listing publish returns after record creation and submits in background", () => {
  const directSource = serviceSource.match(/export async function publishListingTemplateToOzon[\s\S]*?function createListingPublishTaskNo/)?.[0] || "";
  assert.match(directSource, /recordId = await preparePublishRecordForSubmit/);
  assert.match(directSource, /initialStatus: "processing"/);
  assert.match(directSource, /runBackgroundListingPublish\(`direct publish record \$\{recordId}`/);
  assert.match(directSource, /await submitPreparedListingPublishRecord/);
  assert.match(directSource, /queued: true/);
  assert.match(directSource, /async: true/);
  assert.doesNotMatch(directSource, /await importOzonProducts\(shop, shopPayload\)/);
  assert.doesNotMatch(directSource, /await prepareOzonSellerMediaForPublishPayload\(repairedShopPayload/);
  assert.match(viewSource, /已创建上架处理记录，系统将在后台提交 Ozon/);
});
