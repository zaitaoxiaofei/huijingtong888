<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Refresh, Search } from "@element-plus/icons-vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import { apiClient } from "../../utils/api";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { shanghaiDateKey, shanghaiDateTimeText, shanghaiMonthStart } from "../../utils/shanghai-date";
import { formatInteger, formatMoney } from "../profit/profit-utils.js";

const router = useRouter();

const loading = ref(false);
const productsLoading = ref(false);
const skuLoading = ref(false);
const unmatchedLoading = ref(false);
const aiClassifyLoading = ref(false);
const detailVisible = ref(false);
const confirmVisible = ref(false);
const reviewVisible = ref(false);
const shops = ref([]);

const state = reactive({
  filters: {
    from: shanghaiMonthStart(),
    to: shanghaiDateKey(),
    shopId: "all",
    includeCancelled: false
  },
  models: [],
  products: [],
  totals: {},
  productTotals: {},
  unmatchedSamples: [],
  unmatchedRows: [],
  sourceRows: 0,
  activeModel: null,
  activeProduct: null,
  confirmRow: null,
  confirmForm: {
    brand: "",
    model: "",
    product_key: "",
    product_label: "",
    yearsText: ""
  }
});

const detail = reactive({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 20,
  totalPages: 1,
  totals: {}
});

const UNKNOWN_BRAND = "未识别品牌";
const UNKNOWN_MODEL = "未识别车型";

function isRecognizedModel(row = {}) {
  return Boolean(row?.matched) && row.brand !== UNKNOWN_BRAND && row.model !== UNKNOWN_MODEL;
}

const recognizedModels = computed(() => state.models.filter((row) => isRecognizedModel(row)));
const unresolvedBucket = computed(() => state.models.find((row) => !isRecognizedModel(row)) || null);
const activeModelLabel = computed(() => {
  if (!state.activeModel) return "请选择车型";
  return isRecognizedModel(state.activeModel) ? `${state.activeModel.brand} ${state.activeModel.model}` : "待归类标题";
});
const activeProductLabel = computed(() => state.activeProduct?.product_label || "请选择产品");
const topOpportunityRows = computed(() => recognizedModels.value.slice(0, 5));
const maxMatrixSkuCount = computed(() => Math.max(1, ...recognizedModels.value.map((row) => Number(row.sku_count || 0))));
const maxMatrixDensity = computed(() => Math.max(1, ...recognizedModels.value.map((row) => Number(row.orders_per_sku || 0))));
const matrixRows = computed(() => recognizedModels.value.slice(0, 28).map((row) => ({
  ...row,
  left: `${Math.min(92, Math.max(7, (Number(row.orders_per_sku || 0) / maxMatrixDensity.value) * 86 + 7))}%`,
  bottom: `${Math.min(88, Math.max(8, (Number(row.sku_count || 0) / maxMatrixSkuCount.value) * 80 + 8))}%`
})));
const unmatchedCountText = computed(() => {
  if (state.unmatchedRows.length) return `${numberText(state.unmatchedRows.length)} 条待处理`;
  if (state.unmatchedSamples.length) return `至少 ${numberText(state.unmatchedSamples.length)} 条需复核`;
  return "暂无明显异常";
});
const productKeywordOptions = [
  { value: "floor_mat", label: "脚垫" },
  { value: "trunk_mat", label: "后备箱垫" },
  { value: "seat_cover", label: "座套" },
  { value: "wiper", label: "雨刮" },
  { value: "mud_flap", label: "挡泥板" },
  { value: "door_sill", label: "门槛条" },
  { value: "sunshade", label: "遮阳" },
  { value: "organizer", label: "收纳" },
  { value: "armrest", label: "扶手箱" },
  { value: "steering_cover", label: "方向盘套" },
  { value: "mirror_cover", label: "后视镜壳" },
  { value: "bumper_guard", label: "保险杠护板" },
  { value: "phone_holder", label: "手机支架" },
  { value: "air_filter", label: "空调滤芯" },
  { value: "deflector", label: "晴雨挡" },
  { value: "screen_protector", label: "屏幕膜" },
  { value: "key_case", label: "钥匙套" },
  { value: "unknown_product", label: "未识别产品" }
];

function formatDateTime(value) {
  return value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "-";
}

function numberText(value) {
  return formatInteger(value || 0);
}

function moneyText(value) {
  return formatMoney(value || 0);
}

