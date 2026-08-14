import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importInfoStatus, normalizeOzonImportInfoErrors } from "../src/services/listing-automation.js";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const listingAutomationViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const publishRecordsViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");

test("listing publish normalizes Ozon import-info errors", () => {
  assert.match(listingSource, /export function normalizeOzonImportInfoErrors/);
  assert.match(listingSource, /extractOzonImportItemErrors/);
  assert.match(listingSource, /summarizeOzonImportInfoErrors/);
  assert.match(listingSource, /import_errors: importErrorSummary\.items/);
  assert.match(listingSource, /ok: !importErrorSummary\.has_errors/);
});

test("publish result drawer shows import-info suggestions", () => {
  assert.match(listingAutomationViewSource, /prop="fix_tip" label="建议"/);
  assert.match(listingAutomationViewSource, /row\.import_error_summary\?\.items\?\.\[0\]\?\.raw_message/);
  assert.match(listingAutomationViewSource, /publishSubmitFailedResults/);
  assert.match(listingAutomationViewSource, /publishSubmitVisibleResults/);
  assert.match(listingAutomationViewSource, /openPublishSubmitRecord/);
  assert.match(listingAutomationViewSource, /recordId: row\.record_id/);
});

test("publish records view exposes item-level Ozon import errors", () => {
  assert.match(publishRecordsViewSource, /function publishImportErrorItems/);
  assert.match(publishRecordsViewSource, /publishImportErrorItems\(row\)\[0\]\.raw_message/);
  assert.match(publishRecordsViewSource, /publishImportErrorItems\(drawer\.row\)/);
  assert.match(publishRecordsViewSource, /prop="fix_tip" label="建议"/);
  assert.match(publishRecordsViewSource, /function openRoutePublishRecord/);
  assert.match(publishRecordsViewSource, /route\.query\.recordId/);
  assert.match(publishRecordsViewSource, /function repairTargetForImportError/);
  assert.match(publishRecordsViewSource, /drawerRepairIssues/);
  assert.match(publishRecordsViewSource, /focusRepairIssue/);
  assert.match(publishRecordsViewSource, /id="repair-field-offer_id"/);
  assert.match(publishRecordsViewSource, /repair-field-warning/);
});

test("multi-variant import-info marks the record failed when a later variant fails", () => {
  const importInfo = {
    result: {
      status: "imported",
      items: [
        { offer_id: "VAR-1", status: "imported", product_id: 101 },
        {
          offer_id: "VAR-2",
          status: "failed",
          errors: [{ message: "Duplicate offer_id", code: "DUPLICATE_OFFER_ID" }]
        }
      ]
    }
  };
  const normalized = normalizeOzonImportInfoErrors(importInfo);
  assert.equal(normalized.has_errors, true);
  assert.equal(normalized.items[0].offer_id, "VAR-2");
  assert.equal(importInfoStatus(importInfo), "failed");
});

test("successful import-info item messages do not mark variants failed", () => {
  const importInfo = {
    result: {
      status: "imported",
      items: [
        { offer_id: "VAR-1", status: "imported", product_id: 101, message: "Imported" },
        { offer_id: "VAR-2", status: "imported", product_id: 102, message: "Imported" }
      ]
    }
  };
  const normalized = normalizeOzonImportInfoErrors(importInfo);
  assert.equal(normalized.has_errors, false);
  assert.equal(importInfoStatus(importInfo), "imported");
});

test("imported items keep Ozon warnings without being marked failed", () => {
  const importInfo = {
    result: {
      items: [{
        offer_id: "WARN-1",
        status: "imported",
        product_id: 5497955520,
        errors: [{
          code: "BR_hashtags_symbols_limit",
          attribute_id: 23171,
          level: "warning",
          description: "Use no more than 30 characters"
        }]
      }],
      total: 1
    }
  };
  assert.equal(normalizeOzonImportInfoErrors(importInfo).has_errors, false);
  assert.equal(importInfoStatus(importInfo), "imported");
});

test("Ozon image and video processing warnings mark imported items as failed", () => {
  const importInfo = {
    result: {
      items: [{
        offer_id: "MEDIA-WARN-1",
        status: "imported",
        product_id: 5497955521,
        errors: [
          {
            code: "some_image_failed",
            field: "pictures",
            level: "warning",
            description: "Some images could not be downloaded"
          },
          {
            code: "video_cover_is_not_downloaded",
            attribute_id: 21845,
            level: "warning",
            description: "Video cover could not be downloaded"
          }
        ]
      }],
      total: 1
    }
  };

  const normalized = normalizeOzonImportInfoErrors(importInfo);
  assert.equal(normalized.has_errors, true);
  assert.deepEqual(normalized.items.map((item) => item.code), [
    "some_image_failed",
    "video_cover_is_not_downloaded"
  ]);
  assert.equal(importInfoStatus(importInfo), "failed");
});

test("empty Ozon task details remain pending instead of looking submitted", () => {
  const importInfo = { result: { items: [], total: 0 } };
  assert.equal(normalizeOzonImportInfoErrors(importInfo).has_errors, false);
  assert.equal(importInfoStatus(importInfo), "ozon_status_pending");
});
