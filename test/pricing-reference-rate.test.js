import assert from "node:assert/strict";
import test from "node:test";
import { parseCbrCnyRate } from "../src/services/pricing-reference-rate.js";

test("parses CNY nominal and value from the official daily XML", () => {
  const xml = '<ValCurs Date="10.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,00</Value></Valute><Valute><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>125,9840</Value></Valute></ValCurs>';
  assert.deepEqual(parseCbrCnyRate(xml), { rate: 12.5984, source_date: "10.10.2026" });
});

test("rejects a response without CNY instead of inventing an exchange rate", () => {
  assert.throws(() => parseCbrCnyRate("<ValCurs></ValCurs>"), /没有人民币/);
});