function modelLabel(row = {}) {
  if (!isRecognizedModel(row)) return "待归类标题";
  return `${row.brand || "-"} ${row.model || ""}`.trim();
}

function scorePercent(row = {}) {
  return Math.max(0, Math.min(100, Number(row.opportunity_score || 0)));
}

function gradeTagType(grade) {
  if (grade === "S") return "danger";
  if (grade === "A") return "success";
  if (grade === "B") return "warning";
  return "info";
}

function riskText(row = {}) {
  const share = Number(row.top_sku_order_share || 0);
  if (share >= 0.75) return "高";
  if (share >= 0.55) return "中";
  return "低";
}

function shareText(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function densityText(row = {}) {
  return Number(row.orders_per_sku || 0).toFixed(2);
}

function productOpportunityText(row = {}) {
  if (row.product_count <= 1 && row.order_count >= 2) return "类目未铺开";
  if (row.product_count >= 4) return "多类目已验证";
  return "可继续扩品";
}

function modelRowClassName({ row }) {
  return state.activeModel?.brand === row.brand && state.activeModel?.model === row.model ? "is-active-model" : "";
}

function validateFilters() {
  if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) {
    ElMessage.warning("开始日期不能晚于结束日期");
    return false;
  }
  return true;
}

function buildParams(extra = {}) {
  return new URLSearchParams({
    from: state.filters.from || "",
    to: state.filters.to || "",
    shopId: state.filters.shopId || "all",
    includeCancelled: state.filters.includeCancelled ? "1" : "0",
    ...extra
  });
}

async function loadShops() {
  const payload = await loadShopDictionary();
  shops.value = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
}

async function loadModels() {
  if (!validateFilters()) return;
  loading.value = true;
  try {
    const payload = await apiClient.get(`/api/order-car-heatmap/models?${buildParams().toString()}`);
    state.models = Array.isArray(payload?.rows) ? payload.rows : [];
    state.totals = payload?.totals || {};
    state.unmatchedSamples = Array.isArray(payload?.unmatched_samples) ? payload.unmatched_samples : [];
    state.sourceRows = Number(payload?.source_rows || 0);
    if (state.activeModel) {
      const matched = state.models.find((row) => row.brand === state.activeModel.brand && row.model === state.activeModel.model);
      state.activeModel = matched || null;
    }
    if (!state.activeModel && recognizedModels.value.length) state.activeModel = recognizedModels.value[0];
    if (!state.activeModel && state.models.length) state.activeModel = state.models[0];
    await loadProducts();
  } catch (error) {
    ElMessage.error(error.message || "车型热力加载失败");
  } finally {
    loading.value = false;
  }
}

async function openReviewAssistant() {
  reviewVisible.value = true;
  await loadUnmatched();
}

async function loadUnmatched() {
  unmatchedLoading.value = true;
  try {
    const payload = await apiClient.get(`/api/order-car-heatmap/unmatched?${buildParams({ limit: "30" }).toString()}`);
    state.unmatchedRows = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "未识别标题加载失败");
  } finally {
    unmatchedLoading.value = false;
  }
}

async function runAiClassify() {
  if (!validateFilters()) return;
  aiClassifyLoading.value = true;
  try {
    const payload = await apiClient.post("/api/order-car-heatmap/ai-classify", {
      from: state.filters.from || "",
      to: state.filters.to || "",
      shopId: state.filters.shopId || "all",
      includeCancelled: state.filters.includeCancelled ? "1" : "0",
      aiLimit: 5
    });
    ElMessage.success(`AI 已识别 ${Number(payload?.saved_count || 0)} 条标题`);
    await loadModels();
    if (reviewVisible.value) await loadUnmatched();
  } catch (error) {
    ElMessage.error(error.message || "AI 识别失败，请检查 AI 设置");
  } finally {
    aiClassifyLoading.value = false;
  }
}

async function loadProducts() {
  state.products = [];
  state.activeProduct = null;
  if (!state.activeModel || !isRecognizedModel(state.activeModel)) return;
  productsLoading.value = true;
  try {
    const payload = await apiClient.get(`/api/order-car-heatmap/products?${buildParams({
      brand: state.activeModel.brand,
      model: state.activeModel.model
    }).toString()}`);
    state.products = Array.isArray(payload?.rows) ? payload.rows : [];
    state.productTotals = payload?.totals || {};
    state.activeProduct = state.products[0] || null;
  } catch (error) {
    ElMessage.error(error.message || "产品热力加载失败");
  } finally {
    productsLoading.value = false;
  }
}

