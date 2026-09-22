import { normalizeVehicleBrand, vehicleBrandAliases, VEHICLE_BRAND_CHINESE } from "../src/shared/vehicle-brand.js";
import { hasPermission } from "../src/shared/permissions.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createCatalogRoutes, handleCatalogRestRoute } from "../src/server/routes/catalog.js";

const serviceSource = readFileSync(new URL("../src/services/inventory-product-requests.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
const namingSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8").match(/export function normalizeStructuredNamingMysql\(body = \{\}\) \{[\s\S]*?\n\}/)[0].replace("export ", "");
const operator = { personId: 7, name: "录入员", role: "operator" };
const manager = { personId: 8, name: "库存经理", role: "manager" };
const body = () => ({ request_key: "request-a", name: "旧名称", owner_person_id: 7, image_url: "https://example.com/product.png", purchase_url: "https://example.com/buy", composition_items: [{ component_product_id: 22, quantity: 2 }], structured_naming: { category: "门槛贴纸", accessory: "普通款", colors: ["黑色"], materials: ["PVC"], quantity: 2 } });

function fixture() {
  let state = { requests: [], products: [], options: [{ type: "accessory", value: "普通款", status: "active" }, { type: "color", value: "黑色", status: "active" }, { type: "material", value: "PVC", status: "active" }] };
  let failCreate = false, failBind = false, duplicateId = null, tail = Promise.resolve();
  let bindingCalls = 0;
  async function query(sql, args = []) {
    if (sql.includes("inventory_product_naming_options")) return state.options.filter(row => row.type === args[0] && row.value === args[1]).map(row => ({ id: 1, status: row.status }));
    if (sql.includes("ai_vehicle_catalog") || sql.includes("FROM sku_mappings")) return [];
    if (sql.includes("FROM products")) return sql.includes("id = ?") ? state.products.filter(row => row.id === args[0]) : [];
    if (sql.includes("FROM inventory_product_requests")) {
      let rows = state.requests;
      if (sql.includes("request_key = ?")) rows = rows.filter(row => row.applicant_id === args[0] && row.request_key === args[1]);
      else if (sql.includes("WHERE id = ?")) rows = rows.filter(row => row.id === args[0]);
      else {
        let index = 0;
        if (sql.includes("r.applicant_id = ?")) rows = rows.filter(row => row.applicant_id === args[index++]);
        if (sql.includes("r.status = ?")) rows = rows.filter(row => row.status === args[index++]);
      }
      if (sql.includes("COUNT(*)")) return [{ total: rows.length }];
      return structuredClone(rows);
    }
    if (sql.startsWith("SAVEPOINT") || sql.startsWith("ROLLBACK TO SAVEPOINT")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  }
  async function execute(sql, args = []) {
    if (sql.includes("CREATE TABLE")) return {};
    if (sql.includes("INSERT INTO inventory_product_requests")) {
      const [key, applicant, name, payload, options] = args;
      if (!state.requests.some(row => row.request_key === key && row.applicant_id === applicant)) state.requests.push({ id: state.requests.length + 1, request_key: key, applicant_id: applicant, applicant_name: name, payload_json: payload, new_options_json: options, status: "pending", revision: 1, binding_status: "none" });
      return {};
    }
    if (sql.includes("INSERT INTO inventory_product_naming_options")) {
      const existing = state.options.find(row => row.type === args[0] && row.value === args[1]);
      if (existing) existing.status = "active";
      else state.options.push({ type: args[0], value: args[1], status: "active" });
      return {};
    }
    if (sql.includes("UPDATE inventory_product_requests")) {
      const row = state.requests.find(row => row.id === args.at(-1));
      if (sql.includes("status = 'returned'")) { row.status = "returned"; row.review_note = args[0]; row.revision++; }
      else if (sql.includes("status = 'pending'")) { row.status = "pending"; row.payload_json = args[0]; row.new_options_json = args[1]; row.revision++; }
      else if (sql.includes("status = 'approved'")) { row.status = "approved"; row.payload_json = args[0]; row.new_options_json = args[1]; row.product_id = args[2]; row.binding_status = args[3]; row.revision++; }
      else if (sql.includes("binding_status = 'failed'")) { row.binding_status = "failed"; row.binding_error = args[0]; }
      else if (sql.includes("binding_status = 'bound'")) { row.binding_status = "bound"; row.binding_error = ""; }
      else throw new Error(`Unexpected update: ${sql}`);
      return {};
    }
    throw new Error(`Unexpected execute: ${sql}`);
  }
  const connection = { query: async (...args) => [await query(...args)], execute: async (...args) => [await execute(...args)] };
  async function create(payload, tx) {
    if (failCreate) throw new Error("模拟建品失败");
    if (duplicateId) throw new Error(`已存在相同标准产品：旧库存（#${duplicateId}），请直接绑定 SKU`);
    assert.ok(tx || !state.requests.length);
    const product = { id: state.products.length + 50, payload: structuredClone(payload) };
    state.products.push(product);
    return { id: product.id };
  }
  const context = vm.createContext({ normalizeVehicleBrand, vehicleBrandAliases, VEHICLE_BRAND_CHINESE,
    hasPermission, randomUUID: () => "generated-key", mysqlQuery: query, mysqlExecute: execute,
    inventoryProductNamingOptions: async () => ({}), aiVehicleCatalog: async () => ({}), prepareInventoryProductCreationMysql: async () => {},
    validateVehicleBrand: value => { if (!/[A-Z]/i.test(value)) throw new Error("汽车品牌请填写英文名称"); return value.toUpperCase(); },
    createProductMysql: create, createProductFromOnlineProductMysql: create,
    bindOnlineProductMysql: async () => { bindingCalls++; if (failBind) throw new Error("模拟订单绑定失败"); },
    withMysqlTransaction: work => {
      const run = tail.then(async () => { const snapshot = structuredClone(state); try { return await work(connection); } catch (error) { state = snapshot; throw error; } });
      tail = run.catch(() => {}); return run;
    }
  });
  vm.runInContext(namingSource + "\n" + serviceSource, context);
  return { api: context, state: () => state, failCreate: value => { failCreate = value; }, failBind: value => { failBind = value; }, duplicate: value => { duplicateId = value; }, bindingCalls: () => bindingCalls };
}

test("new names save one complete application without creating products or activating options", async () => {
  const f = fixture();
  const input = { ...body(), created_by_person_id: 999 };
  const results = await Promise.all([f.api.submitInventoryProductRequest(input, operator), f.api.submitInventoryProductRequest(input, operator)]);
  assert.deepEqual(results.map(row => row.request_id), [1, 1]);
  assert.equal(f.state().requests.length, 1);
  assert.equal(f.state().products.length, 0);
  assert.equal(f.state().options.some(row => row.value === "门槛贴纸"), false);
  const detail = await f.api.inventoryProductRequestDetail(1, operator);
  assert.equal(detail.payload.created_by_person_id, 7);
  assert.equal(detail.payload.image_url, input.image_url);
  assert.equal(detail.payload.composition_items[0].quantity, 2);
  assert.match(detail.payload.name, /门槛贴纸.*黑色.*PVC.*2个/);
});

test("existing active options still create inventory immediately", async () => {
  const f = fixture(); f.state().options.push({ type: "category", value: "门槛贴纸", status: "active" });
  const result = await f.api.submitInventoryProductRequest(body(), operator);
  assert.equal(result.id, 50); assert.equal(f.state().requests.length, 0);
});

test("operators cannot read other applications, approve, return, retry binding or resubmit another user's request", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "retry_binding" }, manager), /只有已通过/);
  const other = { ...operator, personId: 99 };
  await assert.rejects(f.api.inventoryProductRequestDetail(1, other), /只能查看自己的/);
  for (const action of ["approve", "return", "retry_binding"]) await assert.rejects(f.api.reviewInventoryProductRequest(1, { action }, other), /仅库存审批人员/);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "resubmit" }, other), /只能修改自己的/);
  assert.equal((await f.api.inventoryProductRequests({}, other)).rows.length, 0);
  assert.equal((await f.api.inventoryProductRequests({}, manager)).rows.length, 1);
});

