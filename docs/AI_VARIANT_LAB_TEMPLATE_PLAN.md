# AI Variant Lab Template Plan

Review date: 2026-06-24

This document defines the experimental AI variant lab plan. It is intentionally separate from the current AI variant workbench and listing publish flow. The first goal is to make product recognition, vehicle/logo variant planning, prompt reuse, cost tracking, and template promotion testable without writing generated results into listing drafts.

## Current Test Result

Test case: TENET T4 door sill protector main image.

Local CCTQ configuration found on 2026-06-23:

- Text provider: `custom`
- Provider name: `CCTQ-GPT-5.4`
- Base URL: `https://www.cctq.ai/v1`
- Text model: `gpt-5.4`
- Image route: `cctq-image2` / `gpt-image-2`
- Vision route in system settings: not configured yet

Observed capability:

- `gpt-5.4` accepts OpenAI-compatible multimodal `chat/completions` content with `image_url`.
- It successfully recognized a TENET T4 door sill protector image.
- It correctly found product type, visible model text, background vehicle, 4-piece count, and editable regions.
- It needs stricter business prompting because an unconstrained recognition prompt may treat source model text as a must-keep fact.

Important implementation note:

- The existing `chatWithAiProvider` text path normalizes message content into plain text. It is not suitable for multimodal image input as-is.
- Add a separate vision call path instead of forcing image input through the current text path.

## Business Target

The AI variant goal is not generic image generation. It is a controlled SKU fission workflow:

1. Use a good product SKU as a source template.
2. Keep the product body, material, quantity, and real product facts unchanged.
3. Change only the intended variant dimension, such as vehicle model, logo text, background vehicle, audience scene, or marketplace copy angle.
4. Generate consistent main image, title, tags, description, and rich text.
5. Save successful recognition and prompt results as reusable templates to reduce future token cost.

For the first phase, focus on vehicle-model variants for door sill protector products.

## Template Layers

Use two layers of reusable knowledge.

### 1. Category Template

Category templates describe stable product-family rules.

Example:

```json
{
  "templateKey": "sill_plate_vehicle_variant",
  "templateName": "不锈钢门槛条-车型裂变",
  "categoryKey": "sill_plate",
  "userNote": "适合门槛条产品。产品主体不变，只换车型 logo、背景车和车型文案。",
  "matchRules": {
    "productTypeAny": ["door sill protector", "накладки на пороги", "门槛条"],
    "visualSignalsAny": ["4 pieces", "brushed metal", "black frame"],
    "textSignalsAny": ["КОМПЛЕКТ", "НАКЛАДКИ НА ПОРОГИ"]
  },
  "keepFacts": [
    "product subject",
    "material",
    "piece count",
    "shape",
    "black frame",
    "marketplace layout quality"
  ],
  "changeableFacts": [
    "vehicle model text",
    "product logo text",
    "background vehicle",
    "license plate model text",
    "title model text",
    "tag model text",
    "description model text",
    "rich text model text"
  ],
  "forbiddenChanges": [
    "do not change stainless steel into ABS unless the source product is ABS",
    "do not change piece count",
    "do not change product category",
    "do not invent certification, official authorization, warranty, sales volume, or exact dimensions"
  ]
}
```

### 2. Successful Case Template

Successful case templates describe a proven source-image pattern and prompt set.

Example:

```json
{
  "caseKey": "tenet_t4_sill_plate_template_image_v1",
  "caseName": "TENET T4 不锈钢门槛条主图",
  "categoryTemplateKey": "sill_plate_vehicle_variant",
  "sourceModel": "TENET T4",
  "sourceImageFingerprint": {
    "perceptualHash": "",
    "ocrTerms": ["TENET T4", "НАКЛАДКИ НА ПОРОГИ", "КОМПЛЕКТ: 4 ШТ"],
    "detectedProductType": "накладки на пороги автомобиля"
  },
  "promptSet": {
    "imageEditPromptEn": "Create an Ozon-ready automotive listing image variant for {{target_model}} based on the source image. Preserve the exact product subject as a 4-piece stainless steel brushed metal door sill protector set with black frame. Keep the item count, arrangement logic, metallic realism, and high-resolution product presentation. Change only model-specific elements so the set is presented as compatible with {{target_model}}: replace source-model branding/text/logo with {{target_model}}, and if any car context or background vehicle cues are visible, adapt them to {{target_model}}.",
    "negativePromptEn": "Do not change the product category. Do not change the number of pieces. Do not remove the black frame. Do not replace brushed stainless steel with plastic, carbon fiber, chrome mirror, or painted surfaces. Do not leave any source-model text visible.",
    "copyPromptRule": "Output Russian Ozon copy for a {{quantity}} {{material}} door sill protector set for {{target_model}}. Do not mention {{source_model}}."
  },
  "qualityChecks": [
    "exactly 4 door sill protector pieces remain visible",
    "brushed stainless steel appearance remains",
    "black frame remains",
    "source model text is not visible",
    "target model appears consistently",
    "copy does not mention the source model",
    "copy does not invent material, quantity, certification, warranty, or official authorization"
  ],
  "promotion": {
    "status": "draft",
    "successCount": 0,
    "failureCount": 0,
    "minSuccessCountForAutoApply": 10,
    "minQualityPassRateForAutoApply": 0.9
  }
}
```

