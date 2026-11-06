import { buildOrderOutcomeSql } from './order-outcome.js';
import { buildOrderOutcomeSql as buildBaseOrderOutcomeSql } from './profit-formulas/v1/order-outcome.js';

// Reuse the published expressions unchanged. Materialize their shared parts
// before the reporting predicates expand them for every order/item/aggregate.
// GROUP BY keeps MySQL from merging these stages and expanding them again.
export function orderReportOutcomeCtesSql(orderScope, dateWhereSql = '') {
  const base = buildBaseOrderOutcomeSql('o', 'mysql');
  const current = buildOrderOutcomeSql('o', 'mysql');
  const references = [];
  const substitute = sql => references.toSorted((a, b) => b[0].length - a[0].length)
    .reduce((value, [expression, column]) => value.replaceAll(expression, `o.${column}`), sql);
  const fields = keys => {
    const result = keys.map(key => `CASE WHEN ${substitute(base[key])} THEN 1 ELSE 0 END AS report_${key}`);
    for (const key of keys) references.push([base[key], `report_${key}`]);
    return result.join(',\n        ');
  };
  const textFields = ['statusText', 'reasonText'].map(key => `${base[key]} AS report_${key}`).join(',\n        ');
  references.push(...['statusText', 'reasonText'].map(key => [base[key], `report_${key}`]));
  const flags = fields(['delivered', 'returnLike', 'rejectedLike', 'shippedLike']);
  const terminal = fields(['cancelLike', 'afterDeliveryReturn']);
  const effectiveSale = substitute(`(${current.effectiveSale} AND NOT ${current.afterDeliveryReturn})`);
  const rejected = substitute(current.rejectedUnclaimed);
  const returned = substitute(current.afterDeliveryReturn);
  return `WITH report_order_text AS (
      SELECT o.id,o.cancel_reason_id,o.cancel_reason,o.cancel_type,o.cancelled_after_ship,o.delivered_at,o.accrued_at,
        ${textFields}
      FROM orders o WHERE 1=1 ${dateWhereSql} AND (${orderScope})
      GROUP BY o.id
    ), report_order_flags AS (
      SELECT o.id,o.cancel_reason_id,o.cancel_reason,o.cancel_type,o.report_statusText,o.report_reasonText,
        ${flags}
      FROM report_order_text o GROUP BY o.id
    ), report_order_terminal AS (
      SELECT o.*,
        ${terminal}
      FROM report_order_flags o GROUP BY o.id
    ), order_outcomes AS (
      SELECT o.id,
        CASE WHEN ${effectiveSale} THEN 1 ELSE 0 END AS effective_business_sale,
        CASE WHEN ${rejected} THEN 1 ELSE 0 END AS rejected_unclaimed,
        CASE WHEN ${returned} THEN 1 ELSE 0 END AS after_delivery_return
      FROM report_order_terminal o GROUP BY o.id
    )`;
}
