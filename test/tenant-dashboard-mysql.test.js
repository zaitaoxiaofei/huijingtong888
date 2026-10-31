import assert from "node:assert/strict";
import test from "node:test";
import { createTenantMysqlFixture } from "./helpers/tenant-mysql-fixture.js";

test("actual dashboard queries and persisted snapshots isolate A/B/default", {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated socket-only MySQL", timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture("dashboard");
  fixture.useEnvironment();
  const service = await import("../src/services/mysql-cutover.js");
  const { closeMysqlPool } = await import("../src/mysql-pool.js");
  const { query } = fixture;
  try {
    await query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES(1,'Default staff','admin'),(2,'A staff','admin'),(3,'B private staff','admin')");
    for (const id of [1, 2, 3]) {
      await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'admin',JSON_ARRAY('admin'))", [id, id]);
      await query("INSERT INTO shops(id,tenant_id,name) VALUES(?,?,?)", [id * 10, id === 1 ? null : id, `Only company ${id}`]);
    }
    await service.warmCoreInventoryRuntimeMysql("admin");
    for (const id of [1, 2, 3]) {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(?,?,?,'delivered','delivered','2026-10-02 04:00:00')", [id * 10, id * 10, `company-${id}`]);
      await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(?,?,?,?,?,?)", [id * 10, id * 10, "same-sku", 1, id * 100, id * 10]);
      await query("INSERT INTO analytics_shop_daily(date_key,shop_id,revenue,current_profit,effective_orders) VALUES('2026-10-02',?,?,?,1)", [id * 10, id * 100, id * 10]);
      await query("INSERT INTO ozon_ad_sku_daily(date_key,shop_id,ozon_sku,spend_cny,revenue_cny) VALUES('2026-10-02',?,'same-sku',?,?)", [id * 10, id, id * 10]);
    }
    const built = new Map();
    for (const id of [1, 2, 3]) built.set(id, await service.refreshDashboardSnapshotMysql({ date_key: "2026-10-02", forceRefresh: true, tenantId: 3 }, id === 1 ? "admin" : String(id)));
    await t.test("forced rebuild preserves the existing dashboard contract with scoped sales, ads and month totals", async () => {
      for (const id of [1, 2, 3]) {
        const result = built.get(id);
        assert.equal(result.commerce.today.order_count, 1);
        assert.equal(result.commerce.today.effective_revenue, id * 100);
        assert.deepEqual(result.commerce.shops.map(row => Number(row.shop_id)), [id * 10]);
        assert.equal(result.commerce.profit_trend.month_total_revenue, id * 100);
        assert.equal(result.commerce.advertising.today.spend_cny, id);
        assert.equal(result.summary.month_shipping_cost.revenue, id * 100);
        assert.deepEqual(result.summary.scheduled_jobs, {});
        assert.ok(!JSON.stringify(result).includes(`Only company ${id === 2 ? 3 : 2}`));
      }
    });
    await t.test("old global snapshot is ignored and cache refresh cannot replace another enterprise", async () => {
      await query("INSERT INTO dashboard_snapshots(snapshot_key,date_key,payload_json,source_updated_at,refreshed_at) VALUES('dashboard:2026-10-02','2026-10-02',?,NOW(),NOW())", [JSON.stringify({ commerce: { today: { effective_revenue: 999999 }, shops: [{ shop_name: "global secret" }] } })]);
      for (const id of [1, 2, 3]) {
        const result = await service.dashboardMysql({ date_key: "2026-10-02", snapshot_only: 1, tenant_id: 3 }, String(id));
        assert.equal(result.commerce.today.effective_revenue, id * 100);
        assert.ok(!JSON.stringify(result).includes("global secret"));
      }
      const beforeB = (await query("SELECT payload_json FROM dashboard_snapshots WHERE snapshot_key='dashboard:v2:tenant:3:2026-10-02'"))[0].payload_json;
      await service.refreshDashboardSnapshotMysql({ date_key: "2026-10-02" }, "2");
      const afterB = (await query("SELECT payload_json FROM dashboard_snapshots WHERE snapshot_key='dashboard:v2:tenant:3:2026-10-02'"))[0].payload_json;
      assert.deepEqual(afterB, beforeB);
    });
    await t.test("aftersales report and export details also reject a foreign shop filter", async () => {
      const result = await service.profitAftersalesMysql({ from: "2026-10-01", to: "2026-10-31", shop_id: 30 }, "2");
      assert.equal(result.totals.order_count || result.totals.orders || 0, 0);
      assert.ok(!JSON.stringify(result).includes("Only company 3"));
      const details = await service.profitAftersalesDetailsMysql({ from: "2026-10-01", to: "2026-10-31", export: "1" }, "admin");
      assert.ok(!JSON.stringify(details).includes("Only company 2"));
    });
    await t.test("legacy ERP diagnostic views also obey the current enterprise", async () => {
      for (const id of [1, 2, 3]) {
        await query("INSERT INTO ozon_orders_raw(store_id,posting_number,raw_json) VALUES(?,?,?)", [id*10, `company-${id}`, JSON.stringify({ private: `Company ${id}` })]);
        await query("INSERT INTO order_profit_items(order_item_id,net_profit_cny) VALUES(?,?)", [id*10,id]);
        await query("INSERT INTO order_exceptions(store_id,order_item_id,exception_type,message) VALUES(?,?,'test',?)",[id*10,id*10,`Company ${id}`]);
      }
      for (const id of [1, 2, 3]) {
        const tenant = id === 1 ? 'admin' : String(id);
        assert.deepEqual((await service.rawOzonOrdersMysql(tenant)).map(row => Number(row.store_id)),[id*10]);
        assert.deepEqual((await service.profitItemsMysql(tenant)).map(row => Number(row.order_item_id)),[id*10]);
        assert.deepEqual((await service.orderExceptionsMysql(tenant)).map(row => Number(row.store_id)),[id*10]);
      }
    });
    await t.test("normal visits refresh newly landed orders while polling only reads progress/snapshots", async () => {
      await query("INSERT INTO orders(id,shop_id,posting_number,status,tracking_stage,ordered_at) VALUES(21,20,'new-a','delivered','delivered','2026-10-02 05:00:00')");
      await query("INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,estimated_profit) VALUES(21,21,'new-sku',1,50,5)");
      const initial = await service.dashboardMysql({ date_key: "2026-10-02" }, "2");
      assert.equal(initial.snapshot.status, "building");
      let current = initial;
      for (let i = 0; i < 200 && current.snapshot.status === "building"; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        current = await service.dashboardMysql({ date_key: "2026-10-02", snapshotOnly: "1" }, "2");
      }
      assert.equal(current.snapshot.status, "snapshot");
      assert.equal(current.commerce.today.effective_orders, 2);
      assert.equal(current.commerce.today.effective_revenue, 250);
      const other = await service.dashboardMysql({ date_key: "2026-10-02", snapshotOnly: "1" }, "3");
      assert.equal(other.commerce.today.effective_orders, 1);
      assert.equal(other.commerce.today.effective_revenue, 300);
    });
  } finally {
    await closeMysqlPool();
    await fixture.cleanup();
  }
});
