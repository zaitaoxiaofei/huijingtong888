import { db } from "../db.js";
import { classifyOrderOutcome, resolveOrderLossProfile } from "./order-outcome.js";

let cancellationRuleCache = null;

function normalizeText(...values) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function normalizeLower(...values) {
  return normalizeText(...values).toLowerCase();
}

function cancellationRules() {
  if (cancellationRuleCache) return cancellationRuleCache;
  cancellationRuleCache = db.prepare(`
    SELECT *
    FROM order_cancellation_rules
    WHERE enabled = 1
    ORDER BY priority ASC, id ASC
  `).all();
  return cancellationRuleCache;
}

export function invalidateOrderCancellationRuleCache() {
  cancellationRuleCache = null;
}

function matchesRule(text, rule = {}) {
  const normalized = String(text || "").toLowerCase();
  const pattern = String(rule.match_text || "").trim().toLowerCase();
  const mode = String(rule.match_mode || "contains").toLowerCase();
  if (!pattern) return false;
  if (mode === "equals") return normalized === pattern;
  if (mode === "starts_with") return normalized.startsWith(pattern);
  if (mode === "regex") {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return false;
    }
  }
  return normalized.includes(pattern);
}

function matchedRule(row = {}) {
  const text = normalizeLower(
    row.cancel_reason,
    row.cancel_type,
    row.cancel_initiator,
    row.raw_cancellation_reason,
    row.cancel_reason_id
  );
  return cancellationRules().find((item) => matchesRule(text, item)) || null;
}

export function cancelInitiatorLabel(value = "") {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) return "";
  if (lower === "client" || lower === "buyer" || lower.includes("покупатель")) return "买家";
  if (lower === "seller" || lower.includes("продав")) return "卖家";
  if (lower === "delivery" || lower.includes("служба доставки")) return "物流";
  if (lower === "ozon" || lower === "system" || lower.includes("ozon") || lower.includes("систем")) return "平台";
  return String(value || "").trim();
}

export function cancelTypeLabel(value = "") {
  const key = String(value || "").trim().toLowerCase();
  if (key === "client" || key === "buyer") return "买家";
  if (key === "seller") return "卖家";
  if (key === "ozon" || key === "system") return "平台";
  if (key === "delivery") return "物流";
  return "";
}

export function cancelReasonLabel(value = "") {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "";
  if (lower.includes("проверка товара") || lower.includes("соответствие описанию") || lower.includes("quality inspection") || lower.includes("inspection")) return "平台质检/描述核验";
  if (lower.includes("паспорт") || lower.includes("passport")) return "护照信息缺失";
  if (lower.includes("не удалось достав") || lower.includes("delivery failed")) return "无法妥投";
  if (lower.includes("тамож") || lower.includes("customs")) return "清关失败";
  if (lower.includes("не забрал") || lower.includes("not accepted") || lower.includes("unclaim")) return "买家未取货";
  if (lower.includes("не подош") || lower.includes("not suitable")) return "商品不合适";
  if (lower.includes("не тот товар") || lower.includes("wrong item")) return "发错货";
  if (lower.includes("поврежден") || lower.includes("damaged")) return "商品破损";
  if (lower.includes("недоволен каче") || lower.includes("quality issue")) return "质量问题";
  if (lower.includes("срок доставки") || lower.includes("delivery time")) return "配送时效问题";
  if (lower.includes("дешев")) return "找到更便宜商品";
  if (lower.includes("ошиб") || lower.includes("error")) return "下单信息错误";
  if (lower.includes("stock") || lower.includes("нет")) return "库存不足";
  if (lower.includes("отмен")) return "订单取消";
  return text;
}

