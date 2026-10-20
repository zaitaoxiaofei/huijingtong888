import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("order range sync uses the documented 31-day Ozon request window", () => {
  const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  const sync = mysqlSource.slice(mysqlSource.indexOf("export async function syncDemoOrdersMysql"), mysqlSource.indexOf("export async function syncOzonIncrementalOrdersMysql"));
  assert.match(sync, /\["FBS", fetchOzonPostings, fetchFrom\]/);
  assert.match(sync, /\["FBP", fetchOzonFbpPostings, fbpFetchFrom\]/);
  assert.match(sync, /await fetch\(shop, \{ from: feedFrom, to: fetchTo, statuses, chunkDays: 31/);
  assert.doesNotMatch(sync, /chunkDays: 14/);
});
