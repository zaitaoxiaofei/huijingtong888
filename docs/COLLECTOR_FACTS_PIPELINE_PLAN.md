# Collector Facts Pipeline Plan

## Goal

The collector-box flow must stop depending on one-off category fixes and page-specific field luck.
We need a stable pipeline that works for new categories by separating:

1. raw collection
2. fact normalization
3. category resolution
4. schema binding
5. attribute derivation
6. diagnostics

## Current Problem

The current flow mixes several responsibilities:

- frontend collection returns mixed page fields, variant fields, seller fallback fields, and editor payload fields
- collector-box normalization converts those mixed fields directly into Ozon attributes
- category resolution and attribute filling depend on whatever the page happened to expose
- diagnostics run after the fact, but do not drive a structured repair path

This creates two recurring failures:

- new categories repeat the same missing-attribute problem
- performance work and quality work are tightly coupled because seller fallback is used as part of the main collection path

## Target Pipeline

### 1. Raw Collect

Store multi-source raw data without deciding final business values.

Expected raw sources:

- frontend product detail raw
- frontend rich description raw
- frontend variant raw
- seller fallback raw
- collector edit payload raw

### 2. Facts Normalize

Convert raw sources into a stable `CollectedProductFacts` model.

Facts are source-aware business facts, not Ozon submission attributes.

Planned top-level sections:

- `base`
- `media`
- `logistics`
- `categoryHints`
- `attributes`
- `variants`
- `sourceCoverage`

### 3. Category Resolve

Resolve the most likely Ozon category from facts and explicit inputs.

Priority order:

1. explicit request category
2. direct seller/base category ids
3. cached category mapping
4. structured category hints
5. title/category text fallback
6. unresolved/manual-needed

### 4. Schema Bind

Load Ozon category schema using resolved `description_category_id` and `type_id`.

This layer owns:

- required attributes
- dictionary attributes
- free-text attributes
- collection attributes
- variant-related attributes

### 5. Attribute Derive

Map facts into the current category schema.

This layer must:

- prefer structured facts over weak text guesses
- preserve source and confidence
- resolve dictionary ids where possible
- mark unresolved required attributes without hiding the gap

### 6. Diagnostics

Diagnostics must classify gaps by repair type instead of only listing missing fields.

Gap types:

- `category_unresolved`
- `missing_source_data`
- `dictionary_unresolved`
- `attribute_outside_category`
- `source_conflict`

## Phase 1 Scope

Phase 1 adds a reusable facts layer to the current collector-box normalization path without changing protected listing workflows.

Phase 1 changes:

- introduce `listing-collected-facts.js`
- compute normalized facts inside `normalizeCollectedListingDraft`
- expose facts in normalization output and source raw diagnostics
- keep existing category resolution and attribute merge logic intact

Phase 1 explicitly does not:

- replace seller fallback transport flow
- redesign publish payload generation
- add category-specific heuristics for every attribute family
- change protected listing automation workflow behavior

## Phase 1 Runtime Contract

`normalizeCollectedListingDraft(...)` should produce:

- `facts`: normalized fact model
- `diagnostics.facts`: summary of fact-source coverage
- `draft.editablePayload.source_raw.collected_facts`
- `templatePayload.source_raw.collected_facts`

This gives later phases a stable insertion point for:

- asynchronous seller enrichment
- fact-to-schema derivation
- diagnostics-driven repair

## Planned Next Phases

### Phase 2

- move category resolution to consume facts first
- decouple seller fallback from blocking collector save path

### Phase 3

- build a dedicated fact-to-schema attribute derivation layer
- add source/confidence-aware required-attribute repair

### Phase 4

- background enrichment and diagnostics retry
- category-family rule packs only where facts are insufficient
