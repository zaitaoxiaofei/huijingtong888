<script setup>
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { useAuthStore } from "../../stores/auth.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initialProductId: { type: [Number, String, null], default: null },
  lockProduct: { type: Boolean, default: false }
});

const emit = defineEmits(["update:modelValue", "created"]);

const authStore = useAuthStore();
const loading = ref(false);
const submitting = ref(false);
const productQuery = ref("");

const state = reactive({
  products: [],
  people: [],
  suppliers: []
});

const form = reactive(createDefaultForm());

const candidateProducts = computed(() => {
  const query = String(productQuery.value || "").trim().toLowerCase();
  const rows = state.products.filter((row) => Number(row.active ?? 1) !== 0);
  if (!query) return rows.slice(0, 12);
  return rows.filter((row) => {
    const haystack = [
      row.name,
      row.inventory_id,
      row.code,
      row.selection_id,
      row.mapped_skus,
      row.owner_name
    ].map((item) => String(item || "").toLowerCase()).join(" ");
    return haystack.includes(query);
  }).slice(0, 12);
});

const selectedProduct = computed(() => state.products.find((row) => Number(row.id) === Number(form.product_id)) || null);
const currentUserPersonId = computed(() => Number(authStore.user?.id || 0) || null);

function createDefaultForm() {
  return {
    product_id: null,
    person_id: null,
    quantity: 1,
    amount: 0,
    shipping_amount: 0,
    urgency: "normal",
    source_type: "1688",
    supplier_id: "",
    purchase_url: "",
    note: ""
  };
}

function resetForm() {
  Object.assign(form, createDefaultForm());
  productQuery.value = "";
}

function productImage(row) {
  return row?.product_image_url || row?.image_url || "";
}

function productCode(row) {
  return row?.product_code || row?.inventory_id || row?.code || "-";
}

function productSkuText(row) {
  return row?.mapped_skus || "未绑定 SKU";
}

function supplierName(id) {
  return state.suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || "";
}

function preferredPersonId() {
  if (currentUserPersonId.value && state.people.some((item) => Number(item.id) === Number(currentUserPersonId.value))) {
    return currentUserPersonId.value;
  }
  return state.people[0]?.id || null;
}

function applyProductToForm(row) {
  form.product_id = row.id;
  form.person_id = preferredPersonId();
  form.supplier_id = row.supplier_id || "";
  form.purchase_url = row.purchase_url || "";
  form.amount = Number(row.purchase_cost || 0);
  form.shipping_amount = Number(row.domestic_shipping || 0);
}

function syncInitialProduct() {
  if (!props.initialProductId) return;
  const matched = state.products.find((row) => Number(row.id) === Number(props.initialProductId));
  if (!matched) return;
  applyProductToForm(matched);
  productQuery.value = matched.name || matched.inventory_id || matched.code || "";
}

async function ensureOptionsLoaded() {
  if (state.products.length && state.people.length) {
    syncInitialProduct();
    return;
  }
  loading.value = true;
  try {
    const [products, people, suppliers] = await Promise.all([
      apiClient.get("/api/products"),
      apiClient.get("/api/people"),
      apiClient.get("/api/suppliers")
    ]);
    state.products = Array.isArray(products) ? products : [];
    state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
    state.suppliers = Array.isArray(suppliers) ? suppliers : [];
    form.person_id = preferredPersonId();
    syncInitialProduct();
  } catch (error) {
    ElMessage.error(error.message || "初始化采购表单失败");
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!form.product_id) {
    ElMessage.warning("请先选择商品");
    return;
  }
  submitting.value = true;
  try {
    await apiClient.post("/api/procurement/requests", {
      ...form,
      quantity: Number(form.quantity || 1),
      amount: Number(form.amount || 0),
      shipping_amount: Number(form.shipping_amount || 0),
      person_id: Number(form.person_id || 0) || null,
      supplier_id: form.supplier_id || null
    });
    ElMessage.success("采购请求已创建");
    emit("created");
    emit("update:modelValue", false);
    resetForm();
  } catch (error) {
    ElMessage.error(error.message || "创建采购请求失败");
  } finally {
    submitting.value = false;
  }
}

