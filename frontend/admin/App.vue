<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElNotification } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { useAuthStore } from "./stores/auth";
import { useGlobalImagePreviewDismiss } from "./composables/useGlobalImagePreviewDismiss";
import { apiClient, getAuthToken } from "./utils/api";

const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();
const elementLocale = zhCn;
const APP_RELEASE_VERSION = String(import.meta.env.VITE_APP_RELEASE_VERSION || __APP_RELEASE_VERSION__ || "local");
const APP_RELEASE_CHANNEL = String(import.meta.env.VITE_APP_RELEASE_CHANNEL || __APP_RELEASE_CHANNEL__ || "local");
const UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const APP_UPDATE_DISMISSED_PREFIX = "baodanDismissedAppUpdate";
const showLoginWelcome = ref(false);
const loginWelcomeText = "欢迎大卖回归！";
const loginWelcomeChars = computed(() => Array.from(loginWelcomeText));
let updateCheckTimer = 0;
let loginWelcomeTimer = 0;
let updateEventSource = null;
let updateNotification = null;
let updateNotificationKey = "";
useGlobalImagePreviewDismiss();

function handleAuthExpired(event) {
  closeUpdateEventStream();
  authStore.clearSession();
  ElMessage.warning(event?.detail?.message || "登录已失效，请重新登录");
  if (route.name !== "login") {
    router.replace({
      name: "login",
      query: { redirect: route.fullPath }
    }).catch(() => {});
  }
}

