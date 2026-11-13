// First acceptance stage: connect a real shop and inspect source data. Enable
// remote writes only after its permissions and fulfillment contract are verified.
export const WB_REMOTE_WRITES_ENABLED = false;
export const WB_REMOTE_WRITE_ACTIONS = new Set(['bindProduct','publish','uploadMedia','setPrice','setStocks','prepare','stickers','supplyAction','enrollPromotion']);

// Only the reviewed, durable new-product publishing flow is enabled.
// Standalone price, stock, existing-card edits and fulfillment stay gated above.
export const WB_LISTING_PUBLISH_ENABLED = true;
