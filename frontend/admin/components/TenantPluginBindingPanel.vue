<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "../stores/auth";
import { apiClient, currentApiCacheScope } from "../utils/api";
import { canAccessPage, isEnterpriseAdmin, isPlatformAdmin } from "../../../src/shared/permissions.js";
import { shanghaiDateTimeText } from "../utils/shanghai-date";

const props = defineProps({ enabled: { type: Boolean, default: true } });
const auth = useAuthStore(), router = useRouter();
const tenant = computed(() => auth.user?.tenant || null);
const canManage = computed(() => props.enabled && Boolean(tenant.value?.id) && (isPlatformAdmin(auth.user) || tenant.value.slug !== "default" && isEnterpriseAdmin(auth.user)));
const origin = window.location.origin;
const status = ref(null), loading = ref(false), saving = ref(false), error = ref("");
const token = ref(""), tokenVisible = ref(false);
let sequence = 0, disposed = false, active = true, controller;
const identity = () => `${currentApiCacheScope()}:${tenant.value?.id}:${tenant.value?.role}:${auth.user?.platform_role}:${props.enabled}`;
const current = scope => !disposed && active && canManage.value && scope === identity();
function clearToken() { token.value = ""; tokenVisible.value = false; }
function reset() {
  ++sequence; controller?.abort(); clearToken(); status.value = null; error.value = ""; loading.value = false; saving.value = false;
}
async function loadStatus() {
  if (!active || disposed || !canManage.value) return;
  const id = Number(tenant.value.id), scope = identity(), request = ++sequence;
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = "";
  try {
    const result = await apiClient.get(`/api/tenants/plugin-token?tenant_id=${id}`, { noCache: true, signal: controller.signal });
    if (current(scope) && request === sequence) status.value = result;
  } catch (failure) {
    if (current(scope) && request === sequence && failure.name !== "AbortError") error.value = failure.message || "插件绑定信息读取失败";
  } finally { if (current(scope) && request === sequence) loading.value = false; }
}
function scopeChanged() { reset(); void loadStatus(); }
async function requestToken(action) {
  if (!canManage.value || saving.value || loading.value || !status.value?.encryption_configured) return;
  const scope = identity(), id = Number(tenant.value.id);
  if (action === "issue" && status.value.configured) {
    try { await ElMessageBox.confirm("重置会立即撤销原密钥；已连接此企业的插件都需要重新粘贴新密钥。", "重置企业专属密钥", { type: "warning", confirmButtonText: "确认重置" }); }
    catch { return; }
    if (!current(scope)) return;
  }
  saving.value = true;
  try {
    const result = await apiClient.post(action === "reveal" ? "/api/tenants/plugin-token/reveal" : "/api/tenants/plugin-token", { tenant_id: id });
    if (!current(scope)) return;
    if (Number(result.tenant_id) !== id || !/^ozp_[A-Za-z0-9_-]{40,80}$/.test(result.token || "")) throw new Error("插件密钥所属企业不一致，请刷新后重试");
    token.value = result.token; tokenVisible.value = true;
    await loadStatus();
  } catch (failure) { if (current(scope)) ElMessage.error(failure.message || "插件密钥读取失败"); }
  finally { if (current(scope)) saving.value = false; }
}
async function copyToken() {
  if (!canManage.value || !token.value) return;
  const scope = identity();
  try { await navigator.clipboard.writeText(token.value); if (current(scope)) ElMessage.success("企业专属密钥已复制，请粘贴到插件后保存"); }
  catch { if (current(scope)) ElMessage.error("复制失败，请手动选中密钥复制"); }
}
watch(() => [auth.user?.id, tenant.value?.id, tenant.value?.role, auth.user?.platform_role, props.enabled], scopeChanged, { immediate: true, flush: "sync" });
window.addEventListener("erp:auth-scope-changed", scopeChanged);
onActivated(() => { active = true; scopeChanged(); });
onDeactivated(() => { active = false; reset(); });
onBeforeUnmount(() => { disposed = true; reset(); window.removeEventListener("erp:auth-scope-changed", scopeChanged); });
</script>

