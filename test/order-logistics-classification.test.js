import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createHash } from "node:crypto";
import {
  classifyOrderLogistics, normalizeLogisticsServiceClass, orderLogisticsEvidence,
  ORDER_LOGISTICS_SERVICE_CLASSES, orderLogisticsServiceClassOptions
} from "../src/services/order-logistics-classification.js";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const definition = (name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
function functions(names, context) {
  return vm.runInNewContext(`${names.map(definition).join("\n")}\n({${names.join(",")}})`, context);
}

const guoo = {
  raw_json: JSON.stringify({ raw: {
    delivery_method: { name: "GUOO Standard Extra Small Hefei PUDO", tpl_provider: "GUOO", warehouse: "合肥 GUOO" },
    customer: { name: "sample-ogl-customer" },
    products: [{ name: "Google Premium Big product", image: "https://example.test/OGL/file" }]
  } }),
  resolved_logistics_rule_name: "CEL 陆空标准 Extra Small",
  billing_logistics_rule_name: "GUOO 标准 Extra Small"
};

test("carrier ignores customer, product and URL substrings even when legacy classification says CEL", () => {
  const actual = classifyOrderLogistics(guoo);
  assert.equal(actual.logistics_carrier, "guoo");
  assert.equal(actual.logistics_service_class, "Extra Small");
  assert.equal(actual.logistics_service_class_source, "ozon_raw");
  assert.equal(actual.logistics_transport_mode, "air_land");
  assert.doesNotMatch(orderLogisticsEvidence(guoo).text, /customer|Google|example\.test|CEL/);
});

test("the reported six-order mix contains two OGL orders and four GUOO orders despite customer-name matches", () => {
  const rows = [
    ...Array.from({ length: 2 }, (_, index) => ({ id: index + 1, warehouse_name: "OGL 嘉兴仓库", billing_logistics_rule_name: "OGL 陆运 Extra Small" })),
    ...Array.from({ length: 4 }, (_, index) => ({ ...guoo, id: index + 3 }))
  ].map((row) => ({ ...row, ...classifyOrderLogistics(row) }));
  const { filterOrderIdsByLogisticsCarrierMysql } = functions(["filterOrderIdsByLogisticsCarrierMysql", "orderLogisticsCarrierMysql"], { classifyOrderLogistics });
  assert.deepEqual(Array.from(filterOrderIdsByLogisticsCarrierMysql(rows, "ogl")), [1, 2]);
  assert.deepEqual(Array.from(filterOrderIdsByLogisticsCarrierMysql(rows, "guoo")), [3, 4, 5, 6]);
  assert.equal(orderLogisticsServiceClassOptions(rows).find((item) => item.value === "extra_small").count, 6);
});

test("six service classes remain independent of carrier and transport and retain Extra Small spelling", () => {
  for (const item of ORDER_LOGISTICS_SERVICE_CLASSES) {
    for (const carrier of ["GUOO", "CEL", "OGL"]) {
      for (const [channel, mode] of [["Economy", "land"], ["Standard", "air_land"], ["Express", "air"]]) {
        const actual = classifyOrderLogistics({ delivery_method: { name: `${carrier} ${channel} ${item.label}` } });
        assert.equal(actual.logistics_service_class_key, item.value);
        assert.equal(actual.logistics_service_class, item.label);
        assert.equal(actual.logistics_carrier, carrier.toLowerCase());
        assert.equal(actual.logistics_transport_mode, mode);
      }
    }
  }
  assert.equal(normalizeLogisticsServiceClass("Extra Small"), "extra_small");
  assert.equal(normalizeLogisticsServiceClass("X-Small"), "X-Small");
});

test("frozen billing rule can supplement a missing class with an explicit source", () => {
  const actual = classifyOrderLogistics({
    raw: { delivery_method: { name: "Доставка Ozon курьеру", warehouse: "OGL 嘉兴快递仓库" } },
    billing_logistics_rule_name: "OGL 陆运 Extra Small"
  });
  assert.equal(actual.logistics_carrier, "ogl");
  assert.equal(actual.logistics_service_class, "Extra Small");
  assert.equal(actual.logistics_service_class_source, "billing_rule");
  assert.equal(actual.logistics_transport_mode, "land");
  assert.equal(actual.logistics_transport_mode_source, "billing_rule");
});

test("billing and legacy rules never manufacture a carrier or override official class evidence", () => {
  const unknown = classifyOrderLogistics({
    raw_json: '{"customer":{"name":"OGL"},"products":[{"name":"CEL Extra Small"}]}',
    resolved_logistics_rule_name: "CEL 陆空标准 Extra Small", billing_logistics_rule_name: "OGL 陆运 Extra Small"
  });
  assert.equal(unknown.logistics_carrier, "");
  assert.equal(unknown.logistics_service_class, "");
  const actual = classifyOrderLogistics({ delivery_method_name: "GUOO Economy Budget", billing_logistics_rule_name: "GUOO 标准 Extra Small" });
  assert.equal(actual.logistics_service_class, "Budget");
  assert.equal(actual.logistics_transport_mode, "land");
  assert.equal(actual.logistics_service_class_source, "ozon_raw");
  assert.equal(classifyOrderLogistics({ warehouse_name: "OGL 嘉兴仓库", billing_logistics_rule_name: "CEL 标准 Extra Small" }).logistics_service_class, "");
});

test("mixed frozen classes do not arbitrarily choose one channel for an order", () => {
  const base = { warehouse_name: "OGL 嘉兴仓库" };
  assert.equal(classifyOrderLogistics({ ...base, billing_logistics_rule_name: "OGL 陆运 Extra Small / OGL 陆运 Big" }).logistics_service_class, "");
  assert.equal(classifyOrderLogistics({ ...base, billing_logistics_rule_name: "OGL 陆运 Extra Small / OGL Economy Extra Small" }).logistics_service_class, "Extra Small");
});

test("FBP postings with only their fulfillment identity retain a useful method without inventing a carrier", () => {
  const actual = classifyOrderLogistics({
    raw_json: JSON.stringify({ fulfillment_schema: "FBP", raw: { fulfillment_schema: "FBP", delivery_method: { name: "FBP" } } }),
    resolved_logistics_rule_name: "CEL FBP Standard Extra Small",
    billing_logistics_rule_name: "CEL FBP Standard Extra Small"
  });
  assert.equal(actual.logistics_fulfillment_type, "fbp");
  assert.equal(actual.logistics_method_label, "FBP 仓配");
  assert.equal(actual.logistics_method_source, "fulfillment");
  assert.equal(actual.logistics_display_name, "FBP 仓配");
  assert.equal(actual.logistics_carrier, "");
  assert.equal(actual.logistics_service_class, "");
  assert.equal(actual.logistics_service_class_source, "");
  assert.equal(actual.logistics_transport_mode, "");
  assert.equal(actual.logistics_transport_mode_source, "");
});

test("FBP retains a known raw method or warehouse while billing cannot supply a cross-border channel", () => {
  for (const deliveryMethod of [{ name: "CEL FBP" }, { name: "FBP", warehouse: "CEL FBP 珲春仓" }]) {
    const actual = classifyOrderLogistics({
      raw: { fulfillment_schema: "FBP", delivery_method: deliveryMethod },
      billing_logistics_rule_name: "CEL Standard Extra Small"
    });
    assert.equal(actual.logistics_method_label, deliveryMethod.warehouse || deliveryMethod.name);
    assert.equal(actual.logistics_method_source, "ozon_raw");
    assert.equal(actual.logistics_carrier, "cel");
    assert.equal(actual.logistics_service_class, "");
    assert.equal(actual.logistics_transport_mode, "");
  }
  const explicit = classifyOrderLogistics({ raw: { fulfillment_schema: "FBP", delivery_method: { name: "CEL FBP Standard Extra Small Hch-pd2" } } });
  assert.equal(explicit.logistics_service_class, "Extra Small");
  assert.equal(explicit.logistics_service_class_source, "ozon_raw");
  assert.equal(explicit.logistics_transport_mode, "air_land");
  assert.equal(explicit.logistics_transport_mode_source, "ozon_raw");
});

test("row enrichment passes the existing FBP identity through classification and detail reclassification", async () => {
  const { enrichOrderLogisticsMysql } = functions(["enrichOrderLogisticsMysql"], {
    classifyOrderLogistics,
    resolveOrderLogisticsRuleMysql: async () => ({
      rule: { value: "legacy_fbp", label: "CEL FBP" }, warehouseName: "", deliveryMethodName: "", logisticsChannel: "",
      raw: {}, analytics: {}
    }),
    fallbackShipDeadlineMysql: () => "", describeCancellation: () => ({}), detectShippingMethodKeyMysql: () => ""
  });
  const enriched = await enrichOrderLogisticsMysql({ raw_json: "{}", billing_logistics_rule_name: "CEL Standard Extra Small" });
  assert.equal(enriched.fulfillment_type_key, "fbp");
  assert.equal(enriched.logistics_fulfillment_type, "fbp");
  assert.equal(enriched.logistics_method_label, "FBP 仓配");
  assert.equal(enriched.logistics_carrier, "");
  assert.equal(classifyOrderLogistics(enriched).logistics_method_label, "FBP 仓配");
  assert.equal(classifyOrderLogistics(enriched).logistics_service_class, "");
});

test("logistics summary bypasses old snapshots and uses the same safe classifier as row enrichment", async () => {
  const queries = [];
  const writes = [];
  const rawRows = [
    { ...guoo, id: 3 },
    { id: 1, raw_json: '{"raw":{"delivery_method":{"warehouse":"OGL 嘉兴仓库"}}}', billing_logistics_rule_name: "OGL 陆运 Extra Small" },
    { id: 4, raw_json: '{"raw":{"fulfillment_schema":"FBP","delivery_method":{"name":"FBP"}}}', billing_logistics_rule_name: "CEL Standard Extra Small" }
  ];
  const context = {
    createHash, classifyOrderLogistics,
    getCachedMasterData: async (key, load) => { queries.push(key); return load(); },
    ORDER_COUNTS_CACHE_TTL_MS: 180000,
    orderLogisticsSnapshotSchemaReady: true,
    mysqlQueryOne: async () => null,
    activeOrderLogisticsFilterMethodsMysql: async () => [],
    readableLogisticsTenantScopeMysql: async (_tenant, alias) => ({ sql: `${alias}.tenant_id = ?`, params: [9] }),
    mysqlQuery: async (sql, params) => { queries.push({ sql, params }); return rawRows; },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); },
    cachedOrderLogisticsRuleFromRowMysql: () => null,
    parseJsonFallback: () => null
  };
  const { loadOrderLogisticsSummaryForBaseMysql } = functions(["loadOrderLogisticsSummaryForBaseMysql"], context);
  const rows = await loadOrderLogisticsSummaryForBaseMysql({ where: "o.shop_id = ?", params: [2] }, "tenant-a");
  assert.match(queries[0], /^orders:logistics-summary:v8:tenant-a:/);
  assert.deepEqual(Array.from(rows, (row) => [row.id, row.logistics_carrier]), [[3, "guoo"], [1, "ogl"], [4, ""]]);
  assert.equal(rows[1].logistics_service_class_source, "billing_rule");
  assert.equal(rows[2].logistics_method_label, "FBP 仓配");
  assert.equal(rows[2].logistics_service_class_key, "");
  assert.equal(orderLogisticsServiceClassOptions(rows).find((item) => item.value === "extra_small").count, 2);
  assert.deepEqual(Array.from(queries[1].params), [9, 2]);
  assert.match(queries[1].sql, /summary_item\.frozen_logistics_rule_id/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO order_logistics_summary_snapshots/);
});

