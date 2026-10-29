<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../utils/api';
import { hasPermission } from '../../../../src/shared/permissions.js';
import { useAuthStore } from '../../stores/auth';
import ProductImagePreview from '../../components/ProductImagePreview.vue';
import { dateText } from './inventory-utils.js';

const auth = useAuthStore();
const canEdit = computed(() => hasPermission(auth.user, 'inventory.write'));
const canPack = computed(() => hasPermission(auth.user, 'packing'));
const tab = ref('stock'), loading = ref(false), saving = ref(false), error = ref('');
const page = ref(1), total = ref(0), search = ref(''), filter = ref('all');
const rows = ref([]), selected = ref([]), tasks = ref([]), events = ref([]), detail = ref(null);
const activeTask = ref(null), taskForm = ref([]), correction = ref(null), correctionForm = reactive({ actual_quantity: 0, reason: '' });
const application = ref(false), applicationRows = ref([]), applicationKey = ref('');
const rulesOpen = ref(false), ruleProduct = ref(0), ruleRevision = ref(0);
const rules = reactive({ production_days: null, local_days: null, fbp_days: 7, minimum_order: 1, potential_sales: 20, hit_sales: 100, holidays: [] });
const flash = ref(false);
let generation = 0;
const counts = computed(() => ({ all: rows.value.length, local: rows.value.filter(r => r.local_gap > 0).length,
  fbp: rows.value.filter(r => r.skus.some(s => s.suggested_qty > 0)).length, locked: rows.value.filter(r => r.locked_qty > 0).length }));
const filtered = computed(() => rows.value.filter(r => filter.value === 'all' || (filter.value === 'local' && r.local_gap > 0)
  || (filter.value === 'fbp' && r.skus.some(s => s.suggested_qty > 0)) || (filter.value === 'locked' && r.locked_qty > 0)));
const purchaseRows = computed(() => rows.value.filter(r => r.purchase_qty > 0));
const taskLabels = { pending_review: '仓库准备中', approved: '锁定待发运', sent: '已发运', completed: '已入仓', cancelled: '已取消' };
const actionLabels = { create: '提交申请', edit: '调整申请', lock: '仓管锁定', ship: '实际发运', receive: '确认到仓', correct: '少发纠错', settings: '修改规则' };
const number = v => v == null ? '待同步' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

