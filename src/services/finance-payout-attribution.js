export const PAYOUT_ATTRIBUTION_SCHEMA = `CREATE TABLE IF NOT EXISTS finance_payout_attributions (
 tenant_id BIGINT UNSIGNED NOT NULL, company_id BIGINT UNSIGNED NOT NULL,
 entry_reference VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
 payment_document_id BIGINT UNSIGNED NOT NULL, payment_source VARCHAR(80) NOT NULL,
 shop_id BIGINT UNSIGNED NOT NULL, confirmed_by BIGINT UNSIGNED NOT NULL,
 confirmed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (tenant_id,company_id,entry_reference),
 UNIQUE KEY uk_payout_evidence (tenant_id,company_id,payment_document_id,payment_source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export const payoutEvidenceKey = p => JSON.stringify([Number(p.document_id),p.source]);

function validPayoutPair(payment, entry) {
 return payment.currency === 'CNY' && entry.currency === 'CNH'
  && Math.round(payment.amount * 100) === Math.round(entry.amount * 100)
  && Math.abs(Date.parse(String(entry.date).slice(0,10)) - Date.parse(payment.date)) <= 4 * 86400000;
}

export function matchFinancePayouts(payments, entries, attributions) {
 const confirmedByPayment = new Map(attributions.map(a => [
  payoutEvidenceKey({document_id:a.payment_document_id,source:a.payment_source}),a
 ]));
 const entriesByReference = new Map(entries.map(entry => [String(entry.reference),entry]));
 const reserved = new Set(attributions.map(a => a.entry_reference));
 const byAmount = new Map();
 for (const entry of entries) {
  if (entry.currency !== 'CNH' || !entry.reference || reserved.has(String(entry.reference))) continue;
  const key = Math.round(entry.amount * 100);
  if (!byAmount.has(key)) byAmount.set(key, []);
  byAmount.get(key).push(entry);
 }
 const claims = new Map();
 const matches = payments.map(payment => {
  const saved = confirmedByPayment.get(payoutEvidenceKey(payment));
  if (saved) {
   const entry = entriesByReference.get(saved.entry_reference);
   if (entry && validPayoutPair(payment, entry) && Number(saved.shop_id) === Number(payment.shop_id)) {
    return {payment,entry,status:'confirmed'};
   }
   return {payment,entry:null,status:'evidence_missing'};
  }
  const candidates = Number(payment.shop_id) && payment.source
   ? (byAmount.get(Math.round(payment.amount * 100)) || []).filter(entry =>
      validPayoutPair(payment, entry))
   : [];
  for (const entry of candidates) claims.set(entry, (claims.get(entry) || 0) + 1);
  return {payment,candidates};
 });
 return matches.map(({candidates,...match}) => {
  if (!candidates) return match;
  if (candidates.length === 1 && claims.get(candidates[0]) === 1) {
   return {...match,entry:candidates[0],status:'amount_date_candidate'};
  }
  return {...match,entry:null,status:candidates.length ? 'ambiguous' : 'unmatched'};
 });
}

export function summarizePayoutAttributions(rows, matches) {
 const byEntry = new Map(matches.filter(m => m.status === 'confirmed')
  .map(m => [String(m.entry.reference),Number(m.payment.shop_id)]));
 const groups = new Map();
 for (const entry of rows) {
  if (entry.type !== 'entry') continue;
  const month = String(entry.date).slice(0,7);
  const shop_id = entry.currency === 'CNH' ? byEntry.get(String(entry.reference)) || null : null;
  const key = JSON.stringify([month,shop_id,entry.currency]);
  if (!groups.has(key)) groups.set(key,{month,shop_id,currency:entry.currency,count:0,cents:0});
  const group = groups.get(key);
  group.count++;
  group.cents += Math.round(entry.amount * 100);
 }
 return [...groups.values()].map(({cents,...row}) => ({...row,amount:cents / 100}))
  .sort((a,b) => a.month.localeCompare(b.month) || (a.shop_id ?? Infinity) - (b.shop_id ?? Infinity));
}
