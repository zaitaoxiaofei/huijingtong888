// Display metadata only: retain original notes and never infer platform roles.
export function procurementRequestDisplay(row = {}) {
  const note = String(row.note || '');
  const automatic = !row.created_by_person_id && /^系统按真实订单缺口自动生成[：:]/.test(note);
  const historicalOrder = note.match(/^系统按真实订单缺口自动生成[：:]\s*([^\s/；;]+)/)?.[1];
  const order = String(row.source_order_number || historicalOrder || '').trim();
  const manual = String(row.request_reason_note || '').trim();
  const fullReason = automatic && order ? `真实订单创建 · ${order}` : manual || (order ? `关联订单 · ${order}` : automatic ? '真实订单创建' : note.split('\n')[0] || '人工采购申请');
  const reason = Array.from(fullReason).length>72?Array.from(fullReason).slice(0,72).join('')+'…':fullReason;
  const rejection = note.match(/(?:拒绝原因|拒绝说明)[：:]\s*([^\n]+)/)?.[1];
  return {
    ...row,
    applicant_name: automatic ? '系统规则' : row.applicant_name || '历史申请人待核对',
    reason_summary: reason,
    rejection_summary: rejection || '',
    reason_detail: note !== reason || (manual && manual !== reason) ? [...new Set([manual,note].filter(Boolean))].join('\n') : ''
  };
}
