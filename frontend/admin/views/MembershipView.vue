<script setup>
import { computed, defineAsyncComponent, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { getMembership } from "../api/account";
import { currentApiCacheScope } from "../utils/api";
import { membershipDisplay } from "../utils/account-membership";
import { shanghaiDateTimeText } from "../utils/shanghai-date";
import { canAccessPage } from "../../../src/shared/permissions.js";
import AiCreditsPanel from "../components/AiCreditsPanel.vue";
import TenantPluginBindingPanel from "../components/TenantPluginBindingPanel.vue";
import MembershipActivationForm from "../components/MembershipActivationForm.vue";

import { BETA_PLAN_PRICES_FEN } from "../../../src/shared/subscription-plan-features.js";
const MembershipPlanCatalog = defineAsyncComponent(() => import("../components/MembershipPlanCatalog.vue"));
const catalogVisible = ref(false);
const planPrice = computed(() => { const value = BETA_PLAN_PRICES_FEN[membership.value?.plan_code || tenant.value?.plan_code]; return value === undefined ? "联系确认" : `¥${(value / 100).toFixed(value % 100 ? 1 : 0)}`; });
const props = defineProps({ embedded: { type: Boolean, default: false } });
const auth = useAuthStore();
const route = useRoute();
const membership = ref(null);
const activationVisible = ref(false);
const loading = ref(false);
const error = ref("");
let disposed = false;
let active = true;
let requestSequence = 0;
const tenant = computed(() => auth.user?.tenant || null);
const status = computed(() => membershipDisplay(membership.value || tenant.value));
const canActivate = computed(() => !["permanent", "suspended", "no-tenant", "unavailable"].includes(status.value.kind)
  && tenant.value?.role === "owner" && membership.value?.can_activate !== false);
const expiryText = computed(() => status.value.expiresAt
  ? shanghaiDateTimeText(status.value.expiresAt, { assumeUtcWhenNaive: true })
  : status.value.active ? "未设置到期时间" : "尚未开通");

async function load() {
  const sequence = ++requestSequence;
  const scope = currentApiCacheScope();
  const tenantId = Number(tenant.value?.id || 0);
  const current = () => !disposed && active && sequence === requestSequence
    && scope === currentApiCacheScope() && tenantId === Number(tenant.value?.id || 0);
  membership.value = null;
  loading.value = false;
  error.value = "";
  if (disposed || !active || !tenantId) return;
  loading.value = true;
  try {
    const result = await getMembership();
    if (!current()) return;
    if (Number(result.tenant_id) !== tenantId) throw new Error("会员信息已变更，请刷新后重试");
    membership.value = result;
  } catch (failure) {
    if (current()) error.value = failure.message || "会员信息加载失败，请重试";
  } finally {
    if (current()) loading.value = false;
  }
}

function clearMembership() {
  requestSequence += 1;
  activationVisible.value = false;
  catalogVisible.value = false;
  membership.value = null;
  loading.value = false;
  error.value = "";
}
function handleScopeChange() {
  clearMembership();
  if (active && !disposed) void load();
}
watch(() => [auth.user?.id, tenant.value?.id, tenant.value?.role, tenant.value?.subscription_status, tenant.value?.subscription_expires_at], load, { immediate: true, flush: "sync" });
window.addEventListener("erp:auth-scope-changed", handleScopeChange);
onActivated(() => { const returning = !active; active = true; if (returning) void load(); });
onDeactivated(() => { active = false; clearMembership(); });
onBeforeUnmount(() => { disposed = true; clearMembership(); window.removeEventListener("erp:auth-scope-changed", handleScopeChange); });
</script>

<template>
  <main class="membership-page">
    <header class="membership-heading"><div><h1 v-if="!props.embedded">会员中心</h1><p>{{ tenant?.name || "当前账号" }} · 查看会员时长与激活服务</p></div><el-button :loading="loading" @click="load">刷新</el-button></header>
    <el-alert v-if="route.query.denied === 'activation'" title="此功能需要开通会员，激活后即可继续使用。" type="info" :closable="false" show-icon />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <TenantPluginBindingPanel v-if="tenant" :enabled="status.active" />
    <el-card shadow="never" class="membership-status" v-loading="loading">
      <div class="membership-heading"><div><span class="membership-eyebrow">会员时长</span><h2><button v-if="canActivate" type="button" class="membership-time-button" @click="activationVisible = !activationVisible">{{ status.label }}</button><span v-else>{{ status.label }}</span></h2></div><div class="membership-actions"><el-button type="primary" @click="catalogVisible = !catalogVisible">查看套餐 / 续费</el-button><el-button v-if="canActivate" @click="activationVisible = !activationVisible">{{ status.active ? '输入激活码续期' : '输入激活码' }}</el-button></div></div>
      <dl><div><dt>到期时间（北京时间）</dt><dd>{{ expiryText }}</dd></div><div><dt>本期开始时间（北京时间）</dt><dd>{{ membership?.started_at ? shanghaiDateTimeText(membership.started_at, { assumeUtcWhenNaive: true }) : '暂无记录' }}</dd></div><div><dt>所属企业</dt><dd>{{ membership?.tenant_name || tenant?.name || '未加入企业' }}</dd></div><div><dt>套餐价格</dt><dd>{{ planPrice }} <el-button link type="primary" @click="catalogVisible = !catalogVisible">查看套餐 / 联系续费</el-button></dd></div></dl>
      <MembershipActivationForm v-if="canActivate && (activationVisible || !status.active)" :active="status.active" @activated="load" />
      <p v-else-if="!canActivate && !status.active">{{ tenant ? '请联系企业负责人激活或续期会员' : '请先加入企业' }}</p>
    </el-card>
    <MembershipPlanCatalog v-if="tenant && catalogVisible" />
    <AiCreditsPanel v-if="tenant && canAccessPage(auth.user, '/ai-credits')" compact />
  </main>
</template>

<style scoped>
.membership-page { display: grid; gap: 18px; max-width: 1080px; margin: 0 auto; padding: 12px; color: var(--erp-text-main); }
.membership-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.membership-actions { display:flex;flex-wrap:wrap;gap:8px; }.membership-actions :deep(.el-button + .el-button){margin-left:0}
.membership-heading h1 { margin: 0; font-size: 22px; }
.membership-heading p, .membership-status p { color: var(--erp-text-regular); font-size: 13px; line-height: 1.7; }
.membership-heading p { margin: 8px 0 0; }
.membership-eyebrow { color: var(--erp-primary); font-size: 12px; font-weight: 600; }
.membership-status h2 { margin: 16px 0 10px; font-size: 26px; }
.membership-status dl { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px; margin: 20px 0; }
.membership-time-button { cursor:pointer; border:0; padding:0; background:none; color:inherit; font:inherit; text-align:left; }
.membership-time-button:focus-visible { outline:2px solid var(--erp-primary); outline-offset:4px; }
.membership-status dl > div { display: grid; gap: 6px; }
.membership-status dt { font-size: 12px; color: var(--erp-text-secondary); }
.membership-status dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
@media (max-width: 720px) { .membership-status dl { grid-template-columns: 1fr; } .membership-page { padding: 4px; } }
</style>
