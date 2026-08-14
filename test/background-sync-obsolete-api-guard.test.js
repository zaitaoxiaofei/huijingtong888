import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mysqlSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const ozonClientSource = readFileSync(new URL("../src/ozonClient.js", import.meta.url), "utf8");

test("stock sync does not call the retired managed stocks endpoint", () => {
  assert.doesNotMatch(mysqlSource, /fetchOzonManagedStocks/);
  assert.doesNotMatch(mysqlSource, /managedResult/);
  assert.doesNotMatch(ozonClientSource, /\/v1\/analytics\/manage\/stocks/);
  assert.doesNotMatch(ozonClientSource, /fetchOzonManagedStocks/);
});

test("category sync keeps a local chunk helper for bulk persistence", () => {
  assert.match(listingSource, /function chunkArray\(items = \[\], size = 1\)/);
  assert.match(listingSource, /chunkArray\(validRows, 300\)/);
});
