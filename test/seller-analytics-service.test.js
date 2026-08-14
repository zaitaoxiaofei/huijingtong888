import test from "node:test";
import assert from "node:assert/strict";
import {
  claimPluginPrepareRequest,
  claimNextCollectRequest,
  claimNextCollectRequests,
  createCollectRun,
  finishCollectRequest,
  getAnalysis,
  getPluginStatus,
  inferSourceFromRequest,
  listOperationTodos,
  preparePlugin,
  refreshOperationTodos,
  resolveCollectPeriod,
  savePluginStatus,
  validatePluginStatus,
  saveSnapshot
} from "../src/services/seller-analytics.js";
import fs from "node:fs";

test("collect queue converts ISO timestamps before writing MySQL DATETIME columns", () => {
  const source = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
  assert.match(source, /mysqlDateValue\(run\.created_at\), mysqlDateValue\(run\.updated_at\)/);
  assert.match(source, /mysqlDateValue\(request\.claimed_at\)/);
  assert.match(source, /mysqlDateValue\(request\.finished_at\)/);
  assert.doesNotMatch(source, /stringifyJson\(run\.previous_period \|\| \{\}\), run\.created_at, run\.updated_at/);
});

function createMemorySellerAnalyticsDb() {
  const tables = {
    SellerAnalyticsSnapshot: [],
    SellerAnalyticsProductMetric: [],
    SellerAnalyticsProductDiagnosis: [],
    SellerAnalyticsOperationTodo: [],
    Setting: [],
    OnlineProduct: []
  };
  const matchesWhere = (row, where = {}) => Object.entries(where || {}).every(([key, expected]) => {
    if (expected && typeof expected === "object" && expected.__sellerAnalyticsOp === "in") {
      return expected.values.includes(row[key]);
    }
    return row[key] === expected;
  });
  return {
    tables,
    getRepository(entityName) {
      return {
        async save(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) {
            const table = tables[entityName];
            const existingIndex = entityName === "Setting"
              ? table.findIndex((item) => item.key === row.key && item.tenant_id === row.tenant_id)
              : table.findIndex((item) => item.id === row.id);
            if (existingIndex >= 0) table[existingIndex] = row;
            else table.push(row);
          }
          return payload;
        },
        async find(options = {}) {
          const table = tables[entityName];
          return table.filter((row) => matchesWhere(row, options.where || {}));
        },
        async delete(where = {}) {
          const table = tables[entityName];
          const before = table.length;
          tables[entityName] = table.filter((row) => !matchesWhere(row, where));
          return { affected: before - tables[entityName].length };
        },
        async findOne(options = {}) {
          const table = tables[entityName];
          return table.find((row) => matchesWhere(row, options.where || {})) || null;
        },
        async count(options = {}) {
          const table = tables[entityName];
          return table.filter((row) => matchesWhere(row, options.where || {})).length;
        },
        createQueryBuilder() {
          const state = { tenantId: "admin", prefix: "", take: 50 };
          return {
            where(_sql, params = {}) {
              if (params.tenantId) state.tenantId = params.tenantId;
              return this;
            },
            andWhere(_sql, params = {}) {
              if (params.prefix) state.prefix = String(params.prefix).replace(/%$/, "");
              return this;
            },
            orderBy() {
              return this;
            },
            take(value) {
              state.take = Number(value || 50);
              return this;
            },
            async getMany() {
              return tables[entityName]
                .filter((row) => row.tenant_id === state.tenantId && String(row.key || "").startsWith(state.prefix))
                .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
                .slice(0, state.take);
            }
          };
        }
      };
    }
  };
}

test("seller analytics 7d period uses yesterday as the end date", () => {
  const period = resolveCollectPeriod({ period_key: "7d" }, new Date("2026-06-01T10:00:00Z"));

  assert.deepEqual(period.current_period, { date_from: "2026-05-25", date_to: "2026-05-31" });
  assert.deepEqual(period.previous_period, { date_from: "2026-05-18", date_to: "2026-05-24" });
});

test("seller analytics infers all_metrics from official request metrics", () => {
  const source = inferSourceFromRequest({
    request_body: {
      metrics: ["revenue", "delivered_units", "conv_hits_to_cart_to_order"]
    }
  });

  assert.equal(source.key, "all_metrics");
  assert.equal(source.label, "所有指标");
});

