import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { createOrderFixtureSchema, loadTenantOrderService } from "./helpers/tenant-order-service.js";
import { saveOrderPostingLogistics } from "../src/services/mysql-order-posting-logistics.js";
import { isOrderInTransport } from "../src/services/order-query-facts.js";
import { buildLiveShippingProductsMysql, buildSplitShippingPackagesMysql } from "../src/services/mysql-order-shipping-packages.js";
import { strictOzonSkuValue } from "../src/services/mysql-online-product-sku.js";
import { orderStateKey } from "../frontend/orders/constants/orders-ui.js";

const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
const labels = ["click_track_number", "label_download", "label_download_small"];

test("FBS acceptance shipping compensation preserves real SQL state, stock, prints and tenant boundaries", {
  skip: !socketPath && "Requires isolated TENANT_TEST_MYSQL_SOCKET"
}, async t => {
  const database = `ozon_ship_acceptance_${randomBytes(8).toString("hex")}`;
  const connection = await mysql.createConnection({ socketPath, user: "root", dateStrings: true });
  let created = false;
  try {
    assert.equal(Number((await connection.query("SELECT @@skip_networking AS isolated"))[0][0].isolated), 1);
    await connection.query(`CREATE DATABASE \`${database}\``); created = true;
    await connection.changeUser({ database });
    await createOrderFixtureSchema(connection);
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    await query("INSERT INTO tenants(id,slug,name,status) VALUES (1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','active')");
    await query("INSERT INTO people(id,name,role) VALUES (1,'Default packer','packing'),(2,'A packer','packing'),(3,'B packer','packing')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (1,1,'member',JSON_ARRAY('packing')),(2,2,'member',JSON_ARRAY('packing')),(3,3,'member',JSON_ARRAY('packing'))");
    const fixtures = [
      { id: 10, owner: null, tenant: 1, key: "admin", slug: "default" },
      { id: 11, owner: 1, tenant: 1, key: "admin", slug: "default" },
      { id: 20, owner: 2, tenant: 2, key: "2", slug: "a" },
      { id: 30, owner: 3, tenant: 3, key: "3", slug: "b" }
    ];
    function posting(id, status = "acceptance_in_progress") {
      return { posting_number: "SAME-OGL-POSTING", order_id: String(id), order_number: `ORDER-${id}`, status,
        tracking_stage: status === "acceptance_in_progress" ? "posting_acceptance_in_progress" : status,
        logistics_status: status, tracking_number: `TRACK-${id}`, items: [{ ozon_product_id: String(1000 + id), ozon_sku: "SAME-SKU", quantity: 1 }],
        raw: { status, products: [{ product_id: 1000 + id, sku: "SAME-SKU", quantity: 1 }], available_actions: labels,
          delivery_method: { id: 42, name: "OGL Standard", tpl_provider: "OGL", warehouse: "Fixture warehouse" } } };
    }
    for (const row of fixtures) {
      const { id, owner, tenant } = row;
      await query("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,ozon_api_key) VALUES (?,?,?,'active',?,?)", [id, owner, `Shop ${id}`, `fixture-${id}`, `fixture-key-${id}`]);
      await query("INSERT INTO products(id,tenant_id,name,code) VALUES (?,?,?,?)", [id, owner, `Product ${id}`, `P-${id}`]);
      await query("INSERT INTO sku_mappings(id,tenant_id,shop_id,product_id,ozon_sku,offer_id,person_id) VALUES (?,?,?,?,?,?,?)", [id, owner, id, id, "SAME-SKU", `OFFER-${id}`, tenant]);
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES (?,?,'SAME-OGL-POSTING','awaiting_packaging','posting_created','2026-10-20')", [id, id]);
      await query("INSERT INTO order_items(id,order_id,sku_mapping_id,ozon_sku,ozon_product_id,quantity,sale_price) VALUES (?,?,?,'SAME-SKU',?,1,10)", [id, id, id, String(1000 + id)]);
      await query("INSERT INTO ozon_orders_raw(store_id,posting_number,order_id,status,raw_json) VALUES (?,'SAME-OGL-POSTING',?,'awaiting_packaging',?)", [id, String(id), JSON.stringify(posting(id, "awaiting_packaging"))]);
      await query("INSERT INTO order_label_prints(order_id,print_batch_id,printed_by_person_id,printed_at) VALUES (?,'ALREADY-PRINTED',?,'2026-10-21 00:00:00')", [id, tenant]);
      await query("INSERT INTO inventory_movements(tenant_id,product_id,shop_id,source_type,source_ref,quantity_delta,status,movement_type,related_order_item_id,stock_location) VALUES (?,?,?,'order_outbound','SAME-OGL-POSTING',-1,'posted','ORDER_SHIPPED',?,'LOCAL')", [tenant, id, id, id]);
      await query("INSERT INTO inventory_current(real_product_id,available_stock) VALUES (?,9)", [id]);
    }
    let get = async () => assert.fail("Unexpected Ozon GET"), ship = async () => assert.fail("Unexpected paid/business Ozon ship");
    const remote = [], prefetch = [], dirtied = [];
    const { service } = loadTenantOrderService(connection, {
      extraMethods: ["activeShopForTenantMysql", "shippingProductItemsFromRawPayloadMysql", "resolveShippingProductIdMysql", "isAwaitingDeliverLikeStatusMysql", "normalizeSyncedShippingStateMysql", "syncOrderShippingStateFromOzonMysql", "saveRawPostingMysql"],
      saveOrderPostingLogistics, compactOnlineProductRawJson: JSON.stringify, buildLiveShippingProductsMysql, buildSplitShippingPackagesMysql, strictOzonSkuValue,
      fetchOzonPostingByNumber: async (shop, number) => { remote.push(["GET", shop.id, number]); return get(shop, number); },
      shipOzonPosting: async (shop, number, items, options) => { remote.push(["SHIP", shop.id, number]); return ship(shop, number, items, options); },
      markInventoryAlertSkuDailyDirtyMysql: async (_date, tenant) => dirtied.push(String(tenant)),
      invalidateOrderProcurementCoverage() {}, scheduleOrderPackageLabelPrefetchMysql: rows => prefetch.push(...rows)
    });
    const session = row => ({ personId: row.tenant, roles: ["packing"], tenant: { id: row.tenant, slug: row.slug, role: "member" } });
    async function reset(row, status = "awaiting_packaging") {
      remote.length = 0; prefetch.length = 0; dirtied.length = 0;
      await query("UPDATE orders SET status=?,tracking_stage=? WHERE id=?", [status, status === "acceptance_in_progress" ? "posting_acceptance_in_progress" : status, row.id]);
      await query("UPDATE ozon_orders_raw SET status=?,raw_json=? WHERE store_id=?", [status, JSON.stringify(posting(row.id, status)), row.id]);
    }
    const call = row => service.shipOrdersMysql({ order_ids: [row.id], tenant_id: "foreign-forged" }, row.tenant, row.key, { session: session(row) });
    const untouched = async () => ({ prints: await query("SELECT * FROM order_label_prints ORDER BY order_id"), movements: await query("SELECT * FROM inventory_movements ORDER BY id"), balances: await query("SELECT * FROM inventory_current ORDER BY real_product_id") });

    for (const row of fixtures) await t.test(`${row.key}/${row.id}: stale packaging reconciles acceptance with one GET, no ship, and repeat is idempotent`, async () => {
      await reset(row); const before = await untouched();
      const foreignOrders = await query("SELECT * FROM orders WHERE id<>? ORDER BY id", [row.id]);
      const foreignRaw = await query("SELECT * FROM ozon_orders_raw WHERE store_id<>? ORDER BY store_id", [row.id]);
      get = async shop => { assert.equal(shop.id, row.id); return posting(row.id); };
      const result = await call(row);
      assert.deepEqual(remote, [["GET", row.id, "SAME-OGL-POSTING"]]);
      assert.equal(result.already_shipped_count, 1);
      assert.equal(result.updated_orders[0].status, "acceptance_in_progress");
      assert.equal(result.updated_orders[0].tracking_stage, "posting_acceptance_in_progress");
      assert.deepEqual(Array.from(result.updated_orders[0].ozon_available_actions), labels);
      assert.equal((await query("SELECT status FROM orders WHERE id=?", [row.id]))[0].status, "acceptance_in_progress");
      assert.equal((await query("SELECT status FROM ozon_orders_raw WHERE store_id=?", [row.id]))[0].status, "acceptance_in_progress");
      assert.equal((await query(`SELECT o.id FROM orders o WHERE o.id=? AND ${service.orderStatusSqlMysql("awaiting_deliver")}`, [row.id])).length, 1);
      assert.equal((await query(`SELECT o.id FROM orders o WHERE o.id=? AND ${service.orderStatusSqlMysql("awaiting_packaging")}`, [row.id])).length, 0);
      remote.length = 0; await call(row); assert.deepEqual(remote, []);
      assert.deepEqual(await untouched(), before);
      assert.deepEqual(await query("SELECT * FROM orders WHERE id<>? ORDER BY id", [row.id]), foreignOrders);
      assert.deepEqual(await query("SELECT * FROM ozon_orders_raw WHERE store_id<>? ORDER BY store_id", [row.id]), foreignRaw);
      assert.ok(prefetch.every(value => value.tenant_id === row.tenant));
    });

    const a = fixtures[2];
    await t.test("default/A/B exact transport facts override old acceptance without physical members or tracking-number inference", async () => {
      assert.equal(Number((await query("SELECT COUNT(*) AS n FROM ogl_dispatch_members"))[0].n), 0);
      const before = await untouched();
      const stored = await query("SELECT id,status,tracking_stage,logistics_status,tracking_number FROM orders ORDER BY id");
      const transit = ["delivering", "posting_in_transit", "posting_in_customs", "posting_sorting", "posting_on_way", "posting_on_way_to_city", "posting_in_courier_service", "posting_in_pickup_point"];
      const states = transit.flatMap(value => ["status", "tracking_stage", "logistics_status"].map(field => ({
        status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", logistics_status: "", [field]: value
      })));
      states.push(
        ...["delivering", "posting_in_transit", "delivered", "cancelled", "dispute"].map(tracking_number => ({ status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", tracking_number })),
        ...["not_posting_in_transit", "xposting_on_way", "posting_in_customs_extra"].map(logistics_status => ({ status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", logistics_status })),
        ...["delivered", "cancelled", "returned", "dispute"].map(status => ({ status, tracking_stage: "posting_acceptance_in_progress", logistics_status: "posting_in_transit" }))
      );
      try {
        await query("UPDATE orders SET status='awaiting_packaging',tracking_stage='posting_created',logistics_status='',tracking_number=''");
        for (const row of fixtures) {
          const scope = await service.orderListTenantScopeMysql(row.key);
          const matches = async status => (await query(`SELECT o.id FROM orders o JOIN shops s ON s.id=o.shop_id
            WHERE ${service.orderTenantPredicateMysql("s", scope)} AND ${service.orderStatusSqlMysql(status, null, scope)} ORDER BY o.id`)).map(value => Number(value.id));
          for (const state of states) {
            await query("UPDATE orders SET status=?,tracking_stage=?,logistics_status=?,tracking_number=? WHERE id=?", [state.status, state.tracking_stage, state.logistics_status || "", state.tracking_number || "", row.id]);
            const expected = orderStateKey(state), label = `${row.key}/${row.id} ${JSON.stringify(state)}`;
            assert.deepEqual(await matches("awaiting_deliver"), expected === "awaiting_deliver" ? [row.id] : [], label);
            assert.deepEqual(await matches("delivering"), expected === "delivering" ? [row.id] : [], label);
          }
        }
        assert.deepEqual(await untouched(), before);
        assert.deepEqual(remote, []);
      } finally {
        for (const row of stored) await query("UPDATE orders SET status=?,tracking_stage=?,logistics_status=?,tracking_number=? WHERE id=?", [row.status, row.tracking_stage, row.logistics_status, row.tracking_number, row.id]);
      }
    });
    await t.test("a detail response for another posting cannot update the selected order or raw row", async () => {
      await reset(a); const before = await untouched();
      const stored = await query("SELECT * FROM orders WHERE id=20");
      const raw = await query("SELECT * FROM ozon_orders_raw WHERE store_id=20");
      get = async () => ({ ...posting(a.id), posting_number: "FOREIGN-POSTING" });
      await assert.rejects(call(a), error => Number(error.statusCode || error.status) === 409);
      assert.deepEqual(remote.map(value => value[0]), ["GET"]);
      assert.deepEqual(await query("SELECT * FROM orders WHERE id=20"), stored);
      assert.deepEqual(await query("SELECT * FROM ozon_orders_raw WHERE store_id=20"), raw);
      assert.deepEqual(await untouched(), before);
    });
    for (const message of ["HAS_INCORRECT_STATUS", "POSTING_ALREADY_SHIPPED"]) {
      for (const status of ["acceptance_in_progress", "delivering", "delivered"]) await t.test(`${message} reconciles ${status} without terminal downgrade or a second ship`, async () => {
        await reset(a); const before = await untouched(); let reads = 0;
        get = async () => posting(a.id, ++reads === 1 ? "awaiting_packaging" : status);
        ship = async () => { throw Object.assign(new Error(message), { statusCode: 409, path: "/v4/posting/fbs/ship" }); };
        const result = await call(a);
        assert.deepEqual(remote.map(value => value[0]), ["GET", "SHIP", "GET"]);
        assert.equal(result.already_shipped_count, 1);
        assert.equal(result.updated_orders[0].status, status);
        assert.equal((await query("SELECT status FROM orders WHERE id=20"))[0].status, status);
        assert.equal((await query("SELECT status FROM ozon_orders_raw WHERE store_id=20"))[0].status, status);
        assert.deepEqual(await untouched(), before);
      });
    }

    await t.test("false or empty Ozon preparation success cannot update local preparation state", async()=>{
      for(const response of [{result:false},{result:[]}]){
        await reset(a);const before=await untouched();get=async()=>posting(a.id,"awaiting_packaging");ship=async()=>response;
        await assert.rejects(call(a),/未更新本地备货/);assert.equal((await query("SELECT status FROM orders WHERE id=20"))[0].status,"awaiting_packaging");assert.deepEqual(await untouched(),before);
      }
    });

    for (const state of ["cancelled", "unknown", "get-failed"]) await t.test(`wrong-status compensation cannot fabricate success for ${state}`, async () => {
      await reset(a); const before = await untouched(); let reads = 0;
      get = async () => { if (++reads === 1) return posting(a.id, "awaiting_packaging"); if (state === "get-failed") throw new Error("Fixture detail unavailable"); return posting(a.id, state); };
      ship = async () => { throw Object.assign(new Error("HAS_INCORRECT_STATUS"), { statusCode: 409 }); };
      await assert.rejects(call(a));
      assert.equal(remote.filter(value => value[0] === "SHIP").length, 1);
      assert.equal((await query("SELECT status FROM orders WHERE id=20"))[0].status, "awaiting_packaging");
      assert.deepEqual(await untouched(), before);
    });

    await t.test("local acceptance and terminal rows never submit shipping and foreign or revoked requests stop before Ozon", async () => {
      for (const status of ["acceptance_in_progress", "posting_acceptance_in_progress", "delivering", "delivered"]) {
        await reset(a, status); await call(a); assert.deepEqual(remote, []);
      }
      remote.length = 0;
      for (const [key, ids, actor] of [["2", [20, 30], a], ["admin", [20], fixtures[0]], ["3", [20], fixtures[3]]]) {
        await assert.rejects(service.shipOrdersMysql({ order_ids: ids }, actor.tenant, key, { session: session(actor) }), /不属于/);
      }
      assert.deepEqual(remote, []);
      await query("UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2");
      await assert.rejects(call(a), /不可用/); assert.deepEqual(remote, []);
      await query("UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2");
    });

    await t.test("repeated outbound sync retains one existing deduction after acceptance reconciliation", async () => {
      await reset(a, "acceptance_in_progress");
      const { service: outbound } = loadTenantOrderService(connection, {
        extraMethods: ["syncOutboundForOpenOrdersMysql", "orderOutboundSyncScopeMysql", "upsertOrderOutboundRecordMysql", "revokeShippedCancellationReturnsMysql", "recordOrderExceptionMysql", "postInventoryMysql", "postProductInventoryWithComponentsMysql", "desiredProductInventoryMovementRowsMysql", "productComponentRowsMysql", "applyInventoryCurrentMysql", "inventoryDeltasMysql", "movementTypeFromSourceMysql", "rebuildInventoryCurrentForProductMysql", "mysqlConnectionQuery", "mysqlConnectionQueryOne", "normalizeStockLocationMysql"],
        ensureStockLocationSchemaMysql: async () => {}, inventoryMovementTenantColumnExistsMysql: async () => true,
        compactProductImageUrlForListMysql: () => "", isOrderInTransportMysql: isOrderInTransport,
        resolveOrderStockLocationMysql: () => ({ stockLocation: "LOCAL", stockLocationSource: "fixture" }), invalidateOrderProcurementCoverage() {}
      });
      const foreign = await query("SELECT * FROM inventory_movements WHERE tenant_id<>2 ORDER BY id");
      const prints = await query("SELECT * FROM order_label_prints ORDER BY order_id");
      await outbound.syncOutboundForOpenOrdersMysql({ tenantId: "2", order_ids: [20], session: session(a) });
      const movement = await query("SELECT * FROM inventory_movements WHERE tenant_id=2 ORDER BY id");
      const balance = await query("SELECT * FROM inventory_current WHERE real_product_id=20");
      await outbound.syncOutboundForOpenOrdersMysql({ tenantId: "2", order_ids: [20], session: session(a) });
      assert.equal(movement.length, 1);
      assert.equal(Number(movement[0].quantity_delta), -1);
      assert.deepEqual(await query("SELECT id,quantity_delta FROM inventory_movements WHERE tenant_id=2 ORDER BY id"), movement.map(value => ({ id: value.id, quantity_delta: value.quantity_delta })));
      assert.equal(Number((await query("SELECT available_stock FROM inventory_current WHERE real_product_id=20"))[0].available_stock), Number(balance[0].available_stock));
      assert.equal((await query("SELECT COUNT(*) n FROM outbound_records WHERE order_item_id=20"))[0].n, 1);
      assert.deepEqual(await query("SELECT * FROM inventory_movements WHERE tenant_id<>2 ORDER BY id"), foreign);
      assert.deepEqual(await query("SELECT * FROM order_label_prints ORDER BY order_id"), prints);
    });
  } finally {
    if (created) await connection.query(`DROP DATABASE \`${database}\``);
    await connection.end();
  }
});
