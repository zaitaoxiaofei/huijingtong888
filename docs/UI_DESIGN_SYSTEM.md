# ozon ERP UI Design System

Product and engineering progress is tracked in `docs/DEVELOPMENT_TRACKER.md`. UI rules in this document are mandatory for every item in that tracker.

## 1. Current Frontend Stack

- App type: server-rendered static frontend with vanilla JavaScript.
- Main files:
  - `public/index.html`: page structure, dialogs, top-level views, navigation.
  - `public/ui.js`: vanilla reusable UI render helpers.
  - `public/app.js`: rendering, state, API calls, table/dialog interactions.
  - `public/styles.css`: legacy global styles and page-specific styles.
  - `public/design-system.css`: canonical UI tokens and shared component styles.
- No React, no Tailwind, no component build pipeline. Reusable UI must be CSS classes plus small vanilla JS render helpers.

## 2. Current UI Inconsistencies

- Buttons: multiple ad hoc variants exist (`primary`, `danger`, `danger-primary`, `linklike`, `small`) with inconsistent height, radius, color, and loading behavior.
- Forms: inputs, selects, textareas, filters, and dialog forms use mixed heights and spacing.
- Layout: some pages scroll the whole page, some scroll table areas; top toolbars and table headers are not uniformly sticky.
- Tables: table density, header background, sticky headers, cell padding, and wrap behavior vary by page.
- Modals: dialogs share some structure but widths, body scroll, header behavior, and internal table behavior are inconsistent.
- Colors: legacy random colors exist across pages, especially purple/blue accents, warning shades, and status labels.
- Radius/shadows: cards and popups use inconsistent 4/6/8/10/12px radius and several unrelated shadows.
- Typography: most text is 13px, but page-specific overrides and `!important` usage make hierarchy unclear.

## 3. Design Principles

- ERP first: dense but readable, optimized for scanning and repeated operations.
- Calm visual system: neutral surfaces, restrained blue primary action, semantic green/amber/red status.
- No page-specific invention: new pages must reuse tokens and shared component classes.
- Sticky by default: page toolbars, table headers, modal headers, and modal table headers should remain visible.
- Data over decoration: no decorative gradients, large hero layouts, or unnecessary cards.

## 4. Tokens

Use CSS variables from `public/design-system.css`.

### Colors

- Background: `--ds-bg`
- Surface: `--ds-surface`, `--ds-surface-muted`
- Text: `--ds-text`, `--ds-text-muted`, `--ds-text-subtle`
- Border: `--ds-border`, `--ds-border-strong`
- Primary: `--ds-primary`, `--ds-primary-hover`, `--ds-primary-soft`
- Success: `--ds-success`, `--ds-success-soft`
- Warning: `--ds-warning`, `--ds-warning-soft`
- Danger: `--ds-danger`, `--ds-danger-soft`

### Typography

- Page title: `--ds-font-title`
- Section title: `--ds-font-section`
- Body/table: `--ds-font-body`
- Helper/meta: `--ds-font-meta`
- Line height: `--ds-line-normal`

### Spacing

- Use `--ds-space-1` through `--ds-space-8`.
- Common page gaps: `--ds-space-4`.
- Table cell padding: `--ds-table-cell-y`, `--ds-table-cell-x`.

### Radius

- Small controls: `--ds-radius-sm`
- Buttons/inputs/cards: `--ds-radius-md`
- Modals: `--ds-radius-lg`

### Shadow

- Cards: `--ds-shadow-card`
- Popovers/modals: `--ds-shadow-popover`, `--ds-shadow-modal`

## 5. Component Classes

Use these classes for new UI. Existing legacy classes are mapped where practical.

- Button: `.ds-btn`, `.ds-btn-primary`, `.ds-btn-secondary`, `.ds-btn-danger`, `.ds-btn-ghost`, `.ds-btn-small`
- Inputs: `.ds-input`, `.ds-select`, `.ds-textarea`
- Card: `.ds-card`
- Page: `.ds-page`, `.ds-page-header`, `.ds-toolbar`, `.ds-filter-bar`
- Table: `.ds-table-wrap`, `.ds-table`
- Modal: `.ds-modal`, `.ds-modal-header`, `.ds-modal-body`
- Tabs: `.ds-tabs`, `.ds-tab`
- Badge: `.ds-badge`, `.ds-badge-success`, `.ds-badge-warning`, `.ds-badge-danger`, `.ds-badge-info`
- Empty state: `.ds-empty`

## 6. Vanilla UI Helpers

Use `window.OzonUI` from `public/ui.js` for new rendering code:

- `OzonUI.button({ text, variant, size, attrs })`
- `OzonUI.input({ label, name, value, placeholder, type })`
- `OzonUI.select({ label, name, value, options })`
- `OzonUI.textarea({ label, name, value, placeholder })`
- `OzonUI.card({ title, actions, body })`
- `OzonUI.table({ columns, rows, empty })`
- `OzonUI.tabs({ tabs, active })`
- `OzonUI.badge(text, tone)`
- `OzonUI.emptyState(message, action)`
- `OzonUI.pageHeader({ title, subtitle, actions })`
- `OzonUI.modalShell({ id, title, body, actions })`

Do not create a new ad hoc renderer for these primitives in page code.

## 7. Sticky Rules

- Page header/toolbars: sticky top, white/muted surface, bottom border.
- Table header: sticky top inside its scroll container.
- Modal header: sticky top inside dialog.
- Modal table header: sticky below modal header if table is inside modal body.

## 8. Development Rules

- Do not write random colors, radii, or shadows in page code.
- Do not create new button/input/card/table/modal styles directly inside page sections.
- Use tokens first. If a new token is needed, add it to `design-system.css` and document it here.
- New UI should use DS classes. Existing pages can be migrated gradually without changing business logic.
- All tables must use a scroll container and sticky headers unless there is a specific reason not to.
- Dialogs must have fixed headers and scrollable bodies.
- Loading/disabled/focus/hover states must come from the shared classes.
- Exception/workbench pages must use mutually exclusive business tabs, not overlapping filters. Search, page size, and pagination stay at the same toolbar/table-control level as tabs.
- Warning and danger states must not paint entire rows with saturated red/orange. Keep row backgrounds neutral; use semantic color only on the specific badge, label, border, or value that explains the exception.
- Inventory-related actions in order tables belong inside the inventory column. The operation column is reserved for order operations such as stocking, printing, cancelling, and recalculating order profit.

## 9. Migration Plan

1. Establish tokens and shared CSS primitives. Done in `public/design-system.css`.
2. Map legacy base elements (`button`, `input`, `.panel`, `.table`, `.edit-dialog`) to DS behavior without changing markup.
3. Convert high-traffic pages first: orders, stock/FBP, procurement, profit.
4. Extract repeated JS render snippets into reusable vanilla helpers where safe.
5. Keep business logic and API calls unchanged during UI migration.

## 10. Codex Instruction

When asking Codex to build or change UI, use:

`按 ozon ERP Design System 处理这个页面。`

This means:

- Use `public/design-system.css` tokens.
- Use `window.OzonUI` helpers for new primitives.
- Keep sticky page headers/toolbars/table headers/modal headers.
- Do not invent random colors, radii, shadows, or page-only button styles.
- Do not change APIs or business logic unless explicitly requested.