test("seller analytics replaces older plugin snapshot for the same collected page", async () => {
  const db = createMemorySellerAnalyticsDb();
  const payload = {
    source: "pivot-table-master-controlled",
    source_button_key: "hot",
    source_context: {
      endpoint_type: "by_sku",
      page_index: 0
    },
    request_url: "https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku",
    request_method: "POST",
    request_headers: { "X-O3-Company-Id": "123456" },
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units"],
      limit: "100",
      offset: "0"
    },
    period_key: "7d"
  };

  await saveSnapshot(db, {
    ...payload,
    captured_at: "2026-06-01T10:00:00.000Z",
    response_body: {
      items: [{ sku: "old-sku", product_name: "Old", revenue: 10, ordered_units: 1 }]
    }
  }, "admin");
  await saveSnapshot(db, {
    ...payload,
    captured_at: "2026-06-01T10:05:00.000Z",
    response_body: {
      items: [{ sku: "new-sku", product_name: "New", revenue: 20, ordered_units: 2 }]
    }
  }, "admin");

  assert.equal(db.tables.SellerAnalyticsSnapshot.length, 1);
  assert.equal(db.tables.SellerAnalyticsProductMetric.length, 1);
  assert.match(db.tables.SellerAnalyticsSnapshot[0].response_body, /new-sku/);
  assert.equal(db.tables.SellerAnalyticsProductMetric[0].sku, "new-sku");
});

test("seller analytics analysis caps returned focus products while keeping total count", async () => {
  const db = createMemorySellerAnalyticsDb();
  db.tables.SellerAnalyticsSnapshot.push({
    id: "snapshot_1",
    tenant_id: "admin",
    tab_key: "overview",
    source_button_key: "overview",
    source_button_label: "数据概览",
    period_key: "7d",
    captured_at: "2026-06-01T10:00:00.000Z",
    request_body: JSON.stringify({
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" }
    }),
    response_body: JSON.stringify({
      items: Array.from({ length: 5 }, (_, index) => ({
        sku: `sku-${index + 1}`,
        product_name: `Product ${index + 1}`,
        revenue: 100 - index,
        ordered_units: index + 1
      }))
    })
  });

  const analysis = await getAnalysis(db, {
    period_key: "7d",
    page: 1,
    product_limit: 2,
    focus_limit: 3
  }, "admin");

  assert.equal(analysis.summary.productCount, 5);
  assert.equal(analysis.products.length, 2);
  assert.equal(analysis.focusProducts.length, 3);
});

test("seller analytics derives funnel rates and filters before pagination", async () => {
  const db = createMemorySellerAnalyticsDb();
  await saveSnapshot(db, {
    source_button_key: "all_metrics",
    period_key: "rate-filter-test",
    request_body: { metrics: ["search_views", "pdp_views", "hits_pdp_to_cart", "total_hits_to_cart", "ordered_units"] },
    response_body: {
      items: [
        { sku: "strong", search_views: 1000, pdp_views: 100, hits_pdp_to_cart: 20, total_hits_to_cart: 25, ordered_units: 10 },
        { sku: "weak", search_views: 1000, pdp_views: 20, hits_pdp_to_cart: 1, total_hits_to_cart: 2, ordered_units: 1 }
      ]
    }
  }, "admin");

  const analysis = await getAnalysis(db, {
    period_key: "rate-filter-test",
    click_rate_min: 5,
    sort_key: "metric:convPdpViewsToCart",
    sort_order: "desc",
    page: 1,
    product_limit: 1
  }, "admin");

  assert.equal(analysis.summary.productCount, 1);
  assert.equal(analysis.products[0].sku, "strong");
  assert.equal(analysis.products[0].metrics.convSearchViewsToPdp, 10);
  assert.equal(analysis.products[0].metrics.convPdpViewsToCart, 20);
  assert.equal(analysis.products[0].metrics.convHitsToCartToOrder, 40);
  assert.equal(analysis.products[0].metrics.convPdpViewsToOrder, 10);
});

test("seller analytics click rate follows the displayed exposure denominator", async () => {
  const db = createMemorySellerAnalyticsDb();
  await saveSnapshot(db, {
    source_button_key: "all_metrics",
    period_key: "displayed-rate-test",
    request_body: { metrics: ["total_views", "search_views", "pdp_views", "ordered_units"] },
    response_body: { items: [{ sku: "sku-rate", total_views: 163615, search_views: 22777, pdp_views: 6947, ordered_units: 168, conv_search_views_to_pdp: 30.5 }] }
  }, "admin");
  const analysis = await getAnalysis(db, { period_key: "displayed-rate-test" }, "admin");

  assert.equal(Number(analysis.products[0].metrics.convSearchViewsToPdp.toFixed(2)), 4.25);
  assert.equal(Number(analysis.products[0].metrics.convPdpViewsToOrder.toFixed(2)), 2.42);
});

