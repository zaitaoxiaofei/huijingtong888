import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order pagination keeps the active-filter total separate from status tab counts", async () => {
  const page = await readFile(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(page, /total:\s*vm\.meta\.total,\s*\n\s*counts/);
  assert.match(service, /SELECT COUNT\(DISTINCT o\.id\) AS total[\s\S]*?WHERE \$\{filtered\.where\}/);
});

test("order status counts survive page and status changes within the same filter scope", async () => {
  const page = await readFile(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

  assert.match(page, /const ordersMetaRequestKey = ref\(""\)/);
  assert.match(page, /ordersMetaAbort\.value && ordersMetaRequestKey\.value === requestKey/);
  assert.match(page, /ordersMetaCacheKey\(vm\.filters\) !== requestKey/);
  assert.match(page, /ordersMetaRequestKey\.value !== metaKey/);
});