async function loadSkuDetail({ resetPage = false } = {}) {
  if (!state.activeModel || !state.activeProduct) return;
  if (resetPage) detail.page = 1;
  detailVisible.value = true;
  skuLoading.value = true;
  try {
    const payload = await apiClient.get(`/api/order-car-heatmap/skus?${buildParams({
      brand: state.activeModel.brand,
      model: state.activeModel.model,
      productKey: state.activeProduct.product_key,
      page: String(detail.page),
      pageSize: String(detail.pageSize)
    }).toString()}`);
    detail.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    detail.total = Number(payload?.total || 0);
    detail.totalPages = Number(payload?.total_pages || 1);
    detail.totals = payload?.totals || {};
  } catch (error) {
    ElMessage.error(error.message || "SKU 明细加载失败");
  } finally {
    skuLoading.value = false;
  }
}

function resetFilters() {
  state.filters.from = shanghaiMonthStart();
  state.filters.to = shanghaiDateKey();
  state.filters.shopId = "all";
  state.filters.includeCancelled = false;
  state.activeModel = null;
  state.activeProduct = null;
  loadModels();
}

function selectModel(row) {
  state.activeModel = row;
  if (!isRecognizedModel(row)) {
    state.products = [];
    state.activeProduct = null;
    return;
  }
  loadProducts();
}

function selectProduct(row) {
  state.activeProduct = row;
  loadSkuDetail({ resetPage: true });
}

function openConfirm(row) {
  state.confirmRow = row;
  state.confirmForm.brand = row.rule_brand && row.rule_brand !== "未识别品牌" ? row.rule_brand : "";
  state.confirmForm.model = row.rule_model && row.rule_model !== "未识别车型" ? row.rule_model : "";
  state.confirmForm.product_key = row.rule_product_key || "unknown_product";
  state.confirmForm.product_label = row.rule_product_label || productKeywordOptions.find((item) => item.value === state.confirmForm.product_key)?.label || "";
  state.confirmForm.yearsText = "";
  confirmVisible.value = true;
}

function syncProductLabel() {
  const option = productKeywordOptions.find((item) => item.value === state.confirmForm.product_key);
  if (option) state.confirmForm.product_label = option.label;
}

async function submitConfirm() {
  if (!state.confirmRow) return;
  const brand = state.confirmForm.brand.trim();
  const model = state.confirmForm.model.trim();
  if (!brand || !model) {
    ElMessage.warning("请填写品牌和车型");
    return;
  }
  try {
    await apiClient.post("/api/order-car-heatmap/confirm-tag", {
      title_hash: state.confirmRow.title_hash,
      title: state.confirmRow.title,
      ozon_sku: state.confirmRow.ozon_sku,
      offer_id: state.confirmRow.offer_id,
      brand,
      model,
      product_key: state.confirmForm.product_key,
      product_label: state.confirmForm.product_label,
      years: state.confirmForm.yearsText.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
      confidence: 1
    });
    ElMessage.success("已确认并写入识别缓存");
    confirmVisible.value = false;
    await loadModels();
  } catch (error) {
    ElMessage.error(error.message || "保存确认结果失败");
  }
}

function openOrderSearch(row) {
  const query = row.ozon_sku
    ? { searchType: "sku", searchQuery: row.ozon_sku }
    : { searchType: "product", searchQuery: row.title || row.product_name || "" };
  router.push({ path: "/orders", query });
}

function handleDetailPageChange(page) {
  detail.page = Number(page || 1);
  loadSkuDetail();
}

function handleDetailPageSizeChange(size) {
  detail.page = 1;
  detail.pageSize = Number(size || 20);
  loadSkuDetail();
}

watch(() => [state.filters.from, state.filters.to, state.filters.shopId, state.filters.includeCancelled], () => {
  loadModels();
});

onMounted(async () => {
  try {
    await loadShops();
    await loadModels();
  } catch (error) {
    ElMessage.error(error.message || "车型热力分析初始化失败");
  }
});
</script>

