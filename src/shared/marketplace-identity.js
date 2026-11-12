// Unknown explicit identities must never be silently labelled as Ozon.
export function marketplaceIdentity(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'ozon') return { key, label: 'OZON' };
  if (key === 'wb' || key === 'wildberries') return { key: 'wb', label: 'WB' };
  return { key: 'unknown', label: '待识别' };
}
