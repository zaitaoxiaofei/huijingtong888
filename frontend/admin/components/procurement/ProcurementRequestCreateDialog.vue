<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import ProductImagePreview from "../ProductImagePreview.vue";
import { apiClient, currentApiCacheScope } from "../../utils/api.js";
import { useAuthStore } from "../../stores/auth.js";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initialProductId: { type: [Number, String, null], default: null },
  lockProduct: { type: Boolean, default: false },
  initialQuantity: { type: Number, default: 1 },
  sourceOrderContext: { type: Object, default: () => ({}) },
  sourceRequestIds: { type: Array, default: () => [] },
  verifyingDemand: Boolean,
  demandError: String,
  initialProduct: { type: Object, default: () => null }
});

const emit = defineEmits(["update:modelValue", "created"]);

const authStore = useAuthStore();
const loading = ref(false);
const submitting = ref(false);
const productQuery = ref("");
const productError=ref(''),formTouched=ref(false);
let loadVersion=0,disposed=false;

const state = reactive({
  products: [],
  people: [],
  suppliers: []
});

const form = reactive(createDefaultForm());

const candidateProducts = computed(() => state.products.slice(0, 12));

const selectedProduct = computed(() => state.products.find((row) => Number(row.id) === Number(form.product_id)) || null);
const currentUserPersonId = computed(() => Number(authStore.user?.personId || authStore.user?.id || 0) || null);
const selectedProductEmptyText = computed(() => (
  props.lockProduct ? "正在加载当前库存商品，请稍候。" : "请先在左侧搜索并选择商品。"
));

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
  formTouched.value=false;
  Object.assign(form, createDefaultForm());
  if(Number.isSafeInteger(props.initialQuantity)&&props.initialQuantity>0)form.quantity=props.initialQuantity;
  if (props.lockProduct && props.initialProductId) form.product_id = Number(props.initialProductId);
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

function applyProductToForm(row, preserve=false) {
  form.product_id = row.id;
  if(preserve&&formTouched.value)return;
  if(!preserve||!form.person_id)form.person_id = preferredPersonId();
  if(!preserve||!form.supplier_id)form.supplier_id = row.supplier_id || "";
  if(!preserve||!form.purchase_url)form.purchase_url = row.purchase_url || "";
  if(!preserve||!form.amount)form.amount = Number(row.purchase_cost || 0);
  if(!preserve||!form.shipping_amount)form.shipping_amount = Number(row.domestic_shipping || 0);
}

function syncInitialProduct(preserve=false) {
  if (!props.initialProductId) return;
  const matched = state.products.find((row) => Number(row.id) === Number(props.initialProductId));
  if (!matched) {
    if (props.lockProduct) form.product_id = Number(props.initialProductId);
    return;
  }
  applyProductToForm(matched,preserve);
  productQuery.value = matched.name || matched.inventory_id || matched.code || "";
}

async function ensureInitialProductLoaded(isCurrent=()=>!disposed&&props.modelValue) {
  const productId=Number(props.initialProductId||0);if(!productId)return;
  const result=await apiClient.get(`/api/products/${productId}?includeDetails=0&includeOperations=0`);
  if(!isCurrent())return;
  const product=result?.data||result;
  if(!product?.id)throw Error('当前库存商品未返回，请刷新后重新打开');
  state.products=[product,...state.products.filter(row=>Number(row.id)!==productId)];
  syncInitialProduct(true);
}

async function ensureOptionsLoaded() {
  const token=++loadVersion,scope=currentApiCacheScope(),id=props.initialProductId;
  const isCurrent=()=>!disposed&&props.modelValue&&token===loadVersion&&id===props.initialProductId&&scope===currentApiCacheScope();
  loading.value=true;productError.value='';submitting.value=false;
  if(props.lockProduct&&props.initialProduct?.id)state.products=[{...props.initialProduct}];
  form.person_id=currentUserPersonId.value;
  const productTask=(async()=>{
    if(props.lockProduct&&props.initialProductId){await ensureInitialProductLoaded(isCurrent);return;}
    const products=await apiClient.get(productsQueryString());if(!isCurrent())return;
    state.products=Array.isArray(products?.rows)?products.rows:[];
    if(props.initialProductId)await ensureInitialProductLoaded(isCurrent);
  })().catch(error=>{if(isCurrent())productError.value=error.message||'采购商品加载失败，请重新打开';}).finally(()=>{if(isCurrent())loading.value=false;});
  const peopleTask=apiClient.get('/api/people').then(people=>{if(!isCurrent())return;state.people=(Array.isArray(people)?people:people.rows||[]).filter(item=>Number(item.active)!==0);if(!form.person_id||!state.people.some(p=>Number(p.id)===Number(form.person_id)))form.person_id=preferredPersonId();}).catch(error=>{if(isCurrent())ElMessage.error(error.message||'采购人加载失败');});
  const supplierTask=apiClient.get('/api/suppliers?paged=1&page=1&pageSize=100').then(suppliers=>{if(isCurrent())state.suppliers=Array.isArray(suppliers?.rows)?suppliers.rows:[];}).catch(error=>{if(isCurrent())ElMessage.warning(error.message||'供应商暂未加载，可稍后重新打开');});
  await Promise.allSettled([productTask,peopleTask,supplierTask]);
}

