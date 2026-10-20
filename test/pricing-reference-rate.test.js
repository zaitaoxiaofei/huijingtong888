import assert from "node:assert/strict";
import test from "node:test";
import { parseCbrCnyRate, cbrCnyRateForDate } from "../src/services/pricing-reference-rate.js";

test("OGL historical exchange rate requests the Beijing order day from CBR", async () => {
  let requestedUrl = "";
  const rate = await cbrCnyRateForDate("2026-10-19T16:00:00Z", {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, text: async () => '<ValCurs Date="20.10.2026"><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>12,3869</Value></Valute></ValCurs>' };
    }
  });
  assert.match(requestedUrl, /date_req=20\/10\/2026$/);
  assert.equal(rate.rate, 12.3869);
});

test("parses CNY nominal and value from the official daily XML", () => {
  const xml = '<ValCurs Date="10.10.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,00</Value></Valute><Valute><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>125,9840</Value></Valute></ValCurs>';
  assert.deepEqual(parseCbrCnyRate(xml), { rate: 12.5984, source_date: "10.10.2026" });
});

test("rejects a response without CNY instead of inventing an exchange rate", () => {
  assert.throws(() => parseCbrCnyRate("<ValCurs></ValCurs>"), /没有人民币/);
});