async function load() {
  const token = ++generation, identity = currentApiCacheScope();
  loading.value = true; error.value = '';
  try {
    const data = await apiClient.get(`/api/inventory-flow?page=${page.value}&pageSize=20&query=${encodeURIComponent(search.value)}`, { noCache: true });
    if (token !== generation || identity !== currentApiCacheScope()) return;
    rows.value = data.rows; total.value = data.total; selected.value = [];
  } catch (e) { if (token === generation) { rows.value = []; error.value = e.message; } }
  finally { if (token === generation) loading.value = false; }
}
async function loadWork() {
  const token = ++generation, identity = currentApiCacheScope(); loading.value = true; error.value = '';
  try {
    const data = await apiClient.get(`/api/inventory-flow/${tab.value === 'tasks' ? 'tasks' : 'events'}`, { noCache: true });
    if (token !== generation || identity !== currentApiCacheScope()) return;
    if (tab.value === 'tasks') tasks.value = data; else events.value = data;
  } catch (e) { if (token === generation) error.value = e.message; }
  finally { if (token === generation) loading.value = false; }
}
async function refresh() { if (['stock','buy'].includes(tab.value)) await load(); else await loadWork(); }
async function perform(work) {
  saving.value = true;
  try { await work(); flash.value = true; setTimeout(() => { flash.value = false; }, 700); }
  catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(e.message || '操作未完成，请刷新核对'); }
  finally { saving.value = false; }
}
async function showDetail(row) {
  await perform(async () => { detail.value = await apiClient.get(`/api/inventory-flow/detail?product_id=${row.id}`, { noCache: true }); });
}
async function syncDetail() {
  await perform(async () => {
    const id = detail.value.id;
    const result = await apiClient.post('/api/inventory-flow/sync', { product_id: id });
    const failed = result.results.filter(r => !r.ok);
    if (failed.length) ElMessage.warning(failed.map(r => `${r.shop_name}：${r.message}`).join('；'));
    else ElMessage.success('已从Ozon读取绑定SKU库存');
    detail.value = await apiClient.get(`/api/inventory-flow/detail?product_id=${id}`, { noCache: true });
    await load();
  });
}
function applyFor(products) {
  const unique = new Map();
  for (const p of products) for (const sku of p.skus) {
    if (!sku.mapping_id || Number(sku.per_set_quantity) !== 1) continue;
    const key = `${sku.shop_id}:${sku.ozon_sku}`;
    if (!unique.has(key)) unique.set(key, { ...sku, product_name: p.name, quantity: sku.suggested_qty > 0 ? sku.suggested_qty : 5, chosen: sku.suggested_qty > 0 });
  }
  applicationRows.value = [...unique.values()];
  if (!applicationRows.value.length) { ElMessage.warning('没有可提交的直接绑定SKU；组合SKU请使用原备货流程'); return; }
  applicationKey.value = crypto.randomUUID(); application.value = true;
}
async function submitApplication() {
  await perform(async () => {
    const items = applicationRows.value.filter(r => r.chosen).map(r => ({ mapping_id: r.mapping_id, quantity: r.quantity }));
    if (!items.length) throw new Error('请至少选择一个SKU');
    await apiClient.post('/api/inventory-flow/tasks', { request_key: applicationKey.value, items });
    application.value = false; detail.value = null; tab.value = 'tasks'; await loadWork();
    ElMessage.success('已按店铺创建本次申请；采购由采购人员独立决定');
  });
}
function openTask(task) { activeTask.value = task; taskForm.value = task.items.map(i => ({ ...i, quantity: task.locked ? i.approved_qty : i.requested_qty })); }
async function taskAction(action) {
  await perform(async () => {
    if (['lock','ship'].includes(action)) await ElMessageBox.confirm(action === 'lock' ? '确认本次实际数量并锁仓？未采用数量不结转；确认后不能加量。' : '确认这些货已实际发出？本地实物将扣减，并生成运输在途记录。', '确认本次操作', { type: 'warning' });
    await apiClient.post('/api/inventory-flow/task-action', { order_id: activeTask.value.id, revision: activeTask.value.revision, action,
      items: taskForm.value.map(i => ({ id: i.id, quantity: i.quantity })) });
    activeTask.value = null; await loadWork(); ElMessage.success('操作已保存');
  });
}
function openCorrection(transfer) { correction.value = transfer; correctionForm.actual_quantity = Math.max(0, transfer.quantity - 1); correctionForm.reason = ''; }
async function receive(transfer) {
  await perform(async () => {
    const remaining = Number(transfer.quantity) - Number(transfer.listed_quantity);
    const { value } = await ElMessageBox.prompt(`本批剩余${remaining}件。填写实际到仓件数，官方可售库存仍需单独同步。`, '确认本批到仓', { inputValue: String(remaining), inputValidator: value => /^\d+$/.test(value) && Number(value)>0 && Number(value)<=remaining || '请输入大于0且不超过剩余的整数' });
    await apiClient.post('/api/inventory-flow/task-action', { order_id: activeTask.value.id, revision: activeTask.value.revision, action: 'receive', transfer_id: transfer.id, received_quantity: Number(value) });
    activeTask.value = null; await loadWork(); ElMessage.success('到仓记录已保存，官方库存未自动增加');
  });
}
async function correct() {
  await perform(async () => {
    await ElMessageBox.confirm('仅适用于已核实少发、货物仍在本地。运输丢失不可补回；官方库存不会因此改动。', '确认库存纠错', { type: 'warning' });
    await apiClient.post('/api/inventory-flow/task-action', { order_id: activeTask.value.id, revision: activeTask.value.revision, action: 'correct', transfer_id: correction.value.id, ...correctionForm });
    correction.value = null; activeTask.value = null; await loadWork(); ElMessage.success('已追加库存纠错记录');
  });
}
async function showRules(product = null) {
  await perform(async () => {
    const cfg = product?.settings || await apiClient.get('/api/inventory-flow/settings', { noCache: true });
    ruleProduct.value = product?.id || 0; ruleRevision.value = cfg.revision;
    Object.assign(rules, JSON.parse(JSON.stringify(cfg))); rulesOpen.value = true;
  });
}
async function saveRules() {
  await perform(async () => {
    await apiClient.post('/api/inventory-flow/settings', { product_id: ruleProduct.value, revision: ruleRevision.value, settings: rules });
    rulesOpen.value = false; detail.value = null; await refresh(); ElMessage.success('已保存新中心规则；原预警规则未改动');
  });
}
watch(tab, refresh);
watch(() => [auth.user?.id, auth.user?.tenant?.id], () => {
  generation++; rows.value = []; tasks.value = []; events.value = []; detail.value = null; activeTask.value = null; application.value = false; rulesOpen.value = false; correction.value = null; selected.value = []; refresh();
});
onMounted(load);
</script>

