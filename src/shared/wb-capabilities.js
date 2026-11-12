// First acceptance stage: connect a real shop and inspect source data. Enable
// remote writes only after its permissions and fulfillment contract are verified.
export const WB_REMOTE_WRITES_ENABLED = false;
export const WB_REMOTE_WRITE_ACTIONS = new Set(['bindProduct','publish','uploadMedia','setPrice','setStocks','prepare','stickers','supplyAction','enrollPromotion']);
