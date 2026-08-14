# Ozon cancellation and return reasons

Last updated: 2026-07-30

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

