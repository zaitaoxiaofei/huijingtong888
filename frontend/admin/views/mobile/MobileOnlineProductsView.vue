<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";

const router = useRouter();
const loading = ref(false);
const loadingMore = ref(false);
const nameQuery = ref("");
const offerQuery = ref("");
const status = ref("all");
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;

const statusFilters = [
  { value: "all", label: "全部" },
  { value: "selling", label: "销售中" },
  { value: "zero_stock", label: "零库存" },
  { value: "ready", label: "待供货" },
  { value: "error", label: "异常" }
];
const hasMore = computed(() => rows.value.length < total.value);

function number(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function money(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function imageUrl(row) {
  const normalize = (value) => {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    return String(value.url || value.image_url || value.src || "").trim();
  };
  const value = row?.primary_image || row?.image_url || "";
  if (Array.isArray(value)) return normalize(value[0]);
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalize(parsed[0]) : normalize(parsed);
    } catch {}
  }
  return normalize(value).split(",")[0].trim();
}

function displayedSku(row) {
  return String(row?.ozon_sku || row?.sku || "").trim();
}

function statusKey(row) {
  const rawStatus = String(row?.status || "").toLowerCase();
  const visibility = String(row?.visibility || "").toLowerCase();
  const hasSnapshot = Number(row?.stock_snapshot_count || 0) > 0;
  const supplyState = rawStatus.includes("ready") || rawStatus.includes("created") || visibility.includes("empty_stock") || visibility.includes("ready_to_supply") || visibility.includes("to_supply");
  if (Number(row?.archived || 0) || rawStatus.includes("archive") || visibility.includes("archive")) return "archived";
  if (rawStatus.includes("error") || rawStatus.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (rawStatus.includes("moder") || rawStatus.includes("validation") || visibility.includes("pending")) return "moderation";
  if (visibility.includes("hidden") || visibility.includes("blocked") || rawStatus.includes("hidden") || rawStatus.includes("offline")) return "hidden";
  if (displayedSku(row) && supplyState && hasSnapshot && (Number(row?.fbs_available || 0) > 0 || Number(row?.fbs_present || 0) > 0)) return "selling";
  if (displayedSku(row) && supplyState && hasSnapshot && Number(row?.fbs_available || 0) <= 0) return "zero_stock";
  if (supplyState) return "ready";
  if (rawStatus.includes("online") || rawStatus.includes("active") || rawStatus.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible")) return "selling";
  return "other";
}

function statusLabel(row) {
  return ({ selling: "销售中", zero_stock: "零库存", ready: "待供货", error: "异常", moderation: "审核中", hidden: "已隐藏", archived: "已归档", other: "其他" })[statusKey(row)];
}

function buildParams(nextPage) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize),
    shopId: "all",
    status: status.value
  });
  const name = nameQuery.value.trim();
  const offer = offerQuery.value.trim();
  if (name) params.set("name", name);
  if (offer) params.set("offer", offer);
  return params;
}

