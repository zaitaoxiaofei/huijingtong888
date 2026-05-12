# ozon ERP Docs Index

Use these documents as the active product and engineering reference.

Documentation policy:

- Actual behavior is defined by the current codebase.
- Documents explain the codebase and future direction, but do not override the code.
- When "current state" conflicts with old notes or plans, trust the running entry files, API handlers, and database schema in code.
- Planning documents must be treated as targets, not as proof of current implementation.

- `PROJECT_GUIDE.md`: current project handover guide, actual entry points, business model, API domains, deployment and maintenance notes.
- `DEVELOPMENT_TRACKER.md`: system-level roadmap, feature backlog, priorities, and progress tracking.
- `UI_DESIGN_SYSTEM.md`: UI Design System, component rules, sticky layout rules, and visual interaction standards.
- `ARCHITECTURE.md`: current local deployment and data model overview.
- `erp-blueprint.md`: long-term ERP product blueprint.
- `order-sync-strategy.md`: order synchronization strategy.
- `order-workbench-todo.md`: order workbench-specific tasks.
- `profit-page-v2-design.md`: profit dashboard planning.
- `data-backup-migration.md`: backup and migration notes.

Development rule:

Before starting a new feature, check `DEVELOPMENT_TRACKER.md`.
After completing or changing feature scope, update `DEVELOPMENT_TRACKER.md` in the same change.
