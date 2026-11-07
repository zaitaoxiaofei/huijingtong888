export function summarizeOrderSyncResult(result = {}) {
  const shops = Array.isArray(result.shops) ? result.shops : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const failedShopCount = shops.filter((shop) => shop?.error).length || errors.length;
  const firstError = String(errors[0] || shops.find((shop) => shop?.error)?.error || "未知原因");
  return {
    insertedOrders: shops.reduce((total, shop) => total + Number(shop?.inserted || 0), 0),
    failedShopCount,
    failureReason: firstError.length > 120 ? `${firstError.slice(0, 120)}…` : firstError
  };
}

// A complete posting number can be fetched even if no local child row exists.
export function exactPostingNumbers(searchType, value) {
  if (searchType !== 'order') return [];
  const numbers = [...new Set(String(value || '').trim().split(/[\s,;，；]+/).filter(Boolean))];
  return numbers.length && numbers.length <= 20 && numbers.every(number => /^\d+-\d+-\d+$/.test(number)) ? numbers : [];
}
