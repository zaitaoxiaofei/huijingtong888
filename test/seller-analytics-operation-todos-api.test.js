import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

test("seller analytics exposes operation todo routes and frontend API helpers", () => {
  const routes = readRepoFile("src/server/routes/sellerAnalytics.js");
  const api = readRepoFile("frontend/admin/api/sellerAnalytics.js");

  assert.match(routes, /GET \/api\/db\/seller-analytics\/operation-todos/);
  assert.match(routes, /POST \/api\/db\/seller-analytics\/operation-todos\/refresh/);
  assert.match(routes, /GET \/api\/db\/seller-analytics\/plugin-status/);
  assert.match(routes, /GET \/api\/db\/seller-analytics\/plugin-status\/validate/);
  assert.match(routes, /sellerAnalyticsOperationTodos/);
  assert.match(routes, /sellerAnalyticsRefreshOperationTodos/);
  assert.match(routes, /sellerAnalyticsPluginStatus/);
  assert.match(routes, /sellerAnalyticsValidatePluginStatus/);
  assert.match(api, /function getSellerAnalyticsOperationTodos/);
  assert.match(api, /function refreshSellerAnalyticsOperationTodos/);
  assert.match(api, /function getSellerAnalyticsPluginStatus/);
  assert.match(api, /function validateSellerAnalyticsPluginStatus/);
});
