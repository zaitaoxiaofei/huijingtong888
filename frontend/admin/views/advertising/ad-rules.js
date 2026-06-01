function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value) {
  return num(value) * 100;
}

function pushUnique(target, item) {
  if (!item?.label) return;
  if (!target.some((tag) => tag.label === item.label)) target.push(item);
}

export function evaluateAdSku(row = {}) {
  const spend = num(row.spend_rub);
  const revenue = num(row.revenue_rub);
  const clicks = num(row.clicks);
  const addToCart = num(row.add_to_cart);
  const addToCartAvailable = num(row.add_to_cart_available) > 0;
  const impressions = num(row.impressions);
  const orders = num(row.orders);
  const ctr = impressions ? clicks / impressions : num(row.ctr);
  const cr = clicks ? orders / clicks : num(row.conversion_rate);
  const roas = spend ? revenue / spend : num(row.roas);
  const acos = revenue ? spend / revenue : num(row.acos);
  const cpc = clicks ? spend / clicks : num(row.cpc_rub);
  const grossMarginRate = row.gross_margin_rate == null ? null : num(row.gross_margin_rate);
  const adNetProfit = grossMarginRate == null ? null : revenue * grossMarginRate - spend;

  const tags = [];
  const suggestions = [];
  const actions = [];
  const risks = [];

  if (ctr < 0.005 && impressions > 0) {
    pushUnique(tags, { label: "❌ 主图严重不行", tone: "danger" });
    risks.push("CTR 低于 0.5%，主图/首屏吸引力严重不足");
    suggestions.push("立刻更换主图，增加车型展示、真人场景、俄语强卖点");
    actions.push("创建主图优化任务");
  } else if (ctr < 0.01 && impressions > 0) {
    pushUnique(tags, { label: "⚠ 主图偏弱", tone: "warning" });
    suggestions.push("优化主图，检查价格和标题是否匹配搜索意图");
    actions.push("创建主图优化任务");
  } else if (ctr < 0.02 && impressions > 0) {
    pushUnique(tags, { label: "✅ CTR正常", tone: "success" });
  } else if (ctr >= 0.02) {
    pushUnique(tags, { label: "🔥 高点击率SKU", tone: "success" });
    suggestions.push("点击率优秀，可尝试增加曝光");
  }

  if (cr < 0.005 && clicks > 0) {
    pushUnique(tags, { label: "❌ 严重低转化", tone: "danger" });
    risks.push("CR 低于 0.5%，点击进来但几乎不成交");
    suggestions.push("检查详情页、价格、评价、物流和 SKU 匹配");
    actions.push("创建详情页优化任务");
  } else if (cr < 0.015 && clicks > 0) {
    pushUnique(tags, { label: "⚠ 转化偏低", tone: "warning" });
    suggestions.push("增加安装图、使用场景、买家秀和俄语卖点");
    actions.push("创建详情页优化任务");
  } else if (cr < 0.03 && clicks > 0) {
    pushUnique(tags, { label: "✅ CR正常", tone: "success" });
  } else if (cr >= 0.03) {
    pushUnique(tags, { label: "🔥 高转化SKU", tone: "success" });
    suggestions.push("转化率优秀，可提高排名或测试 CPA");
  }

  if (roas > 0 && roas < 1) {
    pushUnique(tags, { label: "❌ 严重亏损", tone: "danger" });
    suggestions.push("立即暂停广告或大幅降低竞价");
    actions.push("暂停广告复核");
  } else if (roas < 2 && spend > 0) {
    pushUnique(tags, { label: "⚠ 亏损边缘", tone: "warning" });
    suggestions.push("降低竞价，优先优化转化");
  } else if (roas < 4 && spend > 0) {
    pushUnique(tags, { label: "✅ ROAS正常", tone: "success" });
  } else if (roas >= 4) {
    pushUnique(tags, { label: "🔥 高利润广告", tone: "success" });
    suggestions.push("广告回报优秀，可加预算");
    actions.push("加预算复核");
  }

  if (acos > 0.4) {
    pushUnique(tags, { label: "⚠ ACOS过高", tone: "warning" });
    suggestions.push("降低竞价，提高转化率，检查详情页承接");
  } else if (acos > 0 && acos < 0.2) {
    pushUnique(tags, { label: "🔥 广告效率优秀", tone: "success" });
  }

  if (grossMarginRate != null) {
    if (grossMarginRate < 0.15) {
      pushUnique(tags, { label: "❌ 不建议投广告", tone: "danger" });
      suggestions.push("低毛利 SKU 不建议做 CPA，优先自然流量和多链接铺货");
    } else if (grossMarginRate < 0.3) {
      pushUnique(tags, { label: "⚠ 低毛利产品", tone: "warning" });
      suggestions.push("只允许 CPC，严格控制广告费");
    } else if (grossMarginRate > 0.4) {
      pushUnique(tags, { label: "🔥 高利润产品", tone: "success" });
    }
  } else {
    pushUnique(tags, { label: "毛利待接入", tone: "neutral" });
  }

  if (grossMarginRate != null && grossMarginRate > 0.4 && cr > 0.03 && roas > 4) {
    pushUnique(tags, { label: "✅ 可尝试CPA", tone: "success" });
  } else if (grossMarginRate != null && grossMarginRate < 0.4) {
    pushUnique(tags, { label: "⚠ 不适合CPA", tone: "warning" });
  }

  if (clicks > 500 && cr < 0.005) {
    pushUnique(tags, { label: "❌ 测品失败", tone: "danger" });
    suggestions.push("点击超过 500 且转化极低，建议立即停广告");
    actions.push("止损复核");
  }
  if (spend > 300 && orders === 0) {
    pushUnique(tags, { label: "❌ 广告烧钱", tone: "danger" });
    suggestions.push("花费超过 300 RUB 且无订单，建议暂停广告");
    actions.push("暂停广告复核");
  }
  if (clicks > 80 && cr < 0.01) {
    pushUnique(tags, { label: "⚠ 高点击低转化", tone: "warning" });
  }

  const stage = resolveAdStage({ row, ctr, cr, roas, spend, orders, clicks });
  const status = resolveStatus({ tags, ctr, cr, roas, spend, orders });
  const healthScore = scoreAd({ ctr, cr, roas, acos, spend, orders, grossMarginRate });
  const riskLevel = healthScore < 35 ? "high" : healthScore < 60 ? "medium" : healthScore < 78 ? "watch" : "low";
  const diagnosis = buildDiagnosis({ tags, status, stage, spend, orders, roas, cr, ctr });

  if (!suggestions.length) suggestions.push("继续观察，保持当前投放节奏");
  if (!actions.length) actions.push("继续观察");

  return {
    metrics: { spend, revenue, clicks, addToCart, addToCartAvailable, impressions, ctr, cr, roas, acos, cpc, orders, grossMarginRate, adNetProfit },
    healthScore,
    riskLevel,
    status,
    stage,
    diagnosis,
    tags,
    suggestions: [...new Set(suggestions)].slice(0, 4),
    actions: [...new Set(actions)].slice(0, 3),
    risks
  };
}

