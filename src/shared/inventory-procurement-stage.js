export const PROCUREMENT_TRANSIT_WARNING_HOURS=48;
export const PROCUREMENT_INSPECTION_HOURS=72;
export const PROCUREMENT_REQUEST_WARNING_HOURS=24;

// Time only advances the work queue; it never confirms receipt or adds stock.
export function procurementArrivalStage(row, now = Date.now()) {
  const stamp = row.purchased_at instanceof Date ? row.purchased_at.getTime() : Date.parse(row.purchased_at || '');
  const hours = Number.isFinite(stamp) ? Math.max(0, (Number(now) - stamp) / 3600000) : null;
  const pending = row.status === 'pending_arrival';
  return { hours, overdue: pending && !row.received_at && hours > PROCUREMENT_TRANSIT_WARNING_HOURS,
    awaiting_inspection: pending && (!!row.received_at || hours >= PROCUREMENT_INSPECTION_HOURS),
    label: !pending ? '已入库' : row.received_at ? '已到货 · 待验收' : hours >= PROCUREMENT_INSPECTION_HOURS ? '待验收 · 到货待确认' : '采购在途' };
}