## Proposed Experimental API

These endpoints should live under an experimental namespace and should not create listing drafts.

```text
POST /api/ai-variant-lab/analyze-image
POST /api/ai-variant-lab/plan-variant
POST /api/ai-variant-lab/batch-plan
POST /api/ai-variant-lab/batch-run-images
GET  /api/ai-variant-lab/batch-jobs
GET  /api/ai-variant-lab/batch-jobs/{jobNo}
POST /api/ai-variant-lab/generate-copy-contract
POST /api/ai-variant-lab/test-image-edit
POST /api/ai-variant-lab/optimize/analyze
POST /api/ai-variant-lab/optimize/plan
POST /api/ai-variant-lab/optimize/test-image
POST /api/ai-variant-lab/save-template
GET  /api/ai-variant-lab/templates
```

### `analyze-image`

Input:

```json
{
  "imageUrl": "https://... or data URL or local uploaded asset URL",
  "productHint": "optional user note",
  "businessMode": "vehicle_variant"
}
```

Output:

```json
{
  "analysisId": "ailab-analysis-...",
  "model": "gpt-5.4",
  "usage": {},
  "productType": "накладки на пороги автомобиля",
  "material": "нержавеющая сталь + black frame",
  "quantity": "4 шт",
  "sourceVariantValue": "TENET T4",
  "visibleText": [],
  "editableRegions": [],
  "keepFacts": [],
  "changeableFacts": [],
  "templateMatch": {
    "templateKey": "sill_plate_vehicle_variant",
    "confidence": 0.86,
    "reason": "matched product type, piece count, brushed metal visual signals"
  }
}
```

### `plan-variant`

Input:

```json
{
  "analysisId": "ailab-analysis-...",
  "templateKey": "sill_plate_vehicle_variant",
  "sourceVariantValue": "TENET T4",
  "targetVariantValue": "TENET T7",
  "fields": ["mainImage", "title", "tags", "description", "richText"]
}
```

Output:

```json
{
  "variantType": "vehicle_logo_background",
  "targetVariantValue": "TENET T7",
  "keepFacts": [],
  "changeFacts": [],
  "imageEditPromptEn": "",
  "negativePromptEn": "",
  "copyContract": {},
  "qualityChecks": []
}
```

### `save-template`

The template save action should be explicit. Operators can name the case and add a note before it becomes reusable.

Input:

```json
{
  "analysisId": "ailab-analysis-...",
  "planId": "ailab-plan-...",
  "templateName": "不锈钢门槛条-车型裂变",
  "caseName": "TENET T4 门槛条图",
  "userNote": "这套图生成效果好，适合 TENET 系列车型裂变",
  "autoApply": false
}
```

### `batch-plan`

One source SKU to many target vehicle/model values. This is the preferred efficient path for production fission.

Input:

```json
{
  "analysisNo": "AVL-A-...",
  "sourceVariantValue": "TENET T4",
  "targetModels": ["TENET T5", "TENET T7", "TENET T8"],
  "templateKey": "sill_plate_vehicle_variant",
  "budgetCny": 10,
  "imageConcurrency": 1
}
```

Output:

```json
{
  "job_no": "AVL-B-...",
  "items": [
    {
      "target_variant_value": "TENET T7",
      "image_edit_prompt_en": "...",
      "negative_prompt_en": "...",
      "title_ru": "...",
      "tags_ru": [],
      "description_ru": "...",
      "quality_checks": []
    }
  ]
}
```

### `batch-run-images`

Runs image generation for planned batch items. The default mode is dry-run, so real image spend only starts when `execute` is `true`.

```json
{
  "jobNo": "AVL-B-...",
  "imagePath": "C:/path/source.png",
  "execute": false,
  "limit": 10,
  "ratio": "3:4"
}
```

The current implementation processes items sequentially and records item status, image result, elapsed time, and errors.

### Image optimization endpoints

Variant fission and image optimization are separate operator intents.

- Variant fission: same product body, target variable changes.
- Image optimization: same SKU, same facts, improve main-image clarity and selling quality.

