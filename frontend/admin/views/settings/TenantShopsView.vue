<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const healthRows = ref([]);
const checking = ref(null);
const healthError = ref('');
const healthShop = ref(null);
const healthByShop = computed(() => new Map(healthRows.value.map(row => [Number(row.shop_id), row])));
const healthLabels = { valid: '授权查询正常', expiring: '即将到期', expired: '已到期', invalid: '密钥已失效', missing: '未配置有效授权', unchecked: '尚未检查', check_failed: '检查失败', forbidden: '权限受限', offer_required: '需接受卖家协议', unknown_expiry: '到期时间未确认' };
const syncLabels = { orders: '订单', products: '商品与详情价格', stocks: '库存', finance: '官方原始账单' };
const healthDetails = computed(() => healthByShop.value.get(Number(healthShop.value?.id)));
const authorizationWarnings = computed(() => healthRows.value.filter(row => row.status !== 'valid' || row.check_stale).length);
const failedSyncShops = computed(() => healthRows.value.filter(row => Object.values(row.sync || {}).some(item => item.status === 'failed')).length);
const dateText = value => value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : '暂无记录';
function healthType(row) { return ['expired', 'invalid', 'missing'].includes(row?.status) ? 'danger' : row?.status === 'valid' && !row?.check_stale ? 'success' : 'warning'; }
async function loadHealth() {
  const scope = currentApiCacheScope();
  try { const value = await apiClient.get('/api/shops/ozon-health', { noCache: true }); if (scope !== currentApiCacheScope()) return; healthRows.value = value; healthError.value = ''; }
  catch { if (scope !== currentApiCacheScope()) return; healthError.value = '授权状态暂未读取成功，请重试；不能据此判断店铺授权正常。'; healthRows.value = []; }
}
async function checkHealth(row) {
  checking.value = row.id;
  try {
    await apiClient.post('/api/shops/ozon-health', { shop_id: row.id });
    await loadHealth();
    const current = healthByShop.value.get(Number(row.id));
    if (current?.status === 'valid') ElMessage.success('授权查询成功；请继续核查各模块的数据更新时间');
    else ElMessage.warning(healthLabels[current?.status] || '请查看授权检查结果');
  } catch (error) { ElMessage.error(error.message || '授权检查失败'); }
  finally { checking.value = null; }
}
const members = ref([]);
const dialogVisible = ref(false);
const editing = ref(false);
const form = reactive(createForm());
const activeMembers = computed(() => members.value.filter((member) => Number(member.member_active) !== 0 && Number(member.account_active) !== 0));

function createForm() {
  return {
    id: null,
    updated_at: null,
    name: "",
    legal_entity: "",
    user_id: null,
    ozon_client_id: "",
    ozon_seller_id: "",
    ozon_api_key: "",
    api_key_hint: "",
    performance_client_id: "",
    performance_client_secret: "",
    payout_rate: 0.33,
    status: "active"
  };
}

function resetForm() {
  Object.assign(form, createForm());
}

async function load() {
  const scope = currentApiCacheScope();
  loading.value = true;
  try {
    const [shops, tenantMembers] = await Promise.all([
      apiClient.get("/api/shops", { noCache: true }),
      apiClient.get("/api/enterprise/people", { noCache: true }),
      loadHealth()
    ]);
    if (scope !== currentApiCacheScope()) return;
    rows.value = Array.isArray(shops) ? shops : [];
    members.value = Array.isArray(tenantMembers) ? tenantMembers : [];
  } catch (error) {
    ElMessage.error(error.message || "企业店铺加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  resetForm();
  editing.value = false;
  dialogVisible.value = true;
}

function openEdit(row) {
  resetForm();
  Object.assign(form, row, {
    user_id: Number(row.user_id || 0) || null,
    ozon_api_key: "",
    performance_client_secret: ""
  });
  editing.value = true;
  dialogVisible.value = true;
}

async function save() {
  if (!String(form.name || "").trim()) return ElMessage.warning("请填写店铺名称");
  if (!form.user_id) return ElMessage.warning("请选择本企业的店长");
  saving.value = true;
  try {
    const payload = { ...form, payout_rate: Number(form.payout_rate || 0) };
    if (editing.value) await apiClient.put(`/api/shops/${form.id}`, payload);
    else await apiClient.post("/api/shops", payload);
    dialogVisible.value = false;
    ElMessage.success(editing.value ? "店铺已更新" : "店铺已新增");
    await load();
  } catch (error) {
    ElMessage.error(error.message || "保存店铺失败");
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`停用后「${row.name}」不会出现在企业店铺列表中。确认停用吗？`, "停用店铺", { type: "warning" });
    await apiClient.delete(`/api/shops/${row.id}`);
    ElMessage.success("店铺已停用");
    await load();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "停用店铺失败");
  }
}

