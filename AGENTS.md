
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

## 5. Local Server Port

**Use the existing app port. Do not start random preview ports.**

- The Ozon ERP app runs on port `8787`.
- All local verification must use the unified `8787` entrypoint, especially `http://localhost:8787/admin.html#/...` for the admin app.
- Local code and the official website deployment may be updated at different times, but the local verification port must not change. This prevents checking an old page after code changes.
- After frontend or backend updates, rebuild and restart the current project on `8787`.
- Do not start separate Vite/dev preview ports such as `5173`, `5174`, or ad-hoc ports such as `8790` unless the user explicitly asks for a temporary isolated server.
- If `8787` is already running, stop the process that owns `8787`, then start the current project there again so the browser URL stays the same.
- When reporting a local verification URL, prefer the canonical admin URL format: `http://localhost:8787/admin.html#/[route]`.

## 6. Product Image Display

**Images must be inspectable, consistent, and previewable.**

- Product/listing images in data tables should use a consistent portrait thumbnail, normally around `64x84px` for product rows. Do not shrink product images to icon size when the user needs to compare products visually.
- Table rows that contain product images should have enough height for the thumbnail to be useful, normally `84-92px` row height.
- Use `object-fit: cover`/Element Plus `fit="cover"` for thumbnails and keep a stable aspect ratio so rows do not jump while images load.
- Use the existing `el-image` preview pattern with `preview-src-list`, `initial-index`, and `preview-teleported` for clickable product images unless a page has a stronger established local pattern.
- Empty image states should keep the same thumbnail box size and show a short neutral label such as `无图`.
- Compact thumbnails are acceptable only in dense side lists, rankings, task cards, or secondary panels where the image is not the main inspection target.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
