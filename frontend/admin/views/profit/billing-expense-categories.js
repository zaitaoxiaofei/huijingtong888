export const billingExpenseCategories = [
  {value:"internet",label:"网络费用",hint:"宽带费用按公司分摊的当月费用，不重复计入全年付款。"},
  {value:"ai_tokens",label:"外部AI Token费用",hint:"历史外部AI调用费用，估算与实际账单分别核对。"},
  { value:"order_payment",label:"Ozon收单费更正",hint:"订单收单费的补充与更正，不含连连提现手续费。" },
  { value: "domestic_shipping", label: "订单国内运费", hint: "订单国内运费的补充或更正；已分摊金额不要重复录入。" },
  { value: "fbp_stocking_shipping", label: "FBP备货运费", hint: "国内备货发往FBP仓库的快递费；按发生日期计入净利润，不分摊订单。已含在其他成本中的不要重复录入。" },
  { value: "packaging", label: "包装费用", hint: "补充包装费用或订单包装费用更正，不与订单已分摊金额重复录入。" },
  { value: "ai_subscription", label: "AI固定订阅费", hint: "ChatGPT Pro等订阅，已含在日常经营费用中。" },
  { value: "rent", label: "场地租金", hint: "办公室、仓库等场地租用费用" },
  { value: "utilities", label: "水电费", hint: "水费、电费等场地公用支出" },
  { value: "subsidy", label: "员工补贴", hint: "餐补、交通和通讯补贴；工资已含的不要重复录入。" },
  { value: "office", label: "办公用品", hint: "办公耗材和用品" },
  { value: "software", label: "其他软件订阅", hint: "除AI订阅外的软件费用，避免重复录入。" },
  { value: "team_building", label: "团建费用", hint: "聚餐、团队活动等员工团建支出。" },
  { value: "equipment_maintenance", label: "设备维修与耗材", hint: "电脑、打印机等维修及配件；设备购置另行记录。" },
  { value: "withdrawal", label: "提现手续费", hint: "连连等渠道提现的实际手续费；登记后替换本期1.2%估算，不重复扣。" },
  { value: "currency_exchange", label: "换汇手续费", hint: "明确收取的换汇手续费，不把汇率波动当成手续费。" },
  { value: "travel", label: "差旅费用", hint: "出差交通、住宿等" },
  { value: "bank", label: "银行手续费", hint: "公司账户转账手续费，不含平台已扣手续费。" },
  { value: "temporary_labor", label: "临时用工", hint: "临时包装、搬运等用工支出" },
  { value: "other", label: "其他经营杂费", hint: "未归类的日常支出，请写明具体用途。" },
  { value: "salary", label: "工资支出", hint: "员工工资；已含的补贴不再单独录入。" }
];

export function billingExpenseCategoryLabel(category) {
  return billingExpenseCategories.find((item) => item.value === category)?.label || `未分类费用（${category || "空"}）`;
}

export function summarizeBillingExpenses(rows = []) {
  const totals = new Map(billingExpenseCategories.map((item) => [item.value, { ...item, amount: 0, count: 0 }]));
  for (const row of rows) {
    const key = row.category || "other";
    if (!totals.has(key)) totals.set(key, { value: key, label: billingExpenseCategoryLabel(key), hint: "历史费用类型", amount: 0, count: 0 });
    const item = totals.get(key);
    item.amount += Math.round(Number(row.amount_cny || 0) * 100);
    item.count += 1;
  }
  return [...totals.values()].map((item) => ({ ...item, amount: item.amount / 100 }));
}