function resetScope() { rows.value = []; healthRows.value = []; healthShop.value = null; dialogVisible.value = false; checking.value = null; load(); }
onMounted(() => { load(); window.addEventListener('erp:auth-scope-changed', resetScope); });
onBeforeUnmount(() => window.removeEventListener('erp:auth-scope-changed', resetScope));
</script>

<template>
  <main class="tenant-shops-page" v-loading="loading">
    <header class="page-head">
      <div><h1>企业店铺</h1><p>管理当前企业自己的 Ozon 店铺和店长。其他企业的店铺不会显示在这里。</p></div>
      <el-button type="primary" @click="openCreate">新增店铺</el-button>
    </header>
    <el-alert v-if="healthError" :title="healthError" type="error" :closable="false" show-icon />
    <el-alert v-else-if="authorizationWarnings" :title="`${authorizationWarnings} 个店铺的授权需要关注，请检查到期日期与数据更新状态。`" type="warning" :closable="false" show-icon />
    <el-alert v-if="failedSyncShops" :title="`${failedSyncShops} 个店铺有未完整完成的同步，请查看数据更新时间；已有数据可能尚未更新。`" type="error" :closable="false" show-icon />
    <p class="health-hint">时间均为北京时间。授权查询成功不代表各业务接口权限齐全，也不代表中断期间的数据已补齐。广告授权独立于店铺 API Key。</p>
    <el-table :data="rows" row-key="id" empty-text="当前企业还没有店铺">
      <el-table-column prop="name" label="店铺名称" min-width="160" />
      <el-table-column prop="user_name" label="店长" min-width="120" />
      <el-table-column prop="ozon_client_id" label="Client ID" min-width="140" />
      <el-table-column label="API Key" min-width="110"><template #default="{ row }">{{ row.ozon_api_key ? "已配置" : "未配置" }}</template></el-table-column>
      <el-table-column label="Ozon 授权与到期" min-width="240"><template #default="{ row }">
        <el-tag :type="healthType(healthByShop.get(Number(row.id)))">{{ healthLabels[healthByShop.get(Number(row.id))?.status] || '尚未检查' }}</el-tag>
        <div v-if="healthByShop.get(Number(row.id))?.expires_at">到期：{{ dateText(healthByShop.get(Number(row.id)).expires_at) }}<br>剩余 {{ healthByShop.get(Number(row.id)).days_remaining }} 天</div>
        <div v-else>到期时间未确认</div>
        <small v-if="healthByShop.get(Number(row.id))?.check_stale">检查记录缺失或超过两天，请重新检查</small>
      </template></el-table-column>
      <el-table-column label="授权与同步检查" min-width="200"><template #default="{ row }">
        <el-button link type="primary" :loading="checking === row.id" :disabled="checking !== null || row.status !== 'active'" @click="checkHealth(row)">检查授权</el-button>
        <el-button link type="primary" @click="healthShop = row">数据更新时间</el-button>
        <div v-if="Object.values(healthByShop.get(Number(row.id))?.sync || {}).some(item => item.status === 'failed')"><el-tag type="danger">有同步未完成</el-tag></div>
      </template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === "active" ? "启用" : "停用" }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button><el-button link type="danger" @click="remove(row)">停用</el-button></template></el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑企业店铺' : '新增企业店铺'" width="620px" destroy-on-close>
      <el-form label-width="120px">
        <el-form-item label="店铺名称" required><el-input v-model="form.name" maxlength="255" /></el-form-item>
        <el-form-item label="店长" required><el-select v-model="form.user_id" filterable placeholder="请选择本企业成员" style="width: 100%"><el-option v-for="member in activeMembers" :key="member.person_id" :label="`${member.name}（${member.username || '未设置登录名'}）`" :value="Number(member.person_id)" /></el-select></el-form-item>
        <el-form-item label="主体名称"><el-input v-model="form.legal_entity" /></el-form-item>
        <el-form-item label="Ozon Client ID"><el-input v-model="form.ozon_client_id" /></el-form-item>
        <el-form-item label="Seller ID"><el-input v-model="form.ozon_seller_id" /></el-form-item>
        <el-form-item label="Ozon API Key"><el-input v-model="form.ozon_api_key" type="password" autocomplete="new-password" show-password :placeholder="editing ? '粘贴新密钥可替换旧密钥；留空不更改' : '请输入店铺 API Key'" /></el-form-item>
        <el-form-item label="授权备注（选填）"><el-input v-model="form.api_key_hint" placeholder="仅作备注；新密钥请填上方 Ozon API Key" /></el-form-item>
        <el-form-item label="广告 Client ID"><el-input v-model="form.performance_client_id" /></el-form-item>
        <el-form-item label="广告 Client Secret"><el-input v-model="form.performance_client_secret" type="password" show-password :placeholder="editing ? '留空保持现有密钥' : '选填'" /></el-form-item>
        <el-form-item label="结算比例"><el-input-number v-model="form.payout_rate" :min="0" :max="1" :step="0.01" :precision="4" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
    <el-drawer :model-value="Boolean(healthShop)" :title="`${healthShop?.name || ''} · 授权与数据更新`" size="640px" @close="healthShop = null">
      <template v-if="healthShop">
        <el-alert :title="healthLabels[healthDetails?.status] || '尚未检查'" :type="healthType(healthDetails) === 'danger' ? 'error' : healthType(healthDetails)" :closable="false" />
        <p>最近授权检查：{{ dateText(healthDetails?.checked_at) }}</p>
        <p>最近验证通过：{{ dateText(healthDetails?.last_verified_at) }}</p>
        <p>到期日期：{{ dateText(healthDetails?.expires_at) }}</p>
        <p>到期或失效后，请在企业店铺编辑并保存新密钥。临时检查失败需重试，不能直接判为过期。</p>
        <el-divider>各模块同步记录</el-divider>
        <section v-for="(label, module) in syncLabels" :key="module" class="sync-health-row">
          <strong>{{ label }}</strong>
          <p>最近尝试：{{ dateText(healthDetails?.sync?.[module]?.last_attempt_at) }}</p>
          <p>最近成功：{{ dateText(healthDetails?.sync?.[module]?.last_success_at) }}</p>
          <p>成功范围：{{ healthDetails?.sync?.[module]?.last_success_coverage || '尚无可确认的同步范围' }}</p>
          <el-tag v-if="healthDetails?.sync?.[module]?.status === 'failed'" type="danger">本次未完整同步，旧数据可能未更新</el-tag>
          <p v-if="healthDetails?.sync?.[module]?.credential_changed">密钥已更换，该模块尚需用新密钥完成同步验证。</p>
          <p v-if="!healthDetails?.sync?.[module]">上线前的同步不追认成功时间，首次完整同步后记录。</p>
        </section>
        <p>财务成功记录表示该范围账单采集与核对完成，不表示订单全部费用已经到账或利润已最终结算。</p>
        <el-button type="primary" @click="openEdit(healthShop)">编辑店铺密钥</el-button>
      </template>
    </el-drawer>
  </main>
</template>

<style scoped>
.health-hint{color:var(--erp-text-regular, #64748b);font-size:13px}.sync-health-row{padding:12px 0;border-bottom:1px solid var(--erp-border-color, #e5e7eb)}.sync-health-row p{margin:5px 0}
.tenant-shops-page{padding:24px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page-head h1{margin:0 0 8px}.page-head p{margin:0;color:var(--erp-text-regular, #64748b)}@media(max-width:720px){.tenant-shops-page{padding:14px}.page-head{flex-direction:column}}
</style>
