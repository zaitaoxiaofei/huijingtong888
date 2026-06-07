<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { money, shortText } from "./mobile-orders-utils.js";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const procurementLoading = ref(false);
const creatingProcurement = ref(false);
const bindingVisible = ref(false);
const bindingLoading = ref(false);
const bindingSubmitting = ref(false);
const productOptionsLoading = ref(false);
const detail = ref(null);
const procurement = ref(null);
const productOptions = ref([]);
const peopleOptions = ref([]);
const bindingItem = ref(null);
const autoBindOpened = ref(false);
const bindingForm = reactive({
  product_id: "",
  person_id: "",
  query: ""
});

const orderId = computed(() => Number(route.params.id || 0));
const order = computed(() => detail.value?.order || {});
const items = computed(() => Array.isArray(detail.value?.items) ? detail.value.items : []);
const finance = computed(() => detail.value?.finance || {});
const unboundItems = computed(() => items.value.filter((item) => !item.product_name && !item.product_code));
const purchasableProducts = computed(() => Array.isArray(procurement.value?.products) ? procurement.value.products : []);

async function loadDetail() {
  if (!orderId.value) return;
  loading.value = true;
  try {
    detail.value = await apiClient.get(`/api/orders/${orderId.value}`, { noCache: true });
    await loadProcurementPreview();
    await maybeOpenRouteBindDialog();
  } catch (error) {
    ElMessage.error(error.message || "订单详情加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadProcurementPreview() {
  procurementLoading.value = true;
  try {
    procurement.value = await apiClient.get(`/api/orders/${orderId.value}/procurement-preview`, { noCache: true });
  } catch (error) {
    procurement.value = null;
    console.warn("load mobile procurement preview failed", error);
  } finally {
    procurementLoading.value = false;
  }
}

async function loadPeopleOptions() {
  if (peopleOptions.value.length) return;
  try {
    const result = await apiClient.get("/api/people", { noCache: true });
    peopleOptions.value = Array.isArray(result) ? result.filter((item) => Number(item.active) !== 0) : [];
  } catch (error) {
    peopleOptions.value = [];
    console.warn("load mobile people options failed", error);
  }
}

async function loadProductOptions(query = "") {
  productOptionsLoading.value = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "40" });
    const keyword = String(query || "").trim();
    if (keyword) params.set("query", keyword);
    const result = await apiClient.get(`/api/products?${params.toString()}`, { noCache: true });
    productOptions.value = Array.isArray(result?.rows) ? result.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "库存商品候选加载失败");
  } finally {
    productOptionsLoading.value = false;
  }
}

async function openMobileBind(item = {}) {
  if (!item.online_product_id) {
    ElMessage.warning("这条订单商品还没有匹配到在线商品，请先同步在线商品后再绑定");
    return;
  }
  bindingItem.value = item;
  bindingForm.product_id = "";
  bindingForm.person_id = "";
  bindingForm.query = item.ozon_name || item.offer_id || item.ozon_sku || "";
  bindingVisible.value = true;
  bindingLoading.value = true;
  try {
    await Promise.all([
      loadPeopleOptions(),
      loadProductOptions(bindingForm.query)
    ]);
  } finally {
    bindingLoading.value = false;
  }
}

async function searchBindingProducts() {
  await loadProductOptions(bindingForm.query);
}

async function submitMobileBind() {
  const onlineProductId = Number(bindingItem.value?.online_product_id || 0);
  if (!onlineProductId) {
    ElMessage.warning("没有找到可绑定的在线商品");
    return;
  }
  if (!bindingForm.product_id) {
    ElMessage.warning("请选择要绑定的库存商品");
    return;
  }
  bindingSubmitting.value = true;
  try {
    await apiClient.post("/api/online-products/bind", {
      online_product_id: onlineProductId,
      product_id: Number(bindingForm.product_id),
      person_id: bindingForm.person_id ? Number(bindingForm.person_id) : null
    });
    ElMessage.success("库存绑定成功");
    bindingVisible.value = false;
    await loadDetail();
  } catch (error) {
    ElMessage.error(error.message || "绑定库存失败");
  } finally {
    bindingSubmitting.value = false;
  }
}

