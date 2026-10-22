<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient, currentApiCacheScope } from "../utils/api";
import { shanghaiDateTimeText } from "../utils/shanghai-date";
import { useAuthStore } from "../stores/auth";

const props = defineProps({ plans: { type: Array, default: () => [] } });
const auth = useAuthStore();
const canManageVouchers = computed(() => auth.user?.platform_role === "super_admin");
const activePlans = computed(() => props.plans.filter(plan => Number(plan.active)));
const planCode = ref("");
const rows = ref([]);
const loading = ref(false);
const issuing = ref(false);
const error = ref("");
const issuedCode = ref("");
const issuedVisible = ref(false);
let disposed = false;
let active = true;
let generation = 0;
const inScope = (scope, revision) => !disposed && active && canManageVouchers.value && revision === generation && scope === currentApiCacheScope();
const dateText = value => value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "—";
const labels = { active: "待兑换", used: "已兑换", revoked: "已作废", expired: "已过期" };

async function load() {
  if (disposed || !active || !canManageVouchers.value) { clearSensitiveState(); return; }
  const scope = currentApiCacheScope();
  const revision = generation;
  loading.value = true;
  error.value = "";
  try {
    const data = await apiClient.get("/api/tenants/subscription-vouchers", { noCache: true });
    if (inScope(scope, revision)) rows.value = data.rows || [];
  } catch (failure) {
    if (inScope(scope, revision)) error.value = failure.message || "激活码加载失败";
  } finally {
    if (inScope(scope, revision)) loading.value = false;
  }
}

async function issue() {
  if (disposed || !active || !canManageVouchers.value || !planCode.value || issuing.value) return;
  const scope = currentApiCacheScope();
  const revision = generation;
  issuing.value = true;
  error.value = "";
  try {
    const result = await apiClient.post("/api/tenants/subscription-vouchers", { plan_code: planCode.value });
    if (!inScope(scope, revision)) return;
    issuedCode.value = result.activation_code;
    issuedVisible.value = true;
    await load();
  } catch (failure) {
    if (inScope(scope, revision)) error.value = failure.message || "生成激活码失败";
  } finally {
    if (inScope(scope, revision)) issuing.value = false;
  }
}

async function revoke(row) {
  if (disposed || !active || !canManageVouchers.value) return;
  const scope = currentApiCacheScope();
  const revision = generation;
  try {
    await ElMessageBox.confirm(`确定作废尾号 ${row.code_hint} 的激活码？作废后不能再兑换。`, "作废激活码", { type: "warning", confirmButtonText: "确认作废", cancelButtonText: "取消" });
    if (!inScope(scope, revision)) return;
    await apiClient.delete("/api/tenants/subscription-vouchers", { body: JSON.stringify({ id: row.id }) });
    if (!inScope(scope, revision)) return;
    ElMessage.success("激活码已作废");
    await load();
  } catch (failure) {
    if (inScope(scope, revision) && failure !== "cancel" && failure !== "close") error.value = failure.message || "作废失败";
  }
}

async function copyCode() {
  if (disposed || !active || !canManageVouchers.value || !issuedVisible.value || !issuedCode.value) return;
  try { await navigator.clipboard.writeText(issuedCode.value); ElMessage.success("激活码已复制"); }
  catch { ElMessage.info("请手动选择并复制激活码"); }
}

function clearSensitiveState() {
  issuedVisible.value = false;
  issuedCode.value = "";
  rows.value = [];
  error.value = "";
  loading.value = false;
  issuing.value = false;
}
function handleScopeChange() {
  generation += 1;
  clearSensitiveState();
  if (active && !disposed && canManageVouchers.value) void load();
}
watch(() => [auth.user?.id, auth.user?.tenant?.id, auth.user?.platform_role], handleScopeChange, { flush: "sync" });
window.addEventListener("erp:auth-scope-changed", handleScopeChange);
onMounted(load);
onActivated(() => { const returning = !active; active = true; if (returning) void load(); });
onDeactivated(() => { active = false; generation += 1; clearSensitiveState(); });
onBeforeUnmount(() => { disposed = true; clearSensitiveState(); window.removeEventListener("erp:auth-scope-changed", handleScopeChange); });
</script>

<template>
  <section v-if="canManageVouchers" class="vouchers-panel">
    <div class="vouchers-heading"><div><h2>会员激活码</h2><p>客户注册后，在自己的会员中心兑换；会员期限从兑换时起计算，续期会累加剩余时长。</p></div><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-form inline class="vouchers-issue" @submit.prevent="issue"><el-form-item label="开通套餐"><el-select v-model="planCode" aria-label="激活码套餐" placeholder="选择套餐"><el-option v-for="plan in activePlans" :key="plan.code" :label="`${plan.name} · ${plan.duration_days} 天`" :value="plan.code" /></el-select></el-form-item><el-form-item><el-button type="primary" native-type="submit" :disabled="!planCode" :loading="issuing">生成激活码</el-button></el-form-item></el-form>
    <p class="vouchers-hint">默认 30 天内可兑换，一码一次。完整码仅生成时显示；套餐期限和额度在发码时固定。</p>
    <el-table :data="rows" v-loading="loading" row-key="id" empty-text="尚未生成会员激活码">
      <el-table-column label="尾号" prop="code_hint" width="100" />
      <el-table-column label="套餐" prop="plan_name" min-width="150" />
      <el-table-column label="时长" width="90"><template #default="{ row }">{{ row.duration_days }} 天</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'used' ? 'success' : row.status === 'active' ? 'primary' : 'info'">{{ labels[row.status] || row.status }}</el-tag></template></el-table-column>
      <el-table-column label="兑换截止（北京时间）" min-width="205"><template #default="{ row }">{{ dateText(row.redeemable_until) }}</template></el-table-column>
      <el-table-column label="兑换时间（北京时间）" min-width="205"><template #default="{ row }">{{ dateText(row.used_at) }}</template></el-table-column>
      <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="row.status === 'active'" type="danger" link @click="revoke(row)">作废</el-button></template></el-table-column>
    </el-table>
    <el-dialog v-model="issuedVisible" title="激活码已生成" width="500px" append-to-body :close-on-click-modal="false" @closed="issuedCode = ''"><el-alert title="请立即复制保存，关闭后无法再次查看完整激活码。" type="warning" :closable="false" show-icon /><el-input :model-value="issuedCode" readonly aria-label="新生成的会员激活码" class="voucher-code" /><template #footer><el-button @click="issuedVisible = false">已保存，关闭</el-button><el-button type="primary" @click="copyCode">复制激活码</el-button></template></el-dialog>
  </section>
</template>

<style scoped>
.vouchers-panel { padding: 12px 4px; color: var(--erp-text-main); }
.vouchers-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
.vouchers-heading h2 { margin: 0; font-size: 18px; }
.vouchers-heading p, .vouchers-hint { color: var(--erp-text-regular); font-size: 12px; line-height: 1.7; }
.vouchers-issue :deep(.el-select) { width: 260px; max-width: 100%; }
.vouchers-hint { margin-top: 0; }
.voucher-code { margin-top: 20px; }
@media (max-width: 600px) { .vouchers-heading { align-items: flex-start; } .vouchers-issue :deep(.el-form-item) { width: 100%; margin-right: 0; } }
</style>
