<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { getMembership } from "../api/account";
import { currentApiCacheScope } from "../utils/api";
import { membershipDisplay } from "../utils/account-membership";
import { shanghaiDateTimeText } from "../utils/shanghai-date";
import MembershipActivationForm from "../components/MembershipActivationForm.vue";

const props = defineProps({ embedded: { type: Boolean, default: false } });
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const membership = ref(null);
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
    <div class="membership-grid">
      <el-card shadow="never" class="membership-status" v-loading="loading">
        <span class="membership-eyebrow">当前会员</span>
        <h2>{{ status.label }}</h2>
        <p v-if="status.active">服务已开通，可以按你的岗位权限使用业务功能。</p>
        <p v-else>基础工具可直接使用，业务功能需要有效会员。</p>
        <dl><div><dt>所属空间</dt><dd>{{ membership?.tenant_name || tenant?.name || "未加入企业" }}</dd></div><div><dt>到期时间（北京时间）</dt><dd>{{ expiryText }}</dd></div></dl>
        <el-button v-if="status.active && !props.embedded" type="primary" @click="router.push('/dashboard')">进入工作台</el-button>
      </el-card>
      <el-card shadow="never" class="membership-activation">
        <template #header><strong>{{ status.active ? "续期会员" : "激活会员" }}</strong></template>
        <MembershipActivationForm v-if="canActivate" :active="status.active" @activated="load" />
        <el-empty v-else :image-size="64" :description="status.kind === 'permanent' ? '当前授权无需兑换时长' : status.kind === 'suspended' ? '会员已暂停，请联系平台管理员' : tenant ? '请联系企业负责人激活或续期会员' : '平台账号无需开通企业会员'" />
      </el-card>
    </div>
    <el-card v-if="!props.embedded" shadow="never" class="membership-tools">
      <template #header><strong>基础工具</strong></template>
      <p>无需激活即可使用，先算清成本，再开始运营。</p>
      <div><el-button @click="router.push('/tools/profit-calculator')">利润计算器</el-button><el-button @click="router.push('/tools/pricing')">定价工具</el-button></div>
    </el-card>
  </main>
</template>

<style scoped>
.membership-page { display: grid; gap: 18px; max-width: 1080px; margin: 0 auto; padding: 12px; color: var(--erp-text-main); }
.membership-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.membership-heading h1 { margin: 0; font-size: 22px; }
.membership-heading p, .membership-status p, .membership-tools p { color: var(--erp-text-regular); font-size: 13px; line-height: 1.7; }
.membership-heading p { margin: 8px 0 0; }
.membership-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.membership-eyebrow { color: var(--erp-primary); font-size: 12px; font-weight: 600; }
.membership-status h2 { margin: 16px 0 10px; font-size: 26px; }
.membership-status dl { display: grid; gap: 18px; margin: 28px 0; }
.membership-status dl > div { display: grid; gap: 6px; }
.membership-status dt { font-size: 12px; color: var(--erp-text-secondary); }
.membership-status dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.membership-tools p { margin-top: 0; }
.membership-tools > :deep(.el-card__body) > div { display: flex; flex-wrap: wrap; gap: 8px; }
.membership-tools :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 720px) { .membership-grid { grid-template-columns: 1fr; } .membership-page { padding: 4px; } }
</style>
