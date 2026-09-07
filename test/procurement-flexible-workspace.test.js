import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backend = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const page = await readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const navigation = await readFile(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");

test("procurement can be created before inventory binding", () => {
  assert.match(backend, /MODIFY COLUMN product_id BIGINT UNSIGNED NULL/);
  assert.match(backend, /raw_name VARCHAR\(255\)/);
  assert.match(backend, /productId \? "bound" : "unbound"/);
  assert.match(backend, /Array\.isArray\(body\.items\)/);
  assert.match(routes, /GET \/api\/procurement\/binding-suggestions/);
});

test("procurement workspace keeps owner, free names, multi-item creation and later binding visible", () => {
  assert.match(navigation, /采购工作台/);
  assert.match(page, /采购负责人/);
  assert.match(page, /采购名称/);
  assert.match(page, /添加商品/);
  assert.match(page, /建议绑定库存/);
  assert.match(page, /已登记.*采购，现已进入采购在途/);
  assert.match(page, /系统会把这次确认用于后续推荐/);
});
