const DELIVERED_STATUS_KEYWORDS = [
  "delivered",
  "posting_received",
  "received",
  "signed",
  "pickup_code_verified"
];

const RETURN_STATUS_KEYWORDS = [
  "return",
  "returned",
  "refund"
];

const CANCEL_STATUS_KEYWORDS = [
  "cancel",
  "canceled",
  "cancelled",
  "posting_canceled",
  "not_accepted",
  "rejected"
];

const REJECTION_REASON_KEYWORDS = [
  "not accepted",
  "not_accepted",
  "reject",
  "refus",
  "unclaim",
  "pickup",
  "did not pick up",
  "didn't pick up",
  "storage period"
];

const SHIPPED_STATUS_KEYWORDS = [
  "delivering",
  "transferring",
  "carriage",
  "pickup",
  "sorting",
  "customs",
  "shipped",
  "sent",
  "on_way",
  "posting_in_carriage",
  "posting_transferring"
];

const LOSS_PROFILE_NONE = "none";
const LOSS_PROFILE_PURCHASE_COLLECTING = "purchase_collecting";
const LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL = "purchase_collecting_international";
const LOSS_PROFILE_COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL = "commission_purchase_collecting_international";

const ZERO_LOSS_REASON_CODES = new Set([
  "quality_inspection",
  "missing_passport",
  "seller_cancelled",
  "buyer_requested_cancel",
  "out_of_stock",
  "input_error",
  "price_change",
  "delivery_delay",
  "shipment_registration_failed"
]);

const PURCHASE_COLLECTING_REASON_CODES = new Set([
  "delivery_failed",
  "customs_failed"
]);

const PURCHASE_COLLECTING_INTERNATIONAL_REASON_CODES = new Set([
  "item_unsuitable",
  "wrong_item",
  "damaged_in_delivery"
]);

const COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL_REASON_CODES = new Set([
  "aftersale_quality_issue"
]);

const UNSUITABLE_REASON_KEYWORDS = [
  "не подош",
  "not fit",
  "not suitable",
  "商品不合适"
];

const QUALITY_ISSUE_REASON_KEYWORDS = [
  "недоволен каче",
  "quality issue",
  "商品质量",
  "质量问题"
];

const WRONG_ITEM_REASON_KEYWORDS = [
  "не тот товар",
  "wrong item",
  "发错货"
];

const DAMAGED_REASON_KEYWORDS = [
  "поврежден",
  "damaged",
  "商品破损",
  "破损"
];

const UNCLAIMED_REASON_KEYWORDS = [
  "не забрал",
  "not accepted",
  "not_accepted",
  "pickup",
  "unclaim",
  "未取货",
  "拒收"
];

const DELIVERY_FAILED_REASON_KEYWORDS = [
  "не удалось достав",
  "delivery failed",
  "无法妥投"
];

const CUSTOMS_FAILED_REASON_KEYWORDS = [
  "тамож",
  "customs",
  "清关失败"
];

const QUALITY_INSPECTION_REASON_KEYWORDS = [
  "проверка товара",
  "соответствие описанию",
  "quality inspection",
  "inspection",
  "质检",
  "描述核验"
];

const PASSPORT_REASON_KEYWORDS = [
  "паспорт",
  "passport",
  "护照"
];

const QUALITY_ORDER_REASON_CODES = new Set([
  "quality_inspection",
  "missing_passport",
  "shipment_registration_failed",
  "992",
  "994"
]);

const QUALITY_ORDER_REASON_KEYWORDS = [
  "quality inspection",
  "inspection",
  "description check",
  "description verification",
  "\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0442\u043e\u0432\u0430\u0440\u0430",
  "\u0441\u043e\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u044e",
  "质检",
  "描述核验",
  "描述检查"
];

