# Admin Shell Baseline

## Goal

Define the shared admin shell baseline so the ERP keeps one compact, consistent frame across pages.

## Header

- Prioritize the current page title over long breadcrumb chains.
- Treat breadcrumbs as supporting context, not the main focus.
- When the breadcrumb path is deep, prefer showing the first level and the current page only.
- Keep the global header around `48px` high.
- Keep the top-right utilities concise and reserve them for high-frequency actions.

## Workspace Tabs

- Tabs should feel like a lightweight working strip, not large page cards.
- Recommended tab height is `26px` to `28px`.
- Prefer restrained active states with a thin accent and low-noise background.
- Long tab labels should truncate early to protect the overall rhythm of the shell.

## Content Frame

- Reduce the visual separation between header, tabs, and content so the shell reads as one workspace.
- Use lighter shadows, smaller radii, and tighter top spacing than dashboard-style marketing layouts.
- Avoid stacking multiple thick horizontal bands at the top of the page.

## Sidebar

- Expanded sidebar width should stay near `180px`.
- Collapsed sidebar width should stay near `52px`.
- First-level menu items should target about `40px` height.
- Second-level menu items should target about `36px` height.
- Active states should use subtle emphasis such as a slim accent bar, soft background, and restrained border treatment.
- Keep second-level indentation controlled so hierarchy is clear without making the layout feel loose.

## Density

- Default toward lower visual noise: less empty height, softer card treatment, and tighter spacing.
- Prefer stable ERP density over decorative layering.
- If both title, breadcrumb, tabs, and page toolbars exist, actively reduce duplication instead of letting all of them compete equally.

## Acceptance

- The shell should feel compact before any page-specific optimization begins.
- Header, sidebar, and tabs should look like one system rather than separate visual styles.
- New pages added to the admin should follow this baseline before custom styling is introduced.
