import test from "node:test";
import assert from "node:assert/strict";
import { listingVariantInventoryCandidates, propagateListingVariantInventory } from "../src/services/listing-variant-inventory.js";

function fakeDatabase(links) {
  const writes = [];
  const online = new Map([["11:501", { id: 101, offer_id: "a", name: "A", product_id: null }],
    ["12:502", { id: 102, offer_id: "b", name: "B", product_id: null }]]);
  return {
    writes,
    query: async () => [{ draft_id: 7, variant_id: "variant-blue" }],
    transaction: async (callback) => callback({
      execute: async (sql, params) => {
        if (sql.includes("SELECT id, shop_id, ozon_sku, offer_id, source_product_id")) return [links.map((link) => ({ ...link }))];
        if (sql.includes("SELECT l.id FROM listing_publish_variant_links")) {
          if (!sql.includes("l.ozon_sku COLLATE utf8mb4_0900_ai_ci")) {
            throw Object.assign(new Error("Illegal mix of collations"), { code: "ER_CANT_AGGREGATE_2COLLATIONS" });
          }
          return [[]];
        }
        if (sql.includes("SELECT id FROM shops")) return [[{ id: params[0] }]];
        if (sql.includes("SELECT id, offer_id, name, product_id FROM online_products")) return [[online.get(`${params[0]}:${params[1]}`)].filter(Boolean)];
        if (sql.includes("SELECT id, product_id FROM sku_mappings")) return [[]];
        if (sql.includes("INSERT INTO sku_mappings")) {
          writes.push({ table: "mapping", shopId: params[0], sku: params[4], productId: params[2] });
          return [{ insertId: writes.length }];
        }
        if (sql.includes("UPDATE online_products SET product_id")) writes.push({ table: "online", productId: params[0], onlineId: params[1] });
        if (sql.includes("SET source_product_id = ?")) writes.push({ table: "links", productId: params[0] });
        return [{}];
      }
    })
  };
}

test("one bound SKU propagates inventory to sibling shops for the same draft variant", async () => {
  const db = fakeDatabase([
    { id: 1, shop_id: 11, ozon_sku: "501", offer_id: "a", source_product_id: null },
    { id: 2, shop_id: 12, ozon_sku: "502", offer_id: "b", source_product_id: null }
  ]);
  const result = await propagateListingVariantInventory({
    tenantKey: "admin", tenantPk: 1, shopId: 11, ozonSku: "501", offerId: "a", productId: 88
  }, db);
  assert.equal(result.linked, 2);
  assert.equal(result.bound, 2);
  assert.equal(result.conflicts, 0);
  assert.equal(result.mapping_ids.length, 2);
  assert.deepEqual(db.writes.filter((write) => write.table === "mapping").map((write) => [write.shopId, write.sku, write.productId]),
    [[11, "501", 88], [12, "502", 88]]);
  assert.deepEqual(db.writes.filter((write) => write.table === "links").map((write) => write.productId), [88]);
});

test("an existing different inventory blocks sibling propagation", async () => {
  const db = fakeDatabase([
    { id: 1, shop_id: 11, ozon_sku: "501", offer_id: "a", source_product_id: null },
    { id: 2, shop_id: 12, ozon_sku: "502", offer_id: "b", source_product_id: 99 }
  ]);
  const result = await propagateListingVariantInventory({
    tenantKey: "admin", tenantPk: 1, shopId: 11, ozonSku: "501", offerId: "a", productId: 88
  }, db);
  assert.deepEqual(result, { linked: 0, bound: 0, conflicts: 1, mapping_ids: [] });
  assert.deepEqual(db.writes, []);
});

test("reconciliation picks one inventory for unbound sibling shops and skips conflicts", () => {
  const rows = [
    { tenant_id: "admin", draft_id: 7, variant_id: "blue", shop_id: 11, ozon_sku: "501", offer_id: "a", source_product_id: null, online_row_id: 101, online_inventory_id: 88, mapped_inventory_id: 88 },
    { tenant_id: "admin", draft_id: 7, variant_id: "blue", shop_id: 12, ozon_sku: "502", offer_id: "b", source_product_id: null, online_row_id: null, online_inventory_id: null, mapped_inventory_id: null },
    { tenant_id: "admin", draft_id: 8, variant_id: "red", shop_id: 11, ozon_sku: "601", source_product_id: 88, online_row_id: 102, online_inventory_id: 99, mapped_inventory_id: 99 },
    { tenant_id: "admin", draft_id: 8, variant_id: "red", shop_id: 12, ozon_sku: "602", source_product_id: null, online_row_id: 103, online_inventory_id: null, mapped_inventory_id: null }
  ];
  assert.deepEqual(listingVariantInventoryCandidates(rows), [{
    tenantKey: "admin", draftId: 7, variantId: "blue", shopId: 11,
    ozonSku: "501", offerId: "a", productId: 88
  }]);
});