watch(() => props.modelValue, async (visible) => {
  if (visible) {
    resetForm();
    await ensureOptionsLoaded();
  }
});

watch(() => props.initialProductId, () => {
  if (props.modelValue) syncInitialProduct();
});

watch(currentUserPersonId, () => {
  if (props.modelValue) {
    form.person_id = preferredPersonId();
  }
});
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="新建采购请求"
    width="1040px"
    align-center
    class="erp-centered-dialog"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetForm"
  >
    <div v-loading="loading" class="proc-dialog" :class="{ 'proc-dialog-locked': lockProduct }">
      <div v-if="!lockProduct" class="proc-dialog-left">
        <div class="dialog-search-head">
          <strong>搜索商品</strong>
          <span>图片、编码和 SKU 一起展示，减少误选。</span>
        </div>
        <el-input v-model="productQuery" placeholder="搜索商品名称、库存 ID 或 SKU" clearable />
        <div class="product-picker-list">
          <button
            v-for="product in candidateProducts"
            :key="product.id"
            type="button"
            class="product-picker-item"
            :class="{ active: Number(form.product_id) === Number(product.id) }"
            @click="applyProductToForm(product)"
          >
            <el-image
              v-if="productImage(product)"
              :src="productImage(product)"
              fit="cover"
              class="picker-thumb"
              :preview-src-list="[productImage(product)]"
              preview-teleported
            />
            <div v-else class="picker-thumb picker-thumb-fallback">无图</div>
            <div class="picker-item-meta">
              <strong>{{ product.name || "-" }}</strong>
              <span>编码：{{ productCode(product) }}</span>
              <span>SKU：{{ productSkuText(product) }}</span>
              <span>负责人：{{ product.owner_name || "-" }}</span>
            </div>
          </button>
          <div v-if="!candidateProducts.length" class="picker-empty">没有匹配到商品，换个关键词试试。</div>
        </div>
      </div>

      <div class="proc-dialog-right">
        <div class="selected-product-card">
          <template v-if="selectedProduct">
            <div class="selected-product-main">
              <el-image
                v-if="productImage(selectedProduct)"
                :src="productImage(selectedProduct)"
                fit="cover"
                class="selected-product-thumb"
                :preview-src-list="[productImage(selectedProduct)]"
                preview-teleported
              />
              <div v-else class="selected-product-thumb picker-thumb-fallback">无图</div>
              <div class="selected-product-meta">
                <strong>{{ selectedProduct.name }}</strong>
                <span>库存编码：{{ productCode(selectedProduct) }}</span>
                <span>负责人：{{ selectedProduct.owner_name || "-" }}</span>
                <span>供应商：{{ supplierName(selectedProduct.supplier_id) || "-" }}</span>
              </div>
            </div>
            <div class="selected-product-facts">
              <div class="fact-pill">
                <span>默认货款</span>
                <strong>¥ {{ Number(selectedProduct.purchase_cost || 0).toFixed(2) }}</strong>
              </div>
              <div class="fact-pill">
                <span>默认运费</span>
                <strong>¥ {{ Number(selectedProduct.domestic_shipping || 0).toFixed(2) }}</strong>
              </div>
              <div class="fact-pill">
                <span>SKU</span>
                <strong>{{ productSkuText(selectedProduct) }}</strong>
              </div>
            </div>
          </template>
          <span v-else class="muted-text">请先在左侧搜索并选择商品。</span>
        </div>

        <el-form label-width="110px">
          <div v-if="lockProduct" class="dialog-search-head dialog-locked-head">
            <strong>当前采购商品已确定</strong>
            <span>订单页面已经带入目标商品，这里直接填写采购信息即可。</span>
          </div>
          <el-row :gutter="16">
            <el-col :span="12">
              <el-form-item label="申请人">
                <el-select v-model="form.person_id">
                  <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="紧急程度">
                <el-select v-model="form.urgency">
                  <el-option label="普通" value="normal" />
                  <el-option label="加急" value="urgent" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="采购数量">
                <el-input-number v-model="form.quantity" :min="1" :precision="0" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="来源类型">
                <el-select v-model="form.source_type">
                  <el-option label="1688" value="1688" />
                  <el-option label="拼多多" value="pdd" />
                  <el-option label="供应商" value="supplier" />
                  <el-option label="微信" value="wechat" />
                  <el-option label="其他" value="other" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="货款总额">
                <el-input-number v-model="form.amount" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="运费总额">
                <el-input-number v-model="form.shipping_amount" :min="0" :precision="2" :step="1" controls-position="right" />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="供应商">
                <el-select v-model="form.supplier_id" clearable placeholder="请选择供应商">
                  <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="采购链接">
                <el-input v-model="form.purchase_url" placeholder="https://..." />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="备注">
                <el-input v-model="form.note" type="textarea" :rows="3" placeholder="颜色、规格等备注信息" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交请求</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.proc-dialog {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  min-height: 520px;
}

