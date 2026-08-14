# Ozon API Notes

This directory records Ozon seller API behavior that affects local sync logic.

- [product-status.md](./product-status.md): product list visibility, archived products, and pending-listing reconciliation.
- [order-postings.md](./order-postings.md): FBS order list date-window and pagination constraints.
- [cancellation-reasons.md](./cancellation-reasons.md): cancellation/return reason translation, fallback display, and profit-loss classification.
- [customer-message-automation-design.md](./customer-message-automation-design.md): unified Ozon Push webhook, shop matching, delayed customer messages, send records, and safety gates.

## Stock endpoints

- Use `/v4/product/info/stocks` for current product stock and `/v1/analytics/turnover/stocks` for turnover analytics.
- Do not call the retired `/v1/analytics/manage/stocks` endpoint during scheduled stock sync. A failed probe adds latency and error noise without providing usable data.
