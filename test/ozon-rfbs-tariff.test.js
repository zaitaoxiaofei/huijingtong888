import test from "node:test";
import assert from "node:assert/strict";
import { latestRfbsTariff, latestRfbsMarketplace, searchRfbsCategories, rfbsCategory } from "../src/services/ozon-rfbs-tariff.js";
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

test("marketplace snapshot supports the three-column category picker", async () => {
  const catalog = await latestRfbsMarketplace(new Date("2026-10-10T00:00:00Z"));
  assert.equal(catalog.version, "2025-12-01");
  assert.equal(catalog.rows.length, 80);
  assert.equal(new Set(catalog.rows.map((row) => row.block)).size, 9);
  const automotive = catalog.rows.find((row) => row.category === "汽车用品");
  assert.deepEqual(automotive.rates, [12, 17, 17]);
  assert.ok(catalog.rows.some((row) => row.category.includes("苹果") && row.rates[0] === 7));
});
