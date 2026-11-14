<script setup>
import WbProductImages from '../../components/WbProductImages.vue';
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../utils/api.js';

const shops = ref([]), shop = ref(null), warehouses = ref([]), warehouse = ref(null);
const rows = ref([]), selection = ref([]), search = ref(''), quantity = ref(undefined);
const busy = ref(false), notice = ref(''), page = ref(1), confirmVisible = ref(false), submitting = ref(false);
const reviewRows = ref([]), table = ref(null);
let sequence = 0, reviewScope = '', reviewSequence = 0;
const filtered = computed(() => rows.value.filter(row => [row.title, row.vendor_code, row.chrt_id, row.barcode].some(value => String(value || '').toLowerCase().includes(search.value.trim().toLowerCase()))));
const paged = computed(() => filtered.value.slice((page.value - 1) * 50, page.value * 50));
const changed = computed(() => rows.value.filter(row => Number.isSafeInteger(row.quantity) && row.quantity >= 0 && (row.quantity !== row.current || !row.loaded)));
const shopName = computed(() => shops.value.find(row => Number(row.id) === Number(shop.value))?.name || '');
const warehouseName = computed(() => warehouses.value.find(row => Number(row.id) === Number(warehouse.value))?.name || '');
watch(search, () => { page.value = 1; });
const valid = (id, scope) => id === sequence && scope === currentApiCacheScope();
function chunks(items) { const result = []; for (let i = 0; i < items.length; i += 1000) result.push(items.slice(i, i + 1000)); return result; }
function clearReview() { confirmVisible.value = false; reviewRows.value = []; }
function clearRows() { table.value?.clearSelection(); rows.value = []; selection.value = []; page.value = 1; clearReview(); }
async function readRows(items, id, scope) {
  for (const batch of chunks(items)) {
    if (!valid(id, scope)) return;
    try {
      const value = await apiClient.post('/api/wb/stocks/batch/read', { shop_id: shop.value, warehouse_id: warehouse.value, items: batch.map(row => ({ nm_id: row.nm_id, chrt_id: row.chrt_id })) });
      if (!valid(id, scope)) return;
      const byId = new Map(value.rows.map(row => [row.chrt_id, row]));
      for (const row of batch) { const result = byId.get(row.chrt_id); row.current = result?.current ?? null; row.loaded = true; row.status = ''; row.message = result?.current === null ? 'WB 未返回数量，可填写目标数量新增库存' : ''; }
    } catch (error) {
      if (!valid(id, scope)) return;
      for (const row of batch) { row.loaded = false; row.status = 'failed'; row.message = error.message; }
    }
  }
}
async function load(sync = false) {
  const id = ++sequence, scope = currentApiCacheScope();
  clearRows(); warehouses.value = []; warehouse.value = null; notice.value = '';
  if (!shop.value) { busy.value = false; return; }
  busy.value = true;
  try {
    if (sync) await apiClient.post('/api/wb/products/sync', { shop_id: shop.value });
    if (!valid(id, scope)) return;
    const [products, storage] = await Promise.all([apiClient.get(`/api/wb/products?shop_id=${shop.value}`, { noCache: true }), apiClient.get(`/api/wb/warehouses?shop_id=${shop.value}`, { noCache: true })]);
    if (!valid(id, scope)) return;
    warehouses.value = storage.rows.filter(row => !row.isDeleting && !row.isProcessing);
    warehouse.value = warehouses.value.some(row => Number(row.id) === Number(storage.selected)) ? Number(storage.selected) : warehouses.value[0]?.id || null;
    rows.value = products.rows.filter(p => !p.card._wb_archived).flatMap(p => (p.card.sizes || []).map(size => ({ key: `${p.nm_id}:${size.chrtID}`, nm_id: Number(p.nm_id), chrt_id: Number(size.chrtID), title: p.title, vendor_code: p.vendor_code, card: p.card, barcode: (size.skus || []).join(' / '), size: size.techSize === '0' ? '通用' : size.techSize || '通用', current: null, quantity: undefined, loaded: false, status: '', message: '' })));
    if (warehouse.value) await readRows(rows.value, id, scope);
    else notice.value = '该店铺没有可用的 WB 卖家仓，请先在 WB 创建仓库，再刷新本页。';
  } catch (error) { if (valid(id, scope)) ElMessage.error(error.message); }
  finally { if (valid(id, scope)) busy.value = false; }
}
async function refreshStock(resetTargets = false) {
  if (!warehouse.value) return;
  const id = ++sequence, scope = currentApiCacheScope(); clearReview(); busy.value = true;
  if (resetTargets) { table.value?.clearSelection(); selection.value = []; }
  if (resetTargets) for (const row of rows.value) { row.current = null; row.loaded = false; row.quantity = undefined; row.status = ''; row.message = ''; }
  try { await readRows(rows.value, id, scope); } finally { if (valid(id, scope)) busy.value = false; }
}
function apply(all = false) {
  if (!Number.isSafeInteger(quantity.value) || quantity.value < 0) return ElMessage.warning('请先填写非负整数，清零请填写 0。');
  const targets = all ? filtered.value : selection.value;
  for (const row of targets) if (row.loaded) { row.quantity = quantity.value; row.status = ''; row.message = ''; }
  if (targets.some(row => !row.loaded)) ElMessage.warning('部分规格尚未成功读取库存，已跳过；请刷新库存后再设置。');
}
function review() {
  if (!changed.value.length) return;
  if (changed.value.some(row => !row.loaded)) return ElMessage.warning('部分待修改规格未成功读取库存，请先刷新库存。');
  reviewRows.value = changed.value.map(row => ({ ...row })); reviewScope = currentApiCacheScope(); reviewSequence = sequence; confirmVisible.value = true;
}
async function submit() {
  if (submitting.value || !confirmVisible.value || !valid(reviewSequence, reviewScope)) return;
  const id = sequence, scope = reviewScope, shopId = shop.value, warehouseId = warehouse.value;
  submitting.value = true; busy.value = true;
  let confirmedCount = 0, stopped = false;
  try {
    for (const batch of chunks(reviewRows.value)) {
      if (!valid(id, scope)) return;
      try {
        const value = await apiClient.post('/api/wb/stocks/batch/set', { shop_id: shopId, warehouse_id: warehouseId, items: batch.map(row => ({ nm_id: row.nm_id, chrt_id: row.chrt_id, quantity: row.quantity, current: row.current })) });
        if (!valid(id, scope)) return;
        confirmedCount += value.rows.filter(row => row.status === 'success').length;
        for (const result of value.rows) { const row = rows.value.find(item => item.chrt_id === result.chrt_id); if (!row) continue; Object.assign(row, { current: result.current, status: result.status, message: result.message }); if (result.status === 'success') row.quantity = undefined; else if (result.status === 'unconfirmed') row.loaded = false; }
      } catch (error) {
        if (!valid(id, scope)) return;
        for (const item of batch) { const row = rows.value.find(row => row.key === item.key); if (row) { row.status = 'unconfirmed'; row.loaded = false; row.message = error.message + '；请先刷新库存核对。'; } }
        stopped = true; break;
      }
    }
    if (valid(id, scope)) { clearReview(); notice.value = `本次已回读确认 ${confirmedCount} 个规格。${stopped ? '本批结果未确认，后续批次已停止；请刷新库存核对。' : '未成功的规格请查看对应行提示。'}`; }
  } finally { if (valid(id, scope)) busy.value = false; submitting.value = false; }
}
async function bootstrap() {
  const id = ++sequence, scope = currentApiCacheScope(); busy.value = true;
  try { const value = await apiClient.get('/api/wb/shops', { noCache: true }); if (!valid(id, scope)) return; shops.value = value.filter(row => row.status === 'active'); shop.value = shops.value[0]?.id || null; await load(); }
  catch (error) { if (valid(id, scope)) { busy.value = false; ElMessage.error(error.message); } }
  finally { if (valid(id, scope)) busy.value = false; }
}
function reset() { sequence++; clearRows(); shops.value = []; shop.value = null; warehouses.value = []; warehouse.value = null; busy.value = false; bootstrap(); }
onMounted(() => { bootstrap(); window.addEventListener('erp:auth-scope-changed', reset); });
onBeforeUnmount(() => { sequence++; window.removeEventListener('erp:auth-scope-changed', reset); });
</script>

