# AI Variant Case Library Design

Review date: 2026-07-06

This document records the product and technical design for turning a successful AI variant run into a reusable digital asset. The goal is not only to reuse prompts. The case must preserve enough listing-template context to create new publishable listing drafts later.

## Business Goal

The AI variant lab currently produces a valuable chain:

```text
import source material
-> recognize product facts
-> choose variant type
-> generate target-specific image prompt, title, tags, description, rich content, video
-> save listing draft
```

After this chain succeeds, the result should be saved as a reusable case template:

```text
successful case
-> enter new target values
-> regenerate assets
-> merge with listing template snapshot
-> create new listing draft
-> open draft for publish review
```

This allows common product families such as door sill plates, trunk mats, key covers, armrest organizers, kick pads, and dashboard films to be fissioned quickly without re-recognizing the same product from scratch every time.

## Core Principle

A reusable variant case has three kinds of value:

1. Product truth: what the product is, what must not change, and which facts are authoritative.
2. Variant execution logic: what variable changes, where it appears, and how image/copy generation should handle it.
3. Listing draft context: the original publishable template snapshot required to create a new draft that can still go through the normal listing workflow.

The case library must preserve all three. If it only saves prompts and images, it is not enough.

## UI Design

### Navigation

Add a new entry under the AI skills / listing AI area:

```text
AI Variant Lab
AI Variant Case Library
```

Recommended route:

```text
/ai-variant-cases
```

### Case List Page

The first screen should be an operational list, not a landing page.

Filters:

- Keyword: case name, product subject, source value, target value.
- Product subject: door sill plate, key cover, trunk mat, etc.
- Variant type: vehicle model, logo, color, image optimization, scene/audience.
- Status: active, pending verification, disabled.
- Source: draft, collector, online product, publish record.

Columns:

- Reference images: source image and successful generated image thumbnails.
- Case name.
- Product subject.
- Variant type.
- Source value.
- Successful target value.
- Template source: draft id / template id when available.
- Usage count.
- Success score.
- Updated time in Beijing time.
- Actions: quick variant, generate drafts, open detail, disable.

### Case Detail Page

Use a dense operational layout. Do not use a marketing-style page.

Sections:

1. Case Overview
   - Case name.
   - Product subject.
   - Variant type.
   - Variable slot, such as `vehicle_model`.
   - Source value and successful target value.
   - Source trace: analysis no, batch job no, item no, source draft id, template id.
   - Status, usage count, success score.

2. Listing Template Snapshot
   - Source draft id.
   - Source template id.
   - Source shop ids.
   - Ozon category/type/description-category fields.
   - Price and package facts.
   - Attribute summary.
   - Media slots.
   - Warnings when the case cannot create a publishable draft.

3. Product Facts
   - Product subject.
   - Material.
   - Color.
   - Quantity.
   - Shape/structure.
   - Intended use.
   - Keep facts.
   - Forbidden changes.

4. Variant Contract
   - Variant type.
   - Replace zones.
   - Preserve zones.
   - Text policy.
   - Logo policy.
   - Allowed new text template, such as `{target_value}`.

5. Successful Sample
   - Source image.
   - Generated main image.
   - Final image prompt.
   - Negative prompt.
   - Title, tags, description.
   - Rich content and video if available.

6. Quick Reuse
   - Target values textarea.
   - Offer id prefix rule.
   - Shop selection.
   - Toggles:
     - Regenerate main image.
     - Regenerate title/tags/description.
     - Regenerate rich content.
     - Regenerate video.
     - Reuse successful image as visual reference.
     - Create listing drafts after generation.
   - Actions:
     - Generate variant queue.
     - Generate listing drafts.

## Required Saved Data

### Case Metadata

```json
{
  "case_no": "AVC-20260706-xxxx",
  "case_name": "Door sill plate vehicle variant - black gray strip",
  "product_subject_key": "sill_plate",
  "product_subject_name": "Door sill plate",
  "variant_type": "vehicle_model_swap",
  "variable_slot": "vehicle_model",
  "source_value": "TENET T8",
  "success_target_value": "EXEED VX",
  "status": "active",
  "usage_count": 0,
  "success_score": 0.92
}
```

### Product Facts

```json
{
  "product_facts": {
    "product_type": "car door sill protector / sill plate",
    "material": "ABS / sticker material",
    "color": "black and dark gray",
    "quantity": "",
    "shape": "long strip sticker shape",
    "intended_use": "car door sill threshold area",
    "keep_facts": [],
    "forbidden_changes": []
  }
}
```

### Variant Execution Asset