.proc-dialog.proc-dialog-locked {
  grid-template-columns: minmax(0, 1fr);
}

.proc-dialog-left,
.proc-dialog-right,
.dialog-search-head,
.picker-item-meta,
.selected-product-meta {
  display: grid;
  gap: 12px;
}

.dialog-search-head {
  gap: 4px;
}

.dialog-locked-head {
  margin-bottom: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(191, 219, 254, 0.9);
  border-radius: 14px;
  background: rgba(239, 246, 255, 0.8);
}

.dialog-search-head strong {
  font-size: 15px;
}

.dialog-search-head span,
.picker-item-meta span,
.selected-product-meta span,
.muted-text {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.product-picker-list {
  display: grid;
  gap: 10px;
  max-height: 460px;
  overflow: auto;
  padding-right: 4px;
}

.product-picker-item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(248, 250, 252, 1));
  text-align: left;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.product-picker-item:hover {
  transform: translateY(-2px);
  border-color: rgba(37, 99, 235, 0.35);
  box-shadow: 0 16px 30px rgba(37, 99, 235, 0.12);
}

.product-picker-item.active {
  border-color: var(--el-color-primary);
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.12), rgba(255, 255, 255, 0.96)), #fff;
  box-shadow: 0 18px 36px rgba(37, 99, 235, 0.14);
}

.picker-thumb,
.selected-product-thumb {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid rgba(198, 209, 225, 0.75);
  background: #fff;
}

.picker-thumb-fallback {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(15, 23, 42, 0.04)), #fff;
}

.picker-empty {
  padding: 28px 16px;
  border: 1px dashed var(--erp-border-strong);
  border-radius: 16px;
  text-align: center;
  color: var(--erp-text-secondary);
  background: rgba(248, 250, 252, 0.9);
}

.selected-product-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid rgba(191, 219, 254, 0.9);
  border-radius: 20px;
  background: radial-gradient(circle at top right, rgba(37, 99, 235, 0.14), transparent 28%), linear-gradient(180deg, rgba(239, 246, 255, 0.88), rgba(248, 250, 252, 0.98));
  box-shadow: 0 16px 32px rgba(37, 99, 235, 0.08);
}

.selected-product-main {
  display: flex;
  gap: 14px;
  align-items: center;
}

.selected-product-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.fact-pill {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(191, 219, 254, 0.9);
}

.fact-pill span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.fact-pill strong {
  font-size: 14px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@media (max-width: 1280px) {
  .selected-product-facts {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 960px) {
  .proc-dialog,
  .selected-product-main {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
