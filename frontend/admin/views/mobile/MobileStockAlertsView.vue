<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Search, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";

const router = useRouter();
const loading = ref(false);
const loadingMore = ref(false);
const query = ref("");
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const hasMore = computed(() => rows.value.length < total.value);

function integer(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function imageUrl(row) {
  const value = row?.image_url || row?.product_image_url || "";
  if (typeof value === "string") return value.split(",")[0].trim();
  if (Array.isArray(value)) return imageUrl({ image_url: value[0] });
  if (value && typeof value === "object") return String(value.url || value.image_url || value.src || "").trim();
  return "";
}

function coverageText(row) {
  if (row.coverage_days === null || row.coverage_days === undefined) {
    return Number(row.fbp_available || 0) > 0 ? "近两周无销量" : "已断货";
  }
  return `${Number(row.coverage_days || 0).toFixed(1)} 天`;
}

function warningText(row) {
  const warnings = Array.isArray(row?.warnings) ? row.warnings : [];
  return warnings.map((item) => item?.text).filter(Boolean).join("、") || row?.suggestion || "需要关注";
}

function urgencyClass(row) {
  if (Number(row?.fbp_available || 0) <= 0) return "is-danger";
  if (Number(row?.coverage_days || 999) <= 7) return "is-warning";
  return "is-info";
}

function params(nextPage) {
  const value = new URLSearchParams({
    mode: "fbp-alerts",
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize),
    shopId: "all",
    dateFrom: "",
    dateTo: ""
  });
  const keyword = query.value.trim();
  if (keyword) value.set("query", keyword);
  return value;
}