test("seller analytics recomputes rates after metrics from different tabs are merged", async () => {
  const db = createMemorySellerAnalyticsDb();
  const base = { period_key: "merged-rate-test", request_body: { metrics: [] } };
  await saveSnapshot(db, { ...base, source_button_key: "search", response_body: { items: [{ sku: "sku-merged", total_views: 111857 }] } }, "admin");
  await saveSnapshot(db, { ...base, source_button_key: "card_quality", response_body: { items: [{ sku: "sku-merged", pdp_views: 5374, conv_search_views_to_pdp: 30.1 }] } }, "admin");
  await saveSnapshot(db, { ...base, source_button_key: "hot", response_body: { items: [{ sku: "sku-merged", ordered_units: 172 }] } }, "admin");

  const analysis = await getAnalysis(db, { period_key: "merged-rate-test" }, "admin");
  assert.equal(Number(analysis.products[0].metrics.convSearchViewsToPdp.toFixed(2)), 4.8);
  assert.equal(Number(analysis.products[0].metrics.convPdpViewsToOrder.toFixed(2)), 3.2);
});

test("seller analytics analysis cache is invalidated after saving a snapshot", async () => {
  const db = createMemorySellerAnalyticsDb();
  const query = {
    period_key: "7d",
    page: 1,
    product_limit: 30,
    focus_limit: 30
  };

  await saveSnapshot(db, {
    source_button_key: "overview",
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units"]
    },
    period_key: "7d",
    response_body: {
      items: [{ sku: "sku-1", product_name: "Product 1", revenue: 10, ordered_units: 1 }]
    }
  }, "admin");

  const first = await getAnalysis(db, query, "admin");
  assert.equal(first.summary.productCount, 1);

  await saveSnapshot(db, {
    source_button_key: "hot",
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units"],
      offset: "100"
    },
    period_key: "7d",
    response_body: {
      items: [{ sku: "sku-2", product_name: "Product 2", revenue: 20, ordered_units: 2 }]
    }
  }, "admin");

  const second = await getAnalysis(db, query, "admin");
  assert.equal(second.summary.productCount, 2);
});

test("seller analytics analysis filters snapshots by selected store", async () => {
  const db = createMemorySellerAnalyticsDb();
  const base = {
    source_button_key: "hot",
    request_body: {
      current_period: { date_from: "2026-06-02", date_to: "2026-06-02" },
      metrics: ["revenue", "ordered_units"]
    },
    period_key: "store-filter-test"
  };

  await saveSnapshot(db, {
    ...base,
    request_headers: { "X-O3-Company-Id": "111111" },
    response_body: {
      items: [{ sku: "mat-sku", product_name: "MAT Product", revenue: 10, ordered_units: 1 }]
    }
  }, "admin");
  await saveSnapshot(db, {
    ...base,
    request_headers: { "X-O3-Company-Id": "222222" },
    response_body: {
      items: [{ sku: "s-sku", product_name: "S Product", revenue: 20, ordered_units: 2 }]
    }
  }, "admin");

  const mat = await getAnalysis(db, { period_key: "store-filter-test", store_id: "111111", page: 1, product_limit: 30 }, "admin");
  const s = await getAnalysis(db, { period_key: "store-filter-test", store_id: "222222", page: 1, product_limit: 30 }, "admin");

  assert.equal(mat.summary.productCount, 1);
  assert.equal(s.summary.productCount, 1);
  assert.equal(mat.products[0].sku, "mat-sku");
  assert.equal(s.products[0].sku, "s-sku");
});

test("seller analytics collect runs are not reused across stores", async () => {
  const db = createMemorySellerAnalyticsDb();
  const first = await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "111111",
    company_id: "111111"
  }, "admin");
  const second = await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "222222",
    company_id: "222222"
  }, "admin");

  assert.notEqual(first.id, second.id);
  assert.equal(first.store_id, "111111");
  assert.equal(second.store_id, "222222");
});

test("seller analytics claims collect requests for the current store only", async () => {
  const db = createMemorySellerAnalyticsDb();
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "111111",
    company_id: "111111"
  }, "admin");
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["search"],
    page: 1,
    store_id: "222222",
    company_id: "222222"
  }, "admin");

  const request = await claimNextCollectRequest(db, "admin", { company_id: "222222" });

  assert.equal(request.source_key, "search");
});

test("seller analytics does not claim another store when the current store has no pending run", async () => {
  const db = createMemorySellerAnalyticsDb();
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "111111",
    company_id: "111111"
  }, "admin");

  const request = await claimNextCollectRequest(db, "admin", { company_id: "999999" });

  assert.equal(request, null);
});

