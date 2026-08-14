import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("incremental order sync runs global post-processing once after all shops", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const incremental = source.match(/export async function syncOzonIncrementalOrdersMysql[\s\S]*?export async function syncOzonPostingsByNumberMysql/)?.[0] || "";

  assert.match(incremental, /skip_post_processing: true/);
  assert.equal((incremental.match(/await syncOutboundForOpenOrdersMysql\(\{ ordered_from: recentFrom, ordered_to: to \}\)/g) || []).length, 1);
  assert.equal((incremental.match(/await refreshProfitAnalyticsSnapshotsMysql/g) || []).length, 1);
});
