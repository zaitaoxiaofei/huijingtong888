# ERP UI Design Guidelines

This document is the long-term UI rulebook for this ERP. Every new page, page optimization, dialog, drawer, and embedded table should follow these rules unless there is a specific business reason not to.

References:

- Ant Design table pattern: https://012x.ant.design/docs/pattern/table
- SAP Fiori table toolbar: https://experience.sap.com/fiori-design-web/tables-toolbar/
- SAP Fiori filter bar: https://experience.sap.com/fiori-design-web/v1-72/filter-bar/

Core rules:

- Data pages are work surfaces. Keep them dense, stable, and operational. Avoid marketing-style cards, oversized headings, and large empty spacing.
- Standard page structure is: title or tab bar, toolbar/filter bar, table body, pagination.
- Actions that affect the whole table belong in the toolbar/filter bar on the right side. Row actions belong inside the row.
- Main page scrolling should be avoided for data workbenches. The page shell stays fixed; the table body scrolls inside its own container.
- Every table header must be fixed. This applies to main pages, tabs, dialogs, drawers, nested selection lists, and any embedded table in a form.
- Every pagination bar must be fixed at the bottom of its table region. Table content scrolls between the fixed header and fixed pagination.
- A component with a header/table/pagination must use a three-part layout: fixed top, scrollable middle, fixed bottom.
- Empty states must keep the work area height stable. Only the data body is empty; the page must not collapse.
- Filter bars and summary bars must be compact. Use horizontal metrics with label plus value, not large cards.
- Table density should prioritize operating speed: 12-13px text, stable row height, 40-56px thumbnails, 28-34px buttons.
- Pagination is unified: total records, page size, current page/total pages, numeric page buttons, first/last, previous/next, and five-page jump.
- Dialog width should serve the task. Selection dialogs need a wide list area and a narrower detail/form area.
- Same logic must look and behave the same across procurement, orders, stock, profit, config, and future modules.

Before changing any page, check:

1. What is the highest-frequency action on this page, and is it in the easiest place to reach?
2. When the user scrolls, do the toolbar, table header, and pagination stay visible?
3. Is scrolling happening inside the data region instead of the whole page?
4. Is the summary/filter area compact enough for repeated daily use?
5. Does the empty state preserve the page height and structure?
6. Are batch actions and row actions clearly separated?
7. Does this page use the same table and pagination behavior as the rest of the ERP?
