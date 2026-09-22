// Registration/awaiting delivery is not proof that a parcel left the warehouse.
const transportedStatus = '(^| )(delivering|delivered|posting_delivered|posting_received|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^ ]*|posting_in_pickup_point|posting_received_by_buyer)( |$)';

export function orderTransportEvidenceSql(alias = 'o') {
  return `(COALESCE(${alias}.cancelled_after_ship, 0) > 0
    OR ${alias}.delivered_at IS NOT NULL
    OR LOWER(CONCAT_WS(' ', ${alias}.status, ${alias}.tracking_stage, ${alias}.logistics_status)) REGEXP '${transportedStatus}'
    OR EXISTS (SELECT 1 FROM order_status_history transport_history
      WHERE transport_history.order_id = ${alias}.id
        AND LOWER(transport_history.status) REGEXP '${transportedStatus}'))`;
}

// Only system-generated cancellation returns; manual physical receipts stay intact.
export const automaticCancellationReturnSql = `source_type = 'return_in'
  AND (source_ref = CONCAT('cancel_', related_order_item_id)
    OR source_ref = CONCAT('cancel_', related_order_item_id, '_', product_id))`;