test("seller analytics batch claim reads and writes one run only once", async () => {
  const db = createMemorySellerAnalyticsDb();
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot", "search"],
    page: 1,
    store_id: "111111"
  }, "admin");
  const requests = await claimNextCollectRequests(db, "admin", 10, { store_id: "111111" });

  assert.equal(requests.length, 4);
  const savedRun = JSON.parse(db.tables.Setting[0].value);
  assert.equal(savedRun.requests.filter((item) => item.status === "running").length, 4);
});

test("seller analytics drops repeated batch polling during the server cooldown", async () => {
  const db = createMemorySellerAnalyticsDb();
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "cooldown-store"
  }, "cooldown-tenant");

  const first = await claimNextCollectRequests(db, "cooldown-tenant", 1, { store_id: "cooldown-store" });
  const repeated = await claimNextCollectRequests(db, "cooldown-tenant", 1, { store_id: "cooldown-store" });

  assert.equal(first.length, 1);
  assert.deepEqual(repeated, []);
});

test("seller analytics shares polling cooldown across stores in one tenant", async () => {
  const db = createMemorySellerAnalyticsDb();
  await createCollectRun(db, {
    period_key: "7d",
    source_keys: ["hot"],
    page: 1,
    store_id: "store-a"
  }, "shared-cooldown-tenant");

  const first = await claimNextCollectRequests(db, "shared-cooldown-tenant", 1, { store_id: "store-a" });
  const anotherStore = await claimNextCollectRequests(db, "shared-cooldown-tenant", 1, { store_id: "store-b" });

  assert.equal(first.length, 1);
  assert.deepEqual(anotherStore, []);
});

test("seller analytics validates plugin status against selected store", async () => {
  const db = createMemorySellerAnalyticsDb();
  await savePluginStatus(db, {
    seller_missing: false,
    seller_tab: { id: 1, url: "https://seller.ozon.ru/app/analytics", title: "Analytics" },
    current_company_id: "222222",
    polling_enabled: true,
    synced_at: new Date(Date.now() + 1000).toISOString()
  }, "admin");

  const mismatch = await validatePluginStatus(db, { store_id: "111111", shop_name: "RuVibe Mart" }, "admin");
  const ready = await validatePluginStatus(db, { store_id: "222222", shop_name: "RuVibe Mart" }, "admin");

  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "company_mismatch");
  assert.equal(ready.ok, true);
  assert.equal(ready.code, "ready");
});

test("seller analytics isolates plugin status by browser instance", async () => {
  const db = createMemorySellerAnalyticsDb();
  const common = {
    seller_missing: false,
    seller_tab: { id: 1, url: "https://seller.ozon.ru/app/analytics", title: "Analytics" },
    polling_enabled: true,
    synced_at: new Date(Date.now() + 1000).toISOString()
  };
  await savePluginStatus(db, { ...common, plugin_instance_id: "browser-a", current_company_id: "111111" }, "admin");
  await savePluginStatus(db, { ...common, plugin_instance_id: "browser-b", current_company_id: "222222" }, "admin");

  const statusA = await getPluginStatus(db, "admin", { plugin_instance_id: "browser-a" });
  const statusB = await getPluginStatus(db, "admin", { plugin_instance_id: "browser-b" });
  const readyA = await validatePluginStatus(db, { plugin_instance_id: "browser-a", store_id: "111111" }, "admin");

  assert.equal(statusA.current_company_id, "111111");
  assert.equal(statusB.current_company_id, "222222");
  assert.equal(readyA.ok, true);
});

test("seller analytics isolates prepare requests by browser instance", async () => {
  const db = createMemorySellerAnalyticsDb();
  await preparePlugin(db, {
    plugin_instance_id: "browser-a",
    store_id: "111111",
    shop_name: "Store A"
  }, "admin");
  await preparePlugin(db, {
    plugin_instance_id: "browser-b",
    store_id: "222222",
    shop_name: "Store B"
  }, "admin");

  const requestA = await claimPluginPrepareRequest(db, "admin", { plugin_instance_id: "browser-a" });
  const requestB = await claimPluginPrepareRequest(db, "admin", { plugin_instance_id: "browser-b" });

  assert.equal(requestA.expected_store_id, "111111");
  assert.equal(requestA.plugin_instance_id, "browser-a");
  assert.equal(requestB.expected_store_id, "222222");
  assert.equal(requestB.plugin_instance_id, "browser-b");
});

