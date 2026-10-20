import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrderFreightDescriptor } from "../src/services/order-freight-rule-resolver.js";

test("resolves OGL Big to its single land channel", () => {
  assert.deepEqual(resolveOrderFreightDescriptor({ delivery_method_name: "OGL Big" }), {
    carrier: "OGL", channel: "economy", serviceClass: "Big", sourceText: "OGL Big"
  });
});

test("retains OGL warehouse evidence when Ozon omits the service class", () => {
  assert.deepEqual(resolveOrderFreightDescriptor({ raw: {
    delivery_method: { name: "Доставка Ozon курьеру, Hefei", warehouse: "OGL 嘉兴快递仓库" },
    analytics_data: { warehouse: "OGL 嘉兴快递仓库" }
  } }), {
    carrier: "OGL", channel: "economy", serviceClass: "",
    sourceText: "Доставка Ozon курьеру, Hefei OGL 嘉兴快递仓库 OGL 嘉兴快递仓库"
  });
});

test("resolves GUOO realFBS delivery method to a local freight rule descriptor", () => {
  assert.deepEqual(resolveOrderFreightDescriptor({
    raw: {
      delivery_method: {
        name: "GUOO Standard Extra Small Shanghai PUDO",
        tpl_provider: "GUOO Standard Extra Small",
        warehouse: "GUOO land + air 1-500g"
      }
    }
  }), {
    carrier: "GUOO",
    channel: "standard",
    serviceClass: "Extra Small",
    sourceText: "GUOO Standard Extra Small Shanghai PUDO GUOO Standard Extra Small GUOO land + air 1-500g"
  });
});

test("resolves CEL economy big and keeps premium classes distinct", () => {
  assert.equal(resolveOrderFreightDescriptor({ raw: { delivery_method: { name: "CEL Economy Big Shanghai PUDO" } } })?.serviceClass, "Big");
  assert.equal(resolveOrderFreightDescriptor({ raw: { delivery_method: { name: "CEL Express Premium Small Courier" } } })?.serviceClass, "Premium Small");
});

test("FBP and realFBS share rates while ambiguous delivery methods stay unmatched", () => {
  assert.deepEqual(
    resolveOrderFreightDescriptor({ raw: { delivery_method: { name: "CEL FBP Standard Extra Small Hch-pd 2" } } }),
    {
      carrier: "CEL",
      channel: "standard",
      serviceClass: "Extra Small",
      sourceText: "CEL FBP Standard Extra Small Hch-pd 2"
    }
  );
  assert.equal(resolveOrderFreightDescriptor({ raw: { delivery_method: { name: "Unknown Standard Extra Small" } } }), null);
});