function fallbackClassification(text = "") {
  if (!text) {
    return {
      code: "unknown",
      label: "未识别原因",
      accountingHint: "当前缺少足够的取消/退货原因信息，先按订单结果类型兜底处理。"
    };
  }
  if (text.includes("проверка товара") || text.includes("соответствие описанию") || text.includes("quality inspection") || text.includes("inspection")) {
    return {
      code: "quality_inspection",
      label: "平台质检/描述核验",
      accountingHint: "平台质检/描述核验按 0 损失处理，不计入有效销售。"
    };
  }
  if (text.includes("паспорт") || text.includes("passport")) {
    return {
      code: "missing_passport",
      label: "护照信息缺失",
      accountingHint: "护照信息缺失按 0 损失处理，不计入有效销售。"
    };
  }
  if (text.includes("не удалось достав") || text.includes("delivery failed")) {
    return {
      code: "delivery_failed",
      label: "无法妥投",
      accountingHint: "无法妥投按“货物成本 + 收单费”损失口径处理。"
    };
  }
  if (text.includes("тамож") || text.includes("customs")) {
    return {
      code: "customs_failed",
      label: "清关失败",
      accountingHint: "清关失败按“货物成本 + 收单费”损失口径处理。"
    };
  }
  if (text.includes("не забрал") || text.includes("not accepted") || text.includes("unclaim") || text.includes("pickup")) {
    return {
      code: "unclaimed_or_rejected",
      label: "买家未取货/拒收",
      accountingHint: "买家未取货按“货物成本 + 收单费”损失口径处理。"
    };
  }
  if (text.includes("не подош") || text.includes("not suitable")) {
    return {
      code: "item_unsuitable",
      label: "商品不合适",
      accountingHint: "商品不合适按“货物成本 + 收单费 + 国际运费”损失口径处理。"
    };
  }
  if (text.includes("не тот товар") || text.includes("wrong item")) {
    return {
      code: "wrong_item",
      label: "发错货",
      accountingHint: "发错货按“货物成本 + 收单费 + 国际运费”损失口径处理。"
    };
  }
  if (text.includes("поврежден") || text.includes("damaged")) {
    return {
      code: "damaged_in_delivery",
      label: "商品破损",
      accountingHint: "商品破损按“货物成本 + 收单费 + 国际运费”损失口径处理。"
    };
  }
  if (text.includes("недоволен каче") || text.includes("quality issue")) {
    return {
      code: "aftersale_quality_issue",
      label: "质量问题",
      accountingHint: "质量问题按“佣金 + 货物成本 + 收单费 + 国际运费”损失口径处理。"
    };
  }
  if (text.includes("срок доставки") || text.includes("delivery time")) {
    return {
      code: "delivery_delay",
      label: "配送时效问题",
      accountingHint: "配送时效不满意通常属于履约前取消，按 0 损失处理。"
    };
  }
  if (text.includes("stock") || text.includes("нет")) {
    return {
      code: "out_of_stock",
      label: "库存不足",
      accountingHint: "库存不足通常属于履约前取消，按 0 损失处理。"
    };
  }
  if (text.includes("ошиб") || text.includes("error")) {
    return {
      code: "input_error",
      label: "下单信息错误",
      accountingHint: "下单信息错误通常属于履约前取消，按 0 损失处理。"
    };
  }
  if (text.includes("дешев") || text.includes("cheap")) {
    return {
      code: "price_change",
      label: "价格原因取消",
      accountingHint: "价格原因取消通常属于履约前取消，按 0 损失处理。"
    };
  }
  return {
    code: "other",
    label: "其他取消/退货原因",
    accountingHint: "需要结合订单结果类型和真实财务明细进一步确认。"
  };
}

export function classifyCancellationReason(row = {}) {
  const text = normalizeLower(
    row.cancel_reason,
    row.cancel_type,
    row.cancel_initiator,
    row.raw_cancellation_reason,
    row.cancel_reason_id
  );
  for (const rule of cancellationRules()) {
    if (matchesRule(text, rule)) {
      return {
        code: rule.reason_code || "other",
        label: rule.reason_group_label || rule.reason_label || "其他取消/退货原因",
        accountingHint: rule.accounting_hint || "需要结合订单结果类型和真实财务明细进一步确认。",
        matchedRuleId: Number(rule.id || 0)
      };
    }
  }
  const fallback = fallbackClassification(text);
  return { ...fallback, matchedRuleId: 0 };
}

export function describeCancellation(row = {}) {
  const rule = matchedRule(row);
  const outcomeType = row.outcome_type || classifyOrderOutcome(row);
  const reasonClass = classifyCancellationReason(row);
  const reasonLabel = String(rule?.reason_label || "").trim() || cancelReasonLabel(row.cancel_reason || row.raw_cancellation_reason || "") || reasonClass.label;
  const lossProfile = resolveOrderLossProfile({
    ...row,
    outcome_type: outcomeType,
    reason_code: reasonClass.code,
    reason_label: reasonLabel,
    reason_group_label: reasonClass.label
  });
  return {
    initiator_label: String(rule?.initiator_label || "").trim() || cancelInitiatorLabel(row.cancel_initiator || cancelTypeLabel(row.cancel_type)),
    reason_label: reasonLabel,
    reason_code: reasonClass.code,
    reason_group_label: reasonClass.label,
    accounting_hint: reasonClass.accountingHint,
    loss_profile_code: lossProfile.code,
    loss_profile_label: lossProfile.label,
    loss_formula_text: lossProfile.formulaText,
    loss_formula_components: lossProfile.components,
    raw_reason_text: normalizeText(row.cancel_reason, row.raw_cancellation_reason),
    matched_rule_id: Number(reasonClass.matchedRuleId || 0)
  };
}

export function testCancellationRule(body = {}) {
  const sample = {
    status: body.status || "",
    substatus: body.substatus || "",
    tracking_stage: body.tracking_stage || "",
    logistics_status: body.logistics_status || "",
    cancel_reason: body.cancel_reason || "",
    cancel_type: body.cancel_type || "",
    cancel_initiator: body.cancel_initiator || "",
    raw_cancellation_reason: body.raw_cancellation_reason || "",
    cancel_reason_id: body.cancel_reason_id || "",
    cancelled_after_ship: Number(body.cancelled_after_ship || 0),
    delivered_at: body.delivered_at || "",
    accrued_at: body.accrued_at || ""
  };
  const outcome = classifyOrderOutcome(sample);
  const cancellation = describeCancellation({ ...sample, outcome_type: outcome });
  const rule = matchedRule(sample);
  return {
    sample,
    outcome_type: outcome,
    cancellation,
    matched_rule: rule ? {
      id: Number(rule.id || 0),
      name: rule.name || "",
      match_text: rule.match_text || "",
      match_mode: rule.match_mode || "contains",
      priority: Number(rule.priority || 0)
    } : null
  };
}
