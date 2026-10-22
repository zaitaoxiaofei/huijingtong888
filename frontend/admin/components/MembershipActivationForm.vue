<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { activateMembership } from "../api/account.js";
import { useAuthStore } from "../stores/auth";
import { currentApiCacheScope } from "../utils/api";

defineProps({ active: { type: Boolean, default: false } });
const emit = defineEmits(["activated"]);
const auth = useAuthStore();
const code = ref("");
const errorText = ref("");
const saving = ref(false);
let generation = 0;
function resetForScope() {
  generation += 1;
  code.value = "";
  errorText.value = "";
  saving.value = false;
}
watch([() => auth.user?.id, () => auth.user?.tenant?.id, () => auth.user?.tenant?.role], resetForScope, { flush: "sync" });
window.addEventListener("erp:auth-scope-changed", resetForScope);
onBeforeUnmount(() => {
  resetForScope();
  window.removeEventListener("erp:auth-scope-changed", resetForScope);
});

async function submit() {
  if (saving.value) return;
  if (auth.user?.tenant?.role !== "owner") { resetForScope(); return; }
  const activationCode = String(code.value || "").trim();
  if (!activationCode) {
    errorText.value = "请输入激活码";
    return;
  }
  const scope = currentApiCacheScope();
  const requestGeneration = generation;
  const personId = auth.user?.id;
  const tenantId = auth.user?.tenant?.id;
  const isCurrent = () => requestGeneration === generation && scope === currentApiCacheScope()
    && auth.user?.id === personId && auth.user?.tenant?.id === tenantId && auth.user?.tenant?.role === "owner";
  saving.value = true;
  errorText.value = "";
  try {
    const result = await activateMembership(activationCode);
    if (!isCurrent()) return;
    const currentUser = await auth.verifySession({ background: true });
    if (!isCurrent()) return;
    code.value = "";
    window.dispatchEvent(new CustomEvent("erp:membership-updated"));
    ElMessage.success(currentUser ? "会员已激活，权益已更新" : "会员已激活，请刷新页面查看最新权益");
    emit("activated", result);
  } catch (error) {
    if (isCurrent()) errorText.value = error?.message || "激活失败，请核对激活码后重试";
  } finally {
    if (isCurrent()) saving.value = false;
  }
}
</script>

<template>
  <el-form class="membership-activation-form" label-position="top" @submit.prevent="submit">
    <el-form-item label="激活码" :error="errorText">
      <el-input v-model="code" maxlength="128" autocomplete="off" placeholder="请输入会员激活码" :disabled="saving" clearable @input="errorText = ''" />
    </el-form-item>
    <p>激活码用于当前企业的会员开通或续期，权益由企业成员共享。续期保留剩余时长；账号和店铺额度按激活码对应套餐更新。现有数据保留，超过额度时不能继续新增。</p>
    <el-button type="primary" native-type="submit" :loading="saving">{{ active ? "兑换并续期" : "激活会员" }}</el-button>
  </el-form>
</template>

<style scoped>
.membership-activation-form { display: grid; gap: 10px; }
.membership-activation-form :deep(.el-form-item) { margin-bottom: 10px; }
.membership-activation-form :deep(.el-input__wrapper) { min-height: 40px; }
.membership-activation-form p { margin: 0 0 8px; color: var(--erp-text-secondary); font-size: 12px; line-height: 1.65; }
.membership-activation-form > .el-button { margin: 0; width: 100%; min-height: 40px; font-weight: 600; }
</style>