test("paged carrier and official-class filters, counts and dropdowns use one shop/date scoped source", async () => {
  const fixtures = [
    { id: 1, shop: "1", date: "2026-10-20", warehouse_name: "OGL 嘉兴仓库", billing_logistics_rule_name: "OGL 陆运 Extra Small" },
    { id: 2, shop: "1", date: "2026-10-20", delivery_method_name: "OGL Economy Extra Small" },
    { id: 3, shop: "1", date: "2026-10-20", ...guoo },
    { id: 4, shop: "1", date: "2026-10-20", delivery_method_name: "GUOO Economy Budget" },
    { id: 5, shop: "1", date: "2026-10-20", delivery_method_name: "CEL Express Premium Big" },
    { id: 6, shop: "1", date: "2026-10-20", raw_json: '{"customer":{"name":"OGL"}}' },
    { id: 7, shop: "2", date: "2026-10-20", delivery_method_name: "OGL Standard Extra Small" },
    { id: 8, shop: "1", date: "2026-09-01", delivery_method_name: "OGL Economy Extra Small" }
  ];
  const whereRows = (sql, params) => {
    let candidates = fixtures.filter((row) => row.shop === params[0] && row.date >= params[1]);
    if (sql.includes("AND 1 = 0")) return [];
    let offset = 2;
    for (const match of sql.matchAll(/o\.id IN \(([?,]+)\)/g)) {
      const length = match[1].split(",").length;
      const ids = params.slice(offset, offset + length);
      candidates = candidates.filter((row) => ids.includes(row.id));
      offset += length;
    }
    return candidates;
  };
  const context = {
    classifyOrderLogistics, normalizeLogisticsServiceClass, orderLogisticsServiceClassOptions,
    ensureMysqlCutoverEnabled() {}, orderListTenantScopeMysql: async () => null, assertTenantOrderListFiltersMysql() {},
    ensureOrderLabelPrintSchemaMysql: async () => {}, ensureSkuInventoryRecipeSchemaMysql: async () => {},
    ensureProductCompositionSchemaMysql: async () => {}, ensureProductNamingSchemaMysql: async () => {},
    orderBaseSqlMysql: async (query) => ({ where: "o.shop_id = ? AND o.ordered_at >= ?", params: [query.shopId, query.dateFrom] }),
    loadOrderLogisticsSummaryForBaseMysql: async (base) => fixtures.filter((row) => row.shop === base.params[0] && row.date >= base.params[1]).map((row) => ({ ...row, ...classifyOrderLogistics(row) })),
    resolveOrderLogisticsValueFromRowMysql: (row) => row.resolved_logistics_rule_value || "",
    orderFilteredSqlMysql: async (_query, base) => ({ ...base, joins: "" }),
    orderLogisticsMethodOptionsMysql: async () => [],
    mysqlQueryOne: async (sql, params) => ({ total: whereRows(sql, params).length }),
    mysqlQuery: async (sql, params) => whereRows(sql, params).map(({ id }) => ({ id })),
    orderRowsByIdsMysql: async (ids) => ids.map((id) => ({ ...fixtures.find((row) => row.id === id), ...classifyOrderLogistics(fixtures.find((row) => row.id === id)) })),
    orderQuickFilterOrderSqlMysql: () => "o.id", sortPagedOrdersMysql: (rows) => rows
  };
  const { ordersPagedMysql } = functions([
    "ordersPagedMysql", "filterOrderIdsByLogisticsMethodMysql", "filterOrderIdsByLogisticsCarrierMysql",
    "filterOrderIdsByLogisticsServiceClassMysql", "orderLogisticsCarrierMysql", "withRestrictedOrderIdsMysql", "orderLogisticsCarrierOptionsMysql"
  ], context);
  const base = { shopId: "1", dateFrom: "2026-10-01", includeCounts: "0", includeLogisticsOptions: "1" };
  const ogl = await ordersPagedMysql({ ...base, logisticsCarrier: "ogl" });
  assert.deepEqual(Array.from(ogl.rows, (row) => row.id), [1, 2]);
  assert.equal(ogl.total, 2);
  assert.equal(ogl.logisticsServiceClassOptions.length, 7);
  assert.equal(ogl.logisticsServiceClassOptions.find((item) => item.value === "extra_small").count, 2);
  const extra = await ordersPagedMysql({ ...base, logisticsServiceClass: "extra_small" });
  assert.deepEqual(Array.from(extra.rows, (row) => row.id), [1, 2, 3]);
  assert.equal(extra.total, 3);
  assert.equal(extra.logisticsCarrierOptions.find((item) => item.value === "ogl").count, 2);
  assert.equal(extra.logisticsCarrierOptions.find((item) => item.value === "guoo").count, 1);
  const guooExtra = await ordersPagedMysql({ ...base, logisticsCarrier: "guoo", logistics_service_class: "Extra Small" });
  assert.deepEqual(Array.from(guooExtra.rows, (row) => row.id), [3]);
  assert.equal(guooExtra.total, 1);
  const differentShop = await ordersPagedMysql({ ...base, shopId: "2", logisticsServiceClass: "extra_small" });
  assert.deepEqual(Array.from(differentShop.rows, (row) => row.id), [7]);
  const invalid = await ordersPagedMysql({ ...base, logisticsServiceClass: "invalid" });
  assert.equal(invalid.total, 0);
});
