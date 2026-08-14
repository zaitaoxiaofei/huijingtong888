<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Bell, Refresh, Search, TrendCharts } from "@element-plus/icons-vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { apiClient } from "../../utils/api";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { shanghaiDateText } from "../../utils/shanghai-date";
import { openExternalProductLink, ozonBuyerProductLinkFromRow } from "../../utils/product-links";

const loading = ref(false);
const dialogVisible = ref(false);
const shops = ref([]);
const people = ref([]);
const rows = ref([]);
const total = ref(0);
const filters = reactive({ keyword: "", inventoryKeyword: "", shopId: "all", status: "all", tracked: "all", skuScope: "ordered", page: 1, pageSize: 30 });
const form = reactive({ shop_id: 0, ozon_sku: "", product_name: "", owner_person_id: null, decline_weeks: 2, decline_percent: 20, active: true });
const summary = computed(() => ({
  tracked: rows.value.filter((row) => Number(row.tracked)).length,
  declining: rows.value.filter((row) => ["continuous_decline", "sharp_decline"].includes(row.trend_status)).length,
  rising: rows.value.filter((row) => row.trend_status === "rising_star").length,
  sales: rows.value.reduce((sum, row) => sum + Number(row.week_1_sales || 0), 0)
}));

function numberText(value) { return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }
function moneyText(value, currency = "RUB") { return `${numberText(value)} ${currency}`; }
function dateText(value) { return value ? shanghaiDateText(value, { assumeUtcWhenNaive: true }) : "-"; }
function trendMeta(status) { return { rising_star: ["新星", "success"], continuous_decline: ["持续下滑", "danger"], sharp_decline: ["骤降", "danger"], stable: ["稳定", "info"] }[status] || ["稳定", "info"]; }
function changeText(row) { const a = Number(row.week_1_sales || 0); const b = Number(row.week_2_sales || 0); if (!b) return a ? "+100%" : "0%"; const value = Math.round(((a - b) / b) * 100); return `${value > 0 ? "+" : ""}${value}%`; }
function changeClass(row) { return Number(row.week_1_sales || 0) >= Number(row.week_2_sales || 0) ? "is-up" : "is-down"; }
function sparkPoints(values, width = 116, height = 38) { if (!values.length) return ""; const max = Math.max(1, ...values); const min = Math.min(0, ...values); const span = max - min || 1; return values.map((value, index) => `${(index * width) / Math.max(1, values.length - 1)},${height - ((value - min) / span) * (height - 6) - 3}`).join(" "); }
function salesSpark(row) { return sparkPoints([Number(row.week_3_sales || 0), Number(row.week_2_sales || 0), Number(row.week_1_sales || 0)]); }
function priceSpark(row) { return sparkPoints((row.price_trend || []).map((item) => Number(item.value || 0))); }
function imageList(row) { return [...new Set(String(row.image_urls || row.image_url || "").split("||").map((value) => value.trim()).filter(Boolean))]; }
function openProduct(row) { const link = ozonBuyerProductLinkFromRow(row); if (link) openExternalProductLink(link); else ElMessage.warning("该 SKU 暂无可用的 Ozon 前台链接"); }

async function loadOptions() {
  const [shopPayload, personPayload] = await Promise.all([loadShopDictionary(), apiClient.get("/api/people")]);
  shops.value = Array.isArray(shopPayload?.rows) ? shopPayload.rows : (Array.isArray(shopPayload) ? shopPayload : []);
  people.value = Array.isArray(personPayload?.rows) ? personPayload.rows : (Array.isArray(personPayload) ? personPayload : []);
}
async function loadRows() {
  loading.value = true;
  try { const params = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)])); const payload = await apiClient.get(`/api/sku-order-tracking?${params}`); rows.value = payload?.rows || []; total.value = Number(payload?.total || 0); }
  catch (error) { ElMessage.error(error?.message || "单量追踪数据加载失败"); }
  finally { loading.value = false; }
}
function search() { filters.page = 1; loadRows(); }
function openTracker(row) { Object.assign(form, { shop_id: row.shop_id, ozon_sku: row.ozon_sku, product_name: row.product_name, owner_person_id: row.owner_person_id || null, decline_weeks: Number(row.decline_weeks || 2), decline_percent: Number(row.decline_percent || 20), active: true }); dialogVisible.value = true; }
async function saveTracker() { if (!form.owner_person_id) return ElMessage.warning("请选择负责人员，预警才能定向送达"); await apiClient.post("/api/sku-order-tracking", form); ElMessage.success("追踪配置已保存"); dialogVisible.value = false; await loadRows(); }
async function stopTracking(row) { await apiClient.post("/api/sku-order-tracking", { shop_id: row.shop_id, ozon_sku: row.ozon_sku, active: false }); ElMessage.success("已停止追踪"); await loadRows(); }
onMounted(async () => { await loadOptions(); await loadRows(); });
</script>