async function clearBrowserRuntimeCache() {
  try {
    if (window.caches?.keys) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch (error) {
    console.warn("clear runtime caches failed", error);
  }

  try {
    if (navigator.serviceWorker?.getRegistrations) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch (error) {
    console.warn("unregister service workers failed", error);
  }
}

async function reloadForUpdate() {
  await clearBrowserRuntimeCache();
  const url = new URL(window.location.href);
  url.searchParams.set("_erp_update", Date.now().toString(36));
  window.location.replace(url.toString());
}

function appUpdateDismissKey(update = {}) {
  return [
    String(update.version || ""),
    String(update.published_at || update.publishedAt || "")
  ].filter(Boolean).join("@") || String(update.title || "app-update");
}

function currentUserUpdateDismissKey() {
  const user = authStore.user || {};
  const userKey = String(user.id || user.person_id || user.username || user.name || "anonymous").trim() || "anonymous";
  return `${APP_UPDATE_DISMISSED_PREFIX}:${userKey}`;
}

function isAppUpdateDismissed(update = {}) {
  try {
    return window.localStorage?.getItem(currentUserUpdateDismissKey()) === appUpdateDismissKey(update);
  } catch {
    return false;
  }
}

function dismissAppUpdate(update = {}) {
  try {
    window.localStorage?.setItem(currentUserUpdateDismissKey(), appUpdateDismissKey(update));
  } catch {}
}

function closeAppUpdateNotification() {
  if (updateNotification?.close) updateNotification.close();
  updateNotification = null;
  updateNotificationKey = "";
}

function promptAppUpdate(update) {
  if (isAppUpdateDismissed(update)) return;
  const key = appUpdateDismissKey(update);
  if (updateNotification && updateNotificationKey === key) return;
  closeAppUpdateNotification();
  updateNotificationKey = key;

  const handleDismiss = () => {
    dismissAppUpdate(update);
    closeAppUpdateNotification();
  };
  const handleReload = async () => {
    dismissAppUpdate(update);
    closeAppUpdateNotification();
    await reloadForUpdate();
  };

  updateNotification = ElNotification({
    title: update.title || "系统已更新",
    type: "warning",
    position: "top-right",
    duration: 3000,
    showClose: true,
    customClass: "erp-update-toast",
    message: h("div", { class: "erp-update-toast__body" }, [
      h("span", update.message || "系统后台已经发布新版本，空闲时刷新页面即可加载最新功能。"),
      h("div", { class: "erp-update-toast__actions" }, [
        h("button", { type: "button", class: "erp-update-toast__link", onClick: handleDismiss }, "忽略"),
        h("button", { type: "button", class: "erp-update-toast__primary", onClick: handleReload }, "去更新")
      ])
    ]),
    onClose: () => {
      dismissAppUpdate(update);
      if (updateNotificationKey === key) {
        updateNotification = null;
        updateNotificationKey = "";
      }
    }
  });
}

function closeUpdateEventStream() {
  if (!updateEventSource) return;
  updateEventSource.close();
  updateEventSource = null;
}

function handleUpdateStatusPayload(status) {
  if (status?.app?.update_required) {
    promptAppUpdate(status.app);
  }
  if (status?.plugin?.update_required) {
    window.dispatchEvent(new CustomEvent("app:plugin-update", { detail: status.plugin }));
  }
}

function openUpdateEventStream() {
  if (!authStore.isAuthenticated || updateEventSource || typeof EventSource === "undefined") return;
  const token = getAuthToken();
  if (!token) return;
  const params = new URLSearchParams({
    app_version: APP_RELEASE_VERSION,
    app_channel: APP_RELEASE_CHANNEL,
    token
  });
  updateEventSource = new EventSource(`/api/system/events?${params.toString()}`);
  updateEventSource.addEventListener("hello", (event) => {
    try {
      handleUpdateStatusPayload(JSON.parse(event.data || "{}")?.status);
    } catch {}
  });
  updateEventSource.addEventListener("update", (event) => {
    try {
      handleUpdateStatusPayload(JSON.parse(event.data || "{}"));
    } catch (error) {
      console.warn("parse update event failed", error);
    }
  });
  updateEventSource.onerror = () => {
    closeUpdateEventStream();
    window.setTimeout(openUpdateEventStream, 10000);
  };
}

async function checkUpdateStatus() {
  if (!authStore.isAuthenticated) return;
  try {
    const params = new URLSearchParams({
      app_version: APP_RELEASE_VERSION,
      app_channel: APP_RELEASE_CHANNEL
    });
    const status = await apiClient.get(`/api/system/update-status?${params.toString()}`, {
      routeScoped: false,
      noCache: true
    });
    if (status?.app?.update_required) promptAppUpdate(status.app);
    if (status?.plugin?.update_required) {
      window.dispatchEvent(new CustomEvent("app:plugin-update", { detail: status.plugin }));
    }
    openUpdateEventStream();
  } catch (error) {
    if (Number(error?.status || 0) !== 401) console.warn("check update status failed", error);
  }
}

function consumeLoginWelcome() {
  if (!authStore.isAuthenticated || sessionStorage.getItem("baodanLoginWelcome") !== "1") return;
  sessionStorage.removeItem("baodanLoginWelcome");
  window.clearTimeout(loginWelcomeTimer);
  showLoginWelcome.value = true;
  loginWelcomeTimer = window.setTimeout(() => {
    showLoginWelcome.value = false;
  }, 2400);
}

onMounted(async () => {
  await authStore.bootstrap();
  window.addEventListener("app:auth-expired", handleAuthExpired);
  consumeLoginWelcome();
  await checkUpdateStatus();
  openUpdateEventStream();
  updateCheckTimer = window.setInterval(checkUpdateStatus, UPDATE_CHECK_INTERVAL_MS);
});

watch(
  () => route.fullPath,
  () => consumeLoginWelcome(),
  { flush: "post" }
);

onBeforeUnmount(() => {
  window.removeEventListener("app:auth-expired", handleAuthExpired);
  closeUpdateEventStream();
  window.clearInterval(updateCheckTimer);
  window.clearTimeout(loginWelcomeTimer);
  closeAppUpdateNotification();
});
</script>

<template>
  <div class="admin-app-root">
    <el-config-provider :locale="elementLocale">
      <router-view />
      <div v-if="showLoginWelcome" class="login-welcome-toast" aria-live="polite">
        <span
          v-for="(char, index) in loginWelcomeChars"
          :key="`${char}-${index}`"
          class="login-welcome-char"
          :style="{ '--char-index': index }"
        >
          {{ char }}
        </span>
      </div>
    </el-config-provider>
  </div>
</template>

<style scoped>
.login-welcome-toast {
  position: fixed;
  left: 50%;
  top: 42%;
  z-index: 3000;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  color: #ef1f1f;
  font-family: "STXingkai", "鍗庢枃琛屾シ", "KaiTi", "妤蜂綋", cursive;
  font-size: clamp(46px, 7vw, 96px);
  font-weight: 500;
  line-height: 1.08;
  letter-spacing: 0;
  white-space: nowrap;
  text-shadow:
    0 2px 0 rgba(255, 255, 255, 0.92),
    0 8px 0 rgba(15, 23, 42, 0.1),
    0 18px 42px rgba(239, 31, 31, 0.24);
  transform: translate(-50%, -50%);
}

.login-welcome-char {
  position: relative;
  display: inline-block;
  opacity: 0;
  transform: translateY(18px) scale(0.78) rotate(-8deg);
  animation: welcome-char-pop 0.46s cubic-bezier(0.18, 0.9, 0.24, 1.22) forwards;
  animation-delay: calc(var(--char-index) * 0.075s);
  -webkit-text-stroke: 1px rgba(255, 255, 255, 0.86);
  paint-order: stroke fill;
}

.login-welcome-char:nth-child(3),
.login-welcome-char:nth-child(4) {
  color: #005bff;
}

.login-welcome-char::after {
  content: "";
  position: absolute;
  inset: 10% -18%;
  background: linear-gradient(105deg, transparent 0%, rgba(255, 255, 255, 0.74) 46%, transparent 70%);
  opacity: 0;
  transform: translateX(-80%);
  animation: welcome-char-shine 0.72s ease-out forwards;
  animation-delay: calc(var(--char-index) * 0.075s + 0.16s);
  pointer-events: none;
}

.login-welcome-toast::before,
.login-welcome-toast::after {
  content: "";
  position: absolute;
  left: 50%;
  border-radius: 999px;
  transform: translateX(-50%);
}

.login-welcome-toast::before {
  bottom: -20px;
  width: min(58vw, 420px);
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(29, 78, 216, 0.42), transparent);
  animation: welcome-underline 0.72s 0.12s ease-out both;
}

.login-welcome-toast::after {
  inset: -22px -34px;
  z-index: -1;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0));
  filter: blur(10px);
}

