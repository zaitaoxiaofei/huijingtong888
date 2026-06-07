import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import {
  logisticsRulesMysql,
  productsMysql,
  recalculateOrderProfitMysql,
  selectionProductMysql,
  updateProductMysql
} from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const productList = productsMysql;

test("products support paged list contract", async () => {
  const result = await productList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.name, undefined);
    assert.ok(Array.isArray(row.shop_ids));
    assert.ok(Array.isArray(row.shop_names));
    assert.ok(Array.isArray(row.bound_mappings));
    assert.ok(Array.isArray(row.sku_preview));
    assert.equal(row.sku_preview.length <= 2, true);
  }
});

test("products paged list supports search and shop filters", async () => {
  const first = await productList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const keyword = first.rows[0].name || first.rows[0].inventory_id;
  const searched = await productList({ paged: "1", page: 1, pageSize: 10, query: keyword });
  assert.ok(searched.total > 0);
  assert.ok(searched.rows.length <= 10);

  const withShop = first.rows.find((row) => row.shop_ids.length);
  if (!withShop) return;
  const shopId = withShop.shop_ids[0];
  const filtered = await productList({ paged: "1", page: 1, pageSize: 20, shopId });
  assert.ok(filtered.rows.every((row) => row.shop_ids.includes(shopId)));
});

test("products search can find selection draft rows when keyword matches bound sku", async () => {
  const hidden = await productList({ paged: "1", page: 1, pageSize: 20, query: "3144521577" });
  assert.ok(hidden.rows.some((row) => Number(row.id) === 35));
});

test("products default list count includes active selection draft rows", async () => {
  const searchHit = await productList({ paged: "1", page: 1, pageSize: 20, query: "3144521577" });
  assert.ok(searchHit.rows.some((row) => Number(row.id) === 35));

  const result = await productList({ paged: "1", page: 1, pageSize: 20 });
  assert.ok(Number(result.total || 0) >= 245);
});

test("product update persists logistics rule changes and detail reads them back", async () => {
  const product = await selectionProductMysql(35);
  assert.ok(product);

  const rules = await logisticsRulesMysql();
  const currentRuleId = Number(product.logistics_rule_id || 0);
  const fallbackRule = rules.find((rule) => Number(rule.id) !== currentRuleId);
  assert.ok(fallbackRule, "Need at least two logistics rules to verify updating");

  const nextRuleId = Number(fallbackRule.id);
  const payload = {
    ...product,
    updated_at: product.updated_at,
    logistics_rule_id: nextRuleId
  };

  try {
    await updateProductMysql(product.id, payload);
    const updated = await selectionProductMysql(product.id);
    assert.equal(Number(updated.logistics_rule_id || 0), nextRuleId);
  } finally {
    await updateProductMysql(product.id, {
      ...product,
      updated_at: (await selectionProductMysql(product.id))?.updated_at || product.updated_at,
      logistics_rule_id: currentRuleId || null
    });
  }
});

test("recalculating order profit uses product logistics rule freight", async () => {
  const product = await selectionProductMysql(35);
  assert.ok(product);

  const rules = await logisticsRulesMysql();
  const currentRuleId = Number(product.logistics_rule_id || 0);
  const weight = Number(product.package_weight_g || 0);
  const currentRule = rules.find((rule) => Number(rule.id) === currentRuleId) || null;
  const currentFreight = currentRule
    ? Number(currentRule.base_fee_cny || 0) + weight * Number(currentRule.per_gram_cny || 0) + Number(currentRule.per_ticket_cny || 0)
    : null;
  const fallbackRule = rules.find((rule) => {
    if (Number(rule.id) === currentRuleId) return false;
    const nextFreight = Number(rule.base_fee_cny || 0) + weight * Number(rule.per_gram_cny || 0) + Number(rule.per_ticket_cny || 0);
    return currentFreight === null || Math.abs(nextFreight - currentFreight) > 1;
  });
  assert.ok(fallbackRule, "Need an alternative logistics rule with a different freight estimate");

  const orderId = 7714;
  const itemId = 7815;
  const nextRuleId = Number(fallbackRule.id);
  const readItem = async () => {
    const [row] = await mysqlQuery("SELECT frozen_international_shipping, estimated_profit FROM order_items WHERE id = ?", [itemId]);
    return {
      frozen_international_shipping: Number(row?.frozen_international_shipping || 0),
      estimated_profit: Number(row?.estimated_profit || 0)
    };
  };

  const beforeItem = await readItem();
  try {
    await updateProductMysql(product.id, {
      ...product,
      updated_at: product.updated_at,
      logistics_rule_id: nextRuleId
    });
    const updatedProduct = await selectionProductMysql(product.id);
    await recalculateOrderProfitMysql(orderId);
    const afterItem = await readItem();
    assert.notEqual(Number(updatedProduct.logistics_rule_id || 0), currentRuleId);
    assert.ok(
      Math.abs(afterItem.frozen_international_shipping - beforeItem.frozen_international_shipping) > 1
        || Math.abs(afterItem.estimated_profit - beforeItem.estimated_profit) > 1
    );
  } finally {
    await updateProductMysql(product.id, {
      ...product,
      updated_at: (await selectionProductMysql(product.id))?.updated_at || product.updated_at,
      logistics_rule_id: currentRuleId || null
    });
    await recalculateOrderProfitMysql(orderId);
  }
});
