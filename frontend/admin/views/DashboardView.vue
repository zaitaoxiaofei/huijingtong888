<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../utils/api";
import { shanghaiDateTimeText } from "../utils/shanghai-date.js";
import PageFooterPagination from "../components/PageFooterPagination.vue";

const TABLE_HEIGHT = 360;
const router = useRouter();

const loading = ref(false);
const dashboard = ref({
  summary: {
    urgent_count: 0,
    warning_count: 0,
    fbp_count: 0,
    fbs_count: 0,
    procurement_count: 0
  },
  alerts: {
    fbp: [],
    fbs: [],
    procurement: []
  }
});

const pager = reactive({
  fbp: { page: 1, pageSize: 8 },
  fbs: { page: 1, pageSize: 8 },
  procurement: { page: 1, pageSize: 8 }
});

const summaryCards = computed(() => [
  { label: "紧急预警", value: Number(dashboard.value.summary?.urgent_count || 0), type: "danger", hint: "优先处理已空仓或负库存" },
  { label: "库存预警", value: Number(dashboard.value.summary?.warning_count || 0), type: "warning", hint: "首页只保留预警信息" },
  { label: "待采购商品", value: Number(dashboard.value.summary?.procurement_count || 0), type: "primary", hint: "还没采购的申请" }
]);