function resolveAdStage({ row, ctr, cr, roas, spend, orders, clicks }) {
  const activeDays = num(row.active_days);
  if (activeDays > 0 && activeDays <= 14 && clicks < 100) return { key: "testing", label: "🧪 测款", tone: "warning" };
  if (ctr >= 0.02 && cr >= 0.03 && roas >= 4) return { key: "scale", label: "🚀 放量", tone: "primary" };
  if (activeDays >= 7 && orders >= 7 && roas >= 2) return { key: "stable", label: "🔥 稳定", tone: "success" };
  if ((spend > 300 && orders === 0) || (clicks > 500 && cr < 0.005)) return { key: "stop_loss", label: "❌ 止损", tone: "danger" };
  return { key: "observe", label: "👀 观察", tone: "neutral" };
}

function resolveStatus({ tags, ctr, cr, roas, spend, orders }) {
  const labels = tags.map((tag) => tag.label).join(" ");
  if (labels.includes("建议暂停") || labels.includes("烧钱") || labels.includes("严重亏损") || (spend > 300 && orders === 0)) {
    return { key: "pause", label: "建议暂停", tone: "danger" };
  }
  if (labels.includes("主图") || labels.includes("低转化") || labels.includes("ACOS过高") || (ctr < 0.01 && spend > 0) || (cr < 0.015 && spend > 0)) {
    return { key: "optimize", label: "建议优化", tone: "warning" };
  }
  if (roas >= 4 && cr >= 0.03) return { key: "scale", label: "可加预算", tone: "primary" };
  if (spend > 0 && orders === 0) return { key: "watch", label: "需观察", tone: "warning" };
  return { key: "normal", label: "正常", tone: "success" };
}

