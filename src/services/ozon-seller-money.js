// Parse only the already selected seller-price owner. Never search customer
// prices or borrow a currency from another financial/product object.
const object = value => value && typeof value === "object" && !Array.isArray(value);
const currencyCode = value => typeof value === "string" ? value.trim().toUpperCase() : "";

function amount(value) {
  if (!["number", "string"].includes(typeof value)) return null;
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, "").replace(",", ".") : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const result = Number(text);
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : null;
}

export function resolveOzonSellerMoney(owner, sourcePath, priceKey = "price") {
  const source = typeof sourcePath === "string" && sourcePath.trim() ? `${sourcePath.trim().replace(/\.$/, "")}.${priceKey}` : "unknown";
  const unknown = parsed => ({ amount: parsed, verified: false, currency: "", source });
  if (!object(owner) || source === "unknown") return unknown(null);
  const selected = owner[priceKey];
  let parsed;
  if (object(selected)) {
    const values = ["price", "value", "amount"].filter(key => selected[key] !== undefined && selected[key] !== null && selected[key] !== "");
    if (!values.length) return unknown(null);
    parsed = amount(selected[values[0]]);
    // Different representations in one monetary object cannot establish an
    // unambiguous seller amount; preserve V1 parsing elsewhere unchanged.
    if (parsed === null || values.some(key => amount(selected[key]) !== parsed)) return unknown(null);
  } else parsed = amount(selected);
  const candidates = [
    ...(object(selected) ? [selected.currency_code, selected.currency] : []),
    owner.currency_code
  ].filter(value => value !== undefined && value !== null && value !== "");
  const codes = candidates.map(currencyCode);
  if (parsed === null || !codes.length || codes.some(value => !/^[A-Z]{3}$/.test(value)) || new Set(codes).size !== 1) return unknown(parsed);
  return { amount: parsed, verified: true, currency: codes[0], source };
}
