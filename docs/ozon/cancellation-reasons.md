# Ozon cancellation and return reasons

Last updated: 2026-10-30

## Reviewed cancellation and cargo loss policy

The 2026-10-30 business review is registered separately as V3 (legacy currency
inputs) and V4 (V2 daily FX inputs). Frozen V1 and V2 financial results and their
implementations are not changed in place. New items use V3/V4; an existing item's
financial writer continues to honor its pinned version until an explicit repair.

`reviewed-aftersale-reasons.js` records the reviewed platform codes and exact raw
texts. Missing buyer passport/personal data, seller shipment timeout, incorrect
labels, shipment registration failure, seller/buyer-requested cancellation,
carrier requirements and stockout are cancellations, even if an old
`cancelled_after_ship` flag was set. Their estimated fulfilment loss is zero.
Verified acquiring charges remain traceable as actual financial expenses.

Codes 809 and 699 are cargo lost during delivery, not buyer rejection or return.
The cargo loss estimate includes product cost and acquiring fee once, excluding
commission, domestic/international freight, packaging and withdrawal fees.
Cargo loss has its own aftersale bucket and is excluded from return counts and
rates. Compensation remains pending review until there is evidence of payment;
eligibility for a claim is not income. Genuine rejection/return reasons retain
their existing rules. Platform statuses, original reasons, inventory and physical
return evidence are not rewritten by this classification repair.

### Explicit historical repair

`scripts/review-aftersale-policy.mjs --input=SNAPSHOT --output=MANIFEST` is an
offline, read-only preview. It reports each item's before/after amounts and a
manifest hash. Missing historical acquiring-fee inputs block a cargo-loss
monetary repair rather than silently assuming zero. Legacy actual amounts without
complete evidence become estimates pending finance, retaining their original
snapshots and locks in revision history.

Apply requires the exact reviewed manifest and hash, an active platform admin,
command ID and review reason. In one transaction it checks ownership and every
snapshot, archives existing amounts under the old formula, switches only reviewed
items to V3/V4, records both new layers and installs code-specific classification
rules. Retries reuse the command; stale input or any write failure rolls back the
transaction. Blocked items remain listed for follow-up. Existing enterprise-scoped
daily/detail analytics must be refreshed after applying the manifest. A production
apply/deployment follows the repository release approval and concurrency rules.

## Local handling rule

Ozon order sync stores the raw cancellation fields without translating or replacing them:

- `cancel_reason_id`
- `cancel_reason`
- `cancel_initiator`
- `cancel_type`
- `cancelled_after_ship`

Operator-facing pages derive a Chinese display label from the reason code and Russian/English reason text. Unknown reasons must retain the original source text and display it as an unclassified reason. A display translation must never overwrite the raw Ozon reason.

## Profit rule

Cancellation translation and profit classification share the same normalized reason input.

- Pre-fulfillment cancellation: estimated loss is zero. If Ozon later reports a real acquiring or other fee, the real finance fee is used.
- Rejected or unclaimed: estimated loss uses product cost, international freight, and collecting fee.
- Unsuitable, wrong item, or damaged: estimated loss uses product cost, domestic freight, international freight, and collecting fee.
- Quality issue: estimated loss additionally includes commission.
- Final finance accrual: real Ozon finance components replace the estimate and the order item becomes `accrued`.

Each cost component must be deducted once. A reason-driven aggregate return-loss estimate must not be deducted again after its purchase, freight, commission, or collecting components have already been written.

## Translation fallback

Known historical Russian and English reasons are translated through the checked-in dictionary in `src/services/order-cancellation-display.js`.

For an unknown reason:

1. Keep the original Ozon text.
2. Display `未收录原因：<original text>`.
3. Add a reviewed dictionary entry when the business meaning is confirmed.

AI translation may be added as a persisted review workflow, but list rendering must not call AI repeatedly or silently use an unreviewed translation to choose a loss formula.

## Manual classification review

The platform-only cancellation-rule page groups unknown original reasons seen within a Beijing-calendar date range (90 days by default, at most 366 days). It returns at most the latest 1000 reason groups and marks a truncated result so the reviewer can narrow the range. Ordinary enterprise owners and employees cannot access this cross-enterprise review aggregate.

A reviewer selects an existing canonical reason type and saves an exact text classification in `order_cancellation_rules`. The raw Ozon reason, reason ID, order status and all order-profit records remain unchanged. Repeating the same review reuses its rule; a conflicting classification must be edited explicitly in the existing rule list. The page lists both pending and classified reasons. The rule test and review use the same raw-field matcher.

This workflow records shared classification evidence only. It does not run historical profit recalculation, replace a frozen V1 formula, or silently reclassify existing order-profit outcomes. Applying new classifications to future financial formulas is a separate versioned policy decision.

