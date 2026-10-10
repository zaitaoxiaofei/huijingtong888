import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("products schema supports nullable tenant ownership and tenant-first query indexes", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const table = schema.match(/CREATE TABLE IF NOT EXISTS products \(([\s\S]*?)\) ENGINE=InnoDB/);
  assert.ok(table, "products schema exists");
  assert.match(table[1], /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table[1], /idx_products_tenant_active_updated \(tenant_id, active, updated_at, id\)/);
  assert.match(table[1], /idx_products_tenant_owner_active \(tenant_id, owner_person_id, active, id\)/);
  assert.match(table[1], /UNIQUE KEY uk_products_selection_id \(selection_id\)/);
  assert.match(table[1], /UNIQUE KEY uk_products_code \(code\)/);
});

test("product ownership migration is opt-in, leaves legacy ownership unknown, and preserves existing uniqueness", () => {
  const migration = read("../scripts/migrate-tenant-products-ownership.mjs");
  const packageJson = read("../package.json");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing rows remain NULL and visible only to the default tenant; ownership is not inferred/);
  assert.doesNotMatch(migration, /UPDATE products SET tenant_id/);
  assert.match(migration, /GET_LOCK\('tenant_products_ownership_v1'/);
  assert.match(migration, /uk_products_selection_id/);
  assert.match(migration, /uk_products_code/);
  assert.match(migration, /async function inspect\(query = mysqlQuery\)/);
  const lockIndex = migration.indexOf("GET_LOCK('tenant_products_ownership_v1'");
  const adminPreflightIndex = migration.indexOf("const before = await inspect(adminQuery)");
  const firstAlterIndex = migration.indexOf("ALTER TABLE ${TABLE} ADD COLUMN tenant_id");
  assert.ok(lockIndex >= 0 && adminPreflightIndex > lockIndex && firstAlterIndex > adminPreflightIndex);
  assert.match(packageJson, /"db:migrate:tenant-products": "node scripts\/migrate-tenant-products-ownership\.mjs"/);
});