```json
{
  "variant_contract": {
    "variant_type": "vehicle_model_swap",
    "variable_slot": "vehicle_model",
    "source_value": "TENET T8",
    "success_target_value": "EXEED VX",
    "replace_zones": [
      "large_title_text",
      "model_text",
      "license_plate_text",
      "background_vehicle_cues",
      "logo_or_badge_text"
    ],
    "preserve_zones": [
      "product_body",
      "shape",
      "material",
      "quantity",
      "color_scheme",
      "layout"
    ],
    "text_policy": {
      "keep_existing_title_area": true,
      "require_target_text_visible": true,
      "forbid_new_marketing_text": true,
      "allowed_new_text_template": ["{target_value}"]
    },
    "logo_policy": {
      "mode": "replace_when_vehicle_identity"
    }
  },
  "sample_outputs": {
    "final_image_prompt_en": "",
    "negative_prompt_en": "",
    "title_ru": "",
    "tags_ru": [],
    "description_ru": "",
    "rich_content_ru": ""
  },
  "sample_assets": {
    "source_image_url": "",
    "generated_main_image_url": "",
    "reference_images": [],
    "video_urls": []
  }
}
```

### Listing Template Snapshot

This is the publishability layer. It must be saved when the source came from a listing draft, listing template, online product edit draft, or publish record.

```json
{
  "listing_template_snapshot": {
    "source_draft_id": "",
    "source_template_id": "",
    "source_shop_ids": [],
    "template_payload": {},
    "editable_payload": {},
    "normalized_payload": {},
    "category_context": {
      "ozon_category_id": "",
      "ozon_type_id": "",
      "ozon_description_category_id": ""
    },
    "attribute_context": {
      "attributes": [],
      "required_attributes": [],
      "variant_attributes": []
    },
    "offer_context": {
      "price": "",
      "old_price": "",
      "vat": "",
      "weight_g": "",
      "dimensions": {},
      "barcode": "",
      "sku": ""
    },
    "media_context": {
      "images": [],
      "detail_images": [],
      "videos": [],
      "rich_content_json": ""
    }
  }
}
```

### Source Trace

```json
{
  "source_trace": {
    "analysis_no": "",
    "batch_job_no": "",
    "item_no": "",
    "listing_draft_id": "",
    "listing_template_id": "",
    "source_type": "draft"
  }
}
```

## Draft Recreation Rules

When creating new listing drafts from a case:

1. Start from `listing_template_snapshot.template_payload`.
2. Merge regenerated assets into the snapshot:
   - Main image.
   - Detail images if regenerated or inherited.
   - Title.
   - Tags.
   - Description.
   - Rich content JSON.
   - Video urls and video cover urls.
3. Preserve Ozon category/type/description-category fields.
4. Preserve selected dictionary attributes and required attributes.
5. Preserve package dimensions, weight, price, VAT, and shop context unless the user edits them.
6. Generate a new `offer_id` and internal code for every target.
7. Call the existing AI variant draft creation path so the resulting item lands in the normal listing draft workflow.

### Fields That Must Not Be Copied As-Is

These fields must be regenerated, cleared, or re-derived:

- `offer_id`.
- `sku`.
- `barcode` when it is unique to the source item.
- `product_id`.
- `listing_record_id`.
- Ozon publish record ids.
- Online product ids.
- Publish status.
- Sync status.
- Error messages.
- Historical task ids.
- Old generated-result ids when they would point to a previous target.

### Fields That Must Be Preserved

These fields are part of the publishable template context:

- Template payload and editable payload.
- Ozon category/type/description-category fields.
- Required attributes and selected dictionary values.
- Variant attributes.
- Price and package data.
- Shop ids.
- Detail media slots.
- Rich content structure.
- Video fields.
- Manual facts and AI payload facts that are product-truth related.

## Backend Design

### Tables

Use two tables in the first version.

`ai_variant_case_templates`

- `id`
- `case_no`
- `case_name`
- `product_subject_key`
- `product_subject_name`
- `variant_type`
- `variable_slot`
- `source_value`
- `success_target_value`
- `status`
- `usage_count`
- `success_score`
- `case_json`
- `created_by_person_id`
- `created_at`
- `updated_at`

`ai_variant_case_runs`

- `id`
- `run_no`
- `case_no`
- `target_values_json`
- `result_job_no`
- `generated_draft_ids_json`
- `status`
- `result_json`
- `created_by_person_id`
- `created_at`
- `updated_at`

### API Endpoints

Case library:

```text
GET    /api/ai-variant-lab/cases
GET    /api/ai-variant-lab/cases/:caseNo
POST   /api/ai-variant-lab/cases
PATCH  /api/ai-variant-lab/cases/:caseNo
POST   /api/ai-variant-lab/cases/:caseNo/disable
```

Save from a generated row:

```text
POST /api/ai-variant-lab/cases/from-batch-item
```

Body:

