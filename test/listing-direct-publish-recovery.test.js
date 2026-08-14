import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("stale direct publishes recover durably without treating Ozon result as progress", () => {
  assert.match(listingSource, /export async function recoverDirectListingPublishesOnStartup/);
  assert.match(listingSource, /r\.status = 'processing'/);
  assert.match(listingSource, /r\.publish_task_id IS NULL/);
  assert.match(listingSource, /r\.updated_at <= DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/);
  assert.match(listingSource, /fetchOzonProductInfoAttributes\(record, \{ offerIds: \[offerId\], limit: 1 \}\)/);
  assert.match(listingSource, /discovered_on_ozon: true/);
  assert.match(listingSource, /await submitPreparedListingPublishRecord\(/);
});

test("server startup invokes direct publish recovery", () => {
  assert.match(runtimeSource, /recoverDirectListingPublishesOnStartup/);
  assert.match(serverSource, /recoverDirectListingPublishes\(\)/);
  assert.match(serverSource, /services\.recoverDirectListingPublishesOnStartup/);
});
