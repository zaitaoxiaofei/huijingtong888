import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");

test("all identical GET requests share one inflight request by default", () => {
  assert.match(source, /const getInflightRequests = new Map\(\)/);
  assert.match(source, /if \(options\.signal \|\| options\.dedupe === false\)/);
  assert.match(source, /const inflight = getInflightRequests\.get\(key\)/);
  assert.match(source, /getInflightRequests\.set\(key, requestPromise\)/);
});

test("route and global GET requests use separate dedupe scopes", () => {
  assert.match(source, /const routeScoped = options\.routeScoped !== false/);
  assert.match(source, /`\$\{routeScoped \? "route" : "global"\}:\$\{String\(url\)\}`/);
  assert.match(source, /controller\.signal\.addEventListener\("abort"/);
});