async function maybeOpenRouteBindDialog() {
  if (autoBindOpened.value || String(route.query.action || "") !== "bind") return;
  autoBindOpened.value = true;
  const targetSku = String(route.query.sku || "");
  const target = items.value.find((item) => {
    if (item.product_name || item.product_code) return false;
    if (!targetSku) return true;
    return String(item.ozon_sku || "") === targetSku;
  });
  if (target) await openMobileBind(target);
}

function openMobileProcurement() {
  router.push("/mobile/procurement");
}

function productPurchasePayload() {
  return purchasableProducts.value.map((product) => ({
    product_id: Number(product.product_id || product.id || 0),
    quantity: Math.max(0, Number(product.purchase_quantity ?? product.shortage_quantity ?? product.quantity ?? 0)),
    amount: Number(product.purchase_cost || product.amount || 0),
    shipping_amount: Number(product.shipping_amount || 0)
  })).filter((item) => item.product_id);
}

async function createProcurement() {
  if (!purchasableProducts.value.length) {
    ElMessage.info("当前订单没有可直接创建的采购项");
    return;
  }
  try {
    await ElMessageBox.confirm("确认根据当前订单创建采购需求？", "创建采购需求", {
      type: "warning",
      confirmButtonText: "确认创建",
      cancelButtonText: "取消"
    });
    creatingProcurement.value = true;
    const result = await apiClient.post(`/api/orders/${orderId.value}/procurement-requests`, {
      urgency: "normal",
      product_purchases: productPurchasePayload()
    });
    ElMessage.success(`已创建 ${Number(result.created_count || 0)} 条采购需求`);
    await loadProcurementPreview();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "采购需求创建失败");
  } finally {
    creatingProcurement.value = false;
  }
}

onMounted(() => loadDetail());
</script>

