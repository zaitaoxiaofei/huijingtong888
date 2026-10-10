export function commissionRateForRub(rates, saleRub) {
  const price = Number(saleRub);
  if (!Array.isArray(rates) || rates.length !== 3 || !Number.isFinite(price) || price <= 0) return null;
  return Number(rates[price <= 1500 ? 0 : price <= 5000 ? 1 : 2]);
}

export function commissionBandLabel(index) {
  return ["≤ ₽1,500", "₽1,500.01–5,000", "> ₽5,000"][index];
}