```json
{
  "jobNo": "",
  "itemNo": "",
  "caseName": "",
  "sourceDraftId": "",
  "templatePayload": {},
  "includeGeneratedAssets": true
}
```

Reuse a case:

```text
POST /api/ai-variant-lab/cases/:caseNo/quick-plan
POST /api/ai-variant-lab/cases/:caseNo/generate-drafts
```

`quick-plan` creates a normal AI variant batch job and opens the existing generation queue.

`generate-drafts` uses the case, regenerates selected assets, merges the listing template snapshot, and creates listing drafts.

## Frontend Design

### AI Variant Lab Changes

Minimal changes:

- Add `Save as case` on generated rows.
- Add `Save batch as case` near `Save template`.
- Save case requires a source template snapshot. If missing, show a blocking message:

```text
This case cannot create listing drafts because the source material has no listing template snapshot. Import from a listing draft or a publishable template source first.
```

### Case Library Page

File suggestion:

```text
frontend/admin/views/listing/AiVariantCaseLibraryView.vue
```

Layout:

- Left: filter sidebar or compact filter row.
- Center: dense case table.
- Right drawer: case detail and quick reuse form.

Avoid cards inside cards. Use table rows, detail panels, tabs, and drawers.

### Case Detail Tabs

- Overview.
- Template snapshot.
- Product facts.
- Variant contract.
- Successful sample.
- Reuse history.

### Quick Reuse Form

Fields:

- New target values textarea.
- Shop ids.
- Offer id prefix.
- Regenerate main image.
- Regenerate copy.
- Regenerate rich content.
- Regenerate video.
- Create drafts after generation.

Actions:

- Generate queue.
- Generate drafts.

## Reuse Flow

### Save Case From Generated Row

```text
AI Variant Lab generated row
-> collect item_json and generated assets
-> collect source material templatePayload
-> collect listing source trace
-> build case_json
-> insert ai_variant_case_templates
```

### Quick Plan From Case

```text
case_json + target_values
-> clone product facts and variant contract
-> replace {target_value}
-> create ai_variant_lab_batch_job/items
-> open existing AI Variant Lab generation queue
```

### Generate Drafts From Case

```text
case_json + target_values
-> regenerate selected assets
-> clone listing_template_snapshot.template_payload
-> replace target-specific text/media
-> generate new offer_id
-> call existing AI variant lightweight draft creation
-> return generated draft ids
```

## Validation and Guardrails

### Blocking Validation

Block draft generation when:

- No `template_payload` exists.
- Missing Ozon category/type/description-category fields.
- Missing required package dimensions or weight.
- Missing price when the source template requires it.
- Template contains only local media urls that cannot be published.

Messages must say where the missing data belongs: product/template, draft, shop, media, price, package, or attribute layer.

### Regression Tests

Add focused tests for:

- Case table schema and route registration.
- Saving a case from a batch item preserves `template_payload`.
- Saving a case from a temporary upload is blocked from draft generation.
- Quick plan replaces only the variable target and keeps product facts.
- Generate drafts creates new offer ids and does not copy publish ids or product ids.
- Generated draft still passes listing publish validation fixture.

Relevant existing tests:

```text
test/ai-variant-lab-api.test.js
test/listing-draft-create-ai-payload.test.js
test/listing-record-editor-view.test.js
test/listing-template-health-check.test.js
test/listing-publish-e2e-regression.test.js
```

## Implementation Phases

### Phase 1: Save and View Cases

- Add case tables.
- Add backend APIs for list/detail/create.
- Add `Save as case` from a generated row.
- Add case library list/detail UI.
- No automatic draft creation yet.

### Phase 2: Quick Plan

- Add case quick-plan endpoint.
- Use case facts and variant contract to create normal AI variant batch items.
- Route into the existing AI Variant Lab generation queue.

### Phase 3: Generate Drafts

- Add draft generation endpoint from case.
- Merge generated assets into saved `template_payload`.
- Call the existing AI variant lightweight draft path.
- Return draft ids and open draft links.

### Phase 4: Scoring and Recommendation

- Track usage count, generated draft ids, and operator success feedback.
- Promote high-score cases.
- Recommend cases by product subject and variant type.

## Non-Goals for First Version

- Do not bypass listing draft review.
- Do not auto-publish to protected environments.
- Do not replace the AI Variant Lab generation queue.
- Do not require re-recognition when a case has a valid template snapshot.
- Do not use successful case copy if it conflicts with product facts or target value.

## Protected Boundaries

- The existing listing draft and publish validation chain remains the authority for publishability.
- Case reuse must create normal listing drafts, not hidden publish records.
- Media must still be materialized to publishable URLs before formal Ozon submit.
- New draft creation must not copy old `offer_id`, Ozon product ids, publish records, or sync status.
- User edits in generated rows must be included when saving a case.