function productsQueryString() {
  const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "30" });
  const query = String(productQuery.value || props.initialProductId || "").trim();
  if (query) params.set("query", query);
  return `/api/products?${params.toString()}`;
}

async function searchProducts() {
  const token=++loadVersion,scope=currentApiCacheScope();
  const isCurrent=()=>!disposed&&props.modelValue&&token===loadVersion&&scope===currentApiCacheScope();
  loading.value=true;productError.value='';
  try{const products=await apiClient.get(productsQueryString());if(!isCurrent())return;
    state.products=Array.isArray(products?.rows)?products.rows:[];
    if(props.initialProductId)await ensureInitialProductLoaded(isCurrent);
  }catch(error){if(isCurrent())productError.value=error.message||'搜索商品失败';}
  finally{if(isCurrent())loading.value=false;}
}

async function submit() {
  if(submitting.value||loading.value||props.verifyingDemand||props.demandError||productError.value)return;
  if (!form.product_id) {
    ElMessage.warning("请先选择商品");
    return;
  }
  if (!(Number(form.amount || 0) > 0)) {
    ElMessage.warning("请填写实际采购货款；提交即表示已经完成下单");
    return;
  }
  const scope=currentApiCacheScope(),token=loadVersion;
  submitting.value = true;
  try {
    const requestIds=[...new Set(props.sourceRequestIds.map(Number).filter(id=>id>0))];
    await apiClient.post(requestIds.length?"/api/procurement/purchase-orders/confirm-from-requests":"/api/procurement/purchases", {
      ...(requestIds.length?{request_ids:requestIds}:{}),
      person_id: Number(form.person_id || 0) || null,
      source_type: form.source_type,
      supplier_id: form.supplier_id || null,
      note: form.note,
      items: [{
        ...form,
        quantity: Number(form.quantity || 1),
        actual_quantity: Number(form.quantity || 1),
        amount: Number(form.amount || 0),
        shipping_amount: Number(form.shipping_amount || 0),
        person_id: Number(form.person_id || 0) || null,
        supplier_id: form.supplier_id || null,
        source_order_id: Number(props.sourceOrderContext?.orderId || 0) || null,
        source_order_item_id: Number(props.sourceOrderContext?.orderItemId || 0) || null,
        source_ozon_sku: props.sourceOrderContext?.ozonSku || null
      }]
    });
    if(disposed||token!==loadVersion||scope!==currentApiCacheScope())return;
    ElMessage.success("采购已登记，商品已进入采购在途");
    emit("created");
    emit("update:modelValue", false);
    resetForm();
  } catch (error) {
    if(!disposed&&token===loadVersion&&scope===currentApiCacheScope())ElMessage.error(error.message || "创建采购请求失败");
  } finally {
    if(token===loadVersion)submitting.value = false;
  }
}

watch(() => props.modelValue, async (visible) => {
  if (visible) {
    resetForm();
    await ensureOptionsLoaded();
  }else{++loadVersion;loading.value=false;}
}, { immediate:true });

watch(() => props.initialProductId, () => {if(props.modelValue)ensureOptionsLoaded();});
function clearScope(){++loadVersion;state.products=[];state.people=[];state.suppliers=[];resetForm();emit('update:modelValue',false);}
window.addEventListener('erp:auth-scope-changed',clearScope);
onBeforeUnmount(()=>{disposed=true;++loadVersion;window.removeEventListener('erp:auth-scope-changed',clearScope);});