<template>
  <div class="order-tracking-page">
    <ErpPageHeader title="单量追踪" description="发现爆款衰退、价格异动与连续增长的新星，把风险落实到负责人。"><template #actions><el-button :icon="Refresh" :loading="loading" @click="loadRows">刷新数据</el-button></template></ErpPageHeader>
    <section class="summary-strip">
      <div class="summary-title"><TrendCharts /><span>当前页概览</span></div><div class="summary-item"><span>近 7 天销量</span><strong>{{ numberText(summary.sales) }}</strong></div><div class="summary-divider" /><div class="summary-item danger"><span>下滑 SKU</span><strong>{{ summary.declining }}</strong></div><div class="summary-divider" /><div class="summary-item success"><span>潜力新星</span><strong>{{ summary.rising }}</strong></div><div class="summary-divider" /><div class="summary-item"><span>已追踪</span><strong>{{ summary.tracked }}</strong></div><span class="summary-note">下方按累计销量排名</span>
    </section>
    <ErpFilterBar>
      <el-input v-model="filters.keyword" clearable placeholder="搜索 SKU / 商品 / 店铺" :prefix-icon="Search" style="width:230px" @keyup.enter="search" />
      <el-input v-model="filters.inventoryKeyword" clearable placeholder="筛选库存名称 / 编码" style="width:210px" @keyup.enter="search" />
      <el-select v-model="filters.shopId" style="width:150px" @change="search"><el-option label="全部店铺" value="all" /><el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" /></el-select>
      <el-select v-model="filters.skuScope" style="width:150px" @change="search"><el-option label="仅展示出单 SKU" value="ordered" /><el-option label="展示全部 SKU" value="all" /></el-select>
      <el-select v-model="filters.status" style="width:135px" @change="search"><el-option label="全部趋势" value="all" /><el-option label="持续下滑" value="continuous_decline" /><el-option label="骤降" value="sharp_decline" /><el-option label="潜力新星" value="rising_star" /><el-option label="稳定" value="stable" /></el-select>
      <el-select v-model="filters.tracked" style="width:125px" @change="search"><el-option label="全部追踪状态" value="all" /><el-option label="仅已追踪" value="1" /><el-option label="未追踪" value="0" /></el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
    </ErpFilterBar>
    <div class="table-card">
      <el-table v-loading="loading" :data="rows" row-key="ozon_sku" class="tracking-table">
        <el-table-column label="排名" width="62" align="center" fixed="left"><template #default="{ $index }"><span class="rank" :class="`rank-${(filters.page - 1) * filters.pageSize + $index + 1}`">{{ (filters.page - 1) * filters.pageSize + $index + 1 }}</span></template></el-table-column>
        <el-table-column label="主图" width="88" align="center" fixed="left"><template #default="{ row }"><ProductImagePreview class="tracking-thumb" :src="imageList(row)[0] || ''" :preview-list="imageList(row)" fit="cover" :proxy-remote="true" /></template></el-table-column>
        <el-table-column label="商品名称 / SKU" min-width="300" fixed="left"><template #default="{ row }"><div class="product-info"><button type="button" @click="openProduct(row)">{{ row.product_name }}</button><span>SKU {{ row.ozon_sku }}</span><span v-if="row.tracked" class="owner-line">{{ row.owner_name || '未分配负责人' }} · 追踪中</span></div></template></el-table-column>
        <el-table-column label="对应库存" min-width="165"><template #default="{ row }"><div v-if="row.inventory_name" class="inventory-info"><strong>{{ row.inventory_name }}</strong><span>{{ row.inventory_code || `ID ${row.inventory_product_id}` }}</span></div><span v-else class="muted">未绑定库存</span></template></el-table-column>
        <el-table-column label="累计销量" width="92" align="center" sortable prop="total_sales"><template #default="{ row }"><strong class="sales-total">{{ numberText(row.total_sales) }}</strong><small class="metric-label">单</small></template></el-table-column>
        <el-table-column label="售价" width="108" align="right"><template #default="{ row }"><strong>{{ moneyText(row.sale_price, row.currency_code) }}</strong></template></el-table-column>
        <el-table-column prop="shop_name" label="店铺" min-width="118" show-overflow-tooltip /><el-table-column prop="logistics_method" label="物流" width="70" align="center"><template #default="{ row }"><el-tag size="small" effect="plain">{{ row.logistics_method }}</el-tag></template></el-table-column>
        <el-table-column label="上架时间" width="105" align="center"><template #default="{ row }"><span class="date-text">{{ dateText(row.listed_at) }}</span></template></el-table-column><el-table-column label="首单时间" width="105" align="center"><template #default="{ row }"><span class="date-text">{{ dateText(row.first_order_at) }}</span></template></el-table-column>
        <el-table-column label="第 3 周" width="64" align="center"><template #default="{ row }">{{ numberText(row.week_3_sales) }}</template></el-table-column><el-table-column label="第 2 周" width="64" align="center"><template #default="{ row }">{{ numberText(row.week_2_sales) }}</template></el-table-column><el-table-column label="本周" width="68" align="center"><template #default="{ row }"><strong>{{ numberText(row.week_1_sales) }}</strong></template></el-table-column>
        <el-table-column label="三周销量趋势" width="150"><template #default="{ row }"><div class="trend-chart"><svg viewBox="0 0 116 38" preserveAspectRatio="none"><polyline :points="salesSpark(row)" fill="none" :class="changeClass(row)" stroke-width="2.5" /></svg><span :class="changeClass(row)">环比 {{ changeText(row) }}</span></div></template></el-table-column>
        <el-table-column label="近 7 天分析" width="178"><template #default="{ row }"><div v-if="row.analytics_7d" class="analytics-cell"><strong>Ozon {{ numberText(row.analytics_7d.order_count) }} 单</strong><span>曝光 {{ numberText(row.analytics_7d.impressions) }} · 访问 {{ numberText(row.analytics_7d.card_views) }}</span><span>加购 {{ numberText(row.analytics_7d.add_to_cart) }} · 转化 {{ numberText(row.analytics_7d.conversion_rate) }}%</span><small>更新 {{ dateText(row.analytics_7d.captured_at) }}</small><el-tooltip v-if="row.analytics_28d" placement="top"><template #content>近 28 天：{{ numberText(row.analytics_28d.order_count) }} 单，{{ moneyText(row.analytics_28d.order_amount) }}</template><span class="more-data">查看 28 天</span></el-tooltip></div><span v-else class="muted">暂无分析快照</span></template></el-table-column>
        <el-table-column label="成交价趋势" width="135"><template #default="{ row }"><div class="price-trend"><svg viewBox="0 0 116 38" preserveAspectRatio="none"><polyline :points="priceSpark(row)" fill="none" stroke="#7c3aed" stroke-width="2.5" /></svg><small>近三周均价</small></div></template></el-table-column>
        <el-table-column label="判断" width="92" align="center"><template #default="{ row }"><el-tag :type="trendMeta(row.trend_status)[1]" effect="light">{{ trendMeta(row.trend_status)[0] }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="112" fixed="right" align="center"><template #default="{ row }"><el-button v-if="!row.tracked" type="primary" link :icon="Bell" @click="openTracker(row)">追踪</el-button><template v-else><el-button type="primary" link @click="openTracker(row)">设置</el-button><el-button type="danger" link @click="stopTracking(row)">停止</el-button></template></template></el-table-column>
      </el-table>
      <PageFooterPagination :page="filters.page" :page-size="filters.pageSize" :total="total" @update:page="filters.page=$event;loadRows()" @update:page-size="filters.pageSize=$event;filters.page=1;loadRows()" />
    </div>
    <el-dialog v-model="dialogVisible" title="SKU 追踪设置" width="520px" destroy-on-close><div class="dialog-product"><TrendCharts /><div><strong>{{ form.product_name }}</strong><span>SKU {{ form.ozon_sku }}</span></div></div><el-form label-position="top"><el-form-item label="负责人员（异常消息接收人）" required><el-select v-model="form.owner_person_id" filterable style="width:100%"><el-option v-for="person in people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item><div class="rule-row"><el-form-item label="连续下滑周数"><el-select v-model="form.decline_weeks"><el-option label="连续 2 周" :value="2" /><el-option label="连续 3 周" :value="3" /></el-select></el-form-item><el-form-item label="单周下滑阈值"><el-input-number v-model="form.decline_percent" :min="5" :max="90" :step="5" /><span class="suffix">%</span></el-form-item></div><el-alert title="预警逻辑" description="达到连续下滑条件或单周销量跌幅超过阈值时，定向通知负责人；连续三周上涨会标记为潜力新星。" type="info" show-icon :closable="false" /></el-form><template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" @click="saveTracker">保存并开始追踪</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.order-tracking-page{display:flex;flex-direction:column;gap:12px}.summary-strip{min-height:68px;padding:0 18px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;display:flex;align-items:center;gap:20px}.summary-title{display:flex;align-items:center;gap:8px;font-weight:600}.summary-title svg{width:19px;color:#6366f1}.summary-item{display:flex;align-items:baseline;gap:8px}.summary-item span,.summary-note{font-size:12px;color:#64748b}.summary-item strong{font-size:22px}.summary-item.danger strong{color:#dc2626}.summary-item.success strong{color:#059669}.summary-divider{width:1px;height:28px;background:#e2e8f0}.summary-note{margin-left:auto}.table-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}.tracking-table :deep(.el-table__header th){height:44px;background:#f8fafc!important;color:#475569}.tracking-table :deep(.el-table__row td){padding:6px 0}.rank{display:inline-grid;place-items:center;min-width:26px;height:26px;border-radius:13px;background:#f1f5f9;font-weight:700}.rank-1{color:#92400e;background:#fef3c7}.rank-2{background:#e2e8f0}.rank-3{color:#9a3412;background:#ffedd5}.tracking-thumb,.tracking-thumb :deep(.erp-image-preview__image),.tracking-thumb :deep(.el-image),.tracking-thumb :deep(img),.tracking-thumb :deep(.erp-image-preview__empty){width:64px;height:84px;border-radius:7px}.product-info,.inventory-info,.analytics-cell{display:grid;gap:5px}.product-info button{padding:0;border:0;background:none;text-align:left;color:#1d4ed8;font:inherit;font-weight:600;line-height:1.45;white-space:normal;cursor:pointer}.product-info button:hover{text-decoration:underline}.product-info span,.inventory-info span,.analytics-cell span,.analytics-cell small{font-size:12px;color:#64748b}.product-info .owner-line{color:#6366f1}.inventory-info strong{white-space:normal;line-height:1.4}.sales-total{font-size:18px}.metric-label{margin-left:3px;color:#94a3b8}.date-text{font-size:12px;color:#475569}.trend-chart,.price-trend{display:flex;align-items:center;gap:8px}.trend-chart svg,.price-trend svg{width:78px;height:38px;overflow:visible}.trend-chart polyline.is-up{stroke:#10b981}.trend-chart polyline.is-down{stroke:#ef4444}.trend-chart span{font-size:11px;white-space:nowrap}.is-up{color:#059669}.is-down{color:#dc2626}.price-trend{display:grid;grid-template-columns:78px auto}.price-trend small,.muted{color:#94a3b8;font-size:12px}.analytics-cell strong{color:#0f172a}.analytics-cell .more-data{color:#4f46e5;cursor:help}.dialog-product{display:flex;gap:12px;align-items:center;padding:12px;background:#f8fafc;border-radius:8px;margin-bottom:18px}.dialog-product svg{width:26px;color:#6366f1}.dialog-product div{display:grid;gap:4px}.dialog-product span{font-size:12px;color:#64748b}.rule-row{display:grid;grid-template-columns:1fr 1fr;gap:18px}.suffix{margin-left:6px;color:#64748b}@media(max-width:1200px){.summary-note{display:none}.summary-strip{gap:12px;padding:0 12px}}
</style>
