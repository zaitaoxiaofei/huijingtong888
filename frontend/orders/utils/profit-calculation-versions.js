const FIELD_LABELS = {
  quantity: "数量", sale_price: "单件售价", sale_amount_cny: "销售额", purchase_cost: "采购成本",
  domestic_shipping: "国内运费", international_shipping: "国际运费", handling_fee: "处理费", purchase_quantity: "采购分摊数量",
  package_weight_g: "包裹重量（克）", length_cm: "长（厘米）", width_cm: "宽（厘米）", height_cm: "高（厘米）",
  exchange_rate: "汇率", return_rate: "退货率", advertising_rate: "广告费率", withdrawal_fee_rate: "提现费率",
  frozen_purchase_cost: "冻结采购成本", frozen_domestic_shipping: "冻结国内运费",
  frozen_international_shipping: "冻结单件国际运费", frozen_handling_fee: "冻结处理费",
  frozen_logistics_rule_id: "计费规则编号", logistics_rule_id: "物流规则编号", resolved_logistics_rule_id: "匹配计费规则编号", logistics_rule_name: "计费规则",
  logistics_rule_carrier: "计费物流商", logistics_rule_channel: "计费运输渠道", logistics_rule_base_fee_cny: "计费基础费",
  logistics_rule_per_gram_cny: "计费每克费", logistics_rule_per_ticket_cny: "计费每票费",
  logistics_rule_min_weight_g: "计费最低重量（克）", logistics_rule_max_weight_g: "计费最高重量（克）",
  logistics_rule_min_price_rub: "计费最低货值（卢布）", logistics_rule_max_price_rub: "计费最高货值（卢布）",
  ogl_parcel_value_rub: "OGL包裹货值（卢布）", pricing_effective_at: "费率匹配时间",
  name: "名称", carrier: "物流商", channel: "运输渠道", version: "版本", version_no: "版本序号",
  effective_from: "生效时间", effective_to: "失效时间", base_fee_cny: "基础费", per_gram_cny: "每克费",
  per_ticket_cny: "每票费", estimated_profit: "预估利润", actual_profit: "真实利润", net_profit_cny: "净利润",
  purchase_cost_cny: "采购成本合计", domestic_shipping_cny: "国内运费合计", international_shipping_cny: "国际运费合计",
  packaging_cost_cny: "包装处理费", commission_fee_cny: "佣金", commission_rate: "佣金率",
  ozon_service_fee_cny: "Ozon服务费", return_loss_cny: "售后损失", advertising_cost_cny: "广告费", other_fee_cny: "其他费用",
  freight: "单件预估运费", commission: "预估佣金", paymentFee: "尾程银行费", withdrawalFee: "提现费",
  estimated_commission: "冻结预估佣金", expectedReturnLoss: "预估退货损失", profit: "利润", gross_profit_cny: "毛利润",
  platform_fee_actual: "已保存平台费用", aftersale_loss: "已保存售后损失", advertisingCost: "预估广告费", commissionRate: "预估佣金率",
  service_name: "财务费用名称", service_type: "财务费用类型", amount_cny: "财务金额", operation_date: "财务日期",
  status: "订单状态", settlement_state: "结算状态", profit_status: "利润状态", outcome_type: "订单结果",
  ordered_at: "下单时间", is_locked: "已锁定", locked_at: "锁定时间", lock_reason: "锁定原因"
};

export function profitVersionSummary(row = {}) {
  const versions = [...new Set(String(row.profit_formula_versions || "").split(",").map((value) => value.trim()).filter(Boolean))];
  const legacy = row.profit_calculation_legacy === true || Number(row.profit_calculation_legacy) === 1;
  return {
    label: versions.length > 1 ? "多版本" : versions[0] || "未记录",
    tooltip: versions.length ? `${versions.join(" / ")}${legacy ? " · 历史基线：保留原有金额，历史计算输入未完整留存。" : " · 按订单固定版本计算，重算沿用原版本。"}` : "尚无版本记录，未登记公式版本或历史基线。",
    legacy
  };
}

export function versionReferenceText(value) {
  if (value === undefined || value === null || value === "") return "未记录";
  if (typeof value !== "object") return String(value);
  const id = value.id ?? value.logistics_rule_id ?? value.cost_version_id;
  return [value.name || value.logistics_rule_name, value.version || value.version_no, id ? `#${id}` : ""].filter(Boolean).join(" · ") || "未记录";
}

export function calculationSnapshotRows(snapshot = {}, formatTime = (value) => value) {
  const rows = [];
  function visit(value, prefix = "") {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined || item === "") continue;
      if (typeof item === "object") {
        if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${prefix}${key === "finance_rows" ? "财务" : "明细"}${index + 1} · `));
        else visit(item, prefix);
      } else if (FIELD_LABELS[key]) {
        const statusLabels = { pending: "待结算", estimated: "预估", accrued: "已结算", finance_accrued: "Ozon账单锁定" };
        const text = /(?:_at|_from|_to|_date)$/.test(key) ? formatTime(item)
          : key === "is_locked" ? (Number(item) === 1 ? "是" : "否")
            : ["settlement_state", "profit_status", "lock_reason"].includes(key) ? statusLabels[item] || String(item) : String(item);
        rows.push({ label: `${prefix}${FIELD_LABELS[key]}`, value: text });
      }
    }
  }
  visit(snapshot);
  return rows;
}