const AFTERSALE_BUCKET_PRE_FULFILLMENT = "pre_fulfillment_cancel";
const AFTERSALE_BUCKET_REJECTED = "rejected_unclaimed";
const AFTERSALE_BUCKET_UNSUITABLE = "unsuitable_wrong_damaged";
const AFTERSALE_BUCKET_QUALITY = "quality_issue";
const AFTERSALE_BUCKET_PLATFORM = "platform_document_issue";

function normalizeText(...values) {
  return values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function lossProfileMeta(code = LOSS_PROFILE_NONE) {
  if (code === LOSS_PROFILE_PURCHASE_COLLECTING) {
    return {
      code,
      label: "货值+收单费",
      formulaText: "损失 = 货物成本 + 收单费",
      components: ["purchase", "collecting"]
    };
  }
  if (code === LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL) {
    return {
      code,
      label: "货值+收单费+国际运费",
      formulaText: "损失 = 货物成本 + 收单费 + 国际运费",
      components: ["purchase", "collecting", "international"]
    };
  }
  if (code === LOSS_PROFILE_COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL) {
    return {
      code,
      label: "佣金+货值+收单费+国际运费",
      formulaText: "损失 = 佣金 + 货物成本 + 收单费 + 国际运费",
      components: ["commission", "purchase", "collecting", "international"]
    };
  }
  return {
    code: LOSS_PROFILE_NONE,
    label: "0损失",
    formulaText: "损失 = 0",
    components: []
  };
}

function normalizedReasonCode(row = {}) {
  return String(row.reason_code || row.cancel_reason_code || "").trim().toLowerCase();
}

function normalizedPostingNumber(row = {}) {
  return String(row.posting_number || row.order_number || row.postingNumber || row.orderNumber || "").trim();
}

function normalizedReasonText(row = {}) {
  return normalizeText(
    row.cancel_reason,
    row.raw_cancellation_reason,
    row.cancel_reason_id,
    row.cancel_type,
    row.cancel_initiator,
    row.reason_label,
    row.reason_group_label
  );
}

export function isQualityCheckOrder(row = {}, options = {}) {
  const markType = String(row.mark_type || row.order_mark_type || row.mark || "").trim().toLowerCase();
  if (markType === "quality") return true;

  const postingNumber = normalizedPostingNumber(row);
  const prefixes = Array.isArray(options.qualityPrefixes) ? options.qualityPrefixes : [];
  if (postingNumber && prefixes.some((prefix) => {
    const normalizedPrefix = String(prefix || "").trim();
    return normalizedPrefix && postingNumber.startsWith(normalizedPrefix);
  })) {
    return true;
  }

  const reasonCode = normalizedReasonCode(row) || String(row.cancel_reason_id || "").trim().toLowerCase();
  if (QUALITY_ORDER_REASON_CODES.has(reasonCode)) return true;

  const reasonText = normalizedReasonText(row);
  return includesAny(reasonText, QUALITY_ORDER_REASON_KEYWORDS) || includesAny(reasonText, PASSPORT_REASON_KEYWORDS);
}

function sqlLikeAny(expr, keywords) {
  return keywords.map((keyword) => `${expr} LIKE '%${keyword.replace(/'/g, "''")}%'`).join(" OR ") || "0";
}

export function classifyOrderOutcome(row = {}) {
  const statusText = normalizeText(row.status, row.substatus, row.tracking_stage, row.logistics_status);
  const reasonText = normalizeText(row.cancel_reason, row.cancel_type, row.cancel_initiator);
  const delivered = Boolean(row.delivered_at || row.accrued_at) || includesAny(statusText, DELIVERED_STATUS_KEYWORDS);
  const returnLike = includesAny(statusText, RETURN_STATUS_KEYWORDS) || includesAny(reasonText, RETURN_STATUS_KEYWORDS);
  const cancelLike = includesAny(statusText, CANCEL_STATUS_KEYWORDS) || (!delivered && Boolean(reasonText));
  const rejectedLike = includesAny(statusText, ["not_accepted", "rejected"]) || includesAny(reasonText, REJECTION_REASON_KEYWORDS);
  const shippedLike = Number(row.cancelled_after_ship || 0) > 0 || includesAny(statusText, SHIPPED_STATUS_KEYWORDS);

  if (delivered && (returnLike || rejectedLike)) return "after_delivery_return";
  if (cancelLike && (rejectedLike || shippedLike || returnLike)) return "rejected_unclaimed";
  if (cancelLike) return "cancelled_pre_fulfillment";
  if (delivered) return "delivered_signed";
  return "active";
}

export function resolveOrderLossProfile(row = {}) {
  const outcome = String(row.outcome || row.outcome_type || classifyOrderOutcome(row)).trim().toLowerCase();
  const reasonCode = normalizedReasonCode(row);
  const reasonText = normalizedReasonText(row);

  if (outcome === "active" || outcome === "delivered_signed" || outcome === "cancelled_pre_fulfillment") {
    return lossProfileMeta(LOSS_PROFILE_NONE);
  }

  if (ZERO_LOSS_REASON_CODES.has(reasonCode) || includesAny(reasonText, QUALITY_INSPECTION_REASON_KEYWORDS) || includesAny(reasonText, PASSPORT_REASON_KEYWORDS)) {
    return lossProfileMeta(LOSS_PROFILE_NONE);
  }

  if (COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL_REASON_CODES.has(reasonCode) || includesAny(reasonText, QUALITY_ISSUE_REASON_KEYWORDS)) {
    return lossProfileMeta(LOSS_PROFILE_COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL);
  }

  if (
    PURCHASE_COLLECTING_INTERNATIONAL_REASON_CODES.has(reasonCode)
    || includesAny(reasonText, UNSUITABLE_REASON_KEYWORDS)
    || includesAny(reasonText, WRONG_ITEM_REASON_KEYWORDS)
    || includesAny(reasonText, DAMAGED_REASON_KEYWORDS)
  ) {
    return lossProfileMeta(LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL);
  }

  if (
    PURCHASE_COLLECTING_REASON_CODES.has(reasonCode)
    || reasonCode === "unclaimed_or_rejected"
    || includesAny(reasonText, UNCLAIMED_REASON_KEYWORDS)
    || includesAny(reasonText, DELIVERY_FAILED_REASON_KEYWORDS)
    || includesAny(reasonText, CUSTOMS_FAILED_REASON_KEYWORDS)
  ) {
    return lossProfileMeta(LOSS_PROFILE_PURCHASE_COLLECTING);
  }

  if (outcome === "after_delivery_return") {
    return lossProfileMeta(LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL);
  }
  if (outcome === "rejected_unclaimed") {
    return lossProfileMeta(LOSS_PROFILE_PURCHASE_COLLECTING);
  }
  return lossProfileMeta(LOSS_PROFILE_NONE);
}

export function classifyAftersaleBucket(row = {}, options = {}) {
  const outcome = String(row.outcome || row.outcome_type || classifyOrderOutcome(row)).trim().toLowerCase();
  const profile = String(row.loss_profile_code || resolveOrderLossProfile({ ...row, outcome_type: outcome }).code || "").trim().toLowerCase();
  const reasonCode = normalizedReasonCode(row) || String(row.cancel_reason_id || "").trim().toLowerCase();
  const reasonText = normalizedReasonText(row);

  if (isQualityCheckOrder(row, options)) return AFTERSALE_BUCKET_PLATFORM;
  if (outcome === "cancelled_pre_fulfillment") return AFTERSALE_BUCKET_PRE_FULFILLMENT;
  if (QUALITY_ORDER_REASON_CODES.has(reasonCode) || includesAny(reasonText, QUALITY_ORDER_REASON_KEYWORDS) || includesAny(reasonText, PASSPORT_REASON_KEYWORDS)) {
    return AFTERSALE_BUCKET_PLATFORM;
  }
  if (reasonCode === "aftersale_quality_issue" || profile === LOSS_PROFILE_COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL || includesAny(reasonText, QUALITY_ISSUE_REASON_KEYWORDS)) {
    return AFTERSALE_BUCKET_QUALITY;
  }
  if (
    PURCHASE_COLLECTING_INTERNATIONAL_REASON_CODES.has(reasonCode)
    || profile === LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL
    || includesAny(reasonText, UNSUITABLE_REASON_KEYWORDS)
    || includesAny(reasonText, WRONG_ITEM_REASON_KEYWORDS)
    || includesAny(reasonText, DAMAGED_REASON_KEYWORDS)
  ) {
    return AFTERSALE_BUCKET_UNSUITABLE;
  }
  if (outcome === "rejected_unclaimed" || outcome === "after_delivery_return") return AFTERSALE_BUCKET_REJECTED;
  return AFTERSALE_BUCKET_PRE_FULFILLMENT;
}

export function classifyOrderAccounting(row = {}, options = {}) {
  const outcomeType = classifyOrderOutcome(row);
  const qualityCheck = isQualityCheckOrder(row, options);
  const lossProfile = qualityCheck
    ? lossProfileMeta(LOSS_PROFILE_NONE)
    : resolveOrderLossProfile({ ...row, outcome_type: outcomeType });
  const bucket = classifyAftersaleBucket({
    ...row,
    outcome_type: outcomeType,
    loss_profile_code: lossProfile.code
  }, options);

  return {
    order_nature: qualityCheck ? "quality_check" : "normal_sale",
    is_quality_order: qualityCheck,
    outcome_type: outcomeType,
    loss_profile_code: lossProfile.code,
    loss_profile_label: lossProfile.label,
    loss_formula_text: lossProfile.formulaText || lossProfile.formula_text || "",
    aftersale_bucket: bucket,
    should_include_aftersale_loss: !qualityCheck && ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcomeType)
  };
}