<template>
  <div class="mobile-detail-page" v-loading="loading">
    <section class="mobile-detail-hero">
      <span>{{ shortText(order.shop_name, "店铺") }}</span>
      <h1>{{ shortText(order.posting_number || order.order_number, "订单详情") }}</h1>
      <div class="mobile-detail-hero__facts">
        <strong>{{ shortText(order.status || order.tracking_stage, "状态未知") }}</strong>
        <strong>{{ money(order.revenue || order.total_price, "₽") }}</strong>
      </div>
    </section>

    <section class="mobile-section">
      <div class="mobile-section__head">
        <h2>商品明细</h2>
        <span>{{ items.length }} 项</span>
      </div>
      <article v-for="item in items" :key="item.id" class="mobile-item-card">
        <img v-if="item.image_url" :src="item.image_url" alt="">
        <div v-else class="mobile-item-card__fallback">SKU</div>
        <div class="mobile-item-card__main">
          <h3>{{ shortText(item.product_name || item.ozon_name, "未绑定商品") }}</h3>
          <p>Ozon SKU：{{ shortText(item.ozon_sku) }}</p>
          <p>货号：{{ shortText(item.offer_id || item.product_code) }}</p>
          <div class="mobile-item-card__chips">
            <span>数量 {{ Number(item.quantity || 0) }}</span>
            <span>{{ money(item.sale_price, "₽") }}</span>
            <span :class="{ danger: !item.product_name && !item.product_code }">
              {{ item.product_name || item.product_code ? "已绑定" : "待绑定" }}
            </span>
          </div>
          <button
            v-if="!item.product_name && !item.product_code"
            type="button"
            @click="openMobileBind(item)"
          >
            去绑定库存
          </button>
        </div>
      </article>
    </section>

    <section class="mobile-section">
      <div class="mobile-section__head">
        <h2>库存与采购</h2>
        <span v-if="procurementLoading">检查中</span>
        <span v-else>{{ purchasableProducts.length }} 个采购项</span>
      </div>

      <div v-if="unboundItems.length" class="mobile-warning">
        <strong>还有 {{ unboundItems.length }} 个商品未绑定库存</strong>
        <span>先完成绑定后，采购建议会更准确。</span>
      </div>

      <article v-for="product in purchasableProducts" :key="product.product_id || product.id" class="mobile-proc-card">
        <strong>{{ shortText(product.product_name || product.name || product.ozon_sku, "采购商品") }}</strong>
        <span>建议采购：{{ Number(product.purchase_quantity ?? product.shortage_quantity ?? product.quantity ?? 0) }}</span>
        <span>当前库存：{{ Number(product.current_stock || product.stock || 0) }}</span>
      </article>

      <el-button
        type="primary"
        class="mobile-primary-action"
        :loading="creatingProcurement"
        @click="createProcurement"
      >
        创建采购需求
      </el-button>
      <el-button class="mobile-secondary-action" @click="openMobileProcurement">
        打开采购页面
      </el-button>
      <el-button class="mobile-secondary-action" :loading="procurementLoading" @click="loadProcurementPreview">
        刷新采购建议
      </el-button>
    </section>

    <section class="mobile-section">
      <div class="mobile-section__head">
        <h2>利润摘要</h2>
      </div>
      <div class="mobile-profit-grid">
        <div>
          <span>预估利润</span>
          <strong>{{ money(order.estimated_profit) }}</strong>
        </div>
        <div>
          <span>实际利润</span>
          <strong>{{ money(order.actual_profit) }}</strong>
        </div>
        <div>
          <span>采购成本</span>
          <strong>{{ money(order.profit_purchase_cost) }}</strong>
        </div>
        <div>
          <span>服务费</span>
          <strong>{{ money(order.profit_ozon_service_fee) }}</strong>
        </div>
      </div>
    </section>

    <el-dialog
      v-model="bindingVisible"
      title="绑定库存"
      width="94%"
      class="mobile-bind-dialog"
      destroy-on-close
      append-to-body
    >
      <div class="mobile-bind-panel" v-loading="bindingLoading">
        <section v-if="bindingItem" class="mobile-bind-target">
          <strong>{{ shortText(bindingItem.ozon_name || bindingItem.online_product_name || bindingItem.ozon_sku, "待绑定商品") }}</strong>
          <span>SKU：{{ shortText(bindingItem.ozon_sku) }}</span>
          <span>货号：{{ shortText(bindingItem.offer_id) }}</span>
        </section>

        <section class="mobile-bind-search">
          <el-input
            v-model="bindingForm.query"
            clearable
            placeholder="搜索库存商品 / 编码"
            @keyup.enter="searchBindingProducts"
          />
          <el-button type="primary" :loading="productOptionsLoading" @click="searchBindingProducts">搜索</el-button>
        </section>

        <section class="mobile-bind-options">
          <label
            v-for="product in productOptions"
            :key="product.id"
            class="mobile-bind-option"
            :class="{ active: String(product.id) === String(bindingForm.product_id) }"
          >
            <input v-model="bindingForm.product_id" type="radio" :value="String(product.id)">
            <img v-if="product.image_url" :src="product.image_url" alt="">
            <span v-else class="mobile-bind-option__fallback">SKU</span>
            <span class="mobile-bind-option__text">
              <strong>{{ shortText(product.name, "库存商品") }}</strong>
              <small>{{ product.inventory_id || product.code || product.id }}</small>
            </span>
          </label>
        </section>

        <section class="mobile-bind-owner">
          <span>负责人</span>
          <el-select v-model="bindingForm.person_id" clearable filterable placeholder="可不选" style="width: 100%">
            <el-option v-for="person in peopleOptions" :key="person.id" :label="person.name" :value="String(person.id)" />
          </el-select>
        </section>
      </div>

      <template #footer>
        <div class="mobile-bind-footer">
          <el-button @click="bindingVisible = false">取消</el-button>
          <el-button type="primary" :loading="bindingSubmitting" @click="submitMobileBind">确认绑定</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mobile-detail-page {
  display: grid;
  gap: 12px;
}

.mobile-detail-hero,
.mobile-section {
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
}

