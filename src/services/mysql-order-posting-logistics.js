import { mergeOrderPostingLogistics } from "./order-posting-logistics-merge.js";

function serializedPosting(serialize, posting) {
  const value = serialize(posting);
  if (typeof value !== "string" || !value) throw new Error("Order posting serializer returned no JSON");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Order posting serializer must return a JSON object");
  return value;
}

// API calls happen before entering this function. Only SQL and the pure merge
// run under this short transaction; no inventory/profit/history work is invoked.
export async function saveOrderPostingLogistics({ transaction, shopId, posting, serialize, supplement = null }) {
  const storeId = Number(shopId);
  const postingNumber = String(posting?.posting_number || "").trim();
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || !postingNumber || postingNumber.length > 128) {
    throw new Error("Order logistics requires a shop ID and posting number");
  }
  if (typeof transaction !== "function" || typeof serialize !== "function") throw new Error("Order logistics requires a transaction and serializer");
  if (supplement && String(supplement.posting_number || "").trim() !== postingNumber) {
    throw new Error("Logistics supplement belongs to a different posting");
  }
  const incomingJson = serializedPosting(serialize, posting);
  return transaction(async (connection) => {
    // A no-op duplicate-key update acquires X immediately. INSERT IGNORE would
    // take S locks and risk a concurrent S -> X upgrade deadlock below.
    await connection.execute(`INSERT INTO ozon_orders_raw
      (store_id, posting_number, order_id, status, substatus, raw_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE store_id = VALUES(store_id)`, [
      storeId, postingNumber, posting.order_id || posting.order_number || "",
      posting.status || "", posting.substatus || posting.logistics_status || "", incomingJson
    ]);
    const [rows] = await connection.query(`SELECT raw_json FROM ozon_orders_raw
      WHERE store_id = ? AND posting_number = ? FOR UPDATE`, [storeId, postingNumber]);
    if (!rows[0]) throw new Error("Order logistics row disappeared while locked");
    // Invalid stored JSON must fail the transaction, not silently erase evidence.
    const previous = JSON.parse(rows[0].raw_json);
    // A get request can finish after another worker updated this raw row. A
    // supplement fills only the CURRENT locked row; the pre-get list snapshot
    // must never become the incoming business/status/provider authority again.
    const merged = supplement
      ? mergeOrderPostingLogistics(supplement, previous)
      : mergeOrderPostingLogistics(previous, posting);
    if (String(merged?.posting_number || "").trim() !== postingNumber) throw new Error("Merged logistics belongs to a different posting");
    await connection.execute(`UPDATE ozon_orders_raw SET order_id = ?, status = ?, substatus = ?,
      raw_json = ?, fetched_at = CURRENT_TIMESTAMP WHERE store_id = ? AND posting_number = ?`, [
      merged.order_id || merged.order_number || "", merged.status || "",
      merged.substatus || merged.logistics_status || "", serializedPosting(serialize, merged), storeId, postingNumber
    ]);
    return merged;
  });
}