async function loadAlerts({ append = false } = {}) {
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const nextPage = append ? page.value + 1 : 1;
    const payload = await apiClient.get(`/api/stock-alerts?${params(nextPage).toString()}`, { noCache: true });
    const nextRows = Array.isArray(payload?.rows) ? payload.rows : [];
    page.value = Number(payload?.page || nextPage);
    total.value = Number(payload?.total || payload?.meta?.total || 0);
    rows.value = append ? [...rows.value, ...nextRows] : nextRows;
  } catch (error) {
    ElMessage.error(error.message || "库存预警加载失败");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function openDesktopAlerts() {
  window.localStorage?.setItem("baodanMobileMode", "desktop");
  router.push("/inventory/alerts");
}

onMounted(() => loadAlerts());
</script>

<template>
  <div class="mobile-alerts-page" v-loading="loading">
    <section class="mobile-alerts-search">
      <el-input v-model="query" clearable placeholder="店铺 / SKU / 商品名" @keyup.enter="loadAlerts()">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button type="primary" @click="loadAlerts()">查询</el-button>
    </section>

    <section class="mobile-alerts-summary">
      <span><el-icon><Warning /></el-icon></span>
      <div><strong>{{ integer(total) }}</strong><small>条库存预警</small></div>
      <button type="button" @click="openDesktopAlerts">电脑版处理</button>
    </section>

    <section v-if="!rows.length && !loading" class="mobile-alerts-empty">
      <strong>当前没有库存预警</strong>
      <span>可以更换搜索词或稍后刷新。</span>
    </section>

    <section class="mobile-alerts-list">
      <article v-for="row in rows" :key="`${row.shop_id}-${row.ozon_sku}`" class="mobile-alert-card" :class="urgencyClass(row)">
        <div class="mobile-alert-card__head">
          <span>{{ row.shop_name || "未命名店铺" }}</span>
          <strong>{{ coverageText(row) }}</strong>
        </div>
        <div class="mobile-alert-card__product">
          <img v-if="imageUrl(row)" :src="imageUrl(row)" alt="">
          <div v-else class="mobile-alert-card__placeholder">无图</div>
          <div>
            <h2>{{ row.name || row.product_name || "未命名商品" }}</h2>
            <p>SKU {{ row.ozon_sku || "-" }}</p>
            <span>{{ warningText(row) }}</span>
          </div>
        </div>
        <div class="mobile-alert-card__metrics">
          <span><small>FBP可售</small><strong>{{ integer(row.fbp_available) }}</strong></span>
          <span><small>近7天销量</small><strong>{{ integer(row.recent_7d_qty) }}</strong></span>
          <span><small>动态日销</small><strong>{{ Number(row.dynamic_daily_sales || row.daily_sales_14d || 0).toFixed(2) }}</strong></span>
          <span><small>建议备货</small><strong>{{ integer(Math.max(0, row.suggested_qty || 0)) }}</strong></span>
        </div>
        <p v-if="row.suggestion" class="mobile-alert-card__suggestion">{{ row.suggestion }}</p>
      </article>
    </section>

    <el-button v-if="hasMore" class="mobile-alerts-more" :loading="loadingMore" @click="loadAlerts({ append: true })">加载更多</el-button>
  </div>
</template>

<style scoped>
.mobile-alerts-page { display: grid; gap: 12px; }
.mobile-alerts-search { display: grid; grid-template-columns: minmax(0, 1fr) 68px; gap: 8px; }
.mobile-alerts-summary { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid #fecaca; border-radius: 14px; background: #fff7f7; }
.mobile-alerts-summary > span { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; color: #b91c1c; background: #fee2e2; font-size: 21px; }
.mobile-alerts-summary div { display: flex; align-items: baseline; gap: 5px; }
.mobile-alerts-summary strong { color: #b91c1c; font-size: 24px; }
.mobile-alerts-summary small { color: #64748b; }
.mobile-alerts-summary button { min-height: 34px; padding: 0 9px; border: 1px solid #fecaca; border-radius: 9px; background: #fff; color: #b91c1c; font-weight: 700; }
.mobile-alerts-list { display: grid; gap: 10px; }
.mobile-alert-card { overflow: hidden; border: 1px solid #dbe3ef; border-left-width: 4px; border-radius: 16px; background: #fff; }
.mobile-alert-card.is-danger { border-left-color: #dc2626; }
.mobile-alert-card.is-warning { border-left-color: #f59e0b; }
.mobile-alert-card.is-info { border-left-color: #3b82f6; }
.mobile-alert-card__head { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #edf1f6; color: #64748b; font-size: 12px; }
.mobile-alert-card__head strong { color: #b91c1c; }
.mobile-alert-card__product { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 11px; padding: 12px; }
.mobile-alert-card__product img, .mobile-alert-card__placeholder { width: 58px; height: 76px; border-radius: 8px; }
.mobile-alert-card__product img { display: block; object-fit: cover; background: #eef2f7; }
.mobile-alert-card__placeholder { display: grid; place-items: center; color: #94a3b8; background: #eef2f7; font-size: 11px; }
.mobile-alert-card__product div { min-width: 0; }
.mobile-alert-card__product h2 { display: -webkit-box; margin: 0; overflow: hidden; font-size: 14px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mobile-alert-card__product p, .mobile-alert-card__product span { display: block; margin: 5px 0 0; overflow: hidden; color: #64748b; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-alert-card__metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: #f8fafc; border-top: 1px solid #edf1f6; }
.mobile-alert-card__metrics span { min-width: 0; display: grid; gap: 3px; padding: 9px 4px; text-align: center; }
.mobile-alert-card__metrics small { overflow: hidden; color: #64748b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-alert-card__metrics strong { font-size: 14px; }
.mobile-alert-card__suggestion { margin: 0; padding: 10px 12px; border-top: 1px solid #edf1f6; color: #475569; font-size: 12px; line-height: 1.5; }
.mobile-alerts-empty { display: grid; gap: 5px; padding: 28px 18px; border: 1px dashed #cbd5e1; border-radius: 14px; color: #64748b; text-align: center; }
.mobile-alerts-empty strong { color: #334155; }
.mobile-alerts-more { width: 100%; min-height: 44px; }
@media (max-width: 360px) {
  .mobile-alerts-summary { grid-template-columns: 42px 1fr; }
  .mobile-alerts-summary button { grid-column: 1 / -1; }
  .mobile-alert-card__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
