<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { ChatDotRound, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const loading = ref(false);
const syncing = ref(false);
const replying = ref(false);
const replyDialogVisible = ref(false);
const shops = ref([]);
const templates = ref([]);
const currentReview = ref(null);

const state = reactive({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 30,
  filters: {
    shopId: "all",
    replyStatus: "pending",
    rating: "all",
    keyword: ""
  }
});

const replyForm = reactive({
  reply_text: ""
});

const pendingCount = computed(() => state.rows.filter((row) => row.reply_status !== "replied").length);

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function statusLabel(value) {
  if (value === "replied") return "已回复";
  if (value === "ignored") return "已忽略";
  return "待回复";
}

function statusType(value) {
  if (value === "replied") return "success";
  if (value === "ignored") return "info";
  return "warning";
}

function queryString() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    shopId: String(state.filters.shopId || "all"),
    replyStatus: String(state.filters.replyStatus || "all"),
    rating: String(state.filters.rating || "all")
  });
  const keyword = String(state.filters.keyword || "").trim();
  if (keyword) params.set("keyword", keyword);
  return params.toString();
}

async function loadDictionaries() {
  const [shopRows, templateRows] = await Promise.all([
    apiClient.get("/api/shops"),
    apiClient.get("/api/review-reply-templates")
  ]);
  shops.value = Array.isArray(shopRows) ? shopRows.filter((shop) => shop.status !== "deleted") : [];
  templates.value = Array.isArray(templateRows) ? templateRows : [];
}

