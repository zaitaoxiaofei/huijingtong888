<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../utils/api";
import { shanghaiDateTimeText } from "../utils/shanghai-date";
import { useAuthStore } from "../stores/auth";
import { isPlatformAdmin } from "../../../src/shared/permissions.js";
import { aiCreditPoints, aiCreditPointsText, aiCreditYuanText } from "../../../src/shared/ai-credit-points.js";

const props = defineProps({ platform: Boolean, tenantId: { type: Number, default: 0 }, tenantName: { type: String, default: "" } });
const auth = useAuthStore();
const target = computed(() => props.platform ? props.tenantId : Number(auth.user?.tenant?.id || 0));
const canManage = computed(() => props.platform && isPlatformAdmin(auth.user));
const wallet = ref(null);
const entries = ref([]);
const loading = ref(false);
const saving = ref(false);
const more = ref(false);
const error = ref("");
const rechargeVisible = ref(false);
const recharge = reactive({ points: 1, reference: "", reason: "" });
let sequence = 0;
let disposed = false;
const labels = { recharge: "充值", monthly_grant: "每月赠送", initial_grant: "初始积分", reserve: "冻结", settle: "使用扣除", release: "解冻返还" };
const points = value => aiCreditPointsText(value || 0);
const yuan = value => aiCreditYuanText(value || 0);
const chargedPoints = row => row.kind === "settle" ? -aiCreditPoints(row.available_delta) - aiCreditPoints(row.frozen_delta) : 0n;
const changeText = value => `${aiCreditPoints(value) > 0n ? "+" : ""}${points(value)}`;
const statusText = computed(() => !wallet.value ? "尚未读取" : wallet.value.status === "active" ? "已开通" : "未开通或已停用");
function identity() { return `${currentApiCacheScope()}:${target.value}:${props.platform}`; }

async function load(append = false) {
  const id = target.value;
  const scope = identity();
  const request = ++sequence;
  const current = () => !disposed && request === sequence && scope === identity();
  error.value = "";
  if (!append) { wallet.value = null; entries.value = []; more.value = false; }
  if (!id || props.platform && !canManage.value) return;
  const cursor = append && entries.value.length ? entries.value.at(-1).id : null;
  const query = cursor ? `?before=${encodeURIComponent(cursor)}&limit=30` : "?limit=30";
  loading.value = true;
  try {
    const result = props.platform
      ? await apiClient.get(`/api/platform/ai-credits/accounts/${id}${query}`, { noCache: true })
      : await Promise.all([apiClient.get("/api/ai-credits/wallet", { noCache: true }), apiClient.get(`/api/ai-credits/entries${query}`, { noCache: true })]).then(([wallet, entries]) => ({ wallet, entries }));
    if (!current()) return;
    if (Number(result.wallet?.tenant_id) !== id || !Array.isArray(result.entries)) throw new Error("积分所属企业已变更，请刷新后重试");
    wallet.value = result.wallet;
    entries.value = append ? [...entries.value, ...result.entries] : result.entries;
    more.value = result.entries.length === 30;
  } catch (failure) {
    if (current()) error.value = failure.message || "积分信息加载失败，请重试";
  } finally { if (current()) loading.value = false; }
}

async function configureAccount() {
  if (!canManage.value || !target.value || saving.value) return;
  const id = target.value, scope = identity();
  saving.value = true;
  try {
    await apiClient.post("/api/platform/ai-credits/accounts", { tenantId: id, status: wallet.value?.status === "active" ? "disabled" : "active" });
    if (disposed || scope !== identity()) return;
    ElMessage.success("积分账户状态已保存");
    await load();
  } catch (failure) { if (!disposed && scope === identity()) ElMessage.error(failure.message || "积分账户保存失败"); }
  finally { if (!disposed && scope === identity()) saving.value = false; }
}
function openRecharge() {
  recharge.points = 1;
  recharge.reference = `manual-${crypto.randomUUID()}`;
  recharge.reason = "";
  rechargeVisible.value = true;
}
async function submitRecharge() {
  if (!canManage.value || saving.value || !target.value) return;
  if (!Number.isSafeInteger(recharge.points) || recharge.points < 1 || recharge.points > 1_000_000_000_000) return ElMessage.warning("请填写有效的整数积分，范围为 1 至 1 万亿");
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(recharge.reference)) return ElMessage.warning("充值编号请使用英文、数字、下划线或短横线，最多128个字符");
  if (!recharge.reason.trim()) return ElMessage.warning("请填写充值依据，例如线下收款单号或已审核的赠送说明");
  const id = target.value, scope = identity();
  saving.value = true;
  try {
    const result = await apiClient.post("/api/platform/ai-credits/recharges", { tenantId: id, points: recharge.points, reference: recharge.reference, reason: recharge.reason.trim() });
    if (disposed || scope !== identity()) return;
    ElMessage.success(result.replayed ? "该充值编号已入账，未重复增加积分" : "充值已登记");
    rechargeVisible.value = false;
    await load();
  } catch (failure) { if (!disposed && scope === identity()) ElMessage.error(failure.message || "充值登记失败，可保留原编号重试"); }
  finally { if (!disposed && scope === identity()) saving.value = false; }
}
function resetScope() {
  sequence += 1; wallet.value = null; entries.value = []; error.value = ""; more.value = false; loading.value = false; saving.value = false; rechargeVisible.value = false;
  void load();
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, auth.user?.platform_role, target.value, props.platform], resetScope, { immediate: true, flush: "sync" });
window.addEventListener("erp:auth-scope-changed", resetScope);
onBeforeUnmount(() => { disposed = true; sequence += 1; window.removeEventListener("erp:auth-scope-changed", resetScope); });
</script>