function scoreAd({ ctr, cr, roas, acos, spend, orders, grossMarginRate }) {
  let score = 50;
  if (ctr >= 0.02) score += 15;
  else if (ctr >= 0.01) score += 6;
  else if (ctr > 0) score -= 14;
  if (cr >= 0.03) score += 18;
  else if (cr >= 0.015) score += 8;
  else if (cr > 0) score -= 16;
  if (roas >= 4) score += 20;
  else if (roas >= 2) score += 8;
  else if (spend > 0) score -= 18;
  if (acos > 0.4) score -= 10;
  if (spend > 300 && orders === 0) score -= 25;
  if (grossMarginRate != null && grossMarginRate < 0.15) score -= 12;
  if (grossMarginRate != null && grossMarginRate > 0.4) score += 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildDiagnosis({ tags, status, stage, spend, orders, roas, cr, ctr }) {
  if (spend > 300 && orders === 0) return "高花费无订单";
  if (ctr < 0.01 && spend > 0) return "主图点击弱";
  if (cr < 0.015 && orders > 0) return "点击后转化偏弱";
  if (roas >= 4 && orders > 0) return "广告回报优秀";
  if (status.key === "scale") return "可放量 SKU";
  if (stage.key === "testing") return "测款中";
  return tags[0]?.label?.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "") || "继续观察";
}

export function buildAdTasks(rows = []) {
  return rows.flatMap((row) => {
    const evaluation = row.evaluation || evaluateAdSku(row);
    const tasks = [];
    if (evaluation.tags.some((tag) => tag.label.includes("主图"))) {
      tasks.push(task(row, evaluation, "main_image", "主图优化任务", "CTR 过低，优先优化主图"));
    }
    if (evaluation.tags.some((tag) => tag.label.includes("转化") || tag.label.includes("详情"))) {
      tasks.push(task(row, evaluation, "detail_page", "详情页优化任务", "CR 偏低，检查详情页、价格、评价和物流"));
    }
    if (evaluation.status.key === "pause") {
      tasks.push(task(row, evaluation, "stop_loss", "止损复核任务", "广告花费风险高，建议人工复核是否暂停"));
    }
    if (evaluation.status.key === "scale") {
      tasks.push(task(row, evaluation, "budget", "加预算复核任务", "广告效率优秀，可人工复核加预算"));
    }
    return tasks;
  }).slice(0, 20);
}

function task(row, evaluation, type, title, reason) {
  return {
    id: `${type}-${row.shop_id}-${row.ozon_sku}`,
    type,
    title,
    sku: row.ozon_sku,
    shop: row.shop_name,
    productName: row.product_name || row.offer_id || "",
    imageUrl: row.image_url || "",
    reason,
    healthScore: evaluation.healthScore,
    status: "待处理",
    suggestions: evaluation.suggestions
  };
}

export function summarizeAdDashboard(rows = []) {
  const evaluated = rows.map((row) => ({ ...row, evaluation: row.evaluation || evaluateAdSku(row) }));
  const byScore = [...evaluated].sort((a, b) => b.evaluation.healthScore - a.evaluation.healthScore);
  const byRisk = [...evaluated].sort((a, b) => a.evaluation.healthScore - b.evaluation.healthScore);
  const highClickLowCr = evaluated.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("高点击低转化")));
  const noOrderSpend = evaluated.filter((row) => row.evaluation.metrics.spend > 300 && row.evaluation.metrics.orders === 0);
  const scale = evaluated.filter((row) => row.evaluation.status.key === "scale");
  const pause = evaluated.filter((row) => row.evaluation.status.key === "pause");
  const averageScore = evaluated.length
    ? Math.round(evaluated.reduce((sum, row) => sum + row.evaluation.healthScore, 0) / evaluated.length)
    : 0;

  return {
    evaluated,
    averageScore,
    best: byScore[0] || null,
    worst: byRisk[0] || null,
    highRisk: byRisk.slice(0, 5),
    bestRows: byScore.slice(0, 5),
    highClickLowCr,
    noOrderSpend,
    scale,
    pause
  };
}

export function toneType(tone) {
  if (tone === "danger") return "danger";
  if (tone === "warning") return "warning";
  if (tone === "success") return "success";
  if (tone === "primary") return "primary";
  return "info";
}
