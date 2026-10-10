import test from "node:test";
import assert from "node:assert/strict";
import { latestRfbsTariff, searchRfbsCategories, rfbsCategory } from "../src/services/ozon-rfbs-tariff.js";
import { commissionRateForRub } from "../frontend/admin/utils/rfbs-commission.js";

test("latest effective rFBS snapshot exposes source and searchable category rates", async () => {
  const tariff = await latestRfbsTariff(new Date("2026-10-10T00:00:00Z"));
  assert.equal(tariff.effectiveDate, "2025-12-01");
  assert.equal(tariff.sheet, "Full ChinaHK");
  assert.equal(tariff.rows.length, 10795);
  assert.equal(tariff.sourceSha256.length, 64);
  const match = searchRfbsCategories(tariff, "高领衫");
  assert.ok(match.total > 0);
  const detail = rfbsCategory(tariff, match.rows[0].id);
  assert.deepEqual(detail.rates, [12, 14, 20.5]);
  assert.equal(detail.version, "2025-12-01");
});

test("rFBS rates switch at the published ruble price boundaries", () => {
  const rates = [12, 14, 20.5];
  assert.equal(commissionRateForRub(rates, 1500), 12);
  assert.equal(commissionRateForRub(rates, 1500.01), 14);
  assert.equal(commissionRateForRub(rates, 5000), 14);
  assert.equal(commissionRateForRub(rates, 5000.01), 20.5);
});