test("product relationship tables support tenant-first access without runtime migration", () => {
  const service = read("../src/services/mysql-cutover.js");
  const migration = read("../scripts/migrate-tenant-product-relations.mjs");
  const packageJson = read("../package.json");
  assert.match(service, /CREATE TABLE IF NOT EXISTS product_components \([\s\S]*?tenant_id BIGINT UNSIGNED NULL[\s\S]*?idx_product_components_tenant_parent/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS product_name_aliases \([\s\S]*?tenant_id BIGINT UNSIGNED NULL[\s\S]*?idx_product_name_alias_tenant_search/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /relationship tenant follows its product\(s\), treating legacy NULL product ownership as default/);
  assert.match(migration, /Product relation ownership audit failed/);
  assert.match(migration, /UPDATE product_components relation[\s\S]*?SET relation\.tenant_id = COALESCE\(parent\.tenant_id, default_tenant\.id\)/);
  assert.match(migration, /UPDATE product_name_aliases relation[\s\S]*?SET relation\.tenant_id = COALESCE\(product\.tenant_id, default_tenant\.id\)/);
  assert.match(migration, /orphan references abort before attribution/);
  assert.match(migration, /GET_LOCK\('tenant_product_relations_v1'/);
  assert.match(migration, /async function audit\(query = mysqlQuery\)/);
  assert.match(migration, /async function inspectTable\(table, query = mysqlQuery\)/);
  const lockIndex = migration.indexOf("GET_LOCK('tenant_product_relations_v1'");
  const adminPreflightIndex = migration.indexOf("const { before } = await audit(adminQuery)");
  const firstAlterIndex = migration.indexOf("ALTER TABLE ${table} ADD COLUMN tenant_id");
  assert.ok(lockIndex >= 0 && adminPreflightIndex > lockIndex && firstAlterIndex > adminPreflightIndex);
  assert.match(packageJson, /"db:migrate:tenant-product-relations": "node scripts\/migrate-tenant-product-relations\.mjs"/);
});

test("SKU mappings are tenant-indexed and the explicit migration validates shop/product ownership", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const table = schema.match(/CREATE TABLE IF NOT EXISTS sku_mappings \(([\s\S]*?)\) ENGINE=InnoDB/);
  const migration = read("../scripts/migrate-tenant-sku-mappings.mjs");
  const packageJson = read("../package.json");
  assert.ok(table, "sku mappings schema exists");
  assert.match(table[1], /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table[1], /idx_sku_mappings_tenant_shop_active \(tenant_id, shop_id, active, ozon_sku\)/);
  assert.match(table[1], /idx_sku_mappings_tenant_product_shop \(tenant_id, product_id, shop_id\)/);
  assert.match(table[1], /UNIQUE KEY uk_sku_mappings_shop_sku \(shop_id, ozon_sku\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /COALESCE\(s\.tenant_id, \?\)/);
  assert.match(migration, /COALESCE\(p\.tenant_id, \?\)/);
  assert.match(migration, /ownership audit failed/);
  assert.match(migration, /tenant products migration before SKU mappings/);
  assert.match(migration, /tenant_id_remains_nullable/);
  assert.doesNotMatch(migration, /DROP INDEX uk_sku_mappings_shop_sku/);
  assert.match(migration, /async function inspect\(query = mysqlQuery\)/);
  assert.match(migration, /if \(!APPLY\) \{[\s\S]*?const before = await inspect\(\)[\s\S]*?changes_database: false/);
  const lockIndex = migration.indexOf("GET_LOCK('tenant_sku_mappings_v1'");
  const adminPreflightIndex = migration.indexOf("const before = await inspect(adminQuery)");
  const applyUpdateIndex = migration.indexOf("UPDATE ${TABLE} m");
  assert.ok(lockIndex >= 0 && adminPreflightIndex > lockIndex && applyUpdateIndex > adminPreflightIndex);
  assert.match(packageJson, /"db:migrate:tenant-sku-mappings": "node scripts\/migrate-tenant-sku-mappings\.mjs"/);
});

test("inventory movements support product-derived tenant ownership and locked opt-in backfill", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const table = schema.match(/CREATE TABLE IF NOT EXISTS inventory_movements \(([\s\S]*?)\) ENGINE=InnoDB/);
  const migration = read("../scripts/migrate-tenant-inventory-movements.mjs");
  const service = read("../src/services/mysql-cutover.js");
  const packageJson = read("../package.json");
  assert.ok(table, "inventory movements schema exists");
  assert.match(table[1], /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table[1], /idx_inventory_tenant_product_status_created \(tenant_id, product_id, status, created_at, id\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /COALESCE\(p\.tenant_id, tenant_default\.id\)/);
  assert.match(migration, /orphan_product_count/);
  assert.match(migration, /ownership_mismatch_count/);
  assert.match(migration, /GET_LOCK\(\?, 60\)/);
  assert.match(migration, /changes_database: false/);
  const lockIndex = migration.indexOf("GET_LOCK(?, 60)");
  const adminPreflightIndex = migration.indexOf("const before = await inspect(adminQuery)");
  const firstAlterIndex = migration.indexOf("ALTER TABLE ${TABLE} ADD COLUMN tenant_id");
  assert.ok(lockIndex >= 0 && adminPreflightIndex > lockIndex && firstAlterIndex > adminPreflightIndex);
  const postMovement = service.match(/async function postInventoryMysql\([\s\S]*?(?=async function postProductInventoryWithComponentsMysql)/)?.[0] || "";
  assert.match(postMovement, /inventoryMovementTenantColumnExistsMysql\(\)/);
  assert.match(postMovement, /INSERT INTO inventory_movements[\s\S]*?SELECT COALESCE\(p\.tenant_id, tenant_default\.id\)/);
  assert.match(postMovement, /else \{[\s\S]*?INSERT INTO inventory_movements[\s\S]*?VALUES/);
  const componentMovement = service.match(/async function postProductInventoryWithComponentsMysql\([\s\S]*?(?=async function desiredProductInventoryMovementRowsMysql)/)?.[0] || "";
  assert.match(componentMovement, /postProductInventoryWithComponentsMysql\(connection, body = \{\}, tenantId = "admin"\)/);
  assert.match(componentMovement, /productComponentRowsMysql\(productId, tenantId\)/);
  assert.match(packageJson, /"db:migrate:tenant-inventory-movements": "node scripts\/migrate-tenant-inventory-movements\.mjs"/);
});

test("tenant inventory movement creation passes session scope and rejects products owned by another tenant", () => {
  const service = read("../src/services/mysql-cutover.js");
  const routes = read("../src/server/routes/operations.js");
  const isolation = read("../src/server/tenant-isolation.js");
  const createMovement = service.match(/export async function createInventoryMovementMysql\([\s\S]*?(?=export async function updateInventoryMovementMysql)/)?.[0] || "";

  assert.match(routes, /createInventoryMovement\(body, req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(isolation, /parts\[1\] === "inventory" && parts\[2\] === "movements"[\s\S]*?verb === "POST"/);
  assert.match(createMovement, /SELECT id FROM products WHERE id = \? AND tenant_id = \? AND active = 1 FOR UPDATE/);
  assert.match(createMovement, /库存产品不存在或不属于当前企业，未创建库存流水/);
  assert.match(createMovement, /\["products", "inventory_movements"\]/);
  assert.match(createMovement, /shops WHERE id = \? AND tenant_id = \? AND status = 'active'/);
  assert.match(createMovement, /sku_mappings WHERE id = \? AND tenant_id = \? AND active = 1/);
  assert.match(createMovement, /postProductInventoryWithComponentsMysql\(connection, payload, tenantScoped \? String\(tenantPk\) : "admin"\)/);
});

test("hidden product reads carry tenant scope and fail closed when ownership migrations are missing", () => {
  const catalogRoutes = read("../src/server/routes/catalog.js");
  const service = read("../src/services/mysql-cutover.js");
  const hiddenProducts = service.match(/export async function hiddenProductsMysql\([\s\S]*?(?=export async function selectionProductsMysql)/)?.[0] || "";
  assert.match(catalogRoutes, /services\.hiddenProducts\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(hiddenProducts, /p\.tenant_id = \?/);
  assert.match(hiddenProducts, /sm_filter\.tenant_id = \? AND sm_filter\.product_id = p\.id/);
  assert.match(hiddenProducts, /sh_filter\.tenant_id = \?/);
  assert.match(hiddenProducts, /owner_member\.tenant_id = \$\{tenantPk\}/);
  assert.match(hiddenProducts, /creator_member\.tenant_id = \$\{tenantPk\}/);
  assert.match(hiddenProducts, /NULL AS supplier_id/);
  assert.match(hiddenProducts, /NULL AS supplier_name/);
  assert.match(hiddenProducts, /mysqlSchemaColumnExists\(table, "tenant_id"\)/);
  assert.match(hiddenProducts, /statusCode: 503/);
});

test("hidden product image reads verify product tenant ownership and expose only exact tenant routes", () => {
  const service = read("../src/services/mysql-cutover.js");
  const routes = read("../src/server/routes/catalog.js");
  const hiddenView = read("../frontend/admin/views/inventory/InventoryHiddenPage.vue");
  const images = service.match(/export async function productImageMysql\([\s\S]*?(?=\nconst productImageRefreshInflight)/)?.[0] || "";
  const detailImage = service.match(/export async function productDetailImageMysql\([\s\S]*?(?=\nasync function productOrderDetailRowsMysql)/)?.[0] || "";
  const restore = service.match(/export async function restoreProductMysql\([\s\S]*?(?=\nexport async function createProductFromOnlineProductMysql)/)?.[0] || "";
  const session = { tenant: { id: 42, slug: "company-a" } };
  assert.match(images, /WHERE id = \? AND tenant_id = \?/);
  assert.match(detailImage, /WHERE id = \? AND tenant_id = \?/);
  assert.match(images, /products\.tenant_id/);
  assert.match(routes, /services\.productImage\(id, tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.productDetailImage\(Number\(parts\[2\]\), Number\(parts\[4\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /allowRefresh: tenantIdFromRequest\(req\) === "admin"/);
  assert.match(read("../src/server.js"), /options\.allowRefresh !== false/);
  assert.match(restore, /WHERE id = \?\$\{whereTenantSql\}/);
  assert.match(restore, /该隐藏产品不存在或不属于当前企业/);
  assert.match(routes, /services\.restoreProduct\(Number\(parts\[2\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(hiddenView, /canRestoreProduct = computed\(\(\) => hasPermission\(authStore\.user, "inventory\.write"\)\)/);
  assert.match(hiddenView, /el-table-column v-if="canRestoreProduct" label="操作"/);
  for (const [path, method] of [
    [["api", "products", "hidden"], "GET"],
    [["api", "products", "42", "image"], "GET"],
    [["api", "products", "42", "detail-images", "0"], "GET"],
    [["api", "products", "42", "restore"], "POST"]
  ]) assert.equal(tenantIsolationDecision(session, path, method).allowed, true);
  for (const [path, method] of [
    [["api", "products", "hidden", "42"], "GET"],
    [["api", "products", "42", "image"], "POST"],
    [["api", "products", "42", "detail-images", "all"], "GET"],
    [["api", "products", "all", "restore"], "POST"],
    [["api", "products", "42", "unexpected"], "GET"]
  ]) assert.equal(tenantIsolationDecision(session, path, method).allowed, false);
});

test("tenant product APIs expose only tenant-scoped reads and selection creation", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(session, ["api", "products"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "products", "42"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "products", "hidden"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "products", "selection"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "products"], "POST").allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "products", "other"]],
    ["GET", ["api", "products", "42", "selection"]],
    ["DELETE", ["api", "products", "1"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("tenant product creation is limited to tenant-owned selections and rejects unscoped dependencies", () => {
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  const service = read("../src/services/mysql-cutover.js");
  const routes = read("../src/server/routes/catalog.js");
  const selectionView = read("../frontend/admin/views/selection/SelectionView.vue");
  const createProduct = service.match(/export async function createProductMysql\([\s\S]*?(?=export async function addSelectionToInventoryMysql)/)?.[0] || "";
  const tenantDetail = service.match(/async function tenantInventoryProductDetailMysql\([\s\S]*?(?=export async function selectionProductMysql)/)?.[0] || "";

  assert.match(createProduct, /createProductMysql\(body = \{\}, transactionConnection = null, tenantId = "admin"\)/);
  assert.match(createProduct, /String\(body\.product_type \|\| ""\) !== "selection" \|\| structuredNaming/);
  assert.match(createProduct, /JOIN tenant_members tm ON tm\.person_id = p\.id AND tm\.tenant_id = \? AND tm\.active = 1/);
  assert.match(createProduct, /SELECT id FROM suppliers WHERE id = \? AND tenant_id = \?/);
  assert.match(createProduct, /const productColumns = \[[\s\S]*?\.\.\.\(tenantScoped \? \["tenant_id"\] : \[\]\)/);
  assert.match(createProduct, /const productValues = \[[\s\S]*?\.\.\.\(tenantScoped \? \[tenantPk\] : \[\]\)/);
  assert.match(createProduct, /productColumns\.length !== productValues\.length/);
  assert.match(createProduct, /INSERT INTO products \(\$\{productColumns\.join\(", "\)\}\)[\s\S]*?productColumns\.map\(\(\) => "\?"\)/);
  assert.match(createProduct, /saveProductComponentsTxMysql\(connection, productId, body\.composition_items \|\| body\.components \|\| \[\], tenantScoped \? String\(tenantPk\) : "admin"\)/);
  assert.match(createProduct, /incrementLogisticsRuleUsageMysqlTx\(connection, logisticsRuleId, tenantScoped \? String\(tenantPk\) : "admin"\)/);
  assert.match(createProduct, /不支持同时创建采购申请/);
  const updateProduct = service.match(/export async function updateProductMysql\([\s\S]*?(?=export async function updateProductComponentsMysql)/)?.[0] || "";
  assert.match(updateProduct, /updateProductMysql\(id, body = \{\}, tenantId = "admin"\)/);
  assert.match(updateProduct, /WHERE id = \? AND active = 1 \$\{tenantScoped \? "AND tenant_id = \?" : ""\}/);
  assert.match(updateProduct, /WHERE id = \? \$\{tenantScoped \? "AND tenant_id = \?" : ""\}/);
  assert.match(updateProduct, /所选供应商不存在或不属于当前企业/);
  assert.match(updateProduct, /所选物流规则不存在或不属于当前企业/);
  assert.match(updateProduct, /当前企业只能编辑本企业选品/);
  assert.match(updateProduct, /shouldSyncOutbound = !tenantScoped/);
  const usageUpdate = service.match(/async function incrementLogisticsRuleUsageMysqlTx\([\s\S]*?(?=export async function prepareInventoryProductCreationMysql)/)?.[0] || "";
  assert.match(usageUpdate, /logisticsTenantScopeMysql\(tenantId\)/);
  assert.match(usageUpdate, /WHERE l\.id = \? AND \$\{scope\.sql\}/);
  assert.match(usageUpdate, /所选物流规则不存在或不属于当前企业/);
  assert.match(tenantDetail, /p\.tenant_id = \?/);
  assert.match(tenantDetail, /supplier\.tenant_id = p\.tenant_id/);
  assert.match(tenantDetail, /logistics\.tenant_id = p\.tenant_id/);
  assert.match(routes, /services\.createProduct\(payload, null, tenantId\)/);
  assert.match(routes, /services\.selectionProduct\(created\.id, \{ includeDetails: 0 \}, tenantId\)/);
  assert.match(routes, /services\.updateProduct\(productId, await readProductSaveJson\(readJson, req\), tenantIdFromRequest\(req\)\)/);
  assert.match(tenantDetail, /p\.tenant_id = \?/);
  assert.match(routes, /企业库存建品审批流程尚未完成租户隔离/);
  const tenantSelectionList = service.match(/async function tenantSelectionProductsMysql\([\s\S]*?(?=export async function selectionProductsMysql)/)?.[0] || "";
  assert.match(tenantSelectionList, /p\.tenant_id = \?/);
  assert.match(tenantSelectionList, /supplier\.tenant_id = p\.tenant_id/);
  assert.match(tenantSelectionList, /tenant_members owner_member/);
  assert.doesNotMatch(tenantSelectionList, /asset_variant_jobs/);
  assert.match(routes, /services\.selectionProducts\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(selectionView, /isTenantScoped = computed\(\(\) => Boolean\(authStore\.user\?\.tenant\?\.id && authStore\.user\?\.tenant\?\.slug !== "default"\)\)/);
  assert.match(selectionView, /isTenantScoped\.value \? apiClient\.get\("\/api\/tenants\/members"\) : apiClient\.get\("\/api\/people"\)/);
  assert.match(selectionView, /v-if="!isTenantScoped" class="erp-btn erp-btn-secondary" @click="openImportDialog"/);
  assert.match(selectionView, /v-if="!isTenantScoped" label="上架任务"/);
  assert.match(selectionView, /v-if="!isTenantScoped" label="流转操作"/);
  assert.match(selectionView, /label="维护操作"[\s\S]*?isTenantScoped \? openEditDialog\(row\) : openSelectionEditPage\(row\)/);
  assert.match(selectionView, /v-if="!isTenantScoped" class="erp-btn-link-danger" link type="danger" @click="handleDelete\(row\)"/);
});

test("tenant product edits and composition changes are enabled only on their scoped write routes", () => {
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(tenant, ["api", "products", "42", "components"], "PUT").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "products", "42"], "PUT").allowed, true);
  for (const [parts, method] of [
    [["api", "products", "42", "development-meta"], "PUT"],
    [["api", "products", "42"], "DELETE"],
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
});

test("tenant inventory product list is session-scoped and requires tenant ownership on every joined business domain", () => {
  const service = read("../src/services/mysql-cutover.js");
  const routes = read("../src/server/routes/catalog.js");
  const list = service.match(/async function tenantProductsMysql\([\s\S]*?(?=export async function productsMysql)/)?.[0] || "";
  assert.match(routes, /services\.products\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(list, /p\.tenant_id = \?/);
  assert.match(list, /inventory_sm\.tenant_id = \$\{tenantPk\}/);
  assert.match(list, /inventory_im\.tenant_id = \$\{tenantPk\}/);
  assert.match(list, /inventory_movements\s+WHERE tenant_id = \?/);
  assert.match(list, /procurement_requests WHERE tenant_id = \?/);
  assert.match(list, /sm_search\.tenant_id = \$\{tenantPk\}/);
  assert.match(list, /s_search\.tenant_id = \$\{tenantPk\}/);
  assert.match(list, /productMappingSummariesMysql\(productIds, String\(tenantPk\)\)/);
  assert.match(list, /productCompositionSummariesMysql\(productIds, String\(tenantPk\)\)/);
  assert.match(list, /NULL AS supplier_id/);
  assert.match(list, /missingColumns\.length/);
  const detail = service.match(/async function tenantInventoryProductDetailMysql\([\s\S]*?(?=export async function selectionProductMysql)/)?.[0] || "";
  const components = service.match(/async function productComponentRowsMysql\([\s\S]*?(?=async function productCompositionSummariesMysql)/)?.[0] || "";
  const componentWriteTx = service.match(/async function saveProductComponentsTxMysql\([\s\S]*?(?=function selectionSummaryMysql)/)?.[0] || "";
  const componentSave = service.match(/export async function updateProductComponentsMysql\([\s\S]*?(?=export async function updateProductDevelopmentMetaMysql)/)?.[0] || "";
  assert.match(routes, /services\.selectionProduct\(Number\(parts\[2\]\), Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.updateProductComponents\(productId, await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.equal(tenantIsolationDecision({ tenant: { id: 42, slug: "company-a" } }, ["api", "products", "42", "components"], "PUT").allowed, true);
  assert.equal(tenantIsolationDecision({ tenant: { id: 42, slug: "company-a" } }, ["api", "products", "42", "components"], "POST").allowed, false);
  assert.match(detail, /WHERE p\.id = \? AND p\.tenant_id = \? AND p\.active = 1/);
  assert.match(detail, /productComponentRowsMysql\(Number\(id\), String\(tenantPk\)\)/);
  assert.match(components, /pc\.tenant_id = \$\{tenantPk\}/);
  assert.match(components, /p\.tenant_id = \$\{tenantPk\}/);
  assert.match(components, /AND tenant_id = \$\{tenantPk\}/);
  assert.match(components, /stock_shop\.tenant_id = \$\{tenantPk\}/);
  assert.match(components, /pr\.tenant_id = \$\{tenantPk\}/);
  assert.match(componentWriteTx, /SELECT id FROM products WHERE id = \? AND tenant_id = \? AND active = 1 FOR UPDATE/);
  assert.match(componentWriteTx, /AND tenant_id = \?/);
  assert.match(componentWriteTx, /INSERT INTO product_components \(\$\{tenantScoped \? "tenant_id, " : ""\}product_id/);
  assert.match(componentSave, /tenantScoped \? null : await syncOutboundForOpenOrdersMysql/);
  const view = read("../frontend/admin/views/inventory/InventoryProductsPage.vue");
  assert.match(view, /isTenantScoped = computed\(\(\) => Boolean\(authStore\.user\?\.tenant\?\.id && authStore\.user\?\.tenant\?\.slug !== "default"\)\)/);
  assert.match(view, /v-if="!isTenantScoped" type="selection"/);
  assert.match(view, /canWriteInventory = computed\(\(\) => !isTenantScoped\.value/);
  assert.match(view, /v-if="!isTenantScoped" class="metric-cell-link"/);
  assert.match(view, /<el-button class="erp-btn-link" link @click="openManualOutboundRecords/);
  assert.match(view, /if \(isTenantScoped\.value\) \{[\s\S]*?loadShopDictionary\(\)[\s\S]*?return dictionaryLoading;[\s\S]*?apiClient\.get\("\/api\/people"\)/);
  assert.match(view, /v-if="hasProductComponents\(row\)"/);
  assert.match(view, /canManageProductComponents = computed\(\(\) => hasPermission\(authStore\.user, "inventory\.write"\)\)/);
  assert.match(view, /allow-quick-create="!isTenantScoped"/);
  assert.match(read("../frontend/admin/components/inventory/ProductCompositionDialog.vue"), /v-if="allowQuickCreate"/);
});