async function loadReviews() {
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/reviews?${queryString()}`);
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
  } catch (error) {
    ElMessage.error(error.message || "评价加载失败");
  } finally {
    loading.value = false;
  }
}

async function syncReviews() {
  syncing.value = true;
  try {
    const result = await apiClient.post("/api/reviews/sync", {
      shop_id: state.filters.shopId === "all" ? "" : state.filters.shopId,
      maxPages: 3
    });
    if (result.errors?.length) {
      await ElMessageBox.alert(result.errors.join("\n"), "部分店铺同步失败", {
        type: "warning",
        confirmButtonText: "知道了"
      });
    } else {
      ElMessage.success(`同步完成：${result.upserted || 0} 条评价`);
    }
    await loadReviews();
  } catch (error) {
    ElMessage.error(error.message || "同步评价失败");
  } finally {
    syncing.value = false;
  }
}

function handleSearch() {
  state.page = 1;
  loadReviews();
}

function handleReset() {
  state.filters.shopId = "all";
  state.filters.replyStatus = "pending";
  state.filters.rating = "all";
  state.filters.keyword = "";
  state.page = 1;
  loadReviews();
}

function openReply(row) {
  currentReview.value = row;
  const match = templates.value.find((item) => {
    const rating = Number(row.rating || 0);
    const min = item.min_rating == null ? 0 : Number(item.min_rating);
    const max = item.max_rating == null ? 5 : Number(item.max_rating);
    return rating >= min && rating <= max;
  });
  replyForm.reply_text = row.reply_text || match?.template_text || "";
  replyDialogVisible.value = true;
}

function applyTemplate(template) {
  replyForm.reply_text = template.template_text || "";
}

async function submitReply() {
  const review = currentReview.value;
  const text = String(replyForm.reply_text || "").trim();
  if (!review || !text) {
    ElMessage.warning("请先填写回复内容");
    return;
  }
  try {
    await ElMessageBox.confirm("确认把这条回复发送到 Ozon 店铺后台？", "发送回复", {
      type: "warning",
      confirmButtonText: "发送",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  replying.value = true;
  try {
    await apiClient.post(`/api/reviews/${review.id}/reply`, { reply_text: text, source: "manual" });
    ElMessage.success("回复已提交到 Ozon");
    replyDialogVisible.value = false;
    await loadReviews();
  } catch (error) {
    ElMessage.error(error.message || "回复提交失败");
  } finally {
    replying.value = false;
  }
}

onMounted(async () => {
  await loadDictionaries();
  await loadReviews();
});
</script>

<template>
  <div class="review-center">
    <section class="page-head">
      <div>
        <h1>评价中心</h1>
        <p>集中查看多店铺评价，在系统里统一回复 Ozon 买家反馈。</p>
      </div>
      <div class="head-actions">
        <el-statistic title="当前列表待回复" :value="pendingCount" />
        <el-button :icon="Refresh" :loading="syncing" type="primary" @click="syncReviews">同步评价</el-button>
      </div>
    </section>

    <section class="toolbar">
      <el-select v-model="state.filters.shopId" class="filter-item" placeholder="店铺" @change="handleSearch">
        <el-option label="全部店铺" value="all" />
        <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
      </el-select>
      <el-select v-model="state.filters.replyStatus" class="filter-item" placeholder="回复状态" @change="handleSearch">
        <el-option label="全部状态" value="all" />
        <el-option label="待回复" value="pending" />
        <el-option label="已回复" value="replied" />
      </el-select>
      <el-select v-model="state.filters.rating" class="filter-item small" placeholder="评分" @change="handleSearch">
        <el-option label="全部评分" value="all" />
        <el-option v-for="rating in [5, 4, 3, 2, 1]" :key="rating" :label="`${rating} 星`" :value="String(rating)" />
      </el-select>
      <el-input v-model="state.filters.keyword" class="keyword" clearable placeholder="商品、SKU、评价内容" @keyup.enter="handleSearch" />
      <el-button :icon="Search" @click="handleSearch">搜索</el-button>
      <el-button @click="handleReset">重置</el-button>
    </section>

    <el-table v-loading="loading" :data="state.rows" row-key="id" class="review-table" border>
      <el-table-column label="店铺 / 商品" min-width="260">
        <template #default="{ row }">
          <div class="product-cell">
            <el-image v-if="row.product_image" :src="row.product_image" fit="cover" class="product-image" />
            <div>
              <div class="shop-name">{{ row.shop_name }}</div>
              <div class="product-name">{{ row.product_name || row.offer_id || row.ozon_sku }}</div>
              <div class="muted">SKU {{ row.ozon_sku || "-" }} · Offer {{ row.offer_id || "-" }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="评分" width="120" align="center">
        <template #default="{ row }">
          <el-rate :model-value="Number(row.rating || 0)" disabled />
        </template>
      </el-table-column>
      <el-table-column label="评价内容" min-width="340">
        <template #default="{ row }">
          <div class="review-text">{{ row.review_text || "无文字评价" }}</div>
          <div v-if="row.advantages" class="muted">优点：{{ row.advantages }}</div>
          <div v-if="row.disadvantages" class="muted">缺点：{{ row.disadvantages }}</div>
          <div v-if="row.reply_text" class="reply-preview">回复：{{ row.reply_text }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusType(row.reply_status)">{{ statusLabel(row.reply_status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="评价时间" width="170">
        <template #default="{ row }">{{ dateText(row.published_at || row.synced_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button :icon="ChatDotRound" type="primary" link @click="openReply(row)">
            {{ row.reply_status === "replied" ? "查看回复" : "回复" }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination">
      <el-pagination
        v-model:current-page="state.page"
        v-model:page-size="state.pageSize"
        :page-sizes="[20, 30, 50, 100]"
        :total="state.total"
        layout="total, sizes, prev, pager, next"
        @current-change="loadReviews"
        @size-change="handleSearch"
      />
    </div>

    <el-dialog v-model="replyDialogVisible" title="回复评价" width="720px">
      <div v-if="currentReview" class="dialog-review">
        <div class="dialog-title">{{ currentReview.product_name || currentReview.ozon_sku }}</div>
        <el-rate :model-value="Number(currentReview.rating || 0)" disabled />
        <p>{{ currentReview.review_text || "无文字评价" }}</p>
      </div>
      <div class="template-row">
        <el-button v-for="template in templates" :key="template.id" size="small" @click="applyTemplate(template)">
          {{ template.title }}
        </el-button>
      </div>
      <el-input
        v-model="replyForm.reply_text"
        type="textarea"
        :rows="6"
        maxlength="1000"
        show-word-limit
        placeholder="输入俄语回复内容"
      />
      <template #footer>
        <el-button @click="replyDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="replying" @click="submitReply">发送到 Ozon</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.review-center {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.page-head h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.page-head p,
.muted {
  color: var(--el-text-color-secondary);
}

.head-actions,
.toolbar,
.template-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar {
  padding: 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
}

.filter-item {
  width: 180px;
}

.filter-item.small {
  width: 130px;
}

.keyword {
  width: 260px;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.product-image {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color-lighter);
  flex: 0 0 auto;
}

.shop-name {
  font-weight: 700;
}

.product-name {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-text {
  white-space: pre-wrap;
}

.reply-preview {
  margin-top: 6px;
  color: var(--el-color-success);
}

.pagination {
  display: flex;
  justify-content: flex-end;
}

.dialog-review {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.dialog-title {
  font-weight: 700;
  margin-bottom: 6px;
}

.template-row {
  margin-bottom: 12px;
}

@media (max-width: 860px) {
  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .filter-item,
  .filter-item.small,
  .keyword {
    width: 100%;
  }
}
</style>
