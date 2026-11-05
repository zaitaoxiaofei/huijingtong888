import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const page = read("frontend/admin/views/inventory/InventoryProductsPage.vue");
const badge = read("frontend/admin/components/inventory/InventoryCompositionBadge.vue");
const composition = read("frontend/admin/components/inventory/ProductCompositionDialog.vue");
const orders = read("frontend/orders/OrdersPage.vue");

function loadFunction(source, name, globals = {}) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is available`);
  const end = source.indexOf("\n}", start) + 2;
  return vm.runInNewContext(`${source.slice(start, end)}\n${name};`, globals);
}

function badgeLabel(product, detail = null, resolveOnMount = false) {
  const context = vm.createContext({
    props: { product, resolveOnMount },
    data: { value: detail },
    computed: (getter) => ({ get value() { return getter(); } })
  });
  const declarations = ["count", "consumable", "accessory", "label"].map((name) => {
    const line = badge.split("\n").find((value) => value.startsWith(`const ${name}=computed(`));
    assert.ok(line, `${name} remains available in the composition badge`);
    return line;
  }).join("\n");
  return vm.runInContext(`${declarations}\nlabel.value;`, context);
}

test("consumable labels take priority while old API rows retain their existing types", () => {
  const labelers = [
    [badgeLabel, "套装"],
    [loadFunction(composition, "productTypeLabel"), "套装"],
    [loadFunction(orders, "inventoryProductCategoryText"), "组合"]
  ];
  for (const [label, comboLabel] of labelers) {
    assert.equal(label({}), "单品");
    assert.equal(label({ is_accessory: 1 }), "配件");
    assert.equal(label({ component_count: 2 }), comboLabel);
    assert.equal(label({ is_consumable: "0", is_accessory: 1 }), "配件");
    assert.equal(label({ is_consumable: "1", is_accessory: 1, component_count: 2 }), "耗材");
  }
  const orderType = loadFunction(orders, "inventoryProductTypeText");
  assert.equal(orderType({}), "库存产品");
  assert.equal(orderType({ is_accessory: 1 }), "配件库存");
  assert.equal(orderType({ is_consumable: 1, is_accessory: 1 }), "耗材库存");
});

test("composition detail retains its existing count and authoritative consumable flag", () => {
  assert.equal(badgeLabel({ is_consumable: 1 }, { product: { component_count: 2, is_accessory: 1 } }), "耗材");
  assert.equal(badgeLabel({ is_consumable: 0 }, { product: { component_count: 2, is_consumable: 1 } }), "耗材");
  assert.equal(badgeLabel({ is_consumable: 1 }, { product: { component_count: 2, is_consumable: 0 } }), "套装");
  assert.equal(badgeLabel({}, null, true), "类型待核实");
  assert.equal(badgeLabel({ is_consumable: 1 }, null, true), "耗材");
  assert.match(page, /<InventoryCompositionBadge :product="row"\s*\/>/);
  assert.match(badge, /\{\{count\}\} 子产品/);
});

test("the editor preserves independent consumable and accessory flags", () => {
  const dialog = read("frontend/admin/components/inventory/ProductCreateEditDialog.vue");
  const createDefaultForm = loadFunction(dialog, "createDefaultForm");
  const form = createDefaultForm();
  assert.equal(form.is_consumable, 0);
  assert.equal(form.is_accessory, 0);
  const label = loadFunction(dialog, "productAutoTypeLabel", { form });
  assert.equal(label(), "单品产品");
  form.is_consumable = 1;
  assert.equal(label(), "耗材产品");
  assert.equal(form.is_accessory, 0);
  assert.match(dialog, /is_consumable: Number\(value\.is_consumable \|\| 0\) \? 1 : 0/);
  assert.match(dialog, /is_consumable: Number\(form\.is_consumable \|\| 0\) \? 1 : 0/);
  assert.match(dialog, /<el-checkbox v-model="form\.is_consumable" :true-value="1" :false-value="0">耗材<\/el-checkbox>/);
});

test("inventory and component pickers expose the consumable filter", () => {
  assert.match(page, /<el-option label="耗材" value="consumable" \/>/);
  assert.match(composition, /\{ label: "耗材", value: "consumable" \}/);
  assert.match(orders, /\{ label: "耗材", value: "consumable" \}/);
});
