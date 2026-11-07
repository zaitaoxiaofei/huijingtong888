# Procurement Module Maintenance

## Business Flow

1. The procurement workspace is the primary daily purchasing entry point. The order page is a calibration and single-order shortcut; both entry points operate on the same demand and purchase facts.
2. `person_id` is the procurement owner. `created_by_person_id` records who created the request; these roles may differ.
3. One create action may contain multiple request items under one `request_group_no`.
4. Automatic demand may remain unbound while operators correct product mapping, but an actual purchase cannot be submitted until the item is bound to an inventory product. This is required to create a trustworthy in-transit and inbound record.
5. Binding suggestions use confirmed historical `raw_name -> product_id` relationships first, then inventory name/code similarity. Suggestions never silently create stock movements.
6. Any active user can create, edit, or delete pending requests.
7. The workspace has two demand sources: `real_order` for actual order shortages and `advance_stock` for forecast/low-stock purchasing. Real-order demand is the same demand shown by the order module.
8. Submitting purchase quantity and amount means the operator has already placed the supplier order. The synchronous confirmation creates a purchase order, records the purchaser and purchase time, allocates purchased quantity to order items, and creates pending inbound records before returning success.
9. Purchased requests must not appear in the procurement request page. The durable record becomes the purchase order and inbound records.
10. Purchase history shows non-pending purchase orders and is used for later cost, inventory, and supplier review.
11. Platform orders are imported into `procurement_platform_orders` and deduplicated by `platform + platform_order_no`.
12. `procurement_platform_order_links` is a many-to-many bridge: one combined-price platform order may allocate its amount across several procurement requests, and one procurement request may be fulfilled by several platform orders.
13. Pinduoduo collector timestamps are Beijing-local text. Normalize them to UTC before database storage, then use the shared Beijing-time formatter in operator-facing pages.
14. Importing a platform order never changes inventory. Inventory changes still require the normal binding and inbound workflow.
15. The reconciliation workspace imports native 1688 `.xlsx`, WeChat `.xlsx`, and Alipay GBK/UTF-8 `.csv` files without asking operators to clean headers or convert encodings.
16. Automatic payment matching requires equal amounts and prioritizes the matching platform counterparty plus the closest payment time. High-confidence matches may be confirmed automatically; ambiguous matches must remain `suggested` for review.
17. Manual matching remains available for unmatched or rejected rows. Never force a low-confidence payment onto a platform order merely to improve the match rate.
18. Applying actual costs is an explicit operator action. It writes confirmed allocated amounts into procurement requests and updates bound product purchase cost per allocated quantity.
19. The workspace daily purchase export selects a Beijing calendar day and includes all formal purchased order items for that day, regardless of workspace filters or pagination. Cancelled and unconfirmed orders are excluded; historical orders without `purchased_at` use order creation time.
20. The daily `.xlsx` embeds inventory thumbnails and includes quantities, goods amounts, freight, Beijing purchase times, purchaser, inbound status, order number, and a copyable WeChat summary. It counts each purchase item once, independent of inbound splits and request allocations; unavailable images are explicitly marked.

## Inventory Numbering

- A product keeps its inventory number when details inside the same inventory category change.
- Changing `inventory_category` assigns the next unused number from the target category. Numbers are never reused, and the product ID and SKU bindings remain unchanged.
- Numbering initialization repairs only products whose saved number category differs from their current `inventory_category`; it is safe to run repeatedly.

## Three Business Stages

- `待采购`: uncovered demand remains. No request row or status flag may hide a positive quantity shortage.
- `采购在途`: an operator submitted actual quantity and amount, a purchased purchase order exists, and a `pending_arrival` inbound record exists.
- `已入库`: the inbound record has been approved and inventory movement has been posted.

Internal table statuses may remain more granular for transaction safety, but every operator-facing page must project them to these three stages. `suggested`, `pending`, and an orphan `submitted` are all `待采购`; `merged` is transaction-internal only; `purchased` plus a real pending inbound fact is `采购在途`; completed inbound is `已入库`.