test("return preserves payload and resubmission uses the same application with revision protection", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "return", revision: 1 }, manager), /退回原因/);
  await f.api.reviewInventoryProductRequest(1, { action: "return", revision: 1, review_note: "请补充产品主图" }, manager);
  assert.equal(JSON.parse(f.state().requests[0].payload_json).purchase_url, body().purchase_url);
  const corrected = body(); corrected.image_url = "https://example.com/new.png";
  await f.api.reviewInventoryProductRequest(1, { action: "resubmit", revision: 2, payload: corrected }, operator);
  assert.equal(f.state().requests.length, 1);
  assert.equal(f.state().requests[0].status, "pending");
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1 }, manager), /内容已被修改/);
  await f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 3 }, manager);
  assert.equal(f.state().products[0].payload.image_url, corrected.image_url);
});

test("approval failure rolls back dictionary activation and leaves the request pending", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator); f.failCreate(true);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1 }, manager), /模拟建品失败/);
  assert.equal(f.state().requests[0].status, "pending");
  assert.equal(f.state().options.some(row => row.value === "门槛贴纸"), false);
  assert.equal(f.state().products.length, 0);
});

test("concurrent repeated approval creates only one product and commits corrected naming", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator);
  const corrected = body(); corrected.structured_naming.category = "门槛条贴纸";
  const results = await Promise.all(Array.from({ length: 3 }, () => f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1, payload: corrected }, manager)));
  assert.deepEqual(results.map(row => row.product_id), [50, 50, 50]);
  assert.equal(f.state().products.length, 1);
  assert.equal(f.state().products[0].payload.structured_naming.category, "门槛条贴纸");
  assert.equal(f.state().products[0].payload.created_by_person_id, 7);
  assert.equal(f.state().options.find(row => row.value === "门槛条贴纸").status, "active");
});