export function isCancelledOutcome(row = {}) {
  return classifyOrderOutcome(row) === "cancelled_pre_fulfillment";
}

export function isReturnedOutcome(row = {}) {
  const outcome = classifyOrderOutcome(row);
  return outcome === "rejected_unclaimed" || outcome === "after_delivery_return";
}

export function isDeliveredOutcome(row = {}) {
  return classifyOrderOutcome(row) === "delivered_signed";
}

export function isTerminalOutcome(row = {}) {
  return classifyOrderOutcome(row) !== "active";
}

export function buildOrderOutcomeSql(alias = "o", dialect = "mysql") {
  const concatText = (...parts) => {
    if (String(dialect || "").toLowerCase() === "mysql") {
      return `CONCAT_WS(' ', ${parts.map((part) => `COALESCE(${part}, '')`).join(", ")})`;
    }
    return parts.map((part) => `COALESCE(${part}, '')`).join(" || ' ' || ");
  };
  const statusText = `LOWER(TRIM(${concatText(`${alias}.status`, `${alias}.tracking_stage`, `${alias}.logistics_status`)}))`;
  const reasonText = `LOWER(TRIM(${concatText(`${alias}.cancel_reason`, `${alias}.cancel_type`, `${alias}.cancel_initiator`)}))`;
  const delivered = `(COALESCE(${alias}.delivered_at, '') != '' OR COALESCE(${alias}.accrued_at, '') != '' OR ${sqlLikeAny(statusText, DELIVERED_STATUS_KEYWORDS)})`;
  const returnLike = `(${sqlLikeAny(statusText, RETURN_STATUS_KEYWORDS)} OR ${sqlLikeAny(reasonText, RETURN_STATUS_KEYWORDS)})`;
  const cancelLike = `(${sqlLikeAny(statusText, CANCEL_STATUS_KEYWORDS)} OR (NOT ${delivered} AND ${reasonText} != ''))`;
  const rejectedLike = `(${sqlLikeAny(statusText, ["not_accepted", "rejected"])} OR ${sqlLikeAny(reasonText, REJECTION_REASON_KEYWORDS)})`;
  const shippedLike = `(COALESCE(${alias}.cancelled_after_ship, 0) > 0 OR ${sqlLikeAny(statusText, SHIPPED_STATUS_KEYWORDS)})`;
  const afterDeliveryReturn = `(${delivered} AND (${returnLike} OR ${rejectedLike}))`;
  const rejectedUnclaimed = `(${cancelLike} AND NOT ${afterDeliveryReturn} AND (${rejectedLike} OR ${shippedLike} OR ${returnLike}))`;
  const cancelledPreFulfillment = `(${cancelLike} AND NOT ${afterDeliveryReturn} AND NOT ${rejectedUnclaimed})`;
  const deliveredSigned = `(${delivered} AND NOT ${afterDeliveryReturn})`;
  const active = `(NOT ${cancelledPreFulfillment} AND NOT ${rejectedUnclaimed} AND NOT ${afterDeliveryReturn} AND NOT ${deliveredSigned})`;
  const effectiveSale = `(NOT ${cancelledPreFulfillment} AND NOT ${rejectedUnclaimed})`;
  return {
    statusText,
    reasonText,
    delivered,
    returnLike,
    cancelLike,
    rejectedLike,
    shippedLike,
    afterDeliveryReturn,
    rejectedUnclaimed,
    cancelledPreFulfillment,
    deliveredSigned,
    active,
    effectiveSale
  };
}

