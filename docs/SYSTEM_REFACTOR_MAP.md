# ERP System Refactor Map

## 1. Current Runtime Structure

### Runtime Layers

- Current admin shell: `public/admin.html`
- Current admin source: `frontend/admin/*`
- Current frontend build output: `public/vue-apps/*`
- Shared backend: `src/server.js` + `src/services.js` + `src/services/*`
- Data layer: MySQL runtime configured through `.env` and `src/config.js`

### Main Entry Points

- `/` opens the current Vue 3 + Element Plus admin
- `/index.html` resolves to the same admin shell
- Historical old routes are no longer part of the active admin runtime

## 2. Boundaries

### Stable Areas

- MySQL schema and runtime contracts
- Backend API contracts
- Session and access control
- Deployment and remote access workflow

### Vue-Owned Areas

- Layout
- Navigation
- Forms
- Tables
- Dialogs
- Pagination
- Page-level state

### What Must Not Happen

- Reintroducing old static workbench pages into the new shell
- Two active page implementations for the same business view
- New iframe mounts for old business pages
- New root entries outside the current admin shell

## 3. Migration Rules

- New business pages are implemented as Vue SFC views
- Shared interactions go through current frontend API utilities and shared components
- If an old page has a current Vue owner, the old page should not continue rendering in the new system
- Cleanup includes both route exposure and static asset exposure

## 4. Current Page Ownership

1. Dashboard: `frontend/admin/views/DashboardView.vue`
2. Profit: `frontend/admin/views/profit/*`
3. Exceptions: `frontend/admin/views/exceptions/*`
4. Orders: `frontend/admin/views/orders/*`
5. Inventory: `frontend/admin/views/inventory/*`
6. Procurement: `frontend/admin/views/procurement/*`
7. Settings: `frontend/admin/views/settings/*`

## 5. Cleanup Status

- [x] Root entry switched to `admin.html`
- [x] Legacy iframe page removed from admin runtime
- [x] Old public shell files removed from active runtime
- [x] Navigation switched to current pages only
- [x] Procurement main page simplified to request-only workflow
- [x] Compatibility-only legacy redirect routes removed from the active admin router

## 6. Practical Next Steps

- Keep all new business work inside `frontend/admin`
- Continue aligning search bars, tables, and pagers across modules
- Keep the runtime focused on current Vue admin routes only
- Keep SQLite migration history out of current runtime-facing docs
