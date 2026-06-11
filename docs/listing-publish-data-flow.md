# Listing Publish Data Flow

This document describes the current listing data path and the regression boundary that should stay protected when AI variant, collector, online-product copy, draft, or publish-record flows change.

## Current Shape

The listing workflow has several source entry points:

- AI variant workbench: generated text, images, videos, and variant targets are saved back to listing templates or listing drafts.
- Collector box: Ozon page data is normalized into an editable listing template.
- Online product copy: an existing online product is converted into a new editable listing draft or template.
- Publish records: a previous Ozon request can be opened, edited, retried, or saved as a draft.
- Listing drafts: a saved draft can be expanded into a publishable template and sent to one or more shops.

These flows should converge before Ozon submission:

```text
source payload
-> editable listing template or listing draft
-> publish validation
-> shop-specific payload
-> Ozon /v3/product/import items[]
```

The most important backend boundary is `validateListingTemplatePublish()` in `src/services/listing-automation.js`. It builds the local Ozon import preview payload and performs blocking checks before formal publish. Formal publish then runs through `publishListingTemplateToOzon()` or `publishListingDraftsToOzon()`.

## Publish Contract

Any source that claims to be publishable must produce an Ozon candidate with:

- `items[]` with at least one item.
- `offer_id`, `name`, `price`, `description_category_id`, and `type_id` for every item.
- dimensions converted to millimeters with `dimension_unit: "mm"`.
- weight in grams with `weight_unit: "g"`.
- a `primary_image` and optional `images`.
- Ozon attributes shaped as `{ id, values }`.
- dictionary attributes containing only selected values, not every candidate option.
- no schema placeholder values where an attribute value is just the attribute name.
- no local-only media such as `/uploads/...`, `localhost`, or `127.0.0.1` in publish payloads.
- video URLs represented in Ozon complex attributes when present.

## Current Risk Points

- `src/services/listing-automation.js` is a large coordination file. It contains source normalization, template handling, draft handling, media publication, validation, Ozon payload construction, and publish records. This makes accidental bypasses easier when adding new entry points.
- Some important cleaning still exists in the frontend, especially selected dictionary value cleanup in `ListingAutomationView.vue`. Backend validation must remain the final authority.
- Existing guard tests catch deleted code patterns, but they do not fully prove that realistic payloads still become Ozon-acceptable `items[]`.
- Media paths are high risk. Ozon cannot fetch authenticated or local preview URLs, so publish payloads must contain public URLs or fail validation before submit.
- `offer_id` is high risk when copying online products or retrying publish records. A copied product should not accidentally reuse an unsafe original offer ID unless the flow is explicitly updating an existing record.

## Regression Test Boundary

`test/listing-publish-e2e-regression.test.js` protects the current publish contract with fixture payloads that represent important source paths after they have reached the editable listing-template layer:

- AI variant draft/template candidate.
- Collector-box template candidate.
- Publish-record retry candidate.

The test intentionally starts at the backend publish validation boundary. That gives a stable safety net without requiring a database, a running server, Ozon credentials, or a local port.

Run the focused regression with:

```bash
node --test --test-concurrency=1 test/listing-publish-e2e-regression.test.js
```

Future tests should add earlier source-level fixtures when source normalizers are extracted:

```text
AI raw result -> editable template -> Ozon candidate
collector raw payload -> editable template -> Ozon candidate
online product row -> editable template -> Ozon candidate
publish record detail -> editable template -> Ozon candidate
```

The AI raw-result path now uses `buildTemplateCandidateFromAiVariantResult()` from `src/services/listing-publish-normalizer.js` as a pure, reusable normalizer. The collector raw-source path uses `buildTemplateCandidateFromCollectedSource()` from the same module and wraps the existing collected-source draft preparer. The online-product edit path uses `buildTemplateCandidateFromOnlineProductTemplate()` to wrap the listing template standardizer with stable `online_product_live` source metadata.

## Change Rule

When changing AI variant writeback, collector import, online-product copy, listing drafts, publish records, media handling, Ozon attributes, or publish payload generation:

1. Add or update a fixture that represents the affected source.
2. Assert the final Ozon candidate contract, not only the intermediate page state.
3. Run the focused listing tests before completion.
4. Run `npm run check:encoding` after editing Chinese copy, docs, Windows scripts, or packaging metadata.
