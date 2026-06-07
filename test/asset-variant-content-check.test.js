import assert from "node:assert/strict";
import test from "node:test";

import { inspectAssetVariantListingContent } from "../src/services/asset-variant-engine.js";

test("asset variant content check binds shoulder pad listing to shop without key-case drift", () => {
  const result = inspectAssetVariantListingContent({
    title: "Накладка на ремень безопасности, мягкая плечевая подушка, черная, 2 шт.",
    categoryName: "Аксессуары для ремней безопасности",
    shopName: "ViberMart",
    tags: [
      "#ViberMart",
      "#накладка",
      "#ремень_безопасности",
      "#плечевая_подушка",
      "#мягкая",
      "#черная",
      "#комфорт",
      "#daily_use"
    ],
    description: "Накладка на ремень безопасности помогает сделать поездку комфортнее и уменьшает давление ремня на плечо. Добро пожаловать в магазин ViberMart: здесь можно выбрать этот товар для повседневного использования и оформить покупку в нашем магазине.",
    richContent: JSON.stringify({
      content: [{
        widgetName: "raShowcase",
        blocks: [{
          text: { items: [{ content: "ViberMart предлагает мягкую накладку для ремня безопасности." }] }
        }]
      }]
    })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.tags.includes("#ViberMart"));
});

test("asset variant content check blocks non-key product with key-case terms", () => {
  const result = inspectAssetVariantListingContent({
    title: "Накладка на ремень безопасности",
    categoryName: "Аксессуары для ремней безопасности",
    shopName: "ViberMart",
    tags: ["#ViberMart", "#car_key_case", "#key_cover", "#ремень_безопасности"],
    description: "Описание ViberMart для мягкой накладки на ремень безопасности.",
    richContent: ""
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Non-key product content contains key-case related terms/);
});