export function estimateOutcomeReturnLoss({
  outcome = "active",
  lossProfileCode = "",
  quantity = 1,
  purchaseCostPerUnit = 0,
  domesticShippingPerUnit = 0,
  internationalShippingPerUnit = 0,
  packagingCostTotal = 0,
  commissionFeeTotal = 0,
  collectingFeeTotal = 0,
  finalMileFeeTotal = 0,
  serviceFeeTotal = 0,
  returnRateLossTotal = 0
} = {}) {
  const qty = Number(quantity || 1);
  const purchaseTotal = Number(purchaseCostPerUnit || 0) * qty;
  const domesticTotal = Number(domesticShippingPerUnit || 0) * qty;
  const internationalTotal = Number(internationalShippingPerUnit || 0) * qty;
  const packagingTotal = Number(packagingCostTotal || 0);
  const commissionTotal = Number(commissionFeeTotal || 0);
  const collectingTotal = Number(collectingFeeTotal || 0);
  const finalMileTotal = Number(finalMileFeeTotal || 0);
  const serviceTotal = Number(serviceFeeTotal || 0);
  const fallbackTotal = Number(returnRateLossTotal || 0);
  const profile = String(lossProfileCode || "").trim().toLowerCase();

  if (profile === LOSS_PROFILE_NONE) {
    return 0;
  }
  if (profile === LOSS_PROFILE_PURCHASE_COLLECTING) {
    return roundMoney(purchaseTotal + collectingTotal);
  }
  if (profile === LOSS_PROFILE_PURCHASE_COLLECTING_INTERNATIONAL) {
    return roundMoney(purchaseTotal + collectingTotal + internationalTotal);
  }
  if (profile === LOSS_PROFILE_COMMISSION_PURCHASE_COLLECTING_INTERNATIONAL) {
    return roundMoney(purchaseTotal + collectingTotal + internationalTotal + commissionTotal);
  }

  if (outcome === "cancelled_pre_fulfillment" || outcome === "delivered_signed" || outcome === "active") {
    return 0;
  }
  if (outcome === "rejected_unclaimed") {
    return roundMoney(purchaseTotal + collectingTotal);
  }
  if (outcome === "after_delivery_return") {
    return roundMoney(purchaseTotal + collectingTotal + internationalTotal);
  }
  void domesticTotal;
  void packagingTotal;
  void finalMileTotal;
  void serviceTotal;
  return roundMoney(fallbackTotal);
}

function roundMoney(value) {
  const amount = Number(value || 0);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
