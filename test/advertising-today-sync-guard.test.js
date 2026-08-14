import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const advertisingSource = readFileSync(new URL("../src/services/advertising-analytics.js", import.meta.url), "utf8");

test("advertising today sync stays within Ozon single active request limits", () => {
  assert.match(serverSource, /maxShopsPerRun:\s*1/);
  assert.match(serverSource, /shopConcurrency:\s*1/);
  assert.match(serverSource, /const timeoutMinutes = Math\.max\(25,/);
  assert.match(serverSource, /const shopConcurrency = 1/);
  assert.match(serverSource, /retryDelaySeconds: hardErrors > 0 \? 900/);
});

test("advertising sync classifies Russian active request limit errors", () => {
  assert.match(advertisingSource, /lower\.includes\("активных запрос"\)/);
  assert.match(advertisingSource, /active_report_limit/);
});

test("advertising sync waits for active reports and polls generated reports for up to five minutes", () => {
  assert.match(advertisingSource, /if \(!isActiveReportLimitError\(error\)\) break;\s*if \(attempt < 5\) await sleep\(reportRetryDelayMs \+ attempt \* 5000, options\.signal\)/);
  assert.match(advertisingSource, /reportPollAttempts = Math\.max\(12, Math\.min\(120,[\s\S]*\|\| 60\)\)/);
  assert.match(advertisingSource, /reportMissingRetryDelayMs[\s\S]*\|\| 5000\)/);
  assert.match(advertisingSource, /function sleep\(ms, signal\)[\s\S]*signal\?\.addEventListener\("abort", onAbort/);
  assert.match(advertisingSource, /function isRetryablePerformanceReportError\(error\)/);
  assert.match(advertisingSource, /\|\| isActiveReportLimitError\(error\)/);
});

test("an unsupported legacy campaign object type does not fail a successful campaign lookup", () => {
  assert.match(advertisingSource, /let successfulRequests = 0;/);
  assert.match(advertisingSource, /successfulRequests \+= 1;/);
  assert.match(advertisingSource, /if \(!unique\.size && successfulRequests === 0 && lastError\) throw lastError;/);
});

test("advertising rolling sync expands to unresolved rows from the latest 90 Beijing days", () => {
  assert.match(serverSource, /async function advertisingBackfillWindow/);
  assert.match(serverSource, /source = 'ozon_performance_pending'/);
  assert.match(serverSource, /DATE_SUB\(DATE\(CONVERT_TZ\(UTC_TIMESTAMP\(\), '\+00:00', '\+08:00'\)\), INTERVAL 89 DAY\)/);
  assert.match(serverSource, /const window = await advertisingBackfillWindow\(selectedShopIds, syncDays\);/);
});

test("a ready empty Ozon report settles stale pending placeholder rows", () => {
  assert.match(advertisingSource, /reportStats\.settledCampaignIds\.push\(\.\.\.chunk\.map/);
  assert.match(advertisingSource, /reportStats\.settledCampaignIds\.push\(String\(campaign\.id\)\)/);
  assert.match(advertisingSource, /settleReturnedAdvertisingReportsMysql\(shop\.id, reportStats\.settledCampaignIds/);
  assert.match(advertisingSource, /DELETE FROM ozon_ad_sku_daily[\s\S]*source = 'ozon_performance_pending'/);
});

test("historical advertising backfill runs every 15 minutes and prioritizes pending campaigns", () => {
  assert.match(serverSource, /backgroundAdvertisingSyncIntervalMinutes \|\| 15/);
  assert.match(advertisingSource, /pendingAdvertisingCampaignIdsMysql\(shop\.id, \{ from, to \}\)/);
  assert.match(advertisingSource, /pendingCampaignIds\.size[\s\S]*campaign_cursor: 0/);
  assert.match(advertisingSource, /source = 'ozon_performance_pending'[\s\S]*GROUP BY campaign_id/);
});

test("advertising jobs cannot be deferred forever by foreground traffic", () => {
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"advertising_sync"/);
  assert.match(serverSource, /FOREGROUND_DEFERRAL_BOUNDED_JOBS[\s\S]*"advertising_today_sync"/);
});

test("historical advertising repair keeps disappeared campaign ids discoverable", () => {
  assert.match(advertisingSource, /CREATE TABLE IF NOT EXISTS ozon_ad_campaign_catalog/);
  assert.match(advertisingSource, /const historicalCampaigns = await knownAdvertisingCampaignsMysql\(shop\.id\)/);
  assert.match(advertisingSource, /mergeAdvertisingCampaigns\(historicalCampaigns, liveCampaigns\)/);
  assert.match(advertisingSource, /SELECT campaign_id AS id[\s\S]*FROM ozon_ad_campaign_catalog[\s\S]*UNION[\s\S]*FROM ozon_ad_sku_daily/);
});

test("historical advertising repair is audit-only by default and excludes the current Beijing day", () => {
  assert.match(advertisingSource, /const apply = body\.apply === true/);
  assert.match(advertisingSource, /mode: "audit_only"/);
  assert.match(advertisingSource, /beijingDateDaysAgo\(1\)/);
  assert.match(advertisingSource, /splitCalendarMonths\(from, safeTo\)/);
  assert.match(advertisingSource, /shopIds\.length !== 1/);
  assert.match(advertisingSource, /maxCampaignsPerShop[\s\S]*\|\| 1/);
  assert.match(advertisingSource, /next_campaign_cursor: campaignCursor \+ maxCampaignsPerShop/);
});
