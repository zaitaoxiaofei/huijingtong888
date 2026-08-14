# Frontend/Backend Boundary Risk Register

This document tracks places where frontend UI, runtime assets, backend APIs, or generated artifacts are still coupled tightly enough to make small changes risky.

## Active High-Risk Area

### AI workbench runtime proxy

Files:

- `frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue`
- `public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js`
- `public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-wGTlZd1f-20260611213517.css`
- `src/http/aiWorkbenchProxyAssets.js`
- `src/http/static.js`

Risk:

- The route loads a runtime JS/CSS asset through `ai-workbench-proxy` instead of a normal source-owned Vue component.
- Runtime proxy assets are built artifacts and should not be hand-edited during normal feature work.
- API fixes can accidentally affect UI if wrapper styles or runtime asset paths are changed together.

Current guardrails:

- `scripts/check-frontend-safety.mjs` warns when the wrapper still uses runtime proxy assets.
- The AI workbench wrapper is blocked from adding DOM patching such as `MutationObserver` or `innerHTML`.
- AI workbench styling is now source-owned in `frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue`; the wrapper no longer injects a runtime proxy CSS link.
- Legacy scripts that write runtime proxy assets require `ALLOW_RUNTIME_PROXY_PATCH=1`.
- `/vue-apps/assets` fallback to `ai-workbench-proxy` is restricted to an exact allowlist of the pinned AI workbench runtime chunk and its runtime dependency files. Direct `/ai-workbench-proxy/assets/*.js|css` responses are restricted to the same allowlist. Do not broaden this back to the whole proxy asset directory.
- The allowlist lives in `src/http/aiWorkbenchProxyAssets.js`; `src/http/static.js` should keep static-serving rules separate from the runtime asset inventory.
- Static handling normalizes incoming paths and strips query/hash fragments, so `_erp_chunk_reload` recovery URLs still serve `admin.html` instead of a static 404 page.
- Direct `/ai-workbench-proxy/assets/*.js|css` responses use `Cache-Control: no-store, must-revalidate` to avoid stale runtime UI after local deployment or hard refresh.
- Static asset root checks use a path-relative boundary helper instead of raw string prefix checks, with regression coverage for sibling directories such as `public-evil`.
- Frontend builds run `check-frontend-safety` automatically through `npm run build:frontend`.

Migration target:

- Move AI workbench behavior into source-owned Vue components and normal CSS files.
- Keep backend AI generation/provider logic under `src/server` and expose stable JSON contracts.
- Keep UI fields such as main image, detail images, title, tags, description, rich text, video, status, and actions explicit in frontend state.
- Remove the `ai-workbench-proxy` fallback only after the route no longer depends on runtime proxy assets.

## Workflow Rule

For future work:

- Backend/API fixes should not touch UI files or generated frontend assets unless the task explicitly requires it.
- UI changes should not alter backend contracts or AI provider routing unless explicitly scoped.
- If a complex page must be touched, run the relevant safety checks and visually verify the page on local `8788`.
- Local startup scripts default to `8788` and refuse protected ERP ports `8787`/`8087` unless `ALLOW_PROTECTED_PORT_OPERATION=1` is explicitly set for a reviewed manual operation.
