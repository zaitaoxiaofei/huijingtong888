import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("procurement purchase routes pass the authenticated person", () => {
  assert.match(routes, /startConfirmProcurementRequestsPurchased\(await readJson\(req\), req\._session\?\.personId\)/);
  assert.match(routes, /confirmProcurementRequestsPurchased\(await readJson\(req\), req\._session\?\.personId\)/);
  assert.match(routes, /mergeProcurementRequests\(await readJson\(req\), req\._session\?\.personId\)/);
  assert.match(routes, /confirmPurchaseOrder\(Number\(parts\[3\]\), await readJson\(req\), req\._session\?\.personId\)/);
});

test("procurement creation uses only a valid authenticated person", () => {
  assert.match(service, /const personId = await requireSessionPersonIdMysql\(sessionPersonId\);/);
  assert.match(service, /const personId = await requireSessionPersonIdMysql\(userId, connection\);/);
  assert.doesNotMatch(service, /resolvePersonIdOrFirstMysql\(body\.person_id \|\| userId, connection\)/);
});