@keyframes welcome-char-pop {
  0% {
    opacity: 0;
    transform: translateY(18px) scale(0.78) rotate(-8deg);
    filter: blur(5px);
  }
  70% {
    opacity: 1;
    transform: translateY(-4px) scale(1.08) rotate(-2deg);
    filter: blur(0);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1) rotate(-1deg);
    filter: blur(0);
  }
}

@keyframes welcome-char-shine {
  0% {
    opacity: 0;
    transform: translateX(-80%);
  }
  34% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translateX(90%);
  }
}

@keyframes welcome-underline {
  from {
    opacity: 0;
    transform: translateX(-50%) scaleX(0.1);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) scaleX(1);
  }
}

.login-welcome-enter-active {
  animation: login-welcome-in 0.68s cubic-bezier(0.2, 0.82, 0.2, 1) both;
}

.login-welcome-leave-active {
  animation: login-welcome-out 0.72s ease both;
}

@keyframes login-welcome-in {
  0% {
    opacity: 0;
    transform: translate(-50%, -42%) scale(0.86) rotate(-2deg);
    filter: blur(8px);
  }
  68% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.04) rotate(-1deg);
    filter: blur(0);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1) rotate(-1deg);
    filter: blur(0);
  }
}

@keyframes login-welcome-out {
  0% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1) rotate(-1deg);
    filter: blur(0);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -58%) scale(1.08) rotate(-1deg);
    filter: blur(8px);
  }
}

@media (max-width: 560px) {
  .login-welcome-toast {
    top: 38%;
    font-size: clamp(36px, 12vw, 54px);
  }
}

:global(.erp-update-toast) {
  width: 340px;
  max-width: calc(100vw - 28px);
  border-radius: 10px;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
}

:global(.erp-update-toast__body) {
  display: grid;
  gap: 10px;
  color: #475467;
  font-size: 13px;
  line-height: 1.45;
}

:global(.erp-update-toast__actions) {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.erp-update-toast__link),
:global(.erp-update-toast__primary) {
  min-height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

:global(.erp-update-toast__link) {
  border: 1px solid #d0d5dd;
  background: #ffffff;
  color: #475467;
}

:global(.erp-update-toast__primary) {
  border: 1px solid #1677ff;
  background: #1677ff;
  color: #ffffff;
}
</style>