function paginateRows(rows, key) {
  const page = Number(pager[key].page || 1);
  const pageSize = Number(pager[key].pageSize || 8);
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

const fbpRows = computed(() => Array.isArray(dashboard.value.alerts?.fbp) ? dashboard.value.alerts.fbp : []);
const fbsRows = computed(() => Array.isArray(dashboard.value.alerts?.fbs) ? dashboard.value.alerts.fbs : []);
const procurementRows = computed(() => Array.isArray(dashboard.value.alerts?.procurement) ? dashboard.value.alerts.procurement : []);

const pagedFbpRows = computed(() => paginateRows(fbpRows.value, "fbp"));
const pagedFbsRows = computed(() => paginateRows(fbsRows.value, "fbs"));
const pagedProcurementRows = computed(() => paginateRows(procurementRows.value, "procurement"));

function resetPager(key) {
  pager[key].page = 1;
}

function displayName(row) {
  return row?.display_name || row?.product_name || row?.online_name || row?.inventory_id || row?.ozon_sku || "-";
}

function imageUrl(row) {
  return row?.image_url || row?.product_image_url || "";
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function tagType(level) {
  if (level === "danger") return "danger";
  if (level === "warning") return "warning";
  return "info";
}

function openFbpDetail(row) {
  router.push({
    path: "/inventory/fbp",
    query: {
      shopId: row?.shop_id ? String(row.shop_id) : undefined,
      query: row?.ozon_sku || row?.offer_id || row?.inventory_id || row?.product_name || undefined
    }
  });
}

function openFbsDetail(row) {
  router.push({
    path: "/online-products",
    query: {
      shopId: row?.shop_id ? String(row.shop_id) : undefined,
      status: row?.status_key === "selling" ? "selling" : undefined,
      offer: row?.offer_id || row?.ozon_sku || undefined
    }
  });
}

function openProcurementDetail(row) {
  router.push({
    path: "/purchase-list",
    query: {
      productId: row?.product_id ? String(row.product_id) : undefined
    }
  });
}

async function loadDashboard() {
  loading.value = true;
  try {
    dashboard.value = await apiClient.get("/api/dashboard");
    resetPager("fbp");
    resetPager("fbs");
    resetPager("procurement");
  } catch (error) {
    ElMessage.error(error.message || "首页看板加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <div class="page-stack dashboard-page">
    <el-card shadow="never" class="page-card dashboard-hero-card">
      <div class="page-hero dashboard-hero">
        <div>
          <el-tag effect="light" type="danger">预警中心</el-tag>
          <h2>首页看板</h2>
          <p>首页只做预警和待处理入口，利润统计不再放在这里，优先暴露 FBP、FBS 和待采购问题。</p>
        </div>
        <el-button type="primary" plain :loading="loading" @click="loadDashboard">刷新数据</el-button>
      </div>
    </el-card>

    <el-row :gutter="16">
      <el-col v-for="card in summaryCards" :key="card.label" :xs="24" :md="8">
        <el-card shadow="never" class="metric-card dashboard-metric-card">
          <span class="metric-label">{{ card.label }}</span>
          <strong class="metric-value">{{ card.value }}</strong>
          <span class="metric-suffix">{{ card.hint }}</span>
          <el-tag size="small" effect="light" :type="card.type">{{ card.label }}</el-tag>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="dashboard-grid">
      <el-col :xs="24" :xl="12">
        <el-card shadow="never" class="page-card dashboard-panel-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>FBO/FBP 低库存预警</strong>
                <span>优先看平台仓可售库存低于 5 的商品，空仓排前面。</span>
              </div>
              <el-tag type="danger" effect="light">{{ fbpRows.length }} 条</el-tag>
            </div>
          </template>

          <div class="dashboard-table-shell">
            <el-table v-loading="loading" :data="pagedFbpRows" :height="TABLE_HEIGHT" stripe border class="erp-data-table">
              <el-table-column label="商品" min-width="260" fixed="left">
                <template #default="{ row }">
                  <div class="product-cell">
                    <el-image v-if="imageUrl(row)" :src="imageUrl(row)" fit="cover" class="product-thumb" />
                    <div v-else class="product-thumb product-thumb-fallback">无图</div>
                    <div class="cell-stack">
                      <strong>{{ displayName(row) }}</strong>
                      <span class="muted-text">{{ row.inventory_id || row.ozon_sku || "-" }}</span>
                      <span class="muted-text">{{ row.shop_name || "-" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="平台仓可售" width="100" align="center">
                <template #default="{ row }">
                  <strong :class="{ 'danger-text': Number(row.fbp_available || 0) <= 0 }">{{ Number(row.fbp_available || 0) }}</strong>
                </template>
              </el-table-column>
              <el-table-column label="本地库存" width="100" align="center">
                <template #default="{ row }">{{ Number(row.local_stock || 0) }}</template>
              </el-table-column>
              <el-table-column label="预警" min-width="150">
                <template #default="{ row }">
                  <el-tag :type="tagType(row.warning_level)" effect="light">{{ row.warning_text }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="SKU / Offer" min-width="150">
                <template #default="{ row }">
                  <div class="cell-stack">
                    <span>{{ row.ozon_sku || "-" }}</span>
                    <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right" align="center">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openFbpDetail(row)">去处理</el-button>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="!fbpRows.length && !loading" class="compact-empty compact-empty--table">
              <strong>当前没有 FBO/FBP 低库存预警</strong>
              <span>平台仓可售库存低于 5 的商品会显示在这里。</span>
            </div>
          </div>

          <PageFooterPagination
            :total="fbpRows.length"
            :page="pager.fbp.page"
            :page-size="pager.fbp.pageSize"
            :page-sizes="[8, 12, 20]"
            @update:page="pager.fbp.page = $event"
            @update:pageSize="pager.fbp.pageSize = $event; pager.fbp.page = 1"
          />
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="12">
        <el-card shadow="never" class="page-card dashboard-panel-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>FBS 在线商品预警</strong>
                <span>库存小于 0 直接预警，销售中商品库存低于 5 也会预警。</span>
              </div>
              <el-tag type="warning" effect="light">{{ fbsRows.length }} 条</el-tag>
            </div>
          </template>

          <div class="dashboard-table-shell">
            <el-table v-loading="loading" :data="pagedFbsRows" :height="TABLE_HEIGHT" stripe border class="erp-data-table">
              <el-table-column label="商品" min-width="260" fixed="left">
                <template #default="{ row }">
                  <div class="product-cell">
                    <el-image v-if="imageUrl(row)" :src="imageUrl(row)" fit="cover" class="product-thumb" />
                    <div v-else class="product-thumb product-thumb-fallback">无图</div>
                    <div class="cell-stack">
                      <strong>{{ displayName(row) }}</strong>
                      <span class="muted-text">{{ row.inventory_id || row.online_name || "-" }}</span>
                      <span class="muted-text">{{ row.shop_name || "-" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="FBS库存" width="100" align="center">
                <template #default="{ row }">
                  <strong :class="{ 'danger-text': Number(row.fbs_available || 0) < 0 }">{{ Number(row.fbs_available || 0) }}</strong>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">{{ row.status_key === "selling" ? "销售中" : "非销售中" }}</template>
              </el-table-column>
              <el-table-column label="预警" min-width="170">
                <template #default="{ row }">
                  <el-tag :type="tagType(row.warning_level)" effect="light">{{ row.warning_text }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="SKU / Offer" min-width="150">
                <template #default="{ row }">
                  <div class="cell-stack">
                    <span>{{ row.ozon_sku || "-" }}</span>
                    <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right" align="center">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openFbsDetail(row)">去处理</el-button>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="!fbsRows.length && !loading" class="compact-empty compact-empty--table">
              <strong>当前没有 FBS 在线库存预警</strong>
              <span>负库存和销售中库存低于 5 的在线商品会显示在这里。</span>
            </div>
          </div>

          <PageFooterPagination
            :total="fbsRows.length"
            :page="pager.fbs.page"
            :page-size="pager.fbs.pageSize"
            :page-sizes="[8, 12, 20]"
            @update:page="pager.fbs.page = $event"
            @update:pageSize="pager.fbs.pageSize = $event; pager.fbs.page = 1"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="page-card dashboard-panel-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>待采购未处理</strong>
            <span>首页保留还没采购的商品，方便直接推进采购动作。</span>
          </div>
          <el-tag type="primary" effect="light">{{ procurementRows.length }} 条</el-tag>
        </div>
      </template>

      <div class="dashboard-table-shell">
        <el-table v-loading="loading" :data="pagedProcurementRows" :height="TABLE_HEIGHT" stripe border class="erp-data-table">
          <el-table-column label="商品" min-width="280" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <el-image v-if="imageUrl(row)" :src="imageUrl(row)" fit="cover" class="product-thumb" />
                <div v-else class="product-thumb product-thumb-fallback">无图</div>
                <div class="cell-stack">
                  <strong>{{ row.product_name || "-" }}</strong>
                  <span class="muted-text">{{ row.product_code || "-" }}</span>
                  <span class="muted-text">申请人 {{ (row.requester_names || []).join("、") || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="申请数" width="90" align="center">
            <template #default="{ row }">{{ Number(row.request_count || 0) }}</template>
          </el-table-column>
          <el-table-column label="数量" width="90" align="center">
            <template #default="{ row }">{{ Number(row.total_quantity || 0) }}</template>
          </el-table-column>
          <el-table-column label="供应商" min-width="180">
            <template #default="{ row }">{{ (row.supplier_names || []).join("、") || "-" }}</template>
          </el-table-column>
          <el-table-column label="最早提交" width="170">
            <template #default="{ row }">{{ dateText(row.earliest_created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="openProcurementDetail(row)">去处理</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="!procurementRows.length && !loading" class="compact-empty compact-empty--table">
          <strong>当前没有待采购未处理商品</strong>
          <span>已经提交但还没采购的商品会显示在这里。</span>
        </div>
      </div>

      <PageFooterPagination
        :total="procurementRows.length"
        :page="pager.procurement.page"
        :page-size="pager.procurement.pageSize"
        :page-sizes="[8, 12, 20]"
        @update:page="pager.procurement.page = $event"
        @update:pageSize="pager.procurement.pageSize = $event; pager.procurement.page = 1"
      />
    </el-card>
  </div>
</template>

<style scoped>
.dashboard-page {
  padding-bottom: 8px;
}

.dashboard-metric-card :deep(.el-card__body) {
  position: relative;
}

.dashboard-metric-card .el-tag {
  width: fit-content;
}

.dashboard-grid {
  align-items: stretch;
}

.dashboard-panel-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dashboard-panel-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding-bottom: 0;
}

.dashboard-table-shell {
  flex: 1;
  min-height: 0;
}
</style>