test("duplicates require explicit reuse and cannot be redirected to an arbitrary product", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator);
  f.state().products.push({ id: 88 }); f.duplicate(88);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1, reuse_product_id: 99 }, manager), /已存在相同标准产品/);
  const result = await f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1, reuse_product_id: 88 }, manager);
  assert.equal(result.product_id, 88); assert.equal(f.state().products.length, 1);
});

test("failed order binding is retryable without creating inventory twice", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest({ ...body(), online_product_id: 9, order_item_id: 10, ozon_sku: "sku-1" }, operator);
  f.failBind(true);
  const result = await f.api.reviewInventoryProductRequest(1, { action: "approve", revision: 1 }, manager);
  assert.equal(result.status, "approved"); assert.equal(result.binding_status, "failed"); assert.equal(f.state().products.length, 1);
  f.failBind(false);
  const retry = await f.api.reviewInventoryProductRequest(1, { action: "retry_binding" }, manager);
  assert.equal(retry.binding_status, "bound"); assert.equal(f.state().products.length, 1);
  assert.equal(f.bindingCalls(), 2);
});

test("catalog routes preserve pending response without fetching a nonexistent product", async () => {
  const calls = [];
  const routes = createCatalogRoutes({ readJson: async () => body(), services: { submitInventoryProductRequest: async (_body, session) => { calls.push(session); return { status: "pending", request_id: 4 }; }, selectionProduct: () => assert.fail("pending is not inventory") } });
  assert.equal((await routes["POST /api/products"]({ _session: operator })).request_id, 4);
  assert.equal((await routes["POST /api/online-products/create-product"]({ _session: operator })).request_id, 4);
  assert.deepEqual(calls, [operator, operator]);
  let received;
  await handleCatalogRestRoute({ req: { method: "PUT", _session: manager }, parts: ["api", "inventory-product-requests", "4"], readJson: async () => ({ action: "approve" }), services: { reviewInventoryProductRequest: async (...args) => { received = args; } }, json: () => {} });
  assert.equal(received[0], 4); assert.equal(received[2], manager);
});

test("inventory creation returns a lightweight product without a detail reload", async () => {
  const routes = createCatalogRoutes({
    readJson: async () => ({ ...body(), structured_naming: { ...body().structured_naming, stock_unit: "套" } }),
    services: {
      submitInventoryProductRequest: async () => ({ id: 51, code: "P-51" }),
      selectionProduct: () => assert.fail("inventory creation must not reload product details")
    }
  });
  const result = await routes["POST /api/products"]({ _session: operator });
  assert.deepEqual(result.product, { id: 51, code: "P-51", name: "旧名称", stock_unit: "套" });
});

test("selection creation still returns the hydrated product used by the selection list", async () => {
  const product = { id: 61, name: "选品" };
  const routes = createCatalogRoutes({
    readJson: async () => ({ name: "选品", product_type: "selection" }),
    services: {
      createProduct: async () => ({ id: 61 }),
      selectionProduct: async (id, query) => {
        assert.equal(id, 61);
        assert.deepEqual(query, { includeDetails: 0 });
        return product;
      }
    }
  });
  assert.equal((await routes["POST /api/products"]({ _session: operator })).product, product);
});


test("manager permission in a combined role grants actual approval without a named-account exception", async () => {
  const f = fixture(); await f.api.submitInventoryProductRequest(body(), operator);
  await assert.rejects(f.api.reviewInventoryProductRequest(1, {action:"approve", revision:1}, {...operator, name:"核动力牛马"}), /仅库存审批人员/);
  const result = await f.api.reviewInventoryProductRequest(1, {action:"approve", revision:1}, {personId:8,role:"packing",roles:["packing","manager"]});
  assert.equal(result.status,"approved");
  assert.equal(f.state().products.length,1);
});
