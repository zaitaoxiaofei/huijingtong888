import september from '../data/wb/logistics-2026-09-01.json' with { type: 'json' };
import november from '../data/wb/logistics-2026-11-11.json' with { type: 'json' };

// Published snapshots are append-only. A new quote table gets a new registry entry.
function version(snapshot, effectiveTo = null) {
  const key = snapshot.version;
  return Object.freeze({
    ...snapshot, platform: 'wb', effectiveFrom: `${key}T00:00:00+08:00`, effectiveTo,
    downloadUrl: `/reference/wb-logistics-${key}.pdf`,
    rows: Object.freeze(snapshot.rows.map(row => Object.freeze({ ...row,
      light: Object.freeze([...row.light]), heavy: Object.freeze([...row.heavy]),
      platform: 'wb', tariffVersion: key, ruleKey: `wb:${key}:${row.id}`, sourceSha256: snapshot.sha256
    })))
  });
}
export const WB_LOGISTICS_VERSIONS = Object.freeze([
  version(september, '2026-11-11T00:00:00+08:00'), version(november)
]);
export function wbTariffVersion(key) {
  const selected = WB_LOGISTICS_VERSIONS.find(item => item.version === key);
  if (!selected) throw new Error('WB 物流报价版本不存在，请重新选择官方报价版本');
  return selected;
}
export function currentWbTariff(at = new Date()) {
  const time = new Date(at).getTime();
  const selected = WB_LOGISTICS_VERSIONS.find(item => Date.parse(item.effectiveFrom) <= time
    && (!item.effectiveTo || time < Date.parse(item.effectiveTo)));
  if (!selected) throw new Error('该日期没有已登记的 WB 官方报价版本，不能套用其他版本');
  return selected;
}