<template>
  <section class="ai-credits-panel">
    <div class="credit-heading"><div><h2>AI积分{{ tenantName ? ` · ${tenantName}` : '' }}</h2><p>积分与会员时长分别管理。充值请联系平台管理员登记。</p></div><el-button :loading="loading" :disabled="saving" @click="load()">刷新</el-button></div>
    <el-alert title="每个企业按北京时间自然月赠送 100 积分，余额可累计，同一企业多个账号不会重复领取。AI 技能库已开放，默认企业同样按积分规则使用。" type="info" :closable="false" show-icon />
    <el-alert title="1 积分 = ¥0.01；每张成功生成的图片扣 10 积分（¥0.10），文本免费。生成前冻结积分，明确失败后返还；状态不明时等待原任务核对。裁切和复用已有图片不重复收费。" type="info" :closable="false" show-icon />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="credit-summary" v-loading="loading && !wallet">
      <el-card shadow="never"><span>可用积分</span><strong>{{ wallet ? points(wallet.available_points) : '—' }}</strong><small v-if="wallet">余额折合 ¥{{ yuan(wallet.available_points) }}</small></el-card>
      <el-card shadow="never"><span>冻结积分</span><strong>{{ wallet ? points(wallet.frozen_points) : '—' }}</strong></el-card>
      <el-card shadow="never"><span>积分账户</span><strong>{{ statusText }}</strong></el-card>
    </div>
    <div v-if="canManage" class="credit-actions"><el-button :loading="saving" :disabled="loading || !wallet" @click="configureAccount">{{ wallet?.status === 'active' ? '停用积分账户' : '开通积分账户' }}</el-button><el-button type="primary" :disabled="loading || saving || wallet?.status !== 'active'" @click="openRecharge">登记手工充值</el-button></div>
    <el-card shadow="never"><template #header><strong>充值与使用记录</strong></template>
      <el-table :data="entries" v-loading="loading" empty-text="暂无积分记录" style="width: 100%">
        <el-table-column label="时间（北京时间）" width="180"><template #default="{ row }">{{ shanghaiDateTimeText(row.created_at, { assumeUtcWhenNaive: true }) }}</template></el-table-column>
        <el-table-column label="类型" width="110"><template #default="{ row }">{{ labels[row.kind] || '积分变动' }}</template></el-table-column>
        <el-table-column label="图片费用" width="140"><template #default="{ row }">{{ row.kind === 'settle' ? `${points(chargedPoints(row))} 积分 / ¥${yuan(chargedPoints(row))}` : '—' }}</template></el-table-column>
        <el-table-column label="可用积分变动" width="130"><template #default="{ row }">{{ changeText(row.available_delta) }}</template></el-table-column>
        <el-table-column label="冻结积分变动" width="130"><template #default="{ row }">{{ changeText(row.frozen_delta) }}</template></el-table-column>
        <el-table-column label="变动后可用" width="130"><template #default="{ row }">{{ points(row.available_after) }}</template></el-table-column>
        <el-table-column v-if="platform" label="充值编号" min-width="220"><template #default="{ row }">{{ row.kind === 'recharge' ? String(row.entry_key || '').replace(/^recharge:/, '') : '—' }}</template></el-table-column>
        <el-table-column prop="reason" label="说明" min-width="220" />
      </el-table><el-button v-if="more" class="credit-more" :loading="loading" @click="load(true)">加载更早记录</el-button>
    </el-card>
    <el-dialog v-model="rechargeVisible" :title="`登记积分充值 · ${tenantName}`" width="520px" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" destroy-on-close>
      <p>此操作向所选企业增加积分，不发起线上扣款。相同充值编号只入账一次；请求失败时请保留原编号重试。</p>
      <p>本次增加积分折合 ¥{{ yuan(recharge.points) }}，可生成 {{ Math.floor(recharge.points / 10) }} 张图片。</p>
      <el-form label-position="top"><el-form-item label="增加积分"><el-input-number v-model="recharge.points" :min="1" :max="1000000000000" :precision="0" /></el-form-item><el-form-item label="充值编号（防重复）"><el-input v-model="recharge.reference" maxlength="128" /></el-form-item><el-form-item label="充值依据"><el-input v-model="recharge.reason" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item></el-form>
      <template #footer><el-button :disabled="saving" @click="rechargeVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="submitRecharge">确认增加 {{ points(recharge.points) }} 积分</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.ai-credits-panel { display: grid; gap: 16px; }
.credit-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.credit-heading h2 { margin: 0; font-size: 18px; }
.credit-heading p { color: var(--erp-text-secondary); font-size: 13px; }
.credit-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.credit-summary :deep(.el-card__body) { display: grid; gap: 12px; }
.credit-summary span { color: var(--erp-text-secondary); font-size: 13px; }
.credit-summary strong { font-size: 22px; overflow-wrap: anywhere; }
.credit-actions { display: flex; gap: 8px; }
.credit-more { margin-top: 16px; }
@media(max-width: 720px) { .credit-summary { grid-template-columns: 1fr; } .credit-heading { align-items: flex-start; } }
</style>
