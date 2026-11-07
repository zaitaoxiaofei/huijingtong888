// Business review, 2026-10-30. Preserve the platform code and original text.
// This registry is independent of the frozen V1/V2 financial implementations.
export const reviewedAftersaleReasons = Object.freeze([
  { codes: ['688', '684'], original: 'Покупатель не предоставил паспортные данные', label: '买家未提供护照资料', reason_code: 'missing_passport', kind: 'cancellation' },
  { codes: ['686'], original: 'Вы не отгрузили заказ вовремя', label: '卖家未按时发货', reason_code: 'seller_shipment_overdue', kind: 'cancellation' },
  { codes: ['554'], original: 'У товаров неправильная этикетка', label: '商品标签错误', reason_code: 'incorrect_label', kind: 'cancellation' },
  { codes: ['672'], original: 'Не удалось зарегистрировать отправление в службе доставки', label: '无法在配送服务商处登记发运', reason_code: 'shipment_registration_failed', kind: 'cancellation' },
  { codes: ['402'], original: 'Вы отменили заказ', label: '卖家取消订单', reason_code: 'seller_cancelled', kind: 'cancellation' },
  { codes: ['809', '699'], original: 'Заказ утерян при доставке', label: '订单在配送途中丢失', reason_code: 'cargo_lost', kind: 'cargo_loss' },
  { codes: ['677'], original: 'Отменили заказ по вашей просьбе', label: '应卖家要求取消订单', reason_code: 'seller_requested_cancel', kind: 'cancellation' },
  { codes: ['678'], original: 'Не соответствует требованиям перевозчика', label: '不符合承运商要求', reason_code: 'carrier_requirements', kind: 'cancellation' },
  { codes: ['352'], original: 'Товар закончился на складе', label: '仓库商品缺货', reason_code: 'out_of_stock', kind: 'cancellation' },
  { codes: ['808'], original: 'Покупатель попросил вас отменить заказ', label: '买家请求卖家取消订单', reason_code: 'buyer_requested_cancel', kind: 'cancellation' },
  { codes: ['938'], original: 'Покупатель не предоставил персональные данные', label: '买家未提供个人资料', reason_code: 'missing_personal_data', kind: 'cancellation' },
  { codes: ['504', '508', '710', '502'], original: 'Покупатель отменил заказ', label: '买家主动取消订单', reason_code: 'buyer_requested_cancel', kind: 'cancellation' },
  { codes: ['506'], original: 'Покупатель отменил заказ: нашел дешевле', label: '买家取消订单：找到更便宜的商品', reason_code: 'price_change', kind: 'cancellation' },
  { codes: ['505'], original: 'Покупатель отменил заказ: не устроил срок доставки', label: '买家取消订单：不接受配送时效', reason_code: 'delivery_delay', kind: 'cancellation' },
  { codes: ['685'], original: 'Покупатель отменил заказ по вашей просьбе', label: '买家应卖家要求取消订单', reason_code: 'seller_requested_cancel', kind: 'cancellation' }
].map(row => Object.freeze({ ...row, codes: Object.freeze(row.codes) })));

const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function reviewedAftersaleReason(row = {}) {
  const code = normalize(row.cancel_reason_id || row.cancel_reason_code || row.reason_code);
  const original = normalize(row.cancel_reason || row.raw_cancellation_reason || row.cancel_type);
  return reviewedAftersaleReasons.find(reason => reason.codes.includes(code)
    || reason.reason_code === code || normalize(reason.original) === original) || null;
}
