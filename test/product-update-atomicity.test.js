import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serviceSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

function updateProductSource() {
  const start = serviceSource.indexOf("export async function updateProductMysql");
  const end = serviceSource.indexOf("export async function updateProductComponentsMysql", start);
  assert.ok(start >= 0 && end > start, "updateProductMysql source should exist");
  return serviceSource.slice(start, end);
}

test("product core fields, composition and structured naming are saved in one transaction", () => {
  const source = updateProductSource();
  const transactionStart = source.indexOf("await withMysqlTransaction(async (connection)");
  const productUpdate = source.indexOf("await connection.execute(`");
  const componentSave = source.indexOf("await saveProductComponentsTxMysql(connection");
  const namingSave = source.indexOf("await saveStructuredNamingMysql(productId, body, connection)");
  const transactionEnd = source.indexOf("});", namingSave);

  assert.ok(transactionStart >= 0, "product update should open a transaction");
  assert.ok(productUpdate > transactionStart, "product row update should use the transaction connection");
  assert.ok(componentSave > productUpdate, "component save should remain inside the transaction");
  assert.ok(namingSave > componentSave, "structured naming should remain inside the transaction");
  assert.ok(transactionEnd > namingSave, "transaction should close after all core saves");
});

test("outbound synchronization runs after commit and cannot turn a saved product into HTTP 500", () => {
  const source = updateProductSource();
  const namingSave = source.indexOf("await saveStructuredNamingMysql(productId, body, connection)");
  const transactionEnd = source.indexOf("});", namingSave);
  const syncStart = source.indexOf("outboundSync = await syncOutboundForOpenOrdersMysql");
  const syncCatch = source.indexOf("outboundSyncWarning =", syncStart);
  const successReturn = source.indexOf("return { ok: true", syncCatch);

  assert.ok(syncStart > transactionEnd, "outbound synchronization should run only after commit");
  assert.ok(syncCatch > syncStart, "outbound synchronization failure should be caught");
  assert.ok(successReturn > syncCatch, "the product save should still return success after a sync warning");
});
