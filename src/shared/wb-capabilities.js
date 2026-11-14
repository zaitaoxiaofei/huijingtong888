// First acceptance stage: connect a real shop and inspect source data. Enable
// remote writes only after its permissions and fulfillment contract are verified.
export const WB_REMOTE_WRITES_ENABLED = false;
export const WB_REMOTE_WRITE_ACTIONS = new Set(['publish','uploadMedia','setPrice','setStocks','prepare','stickers','supplyAction','enrollPromotion']);

// Reviewed, durable publishing and existing-product operations are enabled.
// Standalone low-level writes and fulfillment stay gated above.
// Manual stock batches use their own reviewed route, shop/warehouse/SKU checks and readback.
export const WB_LISTING_PUBLISH_ENABLED = true;
