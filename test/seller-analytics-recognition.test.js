import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { waitForSellerAnalyticsPreparation } from "../frontend/admin/utils/seller-analytics-recognition.js";

function preparation(status, companyId = "3570178", id = "new-request") {
  return {
    ok: status === "ready" && companyId === "4202503",
    current_company_id: companyId,
    prepare_request: { id, status, current_company_id: companyId }
  };
}

test("recognition waits for this request to finish and does not accept the old shop", async () => {
  const readings = [
    preparation("pending"),
    preparation("running"),
    preparation("ready", "4202503")
  ];
  let readCount = 0;
  let elapsed = 0;
  const result = await waitForSellerAnalyticsPreparation({
    requestId: "new-request",
    expectedStoreId: "4202503",
    readValidation: async () => readings[readCount++],
    wait: async (ms) => { elapsed += ms; },
    now: () => elapsed
  });
  assert.equal(result.status, "ready");
  assert.equal(readCount, 3);
  assert.equal(elapsed, 6000);
});

test("recognition does not claim success until the validated store matches", async () => {
  const readings = [
    preparation("ready", "3570178"),
    preparation("ready", "4202503")
  ];
  let elapsed = 0;
  let index = 0;
  const result = await waitForSellerAnalyticsPreparation({
    requestId: "new-request",
    expectedStoreId: "4202503",
    readValidation: async () => readings[index++],
    wait: async (ms) => { elapsed += ms; },
    now: () => elapsed
  });
  assert.equal(result.status, "ready");
  assert.equal(index, 2);
});

test("recognition returns the current request's mismatch and failure", async () => {
  for (const status of ["mismatch", "failed"]) {
    const result = await waitForSellerAnalyticsPreparation({
      requestId: "new-request",
      expectedStoreId: "4202503",
      readValidation: async () => preparation(status),
      wait: async () => {}
    });
    assert.equal(result.status, status);
    assert.equal(result.request.current_company_id, "3570178");
  }
});

test("recognition does not mistake another request for its own result", async () => {
  const result = await waitForSellerAnalyticsPreparation({
    requestId: "new-request",
    expectedStoreId: "4202503",
    readValidation: async () => preparation("ready", "4202503", "another-request"),
    wait: async () => {}
  });
  assert.equal(result.status, "superseded");
});

test("recognition times out instead of claiming success when the plugin never responds", async () => {
  let elapsed = 0;
  const result = await waitForSellerAnalyticsPreparation({
    requestId: "new-request",
    expectedStoreId: "4202503",
    readValidation: async () => preparation("pending"),
    wait: async (ms) => { elapsed += ms; },
    now: () => elapsed,
    timeoutMs: 6000
  });
  assert.equal(result.status, "timeout");
  assert.equal(elapsed, 6000);
});

test("seller analytics wakes the plugin and hides server-side login controls on ECS", () => {
  const source = fs.readFileSync("frontend/admin/views/analytics/SellerAnalyticsView.vue", "utf8");
  assert.match(source, /async function recognizeCurrentShop\(\)[\s\S]*?wakeAnalyticsPlugin\(\)[\s\S]*?waitForSellerAnalyticsPreparation/);
  assert.match(source, /v-if="showLocalBrowserProfileControls"[^>]+@click="openPersistentBrowserLogin"/);
  assert.match(source, /v-if="showLocalBrowserProfileControls"[^>]+@click="confirmPersistentBrowserLogin"/);
  assert.match(source, /window\.open\("https:\/\/seller\.ozon\.ru\/app\/analytics\/graphs"/);
  assert.doesNotMatch(source, /await wait\(1500\);\s*await Promise\.all\(\[loadPluginStatus\(\), loadPluginValidation\(\)\]\)/);
});