.mobile-detail-hero {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.mobile-detail-hero span {
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
}

.mobile-detail-hero h1 {
  margin: 0;
  overflow-wrap: anywhere;
  color: #172033;
  font-size: 18px;
  line-height: 1.25;
}

.mobile-detail-hero__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mobile-detail-hero__facts strong {
  padding: 5px 9px;
  border-radius: 999px;
  background: #eef6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.mobile-section {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.mobile-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-section__head h2 {
  margin: 0;
  color: #172033;
  font-size: 15px;
}

.mobile-section__head span {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.mobile-item-card {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fafc;
}

.mobile-item-card img,
.mobile-item-card__fallback {
  width: 76px;
  height: 76px;
  border-radius: 12px;
  object-fit: cover;
  background: #e2e8f0;
}

.mobile-item-card__fallback {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 800;
}

.mobile-item-card__main {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.mobile-item-card__main h3 {
  margin: 0;
  color: #172033;
  font-size: 14px;
  line-height: 1.35;
}

.mobile-item-card__main p {
  margin: 0;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-item-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mobile-item-card__chips span {
  padding: 3px 7px;
  border-radius: 999px;
  background: #fff;
  color: #475569;
  font-size: 11px;
  font-weight: 800;
}

.mobile-item-card__chips span.danger {
  background: #fee2e2;
  color: #b91c1c;
}

.mobile-item-card button {
  width: fit-content;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fff1f2;
  color: #b91c1c;
  font-size: 12px;
  font-weight: 800;
}

.mobile-warning {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #fed7aa;
  border-radius: 12px;
  background: #fff7ed;
}

.mobile-warning strong {
  color: #c2410c;
  font-size: 13px;
}

.mobile-warning span {
  color: #9a3412;
  font-size: 12px;
}

.mobile-proc-card {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #eff6ff;
}

.mobile-proc-card strong {
  color: #1e3a8a;
  font-size: 13px;
}

.mobile-proc-card span {
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 700;
}

.mobile-primary-action {
  width: 100%;
  min-height: 42px;
  border-radius: 12px;
}

.mobile-secondary-action {
  width: 100%;
  min-height: 42px;
  border-radius: 12px;
}

.mobile-profit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.mobile-profit-grid div {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 12px;
  background: #f8fafc;
}

.mobile-profit-grid span {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.mobile-profit-grid strong {
  color: #172033;
  font-size: 16px;
}

.mobile-bind-dialog :deep(.el-dialog) {
  max-width: 420px;
  margin: 5vh auto 0;
  border-radius: 14px;
}

.mobile-bind-dialog :deep(.el-dialog__body) {
  padding: 12px 14px;
}

.mobile-bind-panel {
  display: grid;
  gap: 12px;
  max-height: min(68vh, 620px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.mobile-bind-target {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #eff6ff;
}

.mobile-bind-target strong {
  color: #1e3a8a;
  font-size: 13px;
  line-height: 1.35;
}

.mobile-bind-target span {
  overflow: hidden;
  color: #1d4ed8;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-bind-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px;
  gap: 8px;
}

.mobile-bind-search :deep(.el-input__wrapper),
.mobile-bind-search :deep(.el-button) {
  min-height: 40px;
  border-radius: 10px;
}

.mobile-bind-options {
  display: grid;
  gap: 8px;
}

.mobile-bind-option {
  display: grid;
  grid-template-columns: 18px 54px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  padding: 9px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}

.mobile-bind-option.active {
  border-color: #93c5fd;
  background: #eff6ff;
}

.mobile-bind-option input {
  width: 16px;
  height: 16px;
}

.mobile-bind-option img,
.mobile-bind-option__fallback {
  width: 54px;
  height: 54px;
  border-radius: 10px;
  object-fit: cover;
  background: #eef2f7;
}

.mobile-bind-option__fallback {
  display: grid;
  place-items: center;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 800;
}

.mobile-bind-option__text {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.mobile-bind-option__text strong {
  display: -webkit-box;
  overflow: hidden;
  color: #172033;
  font-size: 13px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.mobile-bind-option__text small {
  overflow: hidden;
  color: #64748b;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-bind-owner {
  display: grid;
  gap: 6px;
}

.mobile-bind-owner span {
  color: #334155;
  font-size: 12px;
  font-weight: 800;
}

.mobile-bind-footer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.mobile-bind-footer :deep(.el-button) {
  min-height: 40px;
  border-radius: 10px;
}
</style>
