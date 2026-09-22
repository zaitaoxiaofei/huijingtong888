<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Search } from "@element-plus/icons-vue";
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

function number(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function productImage(row) {
  const normalize = (value) => {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    return String(value.url || value.image_url || value.src || "").trim();
  };
  const value = row?.image_url || row?.product_image_url || "";
  if (Array.isArray(value)) return normalize(value[0]);
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalize(parsed[0]) : normalize(parsed);
    } catch {}
  }
  return normalize(value).split(",")[0].trim();
}

function localStock(row) {
  return Number(row?.local_stock ?? row?.stock ?? 0);
}

function fbpStock(row) {
  return Number(row?.fbp_stock || 0);
}

function totalStock(row) {
  return Number(row?.stock ?? localStock(row) + fbpStock(row));
}

function skuText(row) {
  const preview = Array.isArray(row?.sku_preview) ? row.sku_preview : [];
  return preview.map((item) => item?.sku || item?.ozon_sku || item?.offer_id || item).filter(Boolean).slice(0, 2).join(" / ") || "暂无绑定 SKU";
}

function buildParams(nextPage) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize)
  });
  const keyword = query.value.trim();
  if (keyword) params.set("query", keyword);
  return params;
}

async function loadProducts({ append = false } = {}) {
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const nextPage = append ? page.value + 1 : 1;
    const result = await apiClient.get(`/api/products?${buildParams(nextPage).toString()}`, { noCache: true });
    const nextRows = Array.isArray(result?.rows) ? result.rows : [];
    page.value = Number(result?.page || nextPage);
    total.value = Number(result?.total || 0);
    rows.value = append ? [...rows.value, ...nextRows] : nextRows;
  } catch (error) {
    ElMessage.error(error.message || "库存商品加载失败");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function openDesktop() {
  window.localStorage?.setItem("baodanMobileMode", "desktop");
  router.push("/inventory/products");
}

onMounted(() => loadProducts());
</script>

<template>
  <div class="mobile-inventory-page" v-loading="loading">
    <section class="mobile-inventory-search">
      <el-input v-model="query" clearable placeholder="商品名 / 库存编码 / SKU" @keyup.enter="loadProducts()">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button type="primary" @click="loadProducts()">查询</el-button>
    </section>

    <div class="mobile-inventory-summary">
      <span>库存商品</span>
      <strong>{{ number(total) }}</strong>
      <small>当前显示 {{ rows.length }} 条</small>
    </div>

    <section v-if="!rows.length && !loading" class="mobile-inventory-empty">
      <strong>没有找到库存商品</strong>
      <span>可以更换商品名、库存编码或 SKU。</span>
    </section>

    <section class="mobile-inventory-list">
      <article v-for="row in rows" :key="row.id" class="mobile-inventory-card">
        <div class="mobile-inventory-card__main">
          <img v-if="productImage(row)" :src="productImage(row)" alt="">
          <div v-else class="mobile-inventory-card__placeholder">无图</div>
          <div class="mobile-inventory-card__copy">
            <h2>{{ row.name || "未命名商品" }}</h2>
            <p>{{ row.inventory_number || row.inventory_id || row.code || `ID ${row.id}` }}</p>
            <span>{{ skuText(row) }}</span>
          </div>
        </div>
        <div class="mobile-inventory-card__stocks">
          <span><small>总库存</small><strong>{{ number(totalStock(row)) }}</strong></span>
          <span><small>本地</small><strong>{{ number(localStock(row)) }}</strong></span>
          <span><small>FBP</small><strong>{{ number(fbpStock(row)) }}</strong></span>
          <span><small>采购在途</small><strong>{{ number(row.incoming_stock) }}</strong></span>
          <span><small>FBP在途</small><strong>{{ number(row.fbp_transfer_in_transit_qty) }}</strong></span>
        </div>
        <div class="mobile-inventory-card__foot">
          <span>{{ row.owner_name ? `负责人：${row.owner_name}` : "未设置负责人" }}</span>
          <button type="button" @click="openDesktop">电脑版管理</button>
        </div>
      </article>
    </section>

    <el-button v-if="hasMore" class="mobile-inventory-more" :loading="loadingMore" @click="loadProducts({ append: true })">
      加载更多
    </el-button>
  </div>
</template>

<style scoped>
.mobile-inventory-page { display: grid; gap: 12px; }
.mobile-inventory-search { display: grid; grid-template-columns: minmax(0, 1fr) 68px; gap: 8px; }
.mobile-inventory-summary { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 3px 12px; padding: 13px 14px; border: 1px solid #dbe3ef; border-radius: 14px; background: #fff; }
.mobile-inventory-summary span, .mobile-inventory-summary small { color: #64748b; font-size: 12px; }
.mobile-inventory-summary strong { grid-row: 1 / 3; grid-column: 2; color: #1d4ed8; font-size: 24px; }
.mobile-inventory-list { display: grid; gap: 10px; }
.mobile-inventory-card { overflow: hidden; border: 1px solid #dbe3ef; border-radius: 16px; background: #fff; }
.mobile-inventory-card__main { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; padding: 13px; }
.mobile-inventory-card__main img, .mobile-inventory-card__placeholder { width: 64px; height: 84px; border-radius: 9px; }
.mobile-inventory-card__main img { display: block; object-fit: cover; background: #eef2f7; }
.mobile-inventory-card__placeholder { display: grid; place-items: center; color: #94a3b8; background: #eef2f7; font-size: 12px; }
.mobile-inventory-card__copy { min-width: 0; display: grid; align-content: start; gap: 5px; }
.mobile-inventory-card__copy h2 { display: -webkit-box; margin: 0; overflow: hidden; color: #172033; font-size: 14px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mobile-inventory-card__copy p, .mobile-inventory-card__copy span { margin: 0; overflow: hidden; color: #64748b; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-inventory-card__stocks { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #edf1f6; border-bottom: 1px solid #edf1f6; background: #f8fafc; }
.mobile-inventory-card__stocks span { min-width: 0; display: grid; gap: 3px; padding: 9px 5px; text-align: center; }
.mobile-inventory-card__stocks small { overflow: hidden; color: #64748b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-inventory-card__stocks strong { color: #172033; font-size: 14px; }
.mobile-inventory-card__foot { min-height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 13px; color: #64748b; font-size: 12px; }
.mobile-inventory-card__foot button { min-height: 32px; padding: 0 10px; border: 1px solid #bfdbfe; border-radius: 9px; background: #eff6ff; color: #1d4ed8; font-weight: 700; }
.mobile-inventory-empty { display: grid; gap: 5px; padding: 28px 18px; border: 1px dashed #cbd5e1; border-radius: 14px; color: #64748b; text-align: center; }
.mobile-inventory-empty strong { color: #334155; }
.mobile-inventory-more { width: 100%; min-height: 44px; }
@media (max-width: 360px) {
  .mobile-inventory-card__stocks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
