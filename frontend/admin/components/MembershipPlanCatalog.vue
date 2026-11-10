<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { apiClient, currentApiCacheScope } from '../utils/api';
const BetaContactDialog = defineAsyncComponent(() => import('./BetaContactDialog.vue'));
const auth = useAuthStore();
const plans = ref([]), loading = ref(false), error = ref(''), contactVisible = ref(false), purpose = ref('');
let sequence = 0, disposed = false, controller;
const tenantId = computed(() => Number(auth.user?.tenant?.id || 0));
const identity = () => `${currentApiCacheScope()}:${tenantId.value}:${auth.user?.id}`;
const price = plan => plan.price_fen === null ? '联系确认' : `¥${(plan.price_fen / 100).toFixed(plan.price_fen % 100 ? 1 : 0)}`;
const quota = (value, unit) => value === null ? `不限${unit}` : `${value} ${unit}`;
async function load() {
  const request = ++sequence, scope = identity();
  controller?.abort(); controller = new AbortController();
  plans.value = []; contactVisible.value = false; error.value = ''; loading.value = false;
  if (!tenantId.value || disposed) return;
  const current = () => !disposed && request === sequence && scope === identity();
  loading.value = true;
  try {
    const result = await apiClient.get('/api/auth/membership-plans', { noCache: true, routeScoped: false, signal: controller.signal });
    if (!current()) return;
    if (Number(result.tenant_id) !== tenantId.value || !Array.isArray(result.plans)) throw new Error('套餐所属企业已变更，请刷新重试');
    plans.value = result.plans;
  } catch (failure) { if (current() && failure.name !== 'AbortError') error.value = failure.message || '套餐读取失败'; }
  finally { if (current()) loading.value = false; }
}
function contact(plan) {
  if (!plan.eligible) return;
  purpose.value = `咨询${plan.name} · ${price(plan)} / ${plan.duration_days} 天 · ${quota(plan.account_limit, '个账号')} · ${quota(plan.shop_limit, '家店铺')}`;
  contactVisible.value = true;
}
watch(() => [tenantId.value, auth.user?.id, auth.user?.tenant?.plan_code, auth.user?.tenant?.subscription_status], load, { immediate: true, flush: 'sync' });
window.addEventListener('erp:auth-scope-changed', load);
onBeforeUnmount(() => { disposed = true; ++sequence; controller?.abort(); window.removeEventListener('erp:auth-scope-changed', load); });
</script>
<template>
  <section class="membership-catalog" v-loading="loading">
    <div class="catalog-heading"><h2>选择套餐</h2><el-button :loading="loading" @click="load">刷新套餐</el-button></div>
    <p>Beta 内测期间通过微信联系开通，暂不支持在线支付。账号总数包含主账号；每企业仅可选择一次体验，1 天和 7 天二选一。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="plan-grid"><el-card v-for="plan in plans" :key="plan.code" shadow="never" class="plan-card">
      <div class="plan-title"><h3>{{ plan.name }}</h3><el-tag v-if="auth.user?.tenant?.plan_code === plan.code" size="small">当前套餐</el-tag></div>
      <strong class="plan-price">{{ price(plan) }}<small> / {{ plan.duration_days }} 天</small></strong>
      <p>{{ quota(plan.account_limit, '个账号') }} · {{ quota(plan.shop_limit, '家店铺') }}</p>
      <ul><li>经营首页、Top15、店铺额度</li><li>订单、采集上架、库存采购*</li><li>{{ plan.features.finance ? '✓ 财务中心' : '— 不含财务中心' }}</li><li>{{ plan.features.tasks ? '✓ 任务系统' : '— 不含任务系统' }}</li><li>{{ plan.features.ai ? '✓ AI 技能库（另按积分使用）' : '— 不含 AI 技能库' }}</li></ul>
      <el-button type="primary" :disabled="!plan.eligible" @click="contact(plan)">{{ plan.eligible ? '联系开通 / 续费' : '已体验，不能再次申请' }}</el-button>
    </el-card></div>
    <small>* 功能仍受岗位权限和已开放企业功能范围限制。每月赠送积分不代表包含 AI 技能库；团队版成功图片仍每张扣 10 积分，文本免费。付款、企业授权和账号交付由服务人员人工确认。</small>
    <BetaContactDialog v-if="contactVisible" v-model="contactVisible" :purpose="purpose" />
  </section>
</template>
<style scoped>
.membership-catalog{display:grid;gap:16px}.catalog-heading,.plan-title{display:flex;justify-content:space-between;align-items:center;gap:8px}.catalog-heading h2,.plan-title h3{margin:0;font-size:17px}.membership-catalog p,.membership-catalog small{margin:0;color:var(--erp-text-secondary);line-height:1.8;font-size:12px}.plan-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.plan-card :deep(.el-card__body){display:grid;gap:14px;height:100%;box-sizing:border-box}.plan-price{font-size:27px;color:var(--erp-primary)}.plan-price small{font-weight:normal}.plan-card ul{list-style:none;padding:0;margin:0;display:grid;gap:7px;color:var(--erp-text-regular);font-size:12px}.plan-card :deep(.el-button){width:100%;margin:0}@media(max-width:600px){.plan-grid{grid-template-columns:1fr}}
</style>