test("seller analytics marks plugin status offline when heartbeat is stale", async () => {
  const db = createMemorySellerAnalyticsDb();
  await savePluginStatus(db, {
    seller_missing: false,
    seller_tab: { id: 1, url: "https://seller.ozon.ru/app/analytics", title: "Analytics" },
    current_company_id: "222222",
    synced_at: "2020-01-01T00:00:00.000Z",
    synced_at_ms: Date.now() - 600000
  }, "admin");

  const status = await getPluginStatus(db, "admin");
  const validation = await validatePluginStatus(db, { store_id: "222222" }, "admin");

  assert.equal(status.plugin_online, false);
  assert.equal(validation.ok, false);
  assert.equal(validation.code, "plugin_offline");
});

test("seller analytics refreshes local operation todos from analysis data", async () => {
  const db = createMemorySellerAnalyticsDb();
  await saveSnapshot(db, {
    source_button_key: "overview",
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units", "search_views", "pdp_views"]
    },
    period_key: "7d",
    response_body: {
      items: [{
        sku: "traffic-gap-1",
        product_name: "Traffic Gap Product",
        search_views: 5,
        pdp_views: 0,
        ordered_units: 0
      }]
    }
  }, "admin");

  const result = await refreshOperationTodos(db, {
    period_key: "7d",
    date_to: "2026-05-31",
    focus_limit: 50
  }, "admin");
  const todos = await listOperationTodos(db, { period_key: "7d", biz_date: "2026-05-31" }, "admin");

  assert.equal(result.success, true);
  assert.equal(result.bizDate, "2026-05-31");
  assert.equal(result.diagnosisCount, 1);
  assert.equal(result.todoCount, 1);
  assert.equal(db.tables.SellerAnalyticsProductDiagnosis.length, 1);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].segment, "traffic_gap");
  assert.equal(todos[0].status, "open");
});

test("seller analytics operation todo refresh is idempotent for open todos", async () => {
  const db = createMemorySellerAnalyticsDb();
  await saveSnapshot(db, {
    source_button_key: "overview",
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units", "search_views", "pdp_views"]
    },
    period_key: "7d",
    response_body: {
      items: [{
        sku: "repeat-1",
        product_name: "Repeat Product",
        search_views: 5,
        pdp_views: 0,
        ordered_units: 0
      }]
    }
  }, "admin");

  const query = { period_key: "7d", date_to: "2026-05-31", focus_limit: 50 };
  await refreshOperationTodos(db, query, "admin");
  await refreshOperationTodos(db, query, "admin");

  assert.equal(db.tables.SellerAnalyticsProductDiagnosis.length, 1);
  assert.equal(db.tables.SellerAnalyticsOperationTodo.length, 1);
});

test("seller analytics full-store collect run appends next pages until the page is not full", async () => {
  const db = createMemorySellerAnalyticsDb();
  const run = await createCollectRun(db, {
    period_key: "yesterday",
    source_keys: ["hot"],
    auto_all_pages: true,
    limit: 30
  }, "admin");

  const totalsRequest = await claimNextCollectRequest(db, "admin");
  assert.equal(totalsRequest.endpoint_type, "totals");
  await finishCollectRequest(db, run.id, totalsRequest.request_id, {
    success: true,
    response_status: 200,
    response_body: { metrics: { revenue: 100 } }
  }, "admin");

  const firstPage = await claimNextCollectRequest(db, "admin");
  assert.equal(firstPage.endpoint_type, "by_sku");
  assert.equal(firstPage.page_index, 0);
  await finishCollectRequest(db, run.id, firstPage.request_id, {
    success: true,
    response_status: 200,
    response_body: {
      items: Array.from({ length: 30 }, (_, index) => ({
        sku: `sku-${index + 1}`,
        product_name: `Product ${index + 1}`,
        revenue: index + 1,
        ordered_units: 1
      }))
    }
  }, "admin");

  const secondPage = await claimNextCollectRequest(db, "admin");
  assert.equal(secondPage.endpoint_type, "by_sku");
  assert.equal(secondPage.page_index, 1);
  await finishCollectRequest(db, run.id, secondPage.request_id, {
    success: true,
    response_status: 200,
    response_body: {
      items: [{ sku: "sku-last", product_name: "Last Product", revenue: 1, ordered_units: 1 }]
    }
  }, "admin");

  const next = await claimNextCollectRequest(db, "admin");
  assert.equal(next, null);
  const savedRun = JSON.parse(db.tables.Setting[0].value);
  assert.equal(savedRun.status, "success");
  assert.equal(savedRun.request_count, 3);
  assert.equal(savedRun.completed_count, 3);
});
