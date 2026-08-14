
# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Protected Ports and Local Verification

**Use `8788` for Codex local work and ECS for production.**

- Codex may use `8788` for local editing, debugging, temporary deployment, service restart, and verification. This is the dedicated local testing environment.
- Ports `8787` and `8087` and their former environments have been permanently removed. Do not use, deploy to, probe, restart, or describe them as available environments.
- The Ubuntu ECS environment is the production deployment target. Use the checked-in ECS deployment workflow when the user authorizes an ECS deployment.
- When reporting a local verification URL, prefer the dedicated test URL format: `http://localhost:8788/admin.html#/[route]`.

## 5.0 Plugin Versioning

**Browser plugin code changes must be reflected in `manifest.json`.**

- When changing collector/plugin source files or packaged-plugin contents, bump the corresponding `manifest.json` version before completion.
- For the Baodan/Ozon collector plugin, keep `../ozon-erp-collector-plugin/manifest.json` and `ozon-erp-collector-plugin/manifest.json` at the same version when both copies exist.
- After bumping a plugin version, state the expected package name in the final response, such as `ozon-baodan-erp-plugin-1.4.5.rar`.
- A plugin release is complete only after ECS contains the versioned package, update-status metadata names that same version/package, and the production download URL is successfully tested.
- For every ECS deployment containing plugin changes, inspect the downloaded production archive and verify its `manifest.json` version exactly matches both source manifests. Any mismatch blocks completion.

## 5.1 User-Facing Time Display

**Show operators Beijing time consistently.**

- User-facing pages, tables, filters, exports, and operational copy must display date/time values in Beijing time (`Asia/Shanghai`) with one consistent readable format.
- Frontend display code should use the shared Beijing-time formatter instead of slicing ISO strings or showing raw `T`/`Z` timestamps.
- Backend storage and API internals may keep UTC/standard timestamps where appropriate, but user-facing filtering semantics should match Beijing-calendar days unless a feature explicitly documents another timezone.

## 5.2 Blocking Validation Messages

**When a workflow is blocked by missing fields, say exactly what is missing and where to fix it.**

- Blocking errors must not only show raw database/API field names.
- Include the business field name, relevant database/API field names, why the workflow is blocked, and the operator's next step.
- For Ozon publish/category blockers, explicitly say whether the missing field belongs to the product/selection, shop, draft, variant, media, price, package, or attribute layer.
- Example: if `ozon_description_category_id`, `ozon_type_id`, or `ozon_category_id` is missing, say it is the product's Ozon category/classification field, not a shop field, and that Ozon required attributes cannot be validated until it is filled.

## 6. Product Image Display

**Images must be inspectable, consistent, and previewable.**

- Product/listing images in data tables should use a consistent portrait thumbnail, normally around `64x84px` for product rows. Do not shrink product images to icon size when the user needs to compare products visually.
- Table rows that contain product images should have enough height for the thumbnail to be useful, normally `84-92px` row height.
- Use `object-fit: cover`/Element Plus `fit="cover"` for thumbnails and keep a stable aspect ratio so rows do not jump while images load.
- Use the existing `el-image` preview pattern with `preview-src-list`, `initial-index`, and `preview-teleported` for clickable product images unless a page has a stronger established local pattern.
- Empty image states should keep the same thumbnail box size and show a short neutral label such as `无图`.
- Compact thumbnails are acceptable only in dense side lists, rankings, task cards, or secondary panels where the image is not the main inspection target.

## 6.1 Listing Draft Media Authority

**Current draft images must win over historical collected-product images.**

- Treat `template_payload.editable_payload.variants[0].images` as authoritative when the first variant owns its image set.
- A variant owns its image set when it has images or carries `images_manually_edited` / `image_edit_intent = "manual"`. An explicitly emptied manual image set must not fall back to historical images.
- Otherwise use draft editable images, then draft template images, and only then `source_images_json` as a legacy fallback.
- Consumers must use the backend `effective_images` result instead of independently merging draft, template, and collector image fields.
- Image normalizers must accept both URL strings and media objects. Backend `effective_images` is a URL-string array; converting it as object-only data silently produces empty image rows.
- AI fission drafts may replace the first image with the generated target main image, but their remaining detail images must be revalidated against the source draft's current effective image set on the backend.
- Historical collector payloads under `source_raw` are provenance only. They must never overwrite or be appended behind a current draft-owned image set.