If actual purchased quantity is below selected demand, the fulfilled quantity moves to `采购在途` and the remainder stays `待采购`. If it exceeds real-order demand, the excess becomes `advance_stock` rather than being attached to an order.

## Procurement Priority and Supply Allocation

The workspace uses one supply waterfall for automatic order demand and inventory replenishment:

1. `P0 订单履约优先`: local stock and confirmed inbound supply cover active fulfillable orders. Explicit order allocations take precedence.
2. `P1 历史库存待核`: negative local stock is a reconciliation discrepancy, not new procurement demand. New order purchases never pay down this discrepancy automatically.
3. `P2 安全库存补货`: remaining supply is compared with the shared stable-sales coverage target, normally 21 days.

The operator-facing recommendation exposes all three shortage quantities. The total recommendation covers uncovered active-order demand and safety-stock shortage; historical inventory discrepancies are shown separately and excluded from the quantity to buy. `real_order` and `advance_stock` describe request provenance; they do not override this priority. A product may carry both sources and is grouped into one purchasing row.

Automatic refresh may cancel and recreate unconfirmed `suggested` real-order requests from current facts. It must never rewrite purchased history or confirmed inbound records.

## Internal Status Rules

- `procurement_requests.status = pending` / `suggested`: visible as waiting-to-purchase demand.
- `procurement_requests.status = submitted` without a purchase order is not a completed purchase and must remain/reconcile to waiting demand.
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
- Keep purchase recording fast: there is no approval flow. Actual purchase requires a bound inventory product, quantity, amount, and purchaser; supplier and channel remain optional metadata.
- The procurement workspace does not confirm inbound. Inbound confirmation belongs to the order module shortcut and the pending-inbound list.
- The purchase order drawer must always close on explicit close and when switching pages.


## Historical source reconciliation and inventory corrections

- Entry points: procurement workspace, pending purchase list, and inventory product actions → 采购与库存对账. Product search works even when the product has no open procurement task.
- `GET /api/procurement/ledger` returns the full product source/stock snapshot and its revision; `POST /api/procurement/ledger/preview` validates a proposed correction; `POST /api/procurement/ledger` applies it atomically with a client request key. Replaying the same request returns the saved result; a changed payload cannot reuse its key.
- Transported local orders keep historical missing-source quantities. Explicit purchases allocated to new orders never erase these quantities, including after their receipt. Unallocated receipts later than the historical transport cutoff are not automatically used as proof of old sources.
- Historical shortages distinguish missing purchase sources from recorded purchases whose receipt still needs confirmation. Actual local returns may supply a later shipment once; return/cancellation statuses alone do not add supply. FBP orders do not consume local supply.
- Historical purchase backfill creates a dated formal purchase and approved receipt tied to the selected order. The operator must distinguish a missing local inbound movement from an already-recorded/externally fulfilled source. Only the former adds local stock. Unknown amounts stay zero and remain visibly incomplete.
- Existing batch receipt/link operations cannot consume another order's allocation. Suggested historical matches require explicit source linking, rather than the older bulk receipt shortcut.
- A purchase correction adjusts pending batches, confirmed receipt quantities when explicitly requested, request allocations, header totals, and cost versions together. Current order allocations take priority over historical ones. Corrections may expose negative stock; they do not silently create replacement purchases. Original movement entries remain with corrective movements and an audit snapshot.
- Inventory conversion records both product movements in one transaction. Order substitution restores the nominal product's deduction and records consumption of the actual product; an explicit source link keeps the selected current order covered even with historical stock debt. Operators use physical child products for combinations.
- Damage/loss deduct local stock; stocktake records the actual local count and a required reason, including a documented pending investigation. Missing FBP transfers use the existing FBP transfer workflow.
- Stock transformations and stocktakes require `inventory.write` in addition to procurement access. Every action records the actor, reason, original snapshot, and resulting inventory changes. User-facing dates use Beijing time.
