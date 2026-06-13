import assert from "node:assert/strict";
import test from "node:test";

import { buildSelectionProductBodiesFromCollectorBox } from "../src/services/listing-automation.js";

test("collector box selection creation keeps each selected variant as its own draft body", () => {
  const detail = {
    sku: "1000",
    title: "Base title",
    image_url: "base.jpg",
    product_url: "https://www.ozon.ru/product/1000/",
    category_name: "Автотовары",
    price: 900,
    rawPayload: {
      description_category_id: 170,
      type_id: 970,
      description: "Base Russian description",
      hashtags: ["ключ", "авто"],
      attributes: [
        { attribute_id: 8224, name: "Материал", value: "TPU" }
      ],
      variants: [
        {
          sku: "1001",
          title: "Black key case",
          price: 1000,
          images: ["black.jpg"],
          weight_g: 120,
          length_cm: 12,
          width_cm: 8,
          height_cm: 3,
          attributes: [
            { attribute_id: 10096, name: "Цвет", value: "Черный" }
          ]
        },
        {
          sku: "1002",
          title: "Blue key case",
          price: 1100,
          images: ["blue.jpg"],
          weight_g: 130,
          length_cm: 13,
          width_cm: 9,
          height_cm: 4,
          attributes: [
            { attribute_id: 10096, name: "Цвет", value: "Синий" }
          ]
        }
      ]
    }
  };

  const bodies = buildSelectionProductBodiesFromCollectorBox(detail, {
    variantSelections: [{ sku: "1001" }, { sku: "1002" }]
  });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].name, "Black key case");
  assert.equal(bodies[1].name, "Blue key case");
  assert.equal(bodies[0].image_url, "black.jpg");
  assert.equal(bodies[1].image_url, "blue.jpg");
  assert.equal(bodies[0].package_weight_g, 120);
  assert.equal(bodies[1].length_cm, 13);
  assert.equal(bodies[0].listing_title_ru, "Black key case");
  assert.match(bodies[0].listing_tags_ru, /#ключ/);
  assert.match(bodies[0].listing_description_ru, /Base Russian description/);
  assert.equal(bodies[0].material, "TPU");
  assert.equal(bodies[0].color, "Черный");
  assert.equal(bodies[0].ozon_category_id, "170:970");
  assert.equal(bodies[0].ozon_description_category_id, "170");
  assert.equal(bodies[0].ozon_type_id, "970");
  assert.equal(bodies[0].vehicle_model, "");
  assert.match(bodies[0].supplier_note, /Материал/);
  assert.equal(bodies[1].variant_result_id, "1002");
});

test("collector box selection creation can keep only chosen variants", () => {
  const bodies = buildSelectionProductBodiesFromCollectorBox({
    sku: "2000",
    rawPayload: {
      variants: [
        { sku: "2001", title: "First" },
        { sku: "2002", title: "Second" }
      ]
    }
  }, {
    variantSelections: [{ sku: "2002" }]
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].name, "Second");
  assert.equal(bodies[0].variant_result_id, "2002");
});

test("collector box selection creation prefers edited collector images over template and raw images", () => {
  const bodies = buildSelectionProductBodiesFromCollectorBox({
    sku: "3000",
    title: "Edited image product",
    image_url: "cover-old.jpg",
    listing_template_id: 88,
    templateSnapshot: {
      id: 88,
      images: ["template-main.jpg", "template-detail-1.jpg"],
      editable_payload: {
        images: ["template-editable-main.jpg"]
      }
    },
    editPayload: {
      images: ["collector-edit.jpg"]
    },
    rawPayload: {
      images: ["raw-main.jpg", "raw-detail.jpg"]
    }
  }, {});

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].image_url, "collector-edit.jpg");
  assert.deepEqual(bodies[0].detail_image_urls, []);
  assert.equal(bodies[0].detail_image_urls.includes("raw-main.jpg"), false);
});

test("collector box selection creation keeps user source images above template and raw images", () => {
  const bodies = buildSelectionProductBodiesFromCollectorBox({
    sku: "4000",
    title: "User asset product",
    image_url: "cover-old.jpg",
    source_images: ["user-main.jpg", "user-detail.jpg"],
    templateSnapshot: {
      images: ["template-main.jpg", "template-detail.jpg"]
    },
    editPayload: {
      images: ["collector-edit.jpg"]
    },
    rawPayload: {
      images: ["raw-main.jpg", "raw-detail.jpg"]
    }
  }, {});

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].image_url, "user-main.jpg");
  assert.deepEqual(bodies[0].detail_image_urls, ["user-detail.jpg"]);
});

test("collector box selection creation prefers edited variant images over old top-level collector images", () => {
  const bodies = buildSelectionProductBodiesFromCollectorBox({
    sku: "5000",
    title: "Edited variant image product",
    image_url: "old-collected-main.jpg",
    editPayload: {
      images: ["old-collected-main.jpg", "old-collected-detail.jpg"],
      variants: [
        {
          images: ["uploaded-main.png", "uploaded-detail.png"]
        }
      ]
    },
    rawPayload: {
      images: ["raw-main.jpg", "raw-detail.jpg"]
    }
  }, {});

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].image_url, "uploaded-main.png");
  assert.deepEqual(bodies[0].detail_image_urls, ["uploaded-detail.png"]);
});

test("collector box selection creation lets edited variant images override old variant cover image", () => {
  const bodies = buildSelectionProductBodiesFromCollectorBox({
    sku: "3457326716",
    title: "Edited collected product",
    image_url: "old-collected-main.jpg",
    editPayload: {
      images: ["old-collected-main.jpg", "old-collected-detail.jpg"],
      variants: [
        {
          sku: "3720611837",
          source_sku: "3720611837",
          images: ["uploaded-main.png", "uploaded-detail.png"]
        }
      ]
    },
    rawPayload: {
      variants: [
        {
          sku: "3720611837",
          coverImage: "old-variant-cover.jpg",
          images: ["old-variant-cover.jpg", "old-variant-detail.jpg"]
        }
      ]
    },
    payload: {
      variants: [
        {
          sku: "3720611837",
          coverImage: "old-payload-cover.jpg",
          images: ["old-payload-cover.jpg"]
        }
      ]
    }
  }, {});

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].image_url, "uploaded-main.png");
  assert.deepEqual(bodies[0].detail_image_urls, ["uploaded-detail.png"]);
  assert.equal(bodies[0].image_url.includes("old-variant-cover"), false);
});
