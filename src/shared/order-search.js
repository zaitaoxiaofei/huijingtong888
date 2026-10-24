// Only a complete posting number opts into exact lookup. Partial numbers,
// product names and legacy clients keep the existing contains semantics.
export function orderSearchMatchForInput(type, value) {
  return String(type || "order") === "order"
    && /^\d{8,16}-\d{4,8}-\d{1,4}$/.test(String(value || "").trim())
    ? "exact" : "contains";
}
