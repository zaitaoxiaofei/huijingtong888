# Procurement Module Maintenance

## Business Flow

1. The procurement workspace is the team-facing entry point. A procurement request may be created before an inventory product exists, using `raw_name` and `raw_spec` as the immutable purchasing description.
2. `person_id` is the procurement owner. `created_by_person_id` records who created the request; these roles may differ.
3. One create action may contain multiple request items under one `request_group_no`.
4. Inventory binding is progressive: unbound requests stay visible with `binding_status = unbound`, and binding a product later changes the status to `bound` without overwriting the original purchase name.
5. Binding suggestions use confirmed historical `raw_name -> product_id` relationships first, then inventory name/code similarity. Suggestions never silently create stock movements.
6. Any active user can create, edit, or delete pending requests.
7. The purchase list shows only inventory-bound pending requests, grouped by product for fast buying and inbound processing.
8. Confirming purchase creates a purchase order, marks linked requests as purchased, and creates pending inbound records.
9. Purchased requests must not appear in the procurement request page. The durable record becomes the purchase order and inbound records.
10. Purchase history shows non-pending purchase orders and is used for later cost, inventory, and supplier review.
11. Platform orders are imported into `procurement_platform_orders` and deduplicated by `platform + platform_order_no`.
12. `procurement_platform_order_links` is a many-to-many bridge: one combined-price platform order may allocate its amount across several procurement requests, and one procurement request may be fulfilled by several platform orders.
13. Pinduoduo collector timestamps are Beijing-local text. Normalize them to UTC before database storage, then use the shared Beijing-time formatter in operator-facing pages.
14. Importing a platform order never changes inventory. Inventory changes still require the normal binding and inbound workflow.

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
- Keep request creation fast: no approval flow, no required supplier or inventory binding, and no blocking fields beyond free-form purchase name, quantity, amount, and owner.
- The purchase order drawer must always close on explicit close and when switching pages.
