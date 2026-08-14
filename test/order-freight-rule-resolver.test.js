import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrderFreightDescriptor } from "../src/services/order-freight-rule-resolver.js";

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
