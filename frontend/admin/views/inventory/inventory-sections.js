export const inventorySections = [
  { key: "products", label: "产品库存表", route: "/inventory/products" },
  { key: "fbp", label: "FBP库存表", route: "/inventory/fbp" },
  { key: "hidden", label: "已隐藏产品", route: "/inventory/hidden" },
  { key: "mappings", label: "SKU绑定配置", route: "/inventory/mappings" },
  { key: "suppliers", label: "供应商配置", route: "/inventory/suppliers" },
  { key: "alerts", label: "库存预警", route: "/inventory/alerts" }
];

export const inventorySectionMap = new Map(inventorySections.map((section) => [section.key, section]));