## 7. Listing Automation Protected Workflow

**The product listing page is a protected operational workflow, not a disposable UI surface.**

- The route `/listing-automation` and `frontend/admin/views/listing/ListingAutomationView.vue` must preserve core operator workflows unless the user explicitly asks to change that workflow.
- SKU image editing must keep image upload, manual URL entry, template-image reuse, image preview, selected-image deletion, and drag-and-drop sorting.
- Drag-and-drop sorting in the selected SKU image area is a protected behavior. If this area is changed, keep `draggable`, `dragstart`, `dragover`, `drop`, and order persistence behavior covered by tests.
- Publish payloads must include only selected dictionary values. Do not send the full option candidate list, raw Ozon attribute JSON, or unknown dictionary placeholders as selected values.
- Routed entry points from drafts, publish records, online products, or collector data must not restore stale local listing drafts.
- When `/listing-automation` is opened with an explicit route context such as `draftId`, `recordId`, `recordDraft`, or `templateId`, that route context must take priority over any saved local workbench draft. Do not let local cached draft state replace the active route target, or saves may create duplicate drafts and roll edited images back to older cached state.
- Batch draft editing must map exactly one selected draft to one editor variant row. Keep the original draft ID and template ID as non-editable row metadata, reject mixed `description_category_id + type_id` categories, and save all rows through one transactional batch update. Never collapse the rows into one draft or write every row back to the first draft.
- In batch draft editing, each row keeps its own authoritative effective image set. Common-field synchronization may change values intentionally, but loading or saving must not replace row images with the first draft, template defaults, or collected-product history.
- Ozon dictionary attributes and variant attributes must show human-readable labels where available; raw dictionary IDs should not be shown as normal operator-facing values.
- Keep Ozon optional attributes paged in small batches, and keep variant dictionary editing lazy through a focused editor/drawer instead of rendering every option in every table cell.
- Heavy listing overlays such as attribute details, variant attribute editors, import drawers, API debug drawers, publish validation, and publish result drawers should mount lazily with `v-if`.
- Before changing listing image, variant, Ozon attribute, draft restore, publish payload, or route bootstrap behavior, inspect the relevant tests in `test/listing-template-health-check.test.js`, `test/listing-record-editor-view.test.js`, and `test/listing-draft-create-ai-payload.test.js`.
- After changing the listing automation page or its directly related listing services, run the focused listing tests before completion.

## 8. System-Level Text Encoding Requirement

**This is a required project rule for every code change: all text files must remain UTF-8, and new mojibake is a blocking defect.**

- Source code, docs, config, SQL, HTML, Vue, JS, CSS, JSON, shell scripts, and startup scripts must be saved as UTF-8.
- Do not save files as GBK, ANSI, or mixed encodings. Do not paste already-corrupted text matching common mojibake markers such as U+952F, U+FFFD, U+9416, U+920B, U+93C3, or the sequence U+6D60 followed by `?`.
- Keep `.editorconfig`, `.gitattributes`, `.vscode/settings.json`, and `scripts/check-text-encoding.mjs` in place as mandatory project safeguards.
- Any task that edits Chinese copy, Windows `.bat`/`.ps1` scripts, generated user-facing text, or packaging metadata must run `npm run check:encoding` before completion.
- If terminal output looks garbled, verify the file content with Node/editor UTF-8 reading before editing. Display garbling is not proof that the file is corrupt.
- Windows entry scripts should set UTF-8 where practical, such as `chcp 65001` for `.bat` and `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)` for PowerShell.
- If `npm run check:encoding` fails, fix the encoding issue before reporting the task as done.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
