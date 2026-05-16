<script setup>
import { onBeforeUnmount, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "./stores/auth";
import { useGlobalImagePreviewDismiss } from "./composables/useGlobalImagePreviewDismiss";

const authStore = useAuthStore();
useGlobalImagePreviewDismiss();

function handleAuthExpired(event) {
  authStore.clearSession();
  ElMessage.warning(event?.detail?.message || "登录已失效，请重新登录");
}

onMounted(() => {
  authStore.bootstrap();
  window.addEventListener("app:auth-expired", handleAuthExpired);
});

onBeforeUnmount(() => {
  window.removeEventListener("app:auth-expired", handleAuthExpired);
});
</script>

<template>
  <router-view />
</template>
