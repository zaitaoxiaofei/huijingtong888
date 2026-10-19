import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("order range sync uses the documented 31-day Ozon request window", () => {
  const mysqlSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(mysqlSource, /fetchOzonPostings\(shop, \{[^}]*chunkDays: 31/s);
  assert.doesNotMatch(mysqlSource, /fetchOzonPostings\(shop, \{[^}]*chunkDays: 14/s);
});
