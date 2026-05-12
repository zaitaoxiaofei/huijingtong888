# Procurement Module Maintenance

## Business Flow

1. Procurement requests are the team-facing entry point. Any active user can create, edit, or delete pending requests.
2. The purchase list shows only pending requests, grouped by product for fast buying.
3. Confirming purchase creates a purchase order, marks linked requests as purchased, and creates pending inbound records.
4. Purchased requests must not appear in the procurement request page. The durable record becomes the purchase order and inbound records.
5. Purchase history shows non-pending purchase orders and is used for later cost, inventory, and supplier review.

## Status Rules

- `procurement_requests.status = pending`: visible in procurement requests and purchase list.
- `procurement_requests.status = cancelled`: visible only when filtered; can be deleted.
- `procurement_requests.status = merged`: intermediate state after creating a purchase order before confirming purchase.
- `procurement_requests.status = purchased`: completed; hidden from procurement requests.
- `purchase_orders.status = pending_purchase`: editable purchase execution record.
- `purchase_orders.status = purchased`: historical purchased record and pending inbound source.
- `purchase_orders.status = partial_inbound` / `inbound_done`: historical purchase record.

## Coding Rules

- Do not hard-delete completed procurement history. Delete only pending or cancelled requests.
- Purchase confirmation must update both purchase order items and linked procurement requests in one transaction.
- UI pages should refresh the smallest needed data set where possible. Use full `loadAll()` only when shared state changes broadly.
- Keep request creation fast: no approval flow, no required supplier, and no blocking fields beyond product, quantity, and amount.
- The purchase order drawer must always close on explicit close and when switching pages.
