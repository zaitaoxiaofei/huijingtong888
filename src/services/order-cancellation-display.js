const REASON_CODE_LABELS = new Map([
  ["992", "平台核验商品描述"],
  ["994", "缺少商品护照或合规文件"],
  ["quality_inspection", "平台质量检查"],
  ["missing_passport", "缺少商品护照或合规文件"],
  ["seller_cancelled", "卖家取消订单"],
  ["buyer_requested_cancel", "买家主动取消订单"],
  ["out_of_stock", "商品缺货"],
  ["input_error", "订单信息填写错误"],
  ["price_change", "商品价格发生变化"],
  ["delivery_delay", "配送延迟"],
  ["shipment_registration_failed", "发运登记失败"],
  ["delivery_failed", "配送失败"],
  ["customs_failed", "清关失败"],
  ["item_unsuitable", "商品不合适"],
  ["wrong_item", "收到的商品不符"],
  ["damaged_in_delivery", "商品在运输中损坏"],
  ["aftersale_quality_issue", "商品质量问题"],
  ["unclaimed_or_rejected", "买家拒收或未领取"]
]);

const REASON_TEXT_RULES = [
  ["买家主动取消订单", ["покупатель отменил заказ", "клиент отменил заказ", "buyer cancelled", "buyer canceled", "buyer requested cancel"]],
  ["卖家取消订单", ["продавец отменил заказ", "seller cancelled", "seller canceled"]],
  ["商品缺货", ["нет товара", "товара нет в наличии", "out of stock"]],
  ["配送延迟", ["задержка доставки", "доставка задержалась", "delivery delay"]],
  ["配送失败", ["не удалось доставить", "ошибка доставки", "delivery failed"]],
  ["清关失败", ["тамож", "customs failed"]],
  ["买家未领取", ["покупатель не забрал", "клиент не забрал", "не забрал заказ", "истек срок хранения", "unclaimed", "did not pick up"]],
  ["买家拒收", ["покупатель отказался", "клиент отказался", "отказ от товара", "not accepted", "buyer rejected", "refused"]],
  ["商品不合适", ["товар не подошел", "товар не подходит", "не подошёл", "не подошел", "not suitable", "not fit"]],
  ["收到的商品不符", ["не тот товар", "получен другой товар", "wrong item"]],
  ["商品在运输中损坏", ["товар поврежден", "поврежден при доставке", "damaged"]],
  ["商品质量问题", ["проблема с качеством", "ненадлежащее качество", "бракованный товар", "quality issue", "defect"]],
  ["商品与描述不符", ["не соответствует описанию", "товар не соответствует описанию", "description mismatch"]],
  ["平台核验商品描述", ["проверка товара", "соответствие описанию", "quality inspection", "description verification"]],
  ["缺少商品护照或合规文件", ["отсутствует паспорт", "нет паспорта", "missing passport"]],
  ["发运登记失败", ["ошибка регистрации отправления", "shipment registration failed"]],
  ["订单信息填写错误", ["ошибка ввода", "ошибка в заказе", "input error"]],
  ["商品价格发生变化", ["изменение цены", "ошибка в цене", "price change"]],
  ["买家申请退货", ["возврат товара", "покупатель вернул товар", "customer return", "returned"]]
];

const INITIATOR_RULES = [
  ["买家", ["buyer", "customer", "client", "покупател", "клиент"]],
  ["卖家", ["seller", "продав"]],
  ["Ozon 平台", ["ozon", "platform", "система"]],
  ["物流承运商", ["carrier", "delivery", "logistics", "перевозчик", "доставк"]]
];

const LOSS_PROFILE_LABELS = {
  none: "无规则损失",
  purchase_collecting: "商品成本＋国际运费＋收单费",
  purchase_collecting_international: "商品成本＋国内运费＋国际运费＋收单费",
  commission_purchase_collecting_international: "商品成本＋国内运费＋国际运费＋收单费＋佣金"
};

const LOSS_PROFILE_FORMULAS = {
  none: "预估损失 = 0；真实财务费用到账后以实际扣费为准",
  purchase_collecting: "预估损失 = 商品成本 + 国际运费 + 收单费",
  purchase_collecting_international: "预估损失 = 商品成本 + 国内运费 + 国际运费 + 收单费",
  commission_purchase_collecting_international: "预估损失 = 商品成本 + 国内运费 + 国际运费 + 收单费 + 佣金"
};

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function translatedByText(value) {
  const text = normalize(value);
  if (!text) return "";
  for (const [label, keywords] of REASON_TEXT_RULES) {
    if (keywords.some((keyword) => text.includes(keyword))) return label;
  }
  return "";
}

export function translateCancellationReason(row = {}) {
  const original = String(row.cancel_reason || row.raw_cancellation_reason || row.cancel_type || "").trim();
  const code = normalize(row.cancel_reason_id || row.cancel_reason_code || row.reason_code);
  const translated = REASON_CODE_LABELS.get(code) || translatedByText(original);
  return {
    label: translated || (original ? `未收录原因：${original}` : "取消原因待同步"),
    original,
    translated: Boolean(translated),
    code: code || "other"
  };
}

export function translateCancellationInitiator(value) {
  const original = String(value || "").trim();
  const text = normalize(original);
  if (!text) return "";
  for (const [label, keywords] of INITIATOR_RULES) {
    if (keywords.some((keyword) => text.includes(keyword))) return label;
  }
  return original;
}

export function cancellationDisplay(row = {}, profile = {}) {
  const reason = translateCancellationReason(row);
  const profileCode = String(row.loss_profile_code || profile.code || "none").trim().toLowerCase();
  return {
    initiator_label: translateCancellationInitiator(row.cancel_initiator),
    reason_label: reason.label,
    reason_original: reason.original,
    reason_translated: reason.translated,
    reason_code: reason.code,
    reason_group_label: LOSS_PROFILE_LABELS[profileCode] || "原因待归类",
    accounting_hint: profileCode === "none"
      ? "当前原因不预估履约损失；如 Ozon 财务账单存在实际扣费，则以真实扣费为准。"
      : `当前按“${LOSS_PROFILE_LABELS[profileCode] || "原因规则"}”预估，结算后以 Ozon 真实财务费用覆盖。`,
    loss_profile_code: profileCode,
    loss_profile_label: LOSS_PROFILE_LABELS[profileCode] || "原因待归类",
    loss_formula_text: LOSS_PROFILE_FORMULAS[profileCode] || "预估损失待人工确认；真实结算以 Ozon 财务费用为准"
  };
}