watch(currentUserPersonId, () => {
  if (props.modelValue) {
    form.person_id = preferredPersonId();
  }
});
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="登记已下单采购"
    width="1040px"
    align-center
    class="erp-centered-dialog"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetForm"
  >
    <el-alert v-if="verifyingDemand||demandError||productError" :type="demandError||productError?'warning':'info'" :closable="false" :title="demandError||productError||'正在核对最新采购需求，可先填写采购信息；核对通过后才能提交'"/>
    <div class="proc-dialog" :class="{ 'proc-dialog-locked': lockProduct }">
      <div v-if="!lockProduct" class="proc-dialog-left">
        <div class="dialog-search-head">
          <strong>搜索商品</strong>
          <span>图片、编码和 SKU 一起展示，减少误选。</span>
        </div>
        <el-input v-model="productQuery" placeholder="搜索商品名称、库存 ID 或 SKU" clearable @keyup.enter="searchProducts" @clear="searchProducts" />
        <div class="product-picker-list">
          <button
            v-for="product in candidateProducts"
            :key="product.id"
            type="button"
            class="product-picker-item"
            :class="{ active: Number(form.product_id) === Number(product.id) }"
            @click="applyProductToForm(product)"
          >
            <ProductImagePreview :src="productImage(product)" size="square" />
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
        <div class="selected-product-card" v-loading="loading">
          <template v-if="selectedProduct">
            <div class="selected-product-main">
              <ProductImagePreview :src="productImage(selectedProduct)" size="square" />
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
          <span v-else class="muted-text">{{ selectedProductEmptyText }}</span>
        </div>

        <el-form label-width="110px" @input="formTouched=true" @change="formTouched=true">
          <div v-if="lockProduct" class="dialog-search-head dialog-locked-head">
            <strong>当前采购商品已确定</strong>
            <span>订单页面已经带入目标商品，这里直接填写采购信息即可。</span>
          </div>
          <el-row :gutter="16">
            <el-col :span="12">
                <el-form-item label="采购人">
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
      <div class="erp-dialog-footer">
        <el-button class="erp-btn erp-btn-secondary" @click="emit('update:modelValue', false)">取消</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" :loading="submitting" :disabled="loading||verifyingDemand||!!demandError||!!productError" @click="submit">确认已下单并进入在途</el-button>
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
  border: 1px solid var(--erp-detail-primary-border, rgba(191, 219, 254, 0.9));
  border-radius: 14px;
  background: var(--erp-detail-surface-alt, rgba(239, 246, 255, 0.8));
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
  background: var(--erp-detail-surface-alt, linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(248, 250, 252, 1)));
  text-align: left;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.05);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.product-picker-item:hover {
  transform: translateY(-2px);
  border-color: var(--erp-detail-border-light, rgba(37, 99, 235, 0.35));
  box-shadow: 0 16px 30px rgba(37, 99, 235, 0.12);
}

.product-picker-item.active {
  border-color: var(--el-color-primary);
  background: var(--erp-detail-primary-faint, linear-gradient(135deg, rgba(37, 99, 235, 0.12), rgba(255, 255, 255, 0.96)), #fff);
  box-shadow: 0 18px 36px rgba(37, 99, 235, 0.14);
}

.picker-thumb,
.selected-product-thumb {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--erp-detail-border-light, rgba(198, 209, 225, 0.75));
  background: var(--erp-detail-surface, #fff);
}

.picker-thumb-fallback {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
  background: var(--erp-detail-surface-alt, linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(15, 23, 42, 0.04)), #fff);
}

.picker-empty {
  padding: 28px 16px;
  border: 1px dashed var(--erp-border-strong);
  border-radius: 16px;
  text-align: center;
  color: var(--erp-text-secondary);
  background: var(--erp-detail-surface-alt, rgba(248, 250, 252, 0.9));
}

.selected-product-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--erp-detail-border-light, rgba(191, 219, 254, 0.9));
  border-radius: 20px;
  background: var(--erp-detail-primary-faint, radial-gradient(circle at top right, rgba(37, 99, 235, 0.14), transparent 28%), linear-gradient(180deg, rgba(239, 246, 255, 0.88), rgba(248, 250, 252, 0.98)));
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
  background: var(--erp-detail-surface, rgba(255, 255, 255, 0.78));
  border: 1px solid var(--erp-detail-border-light, rgba(191, 219, 254, 0.9));
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


