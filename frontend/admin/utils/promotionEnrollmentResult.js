function isReadbackLimited(item) {
  return item.code === 'READBACK_RATE_LIMITED' || (/收到报名回执.*回读未完成/.test(String(item.reason || ''))
    && /rate.?limit|too many requests/i.test(String(item.reason || '')));
}

export function buildPromotionEnrollmentSummary(result) {
  if (!result) return null;
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const confirmed = Number(result.count || 0);
  const rejected = failures.filter(item => item.status === 'rejected').length;
  const pending = failures.length - rejected;
  const limited = failures.some(isReadbackLimited);
  const requested = new Set([...(result.confirmedProductIds || []), ...failures.map(item => item.product_id)].map(String));
  const accepted = new Set((result.result?.active_product_ids || []).map(String).filter(id => requested.has(id))).size;
  const groups = new Map();
  for (const item of failures) {
    const reason = isReadbackLimited(item)
      ? 'Ozon 查询暂时限流，等待核对最终结果' : String(item.reason || '结果尚未确认');
    const ids = groups.get(reason) || [];
    ids.push(item.product_id); groups.set(reason, ids);
  }
  return {
    title: `已核实 ${confirmed} 件，待核对 ${pending} 件，未通过 ${rejected} 件`,
    type: result.success ? 'success' : rejected ? 'warning' : 'info',
    message: limited
      ? `已收到 ${accepted} 件商品的报名回执。状态查询暂时限流，暂未核实的商品不代表报名失败。请稍后重新拉取核对，不要重复报名。`
      : pending ? '部分商品结果尚未核实，请先重新拉取核对，不要重复报名。' : '',
    groups: [...groups].map(([reason, ids]) => ({ reason, ids })),
    warnings: Array.isArray(result.warnings) ? result.warnings : []
  };
}