<template>
  <div class="flow-center" :class="{ 'flow-changed': flash }">
    <div class="flow-toolbar"><el-tabs v-model="tab"><el-tab-pane label="库存全景" name="stock"/><el-tab-pane label="本次备货" name="tasks"/><el-tab-pane label="采购建议" name="buy"/><el-tab-pane label="流转记录" name="history"/></el-tabs><div><el-button v-if="canEdit" @click="showRules()">周期与规则</el-button><el-button :loading="loading" @click="refresh">刷新</el-button></div></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/>
    <template v-if="['stock','buy'].includes(tab)">
      <div class="flow-filters"><el-input v-model="search" clearable placeholder="库存名称、编号或绑定SKU" @keyup.enter="page=1;load()"/><el-button @click="page=1;load()">查询</el-button><span>全部 {{ total }} 个产品</span></div>
      <div v-if="tab === 'stock'" class="flow-focus" aria-label="当前页库存筛选"><button v-for="item in [{key:'all',label:'当前页全部'},{key:'local',label:'本地保障不足'},{key:'fbp',label:'FBP需补货'},{key:'locked',label:'已有FBP锁定'}]" :key="item.key" :class="{active:filter===item.key}" @click="filter=item.key"><span>{{ item.label }}</span><strong>{{ counts[item.key] }}</strong></button></div>
      <el-table v-loading="loading" :data="tab==='buy'?purchaseRows:filtered" row-key="id" @selection-change="selected=$event">
        <el-table-column v-if="tab==='stock' && canEdit" type="selection" width="40"/>
        <el-table-column type="expand"><template #default="{ row }"><el-table :data="row.skus" size="small"><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="status" label="供货状态" min-width="175"/><el-table-column prop="category" label="销量分类"/><el-table-column label="FBP可售"><template #default="s">{{ number(s.row.available) }}</template></el-table-column><el-table-column label="建议件数"><template #default="s">{{ number(s.row.suggested_qty) }}</template></el-table-column></el-table></template></el-table-column>
        <el-table-column label="实物库存产品" min-width="260"><template #default="{ row }"><div class="flow-product"><ProductImagePreview :src="row.image_url" :width="64" :height="84"/><div><el-button link type="primary" @click="showDetail(row)">{{ row.name }}</el-button><small>{{ row.inventory_number || row.code || row.id }} · {{ row.skus.length }} 个SKU</small><small v-if="row.stock_incomplete">部分官方库存未同步</small></div></div></template></el-table-column>
        <el-table-column label="本地实物" width="95"><template #default="{row}">{{ number(row.physical_stock) }}<el-tag v-if="row.needs_review" type="danger" size="small">待盘点</el-tag></template></el-table-column>
        <el-table-column prop="order_qty" label="订单占用" width="90"/><el-table-column prop="safety_qty" label="安全目标" width="90"/><el-table-column prop="locked_qty" label="FBP锁定" width="90"/><el-table-column prop="free_qty" label="自由可配" width="90"/><el-table-column prop="incoming_stock" label="采购在途" width="90"/>
        <el-table-column label="FBP官方 / 在途" width="135"><template #default="{row}">{{ number(row.official_qty) }} / {{ number(row.in_transit) }}</template></el-table-column>
        <el-table-column v-if="tab==='buy'" label="采购建议" min-width="200"><template #default="{row}"><div>本地 {{ row.local_purchase }} · FBP {{ row.fbp_purchase }}</div><small>起订约束后 {{ row.purchase_qty }} 件，由采购人员决定</small></template></el-table-column>
        <el-table-column v-else label="处理建议" min-width="150"><template #default="{row}"><div v-if="row.local_gap">本地保障缺 {{ row.local_gap }} 件</div><div v-if="row.purchase_qty">建议采购 {{ row.purchase_qty }} 件</div><div v-if="!row.local_gap && !row.purchase_qty">查看SKU分配</div></template></el-table-column>
      </el-table>
      <div class="flow-footer"><span>安全目标不含订单占用；在途不算本地实物。筛选和汇总针对当前页。</span><el-button v-if="canEdit && tab==='stock'" type="primary" :disabled="!selected.length" @click="applyFor(selected)">创建备货申请（{{ selected.length }}）</el-button></div>
      <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="total, prev, pager, next" @current-change="load"/>
    </template>
    <el-table v-else-if="tab==='tasks'" v-loading="loading" :data="tasks"><el-table-column prop="order_no" label="备货单" min-width="270"/><el-table-column prop="shop_name" label="店铺"/><el-table-column label="状态"><template #default="{row}">{{ taskLabels[row.status] || row.status }}</template></el-table-column><el-table-column label="申请 / 确认"><template #default="{row}">{{ row.items.reduce((n,i)=>n+Number(i.requested_qty),0) }} / {{ row.items.reduce((n,i)=>n+Number(i.approved_qty),0) }}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click="openTask(row)">查看与处理</el-button></template></el-table-column></el-table>
    <el-table v-else v-loading="loading" :data="events"><el-table-column label="时间" min-width="170"><template #default="{row}">{{ dateText(row.created_at) }}</template></el-table-column><el-table-column prop="person_name" label="操作人"/><el-table-column label="操作"><template #default="{row}">{{ actionLabels[row.action] || row.action }}</template></el-table-column><el-table-column prop="order_id" label="备货编号"/><el-table-column label="依据" min-width="250"><template #default="{row}"><el-popover trigger="click" width="500"><pre class="flow-json">{{ JSON.stringify(typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json,null,2) }}</pre><template #reference><el-button link type="primary">查看记录</el-button></template></el-popover></template></el-table-column></el-table>

    <el-drawer v-if="detail" :model-value="true" :title="detail.name+' · 库存流转明细'" size="min(1100px, 96vw)" @close="detail=null">
      <div class="flow-toolbar"><span>真实业务数据 · 不修改原预警规则</span><div><el-button v-if="canEdit" :loading="saving" @click="syncDetail">同步Ozon FBP库存</el-button><el-button v-if="canEdit" @click="showRules(detail)">本产品周期</el-button></div></div>
      <div class="flow-nodes"><div><span>采购在途</span><strong>{{ number(detail.incoming_stock) }}</strong></div><div><span>本地实物</span><strong>{{ number(detail.physical_stock) }}</strong></div><div><span>FBP运输在途</span><strong>{{ number(detail.in_transit) }}</strong></div><div><span>FBP官方库存</span><strong>{{ number(detail.official_qty) }}</strong></div></div>
      <div class="flow-allocation"><span>订单 {{ detail.order_qty }}</span><span>安全目标 {{ detail.safety_qty }}</span><span>已锁定 {{ detail.locked_qty }}</span><span>自由可配 {{ detail.free_qty }}</span></div>
      <el-alert v-if="detail.stock_incomplete" title="部分SKU官方库存未知，未按0生成补货建议。请先同步并检查失败提示。" type="warning" :closable="false"/>
      <p>本地保障 {{ detail.local_days }} 天；FBP保障 {{ detail.fbp_days }} 天。FBP可售不足以覆盖补货周期时，预测本地接替需求。</p>
      <el-table :data="detail.skus"><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="status" label="供货状态" min-width="180"/><el-table-column label="每套实物"><template #default="{row}">{{ row.per_set_quantity }}</template></el-table-column><el-table-column label="日均 / 可售天数"><template #default="{row}">{{ number(row.daily_sales) }} / {{ number(row.coverage_days) }}</template></el-table-column><el-table-column label="FBP可售 / 建议"><template #default="{row}">{{ number(row.available) }} / {{ number(row.suggested_qty) }}</template></el-table-column><el-table-column label="同步时间" min-width="170"><template #default="{row}">{{ row.synced_at ? dateText(row.synced_at) : '尚未同步' }}</template></el-table-column></el-table>
      <p>组合SKU按组成件展示需求；本轮提交备货只支持直接绑定SKU，组合SKU仍使用原备货流程。</p>
      <el-button v-if="canEdit" type="primary" @click="applyFor([detail])">选择SKU并申请备货</el-button>
    </el-drawer>

    <el-dialog v-if="application" v-model="application" title="本次备货申请 · 按店铺生成独立任务" width="min(1000px,96vw)"><el-alert title="确认前不锁实物；仓管确认时会重新核对订单、安全库存及其他锁定。采购独立决定。" :closable="false"/><el-table :data="applicationRows"><el-table-column width="55"><template #default="{row}"><el-checkbox v-model="row.chosen" :aria-label="'选择SKU '+row.ozon_sku"/></template></el-table-column><el-table-column prop="product_name" label="实物产品"/><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="category" label="分类"/><el-table-column label="建议"><template #default="{row}">{{ row.suggested_qty == null ? '先同步库存' : row.suggested_qty || '不推荐，可试备' }}</template></el-table-column><el-table-column label="申请件数" width="170"><template #default="{row}"><el-input-number v-model="row.quantity" :min="1" :max="1000000" :precision="0" :step="1"/></template></el-table-column></el-table><template #footer><el-button @click="application=false">取消</el-button><el-button type="primary" :loading="saving" @click="submitApplication">确认申请</el-button></template></el-dialog>

    <el-drawer v-if="activeTask" :model-value="true" title="本次备货任务" size="min(1000px,96vw)" @close="activeTask=null">
      <h3>{{ activeTask.shop_name }} · {{ taskLabels[activeTask.status] || activeTask.status }}</h3><p>{{ activeTask.order_no }} · 版本 {{ activeTask.revision }}</p><el-alert title="仓管确认后锁定本次版本，未采用数量不结转。实际发运才扣实物。" :closable="false"/>
      <el-table :data="taskForm"><el-table-column prop="product_name" label="产品"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="requested_qty" label="原申请"/><el-table-column label="本次件数" width="170"><template #default="{row}"><el-input-number v-model="row.quantity" :disabled="Boolean(activeTask.locked)" :min="0" :max="1000000" :precision="0" :step="1"/></template></el-table-column></el-table>
      <div class="flow-actions"><el-button v-if="!activeTask.locked && canEdit" :loading="saving" @click="taskAction('edit')">保存申请调整</el-button><el-button v-if="!activeTask.locked && canPack" type="primary" :loading="saving" @click="taskAction('lock')">按本次数量确认并锁定</el-button><el-button v-if="activeTask.status==='approved' && canPack" type="primary" :loading="saving" @click="taskAction('ship')">确认实际发出</el-button></div>
      <h4 v-if="activeTask.transfers.length">发运记录</h4><el-table :data="activeTask.transfers"><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="quantity" label="发运数"/><el-table-column prop="listed_quantity" label="已确认到仓"/><el-table-column label="操作"><template #default="{row}"><el-button v-if="canPack && row.quantity>row.listed_quantity" link type="primary" @click="receive(row)">确认到仓</el-button><el-button v-if="canPack" link type="primary" @click="openCorrection(row)">核实少发纠错</el-button></template></el-table-column></el-table><p>官方库存通过Ozon同步，不能用发运数或到仓记录代替。</p>
    </el-drawer>
    <el-dialog v-if="correction" :model-value="true" title="核实少发 · 追加本地库存调整" width="min(540px,96vw)" @close="correction=null"><p>原发运 {{ correction.quantity }} 件；仅补回已核实仍在本地的货。</p><el-form label-position="top"><el-form-item label="实际发出件数"><el-input-number v-model="correctionForm.actual_quantity" :min="0" :max="correction.quantity-1" :precision="0"/></el-form-item><el-form-item label="核实原因与依据"><el-input v-model="correctionForm.reason" type="textarea"/></el-form-item></el-form><template #footer><el-button :loading="saving" type="primary" @click="correct">确认追加纠错</el-button></template></el-dialog>

    <el-dialog v-if="rulesOpen" v-model="rulesOpen" :title="ruleProduct?'本产品周期与规则':'新中心默认周期与规则'" width="min(700px,96vw)"><el-form label-position="top" class="flow-rule-grid"><el-form-item label="生产周期（空白沿用产品设置）"><el-input-number v-model="rules.production_days" :min="0" :max="180" :precision="0"/></el-form-item><el-form-item label="送本地仓（空白沿用产品设置）"><el-input-number v-model="rules.local_days" :min="0" :max="180" :precision="0"/></el-form-item><el-form-item label="送FBP仓天数"><el-input-number v-model="rules.fbp_days" :min="0" :max="180" :precision="0"/></el-form-item><el-form-item label="采购起订倍数"><el-input-number v-model="rules.minimum_order" :min="1" :precision="0"/></el-form-item><el-form-item label="潜力品近两周销量门槛"><el-input-number v-model="rules.potential_sales" :min="1" :precision="0"/></el-form-item><el-form-item label="爆品近四周销量门槛"><el-input-number v-model="rules.hit_sales" :min="1" :precision="0"/></el-form-item></el-form>
      <template v-if="!ruleProduct"><h4>节假日与其他影响区间</h4><div v-for="(holiday,i) in rules.holidays" :key="i" class="flow-holiday"><el-input v-model="holiday.name" placeholder="名称"/><el-date-picker v-model="holiday.from" type="date" value-format="YYYY-MM-DD" placeholder="开始"/><el-date-picker v-model="holiday.to" type="date" value-format="YYYY-MM-DD" placeholder="结束"/><el-button @click="rules.holidays.splice(i,1)">移除</el-button></div><el-button @click="rules.holidays.push({name:'',from:'',to:''})">添加影响区间</el-button><p>整体周期只计一次重叠日期；未配置来年区间时请及时补充。</p></template><p v-else>节假日沿用本企业新中心的默认区间。</p><template #footer><el-button :loading="saving" type="primary" @click="saveRules">保存新中心规则</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.flow-center{--flow-line:var(--el-border-color-light);--flow-surface:var(--el-fill-color-extra-light);--flow-text:var(--el-text-color-regular)}