<template>
  <div class="wb-stock-batch">
    <div class="stock-filters">
      <el-select v-model="shop" :disabled="busy" placeholder="选择店铺" @change="load()"><el-option v-for="item in shops" :key="item.id" :value="Number(item.id)" :label="item.name" /></el-select>
      <el-select v-model="warehouse" :disabled="busy" placeholder="选择 WB 卖家仓" @change="refreshStock(true)"><el-option v-for="item in warehouses" :key="item.id" :value="Number(item.id)" :label="item.name" /></el-select>
      <el-input v-model="search" placeholder="商品名 / 货号 / SKU / 条码" clearable />
      <el-button :disabled="busy || !warehouse" @click="refreshStock()">刷新库存</el-button>
      <el-button :disabled="busy || !shop" @click="load(true)">同步 WB 商品</el-button>
    </div>
    <div class="stock-toolbar">
      <span>批量设置数量</span><el-input-number v-model="quantity" :min="0" :precision="0" :disabled="busy" placeholder="填写数量" />
      <el-button :disabled="busy || !selection.length" @click="apply()">填入所选（{{ selection.length }}）</el-button>
      <el-button :disabled="busy || !filtered.length" @click="apply(true)">填入全部筛选结果（{{ filtered.length }}）</el-button>
      <el-button type="primary" :disabled="busy || !changed.length || !warehouse" @click="review">提交修改（{{ changed.length }}）</el-button>
    </div>
    <p class="stock-hint">直接设置所选仓库的 WB 可售数量，填写 0 即清零；不改变本地实物库存。未填写的 SKU 不提交。</p>
    <el-alert v-if="notice" :title="notice" :closable="false" type="info" />
    <el-table ref="table" v-loading="busy" :data="paged" row-key="key" border stripe class="erp-data-table" @selection-change="selection = $event">
      <el-table-column type="selection" width="46" reserve-selection :selectable="row => !busy && row.loaded" />
      <el-table-column label="商品" min-width="350"><template #default="{ row }"><div class="stock-product"><WbProductImages :card="row.card" /><div class="stock-product-text">{{ row.title }}<p>货号：{{ row.vendor_code }}</p><p>WB 商品编号：{{ row.nm_id }}</p></div></div></template></el-table-column>
      <el-table-column label="SKU / 规格" min-width="150"><template #default="{ row }"><div>{{ row.chrt_id }}</div><p>{{ row.size }}</p></template></el-table-column>
      <el-table-column prop="barcode" label="条码" min-width="170" />
      <el-table-column label="WB 当前数量" width="135"><template #default="{ row }">{{ !row.loaded ? '未读取' : row.current ?? '未返回' }}</template></el-table-column>
      <el-table-column label="修改后数量" width="185"><template #default="{ row }"><el-input-number v-model="row.quantity" :min="0" :precision="0" :disabled="busy || !row.loaded" placeholder="不修改" @change="row.status = ''; row.message = ''" /></template></el-table-column>
      <el-table-column label="执行结果" min-width="260"><template #default="{ row }"><span :class="{ 'stock-success': row.status === 'success', 'stock-error': ['failed', 'unconfirmed', 'conflict'].includes(row.status) }">{{ row.message || (row.quantity !== undefined && row.quantity !== row.current ? '待提交' : '—') }}</span></template></el-table-column>
      <template #empty>{{ !shop ? '请先配置 WB 店铺' : !warehouse ? '请选择 WB 卖家仓' : '暂无商品，可点击“同步 WB 商品”拉取店铺 SKU' }}</template>
    </el-table>
    <el-pagination v-model:current-page="page" :page-size="50" :total="filtered.length" layout="total, prev, pager, next" />
    <el-dialog v-if="confirmVisible" v-model="confirmVisible" title="确认修改 WB 可售库存" width="820px" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting">
      <p>{{ shopName }} · {{ warehouseName }} · 共 {{ reviewRows.length }} 个 SKU</p>
      <p class="stock-hint">将把以下 SKU 的可售数量设为目标值；本地实物库存不变。</p>
      <el-table :data="reviewRows" max-height="350" border><el-table-column prop="vendor_code" label="货号" min-width="180" /><el-table-column prop="chrt_id" label="SKU" /><el-table-column label="当前数量"><template #default="{ row }">{{ row.current ?? '未返回' }}</template></el-table-column><el-table-column prop="quantity" label="修改后数量" /></el-table>
      <template #footer><el-button :disabled="submitting" @click="clearReview">取消</el-button><el-button type="primary" :loading="submitting" @click="submit">确认提交 {{ reviewRows.length }} 个 SKU</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.wb-stock-batch{display:grid;gap:14px}.stock-filters,.stock-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.stock-filters>.el-select{width:230px}.stock-filters>.el-input{width:280px}.stock-hint{margin:0;color:var(--el-text-color-secondary);font-size:13px}.stock-product{display:flex;align-items:center;gap:12px;min-height:92px}.stock-product-text{min-width:0;line-height:1.5}.stock-product p,.el-table p{margin:4px 0;color:var(--el-text-color-secondary);font-size:12px}.stock-success{color:var(--el-color-success)}.stock-error{color:var(--el-color-danger)}
</style>