```text
POST /api/ai-variant-lab/optimize/analyze
POST /api/ai-variant-lab/optimize/plan
POST /api/ai-variant-lab/optimize/test-image
```

Optimization output focuses on:

- current image problems
- improvement opportunities
- keep facts
- forbidden changes
- optimization prompt
- quality checks

### Latest HTTP test

Tested after implementation:

- Batch plan input: `TENET T4` to `TENET T5`, `TENET T7`, `TENET T8`.
- Batch plan elapsed: about 46.6s.
- Batch plan usage: 8019 tokens, estimated text cost about CNY 0.00762.
- Batch image dry-run: 3/3 preflight passed, no warnings.
- Optimizer analyze elapsed: about 29.7s.
- Optimizer plan elapsed: about 30.7s.
- Optimizer dry-run: passed, no warnings.

## Cost Saving Strategy

Use recognition only when needed.

Recommended flow:

1. First time for a new source-image pattern:
   - Run vision recognition.
   - Generate variant plan.
   - Generate prompts and copy contract.
   - Save as a case template only after the result is manually approved.
2. Future similar products:
   - Run cheap deterministic matching first.
   - If matched confidently, reuse template prompts directly.
   - Run only lightweight AI validation if needed.
3. Auto mode:
   - Enable only after enough successful cases.
   - Enforce daily budget and per-template ROI tracking.

Suggested budget tiers:

```text
Low:    match template + text copy only
Medium: match template + selected main image edit
High:   full recognition + main image edit + rich text + optional video
```

## Matching Rules

A product can reuse a template when at least two of these are true:

- Product title or OCR text matches known category terms.
- Image recognition or cached facts match the category template.
- Product metadata category matches a known category key.
- The source image fingerprint is similar to a successful case.
- The operator manually selects the template.

When confidence is low, ask the operator:

```text
识别为门槛条，是否按“车型/logo/背景车裂变”模板处理？
```

## Quality Gate

Every generated result should be checked before save or publish.

For the door sill protector template:

- Product type remains door sill protector.
- Quantity remains the same.
- Material remains the same.
- Target model is present.
- Source model is removed.
- No unrelated product type appears.
- No fake certification, authorization, warranty, exact size, or sales volume is invented.
- Russian copy does not contain Chinese text or mojibake.

## Data Model Draft

Minimum experimental tables:

```sql
CREATE TABLE ai_variant_lab_analyses (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  analysis_no VARCHAR(64) NOT NULL,
  source_image_url TEXT NULL,
  source_product_id VARCHAR(128) NOT NULL DEFAULT '',
  business_mode VARCHAR(64) NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT '',
  usage_json JSON NULL,
  analysis_json LONGTEXT NOT NULL,
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_variant_lab_analysis_no (analysis_no)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE ai_variant_templates (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  template_key VARCHAR(128) NOT NULL,
  template_name VARCHAR(191) NOT NULL,
  category_key VARCHAR(128) NOT NULL DEFAULT '',
  user_note TEXT NULL,
  template_json LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  auto_apply TINYINT(1) NOT NULL DEFAULT 0,
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_variant_template_key (template_key)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE ai_variant_template_cases (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  case_key VARCHAR(128) NOT NULL,
  template_key VARCHAR(128) NOT NULL,
  case_name VARCHAR(191) NOT NULL,
  source_model VARCHAR(128) NOT NULL DEFAULT '',
  fingerprint_json LONGTEXT NULL,
  prompt_set_json LONGTEXT NOT NULL,
  quality_checks_json LONGTEXT NOT NULL,
  result_score DECIMAL(6,4) NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  created_by_person_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_variant_template_case_key (case_key),
  INDEX idx_ai_variant_template_cases_template (template_key)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## Implementation Order

1. Add a backend-only vision caller for OpenAI-compatible multimodal `chat/completions`.
2. Add `analyze-image` and `plan-variant` experimental endpoints.
3. Save analysis and plan snapshots.
4. Add template save/list endpoints.
5. Add a small internal lab page after backend tests are stable.
6. Only then connect selected templates to the existing AI variant workbench.

## First Acceptance Test

Input:

- Source image: TENET T4 door sill protector image.
- Target: `TENET T7`.
- Template: `sill_plate_vehicle_variant`.

Pass criteria:

- Recognition detects door sill protector, 4 pieces, brushed metal/stainless steel, black frame, TENET T4 source text.
- Plan says product body/material/quantity stay unchanged.
- Plan says all model-specific text/background vehicle/logo references change to TENET T7.
- Copy contract forbids TENET T4 in final output.
- Quality checks are generated and machine-readable.