<template>
  <div class="page-stack car-heatmap-page">
    <el-card shadow="never" class="page-card">
      <ErpPageHeader title="车型机会分析" description="用自有订单反推俄罗斯真实车型需求，筛出值得多类目铺货的汽车型号。">
        <template #actions>
          <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading" @click="loadModels">刷新</el-button>
        </template>
      </ErpPageHeader>

      <ErpFilterBar class="car-heatmap-toolbar">
        <el-form inline @submit.prevent>
          <el-form-item label="开始日期">
            <el-date-picker v-model="state.filters.from" value-format="YYYY-MM-DD" type="date" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker v-model="state.filters.to" value-format="YYYY-MM-DD" type="date" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="店铺">
            <el-select v-model="state.filters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="取消单">
            <el-switch v-model="state.filters.includeCancelled" active-text="包含" inactive-text="排除" />
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" :loading="loading" @click="loadModels">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </ErpFilterBar>

      <div class="car-heatmap-summary">
        <div>
          <span>识别明细</span>
          <strong>{{ numberText(state.sourceRows) }}</strong>
        </div>
        <div>
          <span>车型 SKU</span>
          <strong>{{ numberText(state.totals.sku_count) }}</strong>
        </div>
        <div>
          <span>订单数</span>
          <strong>{{ numberText(state.totals.order_count) }}</strong>
        </div>
        <div>
          <span>销量件数</span>
          <strong>{{ numberText(state.totals.item_quantity) }}</strong>
        </div>
        <div>
          <span>销售额</span>
          <strong>{{ moneyText(state.totals.revenue) }}</strong>
        </div>
        <div>
          <span>最近出单</span>
          <strong>{{ formatDateTime(state.totals.latest_ordered_at) }}</strong>
        </div>
      </div>

      <div class="opportunity-strip">
        <div v-for="row in topOpportunityRows" :key="`${row.brand}-${row.model}`" class="opportunity-strip__item" @click="selectModel(row)">
          <el-tag size="small" :type="gradeTagType(row.opportunity_grade)" effect="light">{{ row.opportunity_grade }}</el-tag>
          <strong>{{ modelLabel(row) }}</strong>
          <span>{{ numberText(row.sku_count) }} SKU / {{ numberText(row.order_count) }} 单</span>
        </div>
        <el-empty v-if="!loading && !topOpportunityRows.length" description="暂无可深挖车型" />
      </div>

      <div class="car-opportunity-layout">
        <section class="car-opportunity-main">
          <header class="car-section-header">
            <div>
              <h3>车型深挖榜</h3>
              <span>只展示已识别车型；待归类标题先进入识别助手，确认后再参与机会排序。</span>
            </div>
            <el-button class="erp-btn erp-btn-secondary" size="small" :loading="unmatchedLoading" @click="openReviewAssistant">
              识别助手
            </el-button>
          </header>
          <div v-if="unresolvedBucket" class="unresolved-model-callout">
            <div>
              <strong>有一批订单标题还没识别出车型</strong>
              <span>
                {{ numberText(unresolvedBucket.sku_count) }} SKU / {{ numberText(unresolvedBucket.order_count) }} 单。
                这不是一个真实车型，先用 AI 或手工确认，归类后才会进入深挖榜。
              </span>
            </div>
            <div class="unresolved-model-callout__actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" @click="selectModel(unresolvedBucket)">查看说明</el-button>
              <el-button class="erp-btn erp-btn-primary" type="primary" size="small" :loading="unmatchedLoading" @click="openReviewAssistant">去归类</el-button>
            </div>
          </div>
          <el-table
            v-loading="loading"
            :data="recognizedModels"
            stripe
            highlight-current-row
            class="erp-data-table car-model-table"
            table-layout="fixed"
            :row-class-name="modelRowClassName"
            @row-click="selectModel"
          >
            <el-table-column label="车型" min-width="210" fixed>
              <template #default="{ row }">
                <div class="model-cell">
                  <div>
                    <el-tag size="small" :type="gradeTagType(row.opportunity_grade)" effect="light">{{ row.opportunity_grade }}</el-tag>
                    <strong>{{ modelLabel(row) }}</strong>
                  </div>
                  <span>{{ row.recommendation_reasons?.join(" / ") || "等待更多订单验证" }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="深挖分" width="132">
              <template #default="{ row }">
                <div class="score-cell">
                  <strong>{{ numberText(row.opportunity_score) }}</strong>
                  <el-progress :percentage="scorePercent(row)" :show-text="false" :stroke-width="7" />
                </div>
              </template>
            </el-table-column>
            <el-table-column label="验证强度" width="168">
              <template #default="{ row }">
                <div class="metric-stack">
                  <strong>{{ numberText(row.sku_count) }} SKU · {{ numberText(row.order_count) }} 单</strong>
                  <span>单 SKU {{ densityText(row) }} 单</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="类目覆盖" width="132">
              <template #default="{ row }">
                <div class="metric-stack">
                  <strong>{{ numberText(row.product_count) }} 类</strong>
                  <span>{{ productOpportunityText(row) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="集中风险" width="118">
              <template #default="{ row }">
                <div class="metric-stack">
                  <strong>{{ riskText(row) }}</strong>
                  <span>头部 SKU {{ shareText(row.top_sku_order_share) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="最近出单" width="150">
              <template #default="{ row }">{{ formatDateTime(row.latest_ordered_at) }}</template>
            </el-table-column>
            <el-table-column label="建议动作" min-width="220">
              <template #default="{ row }">
                <span class="action-text">{{ row.recommendation || "-" }}</span>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <aside class="car-opportunity-side">
          <section class="car-side-panel">
            <header class="car-section-header car-section-header--compact">
              <div>
                <h3>机会矩阵</h3>
                <span>横轴单 SKU 出单，纵轴 SKU 宽度。</span>
              </div>
            </header>
            <div class="matrix-box">
              <span class="matrix-axis matrix-axis--x">出单密度</span>
              <span class="matrix-axis matrix-axis--y">SKU 宽度</span>
              <button
                v-for="row in matrixRows"
                :key="`${row.brand}-${row.model}`"
                type="button"
                class="matrix-dot"
                :class="{ 'matrix-dot--active': state.activeModel?.brand === row.brand && state.activeModel?.model === row.model }"
                :style="{ left: row.left, bottom: row.bottom }"
                :title="`${modelLabel(row)} / ${row.opportunity_score}分`"
                @click="selectModel(row)"
              >
                {{ row.opportunity_grade }}
              </button>
            </div>
          </section>

          <section class="car-side-panel">
            <header class="car-section-header car-section-header--compact">
              <div>
                <h3>{{ activeModelLabel }}</h3>
                <span v-if="isRecognizedModel(state.activeModel)">二级按产品关键词订单数排序，点击看 SKU 明细。</span>
                <span v-else>这是一批未归类标题，不用于判断车型机会。</span>
              </div>
              <el-button
                v-if="isRecognizedModel(state.activeModel)"
                class="erp-btn erp-btn-secondary"
                size="small"
                :disabled="!state.activeModel"
                :loading="productsLoading"
                @click="loadProducts"
              >
                刷新
              </el-button>
            </header>
            <div v-if="!isRecognizedModel(state.activeModel)" class="unresolved-side-panel">
              <strong>怎么用这组数据？</strong>
              <p>它代表标题里有订单和 SKU，但系统暂时没看出品牌/车型。这里不能直接拿来铺货，因为不知道到底是哪款车。</p>
              <ol>
                <li>点“识别助手”，让 AI 先识别标题。</li>
                <li>对高订单或高 SKU 的标题手工确认车型。</li>
                <li>确认后这些订单会自动回到对应车型，再参与深挖分排序。</li>
              </ol>
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="unmatchedLoading" @click="openReviewAssistant">打开识别助手</el-button>
            </div>
            <div v-else v-loading="productsLoading" class="product-opportunity-list">
              <button
                v-for="row in state.products"
                :key="row.product_key"
                type="button"
                class="product-opportunity-row"
                :class="{ 'product-opportunity-row--active': state.activeProduct?.product_key === row.product_key }"
                @click="selectProduct(row)"
              >
                <strong>{{ row.product_label }}</strong>
                <span>{{ numberText(row.order_count) }} 单 / {{ numberText(row.sku_count) }} SKU</span>
                <em>{{ moneyText(row.revenue) }}</em>
              </button>
              <el-empty v-if="!productsLoading && !state.products.length" description="请选择车型" />
            </div>
          </section>

          <div class="car-ai-assistant">
            <div>
              <strong>AI 识别</strong>
              <span>{{ unmatchedCountText }}，慢任务收进助手，不占主分析区。</span>
            </div>
            <div class="car-ai-assistant__actions">
              <el-button class="erp-btn erp-btn-secondary" size="small" :loading="unmatchedLoading" @click="openReviewAssistant">打开</el-button>
              <el-button class="erp-btn erp-btn-primary" size="small" type="primary" :loading="aiClassifyLoading" @click="runAiClassify">识别5条</el-button>
            </div>
          </div>
        </aside>
      </div>
    </el-card>

    <el-drawer
      v-model="reviewVisible"
      size="min(980px, calc(100vw - 48px))"
      title="识别助手"
      destroy-on-close
      class="car-review-drawer"
    >
      <div class="car-review-panel">
        <div class="car-review-toolbar">
          <div>
            <strong>{{ unmatchedCountText }}</strong>
            <span>这里仅用于处理未识别或低置信度标题，不影响主热力图浏览。</span>
          </div>
          <div class="car-unmatched__actions">
            <el-button class="erp-btn erp-btn-secondary" size="small" :loading="unmatchedLoading" @click="loadUnmatched">刷新</el-button>
            <el-button class="erp-btn erp-btn-primary" size="small" type="primary" :loading="aiClassifyLoading" @click="runAiClassify">AI识别5条</el-button>
          </div>
        </div>
        <el-table
          v-loading="unmatchedLoading"
          :data="state.unmatchedRows"
          stripe
          class="erp-data-table car-unmatched-table"
          table-layout="fixed"
        >
          <el-table-column label="标题" min-width="360">
            <template #default="{ row }">
              <div class="car-unmatched-title">
                <strong>{{ row.title || "-" }}</strong>
                <span>SKU：{{ row.ozon_sku || "-" }} / offer_id：{{ row.offer_id || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="当前识别" min-width="210">
            <template #default="{ row }">
              <div class="car-unmatched-title">
                <strong>{{ row.rule_brand || "-" }} / {{ row.rule_model || "-" }}</strong>
                <span>{{ row.rule_product_label || "-" }} · {{ row.source || "rule" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="confidence" label="置信度" width="90">
            <template #default="{ row }">{{ Number(row.confidence || 0).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column prop="shop_name" label="店铺" width="140" />
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" @click="openConfirm(row)">确认</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>

    <el-drawer
      v-model="detailVisible"
      size="min(1120px, calc(100vw - 48px))"
      :title="`${activeModelLabel} / ${activeProductLabel}`"
      destroy-on-close
      class="car-sku-drawer"
    >
      <div v-loading="skuLoading" class="car-sku-detail">
        <div class="car-sku-summary">
          <div>
            <span>SKU 数</span>
            <strong>{{ numberText(detail.total) }}</strong>
          </div>
          <div>
            <span>订单数</span>
            <strong>{{ numberText(detail.totals.order_count) }}</strong>
          </div>
          <div>
            <span>销量件数</span>
            <strong>{{ numberText(detail.totals.item_quantity) }}</strong>
          </div>
          <div>
            <span>销售额</span>
            <strong>{{ moneyText(detail.totals.revenue) }}</strong>
          </div>
          <div>
            <span>预估利润</span>
            <strong>{{ moneyText(detail.totals.estimated_profit) }}</strong>
          </div>
          <div>
            <span>实际利润</span>
            <strong>{{ moneyText(detail.totals.actual_profit) }}</strong>
          </div>
        </div>

        <el-table :data="detail.rows" stripe class="erp-data-table car-sku-table" table-layout="fixed">
          <el-table-column label="图片" width="84" align="center">
            <template #default="{ row }">
              <el-image
                v-if="row.image_url"
                :src="row.image_url"
                fit="contain"
                class="car-sku-thumb"
                :preview-src-list="[row.image_url]"
                preview-teleported
              />
              <div v-else class="car-sku-thumb car-sku-thumb--empty">无图</div>
            </template>
          </el-table-column>
          <el-table-column label="SKU / 标题" min-width="340">
            <template #default="{ row }">
              <div class="car-sku-title">
                <strong>{{ row.title || row.product_name || "-" }}</strong>
                <span>Ozon SKU：{{ row.ozon_sku || "-" }} / offer_id：{{ row.offer_id || "-" }}</span>
                <span>内部商品：{{ row.product_code || "-" }} {{ row.product_name || "" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="order_count" label="订单数" width="92">
            <template #default="{ row }">{{ numberText(row.order_count) }}</template>
          </el-table-column>
          <el-table-column prop="item_quantity" label="件数" width="82">
            <template #default="{ row }">{{ numberText(row.item_quantity) }}</template>
          </el-table-column>
          <el-table-column prop="revenue" label="销售额" width="112">
            <template #default="{ row }">{{ moneyText(row.revenue) }}</template>
          </el-table-column>
          <el-table-column prop="avg_order_value" label="单均" width="96">
            <template #default="{ row }">{{ moneyText(row.avg_order_value) }}</template>
          </el-table-column>
          <el-table-column prop="estimated_profit" label="预估利润" width="112">
            <template #default="{ row }">{{ moneyText(row.estimated_profit) }}</template>
          </el-table-column>
          <el-table-column prop="actual_profit" label="实际利润" width="112">
            <template #default="{ row }">{{ moneyText(row.actual_profit) }}</template>
          </el-table-column>
          <el-table-column prop="shop_names" label="店铺" min-width="150" />
          <el-table-column prop="latest_ordered_at" label="最近出单" width="150">
            <template #default="{ row }">{{ formatDateTime(row.latest_ordered_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="92" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" @click="openOrderSearch(row)">订单</el-button>
            </template>
          </el-table-column>
        </el-table>

        <PageFooterPagination
          :total="detail.total"
          :page="detail.page"
          :page-size="detail.pageSize"
          :total-pages="detail.totalPages"
          :page-sizes="[10, 20, 50, 100]"
          summary=" "
          @update:page="handleDetailPageChange"
          @update:page-size="handleDetailPageSizeChange"
        />
      </div>
    </el-drawer>

    <el-dialog
      v-model="confirmVisible"
      title="确认车型识别"
      width="560px"
      destroy-on-close
      class="erp-centered-dialog"
    >
      <div class="car-confirm-dialog">
        <p>{{ state.confirmRow?.title || "-" }}</p>
        <el-form label-width="86px">
          <el-form-item label="品牌">
            <el-input v-model="state.confirmForm.brand" placeholder="例如 Toyota" />
          </el-form-item>
          <el-form-item label="车型">
            <el-input v-model="state.confirmForm.model" placeholder="例如 Camry" />
          </el-form-item>
          <el-form-item label="产品">
            <el-select v-model="state.confirmForm.product_key" filterable style="width: 100%" @change="syncProductLabel">
              <el-option v-for="item in productKeywordOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="产品名称">
            <el-input v-model="state.confirmForm.product_label" />
          </el-form-item>
          <el-form-item label="年份">
            <el-input v-model="state.confirmForm.yearsText" placeholder="例如 2018 2019 2020，可不填" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button class="erp-btn erp-btn-secondary" @click="confirmVisible = false">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="submitConfirm">保存确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.car-heatmap-toolbar {
  margin: 12px 0 14px;
}

.car-heatmap-toolbar :deep(.el-form) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 0;
}

.car-heatmap-summary,
.car-sku-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.car-heatmap-summary div,
.car-sku-summary div {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
}

.car-heatmap-summary span,
.car-sku-summary span {
  display: block;
  color: #64748b;
  font-size: 12px;
  line-height: 1.2;
}

.car-heatmap-summary strong,
.car-sku-summary strong {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  color: #111827;
  font-size: 16px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opportunity-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.opportunity-strip__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #f8fbff;
  cursor: pointer;
}

.opportunity-strip__item strong,
.opportunity-strip__item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.opportunity-strip__item strong {
  color: #0f172a;
  font-size: 13px;
}

.opportunity-strip__item span {
  grid-column: 1 / -1;
  color: #64748b;
  font-size: 12px;
}

.car-opportunity-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 14px;
  align-items: start;
}

.car-opportunity-main,
.car-side-panel {
  min-width: 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
}

.car-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #e5e7eb;
}

.car-section-header--compact {
  padding: 10px 12px;
}

.car-section-header h3 {
  margin: 0;
  color: #111827;
  font-size: 15px;
  line-height: 1.3;
}

.car-section-header span {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 12px;
}

.car-model-table {
  min-height: 420px;
}

.unresolved-model-callout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 14px 0;
  padding: 10px 12px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
}

.unresolved-model-callout strong {
  display: block;
  color: #9a3412;
  font-size: 13px;
}

.unresolved-model-callout span {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.unresolved-model-callout__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.car-model-table :deep(.el-table__row) {
  cursor: pointer;
}

.car-model-table :deep(.is-active-model td) {
  background: #eff6ff !important;
}

.model-cell,
.metric-stack,
.score-cell {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.model-cell > div {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.model-cell strong,
.metric-stack strong,
.score-cell strong {
  overflow: hidden;
  color: #111827;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-cell span,
.metric-stack span {
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-text {
  display: block;
  overflow: hidden;
  color: #334155;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.car-opportunity-side {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.matrix-box {
  position: relative;
  height: 230px;
  margin: 12px;
  overflow: hidden;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background:
    linear-gradient(90deg, transparent 49%, #e5e7eb 50%, transparent 51%),
    linear-gradient(0deg, transparent 49%, #e5e7eb 50%, transparent 51%),
    #f8fafc;
}

.matrix-axis {
  position: absolute;
  z-index: 1;
  color: #94a3b8;
  font-size: 12px;
}

.matrix-axis--x {
  right: 10px;
  bottom: 8px;
}

.matrix-axis--y {
  top: 8px;
  left: 10px;
}

.matrix-dot {
  position: absolute;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  transform: translate(-50%, 50%);
  border: 1px solid #bfdbfe;
  border-radius: 50%;
  background: #dbeafe;
  color: #1d4ed8;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.matrix-dot--active {
  border-color: #0f172a;
  background: #0f172a;
  color: #fff;
}

.product-opportunity-list {
  display: grid;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
  padding: 10px 12px 12px;
}

.unresolved-side-panel {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.unresolved-side-panel strong {
  color: #111827;
  font-size: 14px;
}

.unresolved-side-panel p,
.unresolved-side-panel li {
  margin: 0;
  color: #475569;
  font-size: 12px;
  line-height: 1.55;
}

.unresolved-side-panel ol {
  margin: 0;
  padding-left: 18px;
}

.product-opportunity-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  text-align: left;
  cursor: pointer;
}

.product-opportunity-row:hover,
.product-opportunity-row--active {
  border-color: #93c5fd;
  background: #eff6ff;
}

.product-opportunity-row strong,
.product-opportunity-row span,
.product-opportunity-row em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-opportunity-row strong {
  color: #111827;
  font-size: 13px;
}

.product-opportunity-row span {
  color: #64748b;
  font-size: 12px;
}

.product-opportunity-row em {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  color: #0f766e;
  font-style: normal;
  font-size: 12px;
  font-weight: 700;
}

.car-ai-assistant {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
}

.car-ai-assistant strong {
  display: block;
  color: #9a3412;
  font-size: 13px;
}

.car-ai-assistant span {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 12px;
}

.car-ai-assistant__actions,
.car-unmatched__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.car-review-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 96px);
  min-height: 480px;
}

.car-review-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.car-review-toolbar strong {
  display: block;
  color: #0f172a;
}

.car-review-toolbar span {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 12px;
}

.car-unmatched-table {
  flex: 1;
  min-height: 0;
  background: #fff;
}

.car-unmatched-title {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.car-unmatched-title strong,
.car-unmatched-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.car-unmatched-title strong {
  color: #7c2d12;
  font-size: 13px;
}

.car-unmatched-title span {
  color: #64748b;
  font-size: 12px;
}

.car-confirm-dialog {
  display: grid;
  gap: 12px;
}

.car-confirm-dialog p {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  color: #334155;
  line-height: 1.45;
}

.car-sku-detail {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 120px);
  min-height: 520px;
  gap: 10px;
}

.car-sku-summary {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 0;
}

.car-sku-table {
  flex: 1;
  min-height: 0;
}

.car-sku-table :deep(.el-table__row) {
  height: 92px;
}

.car-sku-thumb {
  display: block;
  width: 58px;
  height: 76px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.car-sku-thumb--empty {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 12px;
}

.car-sku-title {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.car-sku-title strong {
  overflow: hidden;
  color: #111827;
  font-size: 13px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.car-sku-title span {
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1320px) {
  .car-opportunity-layout {
    grid-template-columns: 1fr;
  }

  .car-opportunity-side {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .car-ai-assistant {
    grid-column: 1 / -1;
  }

  .car-heatmap-summary,
  .car-sku-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .opportunity-strip,
  .car-opportunity-side {
    grid-template-columns: 1fr;
  }

  .unresolved-model-callout {
    align-items: flex-start;
    flex-direction: column;
  }

  .car-heatmap-summary,
  .car-sku-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