<template>
  <el-card shadow="never" class="plugin-binding-panel">
    <template #header><div class="binding-heading"><strong>插件绑定 · 当前企业</strong><el-button v-if="canManage" :loading="loading" :disabled="saving" @click="loadStatus">刷新绑定信息</el-button></div></template>
    <p><strong>{{ tenant?.name || '当前企业' }}</strong> · 企业编号 {{ tenant?.id }} · 系统地址 {{ origin }}</p>
    <p>插件采集先进入本企业的“采集箱”，生成或保存草稿后进入本企业的“草稿箱”。同一企业成员共享，其他企业不可读取。</p>
    <p>插件按所填密钥确定企业归属，切换 ERP 空间不会自动更换插件密钥；跨企业使用时请更新插件中的密钥。</p>
    <ol><li>下载并安装采集插件。</li><li>在这里生成或查看企业专属密钥，点击复制。</li><li>打开插件，将密钥粘贴到“企业专属密钥”，点击“保存密钥”，并确认插件显示连接成功。</li></ol>
    <div class="binding-actions"><el-button tag="a" href="/downloads/ozon-baodan-erp-plugin.zip" target="_blank" rel="noopener noreferrer">下载采集插件</el-button><el-button v-if="canAccessPage(auth.user, '/collector-box')" @click="router.push('/collector-box')">打开本企业采集箱</el-button></div>
    <el-alert v-if="!canManage" :title="!props.enabled ? '请先在会员中心激活试用或会员，再生成或查看企业专属密钥。' : tenant?.slug === 'default' ? '默认企业的插件密钥由平台管理员管理。' : '企业专属密钥由本企业负责人或管理员生成，请联系他们获取后填写到插件。'" type="info" :closable="false" />
    <template v-else>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <p v-if="status">{{ status.configured ? '已生成接入密钥；实际连接状态请在浏览器插件内确认。' : '尚未生成企业专属密钥。' }}<span v-if="status.created_at"> 创建时间：{{ shanghaiDateTimeText(status.created_at, { assumeUtcWhenNaive: true }) }}</span></p>
      <el-alert v-if="status && !status.encryption_configured" title="平台尚未配置插件密钥加密服务，请联系平台管理员开通后再生成或查看。" type="warning" :closable="false" />
      <el-alert v-else-if="status?.configured && !status.can_reveal" title="当前是无法查看的历史密钥。已有插件能用时可继续使用；密钥丢失时再重置，并更新已连接的插件。" type="info" :closable="false" />
      <div class="binding-actions"><el-button v-if="status?.can_reveal" type="primary" :disabled="loading" :loading="saving" @click="requestToken('reveal')">查看 / 复制企业密钥</el-button><el-button :disabled="loading || !status?.encryption_configured" :loading="saving" @click="requestToken('issue')">{{ status?.configured ? '重置企业密钥' : '生成企业专属密钥' }}</el-button></div>
    </template>
    <el-dialog v-if="tokenVisible" v-model="tokenVisible" :title="`企业专属密钥 · ${tenant?.name || tenant?.id}`" width="min(620px, 94vw)" append-to-body destroy-on-close @closed="clearToken">
      <p>复制到插件的“企业专属密钥”输入框，然后点击“保存密钥”。此密钥只连接当前企业。</p>
      <el-input :model-value="token" readonly type="password" show-password autocomplete="off" aria-label="当前企业的插件专属密钥" />
      <template #footer><el-button @click="clearToken">关闭</el-button><el-button type="primary" @click="copyToken">复制密钥</el-button></template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.binding-heading, .binding-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.binding-heading { justify-content: space-between; }
.binding-actions { margin: 12px 0; }
.plugin-binding-panel p, .plugin-binding-panel li { color: var(--erp-text-regular); font-size: 13px; line-height: 1.8; }
</style>