async function loadProducts({ append = false } = {}) {
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const nextPage = append ? page.value + 1 : 1;
    const result = await apiClient.get(`/api/online-products?${buildParams(nextPage).toString()}`, { noCache: true });
    const nextRows = Array.isArray(result?.rows) ? result.rows : [];
    page.value = Number(result?.page || nextPage);
    total.value = Number(result?.total || 0);
    rows.value = append ? [...rows.value, ...nextRows] : nextRows;
  } catch (error) {
    ElMessage.error(error.message || "在线商品加载失败");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function selectStatus(value) {
  status.value = value;
  loadProducts();
}

function openDesktop() {
  window.localStorage?.setItem("baodanMobileMode", "desktop");
  router.push("/online-products");
}

onMounted(() => loadProducts());
</script>

<template>
  <div class="mobile-online-page" v-loading="loading">
    <section class="mobile-online-search">
      <el-input v-model="nameQuery" clearable placeholder="商品名称" @keyup.enter="loadProducts()">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-input v-model="offerQuery" clearable placeholder="Ozon SKU / Offer ID" @keyup.enter="loadProducts()">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button type="primary" @click="loadProducts()">查询</el-button>
    </section>

    <nav class="mobile-online-filters" aria-label="在线商品状态">
      <button v-for="item in statusFilters" :key="item.value" type="button" :class="{ active: status === item.value }" @click="selectStatus(item.value)">
        {{ item.label }}
      </button>
    </nav>

    <div class="mobile-online-summary">
      <span>在线商品</span><strong>{{ number(total) }}</strong><small>当前显示 {{ rows.length }} 条</small>
    </div>

    <section v-if="!rows.length && !loading" class="mobile-online-empty">
      <strong>没有找到在线商品</strong><span>可更换关键词或商品状态后重试。</span>
    </section>

    <section class="mobile-online-list">
      <article v-for="row in rows" :key="row.id" class="mobile-online-card">
        <div class="mobile-online-card__main">
          <img v-if="imageUrl(row)" :src="imageUrl(row)" alt="">
          <div v-else class="mobile-online-card__placeholder">无图</div>
          <div class="mobile-online-card__copy">
            <div><span class="mobile-online-status" :class="`is-${statusKey(row)}`">{{ statusLabel(row) }}</span><small>{{ row.shop_name || "未知店铺" }}</small></div>
            <h2>{{ row.name || "未命名商品" }}</h2>
            <p>SKU：{{ displayedSku(row) || "未返回" }}</p>
            <p>Offer ID：{{ row.offer_id || "-" }}</p>
          </div>
        </div>
        <div class="mobile-online-card__metrics">
          <span><small>售价</small><strong>{{ money(row.sale_price) }}</strong></span>
          <span><small>FBS可售</small><strong>{{ Number(row.stock_snapshot_count || 0) ? number(row.fbs_available) : "--" }}</strong></span>
          <span><small>FBS现货</small><strong>{{ Number(row.stock_snapshot_count || 0) ? number(row.fbs_present) : "--" }}</strong></span>
        </div>
        <div class="mobile-online-card__foot">
          <span><b>绑定库存：</b>{{ row.product_id ? (row.product_name || row.product_code || `ID ${row.product_id}`) : "未绑定" }}</span>
          <button type="button" @click="openDesktop">电脑版管理</button>
        </div>
      </article>
    </section>

    <el-button v-if="hasMore" class="mobile-online-more" :loading="loadingMore" @click="loadProducts({ append: true })">加载更多</el-button>
  </div>
</template>

<style scoped>
.mobile-online-page { display: grid; gap: 12px; }
.mobile-online-search { display: grid; grid-template-columns: minmax(0, 1fr) 68px; gap: 8px; }
.mobile-online-search .el-input:nth-child(2) { grid-column: 1; }
.mobile-online-search .el-button { grid-column: 2; grid-row: 1 / 3; height: auto; }
.mobile-online-filters { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
.mobile-online-filters::-webkit-scrollbar { display: none; }
.mobile-online-filters button { min-height: 34px; flex: 0 0 auto; padding: 0 13px; border: 1px solid #dbe3ef; border-radius: 999px; background: #fff; color: #64748b; font-size: 12px; font-weight: 700; }
.mobile-online-filters button.active { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
.mobile-online-summary { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 3px 12px; padding: 13px 14px; border: 1px solid #dbe3ef; border-radius: 14px; background: #fff; }
.mobile-online-summary span, .mobile-online-summary small { color: #64748b; font-size: 12px; }
.mobile-online-summary strong { grid-row: 1 / 3; grid-column: 2; color: #1d4ed8; font-size: 24px; }
.mobile-online-list { display: grid; gap: 10px; }
.mobile-online-card { overflow: hidden; border: 1px solid #dbe3ef; border-radius: 16px; background: #fff; }
.mobile-online-card__main { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 12px; padding: 13px; }
.mobile-online-card__main img, .mobile-online-card__placeholder { width: 68px; height: 90px; border-radius: 9px; }
.mobile-online-card__main img { display: block; object-fit: cover; background: #eef2f7; }
.mobile-online-card__placeholder { display: grid; place-items: center; color: #94a3b8; background: #eef2f7; font-size: 12px; }
.mobile-online-card__copy { min-width: 0; display: grid; align-content: start; gap: 5px; }
.mobile-online-card__copy > div { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mobile-online-card__copy > div small { overflow: hidden; color: #64748b; text-overflow: ellipsis; white-space: nowrap; }
.mobile-online-card__copy h2 { display: -webkit-box; margin: 0; overflow: hidden; color: #172033; font-size: 14px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mobile-online-card__copy p { margin: 0; overflow: hidden; color: #64748b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-online-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; background: #f1f5f9; color: #475569; font-size: 10px; font-weight: 800; }
.mobile-online-status.is-selling { background: #dcfce7; color: #15803d; }
.mobile-online-status.is-zero_stock, .mobile-online-status.is-moderation { background: #fef3c7; color: #b45309; }
.mobile-online-status.is-error { background: #fee2e2; color: #b91c1c; }
.mobile-online-status.is-ready { background: #dbeafe; color: #1d4ed8; }
.mobile-online-card__metrics { display: grid; grid-template-columns: 1.35fr 1fr 1fr; border-top: 1px solid #edf1f6; border-bottom: 1px solid #edf1f6; background: #f8fafc; }
.mobile-online-card__metrics span { min-width: 0; display: grid; gap: 3px; padding: 9px 5px; text-align: center; }
.mobile-online-card__metrics small { color: #64748b; font-size: 10px; }
.mobile-online-card__metrics strong { overflow: hidden; color: #172033; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-online-card__foot { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 13px; color: #64748b; font-size: 11px; }
.mobile-online-card__foot span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-online-card__foot button { min-height: 32px; flex: 0 0 auto; padding: 0 10px; border: 1px solid #bfdbfe; border-radius: 9px; background: #eff6ff; color: #1d4ed8; font-weight: 700; }
.mobile-online-empty { display: grid; gap: 5px; padding: 28px 18px; border: 1px dashed #cbd5e1; border-radius: 14px; color: #64748b; text-align: center; }
.mobile-online-empty strong { color: #334155; }
.mobile-online-more { width: 100%; min-height: 44px; }
</style>
