import test from "node:test";
import assert from "node:assert/strict";
import {
  claimNextCollectRequest,
  createCollectRun,
  finishCollectRequest,
  getAnalysis,
  getPluginStatus,
  inferSourceFromRequest,
  listOperationTodos,
  refreshOperationTodos,
  resolveCollectPeriod,
  savePluginStatus,
  validatePluginStatus,
  saveSnapshot
} from "../src/services/seller-analytics.js";

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
