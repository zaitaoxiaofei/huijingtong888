const fail = message => Object.assign(new Error(message), { statusCode: 409 });

export function normalizeAdvertisingBid(body) {
  const uint64 = (value, label) => {
    const text = String(value ?? "");
    if (!/^\d{1,20}$/.test(text) || BigInt(text) <= 0n || BigInt(text) > 18446744073709551615n) throw fail(`${label}无效，请重新同步广告后选择`);
    return BigInt(text).toString();
  };
  const campaignId = uint64(body.campaign_id ?? body.campaignId, "广告活动编号");
  const sku = uint64(body.ozon_sku ?? body.sku, "广告商品 SKU");
  const mode = body.mode;
  if (!["bid", "targetCir"].includes(mode)) throw fail("请选择点击出价或目标广告费用份额");
  const text = String(mode === "bid" ? body.bid_rub ?? body.bidRub ?? "" : body.target_cir ?? body.targetCir ?? "");
  if (!/^\d{1,12}(?:\.\d{1,4})?$/.test(text) || Number(text) <= 0) throw fail("广告参数必须大于零且最多四位小数，请在广告策略设置中修改");
  const value = Number(text);
  if (mode === "targetCir" && (value < 10 || value > 100)) throw fail("目标广告费用份额必须在 10% 至 100% 之间");
  if (body.confirmKeywordReset !== true) throw fail("官方调价方法可能覆盖活动原有否定词和关键词出价，请阅读风险提示并确认后保存");
  const [whole, fraction = ""] = text.split(".");
  const bid = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))).toString();
  return { campaignId, sku, mode, value, product: mode === "bid" ? { sku, bid } : { sku, targetCir: value } };
}

async function readProduct(request, campaignId, sku) {
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const data = await request(`/api/client/campaign/${campaignId}/v2/products?page=${page}&pageSize=100`, null, "GET");
    if (!Array.isArray(data?.products)) throw fail("广告商品列表格式异常，请重新同步后核对");
    for (const row of data.products) {
      const id = String(row.sku);
      if (seen.has(id)) throw fail("广告商品分页重复，请刷新核对后再调价");
      seen.add(id);
    }
    const row = data.products.find(row => String(row.sku) === sku);
    if (row) return row;
    if (data.products.length < 100) return null;
  }
  throw fail("广告商品分页超过核查上限，已停止调价");
}

export async function executeAdvertisingBid(setting, request) {
  const { campaignId, sku, mode, product } = setting;
  const catalog = await request(`/api/client/campaign?campaignIds=${campaignId}&advObjectType=SKU`, null, "GET");
  if (!Array.isArray(catalog?.list)) throw fail("广告活动列表格式异常，请重新同步广告后核对");
  const campaign = catalog.list.find(row => String(row.id) === campaignId);
  const required = mode === "bid" ? "TARGET_BIDS" : "TARGET_CIR";
  if (!campaign || campaign.productAutopilotStrategy !== required) throw fail(`当前活动策略不支持该调整，请在 Ozon 后台确认${mode === "bid" ? "平均点击成本" : "目标费用份额"}策略后重新同步`);
  if (!await readProduct(request, campaignId, sku)) throw fail("当前商品不在该广告活动中，已停止调价，请重新同步广告");
  let result;
  try { result = await request(`/api/client/campaign/${campaignId}/products`, { bids: [product] }, "PUT"); }
  catch (error) { throw fail(`本次调价未确认：${error.message}。请先在 Ozon 后台或刷新后核对，勿连续重复提交。`); }
  if (result?.error) throw fail(`Ozon 拒绝广告调价：${String(result.error)}`);
  try {
    const row = await readProduct(request, campaignId, sku);
    const matches = mode === "bid" ? /^\d+$/.test(String(row?.bid)) && BigInt(row.bid) === BigInt(product.bid)
      : row?.targetCir !== null && row?.targetCir !== undefined && Number(row.targetCir) === product.targetCir;
    if (!matches) throw fail("读回值尚未与本次提交一致");
    return { ok: true, verified: true, result };
  } catch (error) {
    return { ok: false, verified: false, pending_verification: true, message: `已发送调价，但未完成回读确认：${error.message}。请先刷新核对，勿连续重复提交。`, result };
  }
}