.flow-toolbar,.flow-filters,.flow-footer,.flow-actions{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}.flow-toolbar :deep(.el-tabs){flex:1;min-width:300px}.flow-filters :deep(.el-input){width:300px}.flow-filters>span{margin-left:auto;color:var(--el-text-color-secondary);font-size:12px}
.flow-focus,.flow-nodes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0}.flow-focus button,.flow-nodes>div{background:var(--flow-surface);border:1px solid var(--flow-line);border-radius:10px;padding:16px;text-align:left;color:var(--flow-text);display:flex;flex-direction:column;gap:10px;font:inherit}.flow-focus button{cursor:pointer}.flow-focus button.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.flow-focus strong,.flow-nodes strong{font-size:26px;font-weight:500;font-variant-numeric:tabular-nums}.flow-focus span,.flow-nodes span{font-size:12px;color:var(--el-text-color-secondary)}.flow-product{display:flex;align-items:center;gap:12px;min-height:88px}.flow-product>div{min-width:0}.flow-product :deep(.el-button){white-space:normal;text-align:left;height:auto;line-height:1.5}.flow-product small{display:block;color:var(--el-text-color-secondary);font-size:12px;margin-top:6px}.flow-footer{font-size:12px;color:var(--el-text-color-secondary);margin-top:16px}.flow-allocation{display:flex;gap:18px;flex-wrap:wrap;background:var(--flow-surface);padding:16px;margin:16px 0;border-radius:8px}.flow-rule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.flow-holiday{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}.flow-holiday :deep(.el-input){max-width:180px}.flow-actions{margin-top:18px;justify-content:flex-start}.flow-json{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}.flow-changed .flow-nodes strong{animation:flow-move .65s ease}@keyframes flow-move{50%{transform:translateY(-6px)}}@media(prefers-reduced-motion:reduce){.flow-changed .flow-nodes strong{animation:none}}@media(max-width:700px){.flow-focus,.flow-nodes{grid-template-columns:repeat(2,minmax(0,1fr))}.flow-rule-grid{grid-template-columns:1fr}.flow-toolbar :deep(.el-tabs){min-width:0;width:100%}.flow-filters :deep(.el-input){width:100%}}
</style>
