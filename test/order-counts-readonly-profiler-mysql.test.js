import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";
import { createOrderFixtureSchema } from "./helpers/tenant-order-service.js";

test("read-only count profiler executes the real isolated coverage and aggregation without initializing or writing data", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires independent TCP-disabled MySQL socket", timeout: 90000
}, async t => {
  const f = await createTenantMysqlFixture("counts_profile");
  try {
    await createOrderFixtureSchema(f.connection);
    await f.query("CREATE TABLE fbp_replenishment_orders(id BIGINT PRIMARY KEY,shop_id BIGINT,status VARCHAR(32)) ENGINE=InnoDB");
    await f.query("CREATE TABLE fbp_replenishment_order_items(id BIGINT PRIMARY KEY,order_id BIGINT,shop_id BIGINT,product_id BIGINT,approved_qty DECIMAL(18,4)) ENGINE=InnoDB");
    await f.query("CREATE TABLE fbp_replenishment_item_adjustments(item_id BIGINT,adjustment_qty DECIMAL(18,4)) ENGINE=InnoDB");
    await f.query("CREATE TABLE inventory_order_priorities(product_id BIGINT,order_item_id BIGINT,priority INT) ENGINE=InnoDB");
    await f.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','Private A')");
    await f.query("INSERT INTO shops(id,tenant_id,name) VALUES(10,NULL,'Legacy'),(20,2,'Private B')");
    await f.query("INSERT INTO products(id,tenant_id,name,code) VALUES(1,NULL,'Private inventory','P1'),(2,2,'Other private inventory','P2')");
    await f.query("INSERT INTO sku_mappings(id,tenant_id,shop_id,ozon_sku,product_id) VALUES(1,NULL,10,'same-sku',1),(2,2,20,'same-sku',2)");
    await f.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(1,10,'PRIVATE-POSTING-1','awaiting_packaging','2026-10-01'),(2,10,'PRIVATE-POSTING-2','delivered','2026-10-02'),(3,20,'OTHER-POSTING','awaiting_deliver','2026-10-03')");
    await f.query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES(1,1,1,'same-sku',1,100),(2,2,1,'same-sku',1,100),(3,3,2,'same-sku',1,100)");
    await f.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type) VALUES(NULL,1,100,'opening_stock'),(2,2,100,'opening_stock')");
    const inventory = Array.from({ length: 200 }, (_, index) => [index + 3, null, `Private component ${index}`, `C${index}`]);
    await f.connection.query("INSERT INTO products(id,tenant_id,name,code) VALUES ?", [inventory]);
    await f.connection.query("INSERT INTO sku_mappings(id,tenant_id,shop_id,ozon_sku,product_id) VALUES ?", [inventory.map(([id]) => [id, null, 10, `sku-${id}`, id])]);
    await f.connection.query("INSERT INTO inventory_movements(tenant_id,product_id,quantity_delta,source_type) VALUES ?", [inventory.map(([id]) => [null, id, 10, 'opening_stock'])]);
    const orders = Array.from({ length: 1000 }, (_, index) => [1000 + index, 10, `PRIVATE-POSTING-${1000 + index}`,
      ['awaiting_packaging', 'awaiting_deliver', 'delivering', 'delivered', 'cancelled'][index % 5], `2026-10-${String(1 + index % 20).padStart(2, '0')}`]);
    await f.connection.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES ?", [orders]);
    await f.connection.query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,quantity,sale_price) VALUES ?", [orders.map(([id], index) => [id, id, index % 2 ? null : 3 + index % 200, `sku-${3 + index % 200}`, 1 + index % 3, 100])]);
    await f.connection.query("INSERT INTO order_status_history(order_id,shop_id,posting_number,status,observed_at,observed_hour,last_status_changed_at) VALUES ?",
      [orders.flatMap(([id, shop, posting, status]) => Array.from({ length: 10 }, (_, hour) => [id, shop, posting, hour < 5 ? 'awaiting_deliver' : status,
        `2026-10-21 ${String(hour).padStart(2, '0')}:00:00`, `2026-10-21 ${String(hour).padStart(2, '0')}:00:00`, hour === 9 ? null : '2026-10-21 08:00:00']))]);
    await f.query("INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(NULL,3,4,2),(NULL,3,5,1)");
    await f.query("INSERT INTO sku_inventory_recipes(id,shop_id,ozon_sku,active,mode) VALUES(1,10,'sku-3',1,'combo')");
    await f.query("INSERT INTO sku_inventory_recipe_items(recipe_id,product_id,quantity) VALUES(1,6,2),(1,7,1)");
    await f.query("INSERT INTO ogl_dispatch_batches(id,tenant_id,batch_number,client_request_id,default_shop_id,containers_count,created_by) VALUES(1,1,'fixture-physical','fixture-request',10,1,1)");
    await f.query("INSERT INTO ogl_dispatch_members(tenant_id,batch_id,order_id,active_order_id,shop_id,posting_number,dispatched_at) VALUES(1,1,1000,1000,10,'PRIVATE-POSTING-1000','2026-10-22')");
    await f.query("INSERT INTO purchase_orders(id,tenant_id,order_no,status,purchased_at) VALUES(1,NULL,'P-APPROVED','purchased','2026-09-01')");
    await f.query("INSERT INTO procurement_requests(id,tenant_id,product_id,source_order_item_id,quantity,amount,status,purchase_order_id) VALUES(1,NULL,4,1001,2,20,'purchased',1),(2,NULL,5,1002,3,0,'purchased',1)");
    await f.query("INSERT INTO inbound_records(id,tenant_id,product_id,quantity,amount,status,purchase_order_id,procurement_request_id,created_at,approved_at) VALUES(1,NULL,4,1,10,'approved',1,1,'2026-09-01','2026-09-02'),(2,NULL,4,1,10,'pending_arrival',1,1,'2026-09-01',NULL),(3,NULL,5,3,0,'pending_arrival',1,2,'2026-09-01',NULL)");
    await f.query("INSERT INTO procurement_order_allocations(procurement_request_id,order_item_id,order_id,product_id,allocated_quantity) VALUES(1,1001,1001,4,2),(2,1002,1002,5,3)");
    await f.query("INSERT INTO procurement_history_sources(action_id,order_item_id,product_id,quantity,inbound_record_id) VALUES(1,1001,4,1,1)");
    await f.query("INSERT INTO inventory_order_priorities(product_id,order_item_id,priority) VALUES(4,1001,5)");
    const cli = fileURLToPath(new URL("../scripts/profile-order-counts-readonly.mjs", import.meta.url));
    const baseline = fileURLToPath(new URL("./fixtures/order-procurement-coverage-read-v1.js", import.meta.url));
    const algorithmBaseline = fileURLToPath(new URL("./fixtures/order-procurement-coverage-calculate-v1.js", import.meta.url));
    const run = async (tenant = "admin") => JSON.parse((await promisify(execFile)(process.execPath, [cli, `--database=${f.database}`, `--mysql-admin-socket=${process.env.TENANT_TEST_MYSQL_SOCKET}`, `--tenant-id=${tenant}`, "--date-from=2026-07-26", "--date-to=2026-10-24", `--compare-coverage-source=${baseline}`, `--compare-algorithm-source=${algorithmBaseline}`, "--explain"], { windowsHide: true, timeout: 30000 })).stdout);
    const before = await f.query("SELECT COUNT(*) n FROM inventory_movements");
    const report = await run();
    assert.equal(report.mode, "read-only"); assert.equal(report.initialization_performed, false);
    assert.equal(report.counts.all, 1002); assert.equal(report.coverage_orders, 1002);
    assert.ok(report.measurements.some(row => row.stage === "procurement_demands" && row.rows >= 1002));
    assert.ok(report.measurements.some(row => row.stage === "status_counts"));
    assert.equal(report.explains.length, 4);
    assert.equal(report.consistent_read_only_snapshot, true);
    assert.equal(report.comparison.equal_coverage, true, JSON.stringify(report.comparison));
    assert.equal(report.comparison.equal_counts, true);
    assert.ok(report.assembly.every(row => row.algorithm_ms >= 0 && row.input_rows.demands > 0));
    assert.notEqual(report.comparison.baseline_algorithm_sha256, report.comparison.candidate_algorithm_sha256);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE-POSTING|OTHER-POSTING|Private inventory|Other private/);
    assert.deepEqual(await f.query("SELECT COUNT(*) n FROM inventory_movements"), before);
    const customer = await run("2");
    assert.equal(customer.counts.all, 1); assert.equal(customer.coverage_orders, 1);
    assert.equal(customer.comparison.equal_coverage, true); assert.equal(customer.comparison.equal_counts, true);
    t.diagnostic(`Same snapshot, 1,002 owned orders/10k history and partial-receipt/allocation evidence: optimized coverage=${report.coverage_total_ms}ms; v1=${report.comparison.candidate_coverage_ms}ms; complete coverage/property hashes and all counts equal for default and customer.`);
  } finally { await f.cleanup(); }
});
