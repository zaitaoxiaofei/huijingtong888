<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Key, MoonNight, Sunny, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";
import { useAppStore } from "../stores/app";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const appStore = useAppStore();
const loginStage = ref("welcome");

const text = {
  light: "\u4eae\u8272",
  dark: "\u6697\u8272",
  mode: "\u6a21\u5f0f",
  dogzon: "\u72d7ZON",
  brandAria: "\u72d7ZON \u7206\u5355\u5355\u5355",
  bao: "\u7206",
  dan: "\u5355",
  login: "\u767b\u5f55",
  systemLoginAria: "\u767b\u5f55\u7206\u5355\u7cfb\u7edf",
  cardIntro: "\u6b22\u8fce\u56de\u6765\uff0c\u5927\u5356",
  cardTitle: "\u767b\u5f55\u7206\u5355\u7cfb\u7edf",
  username: "\u767b\u5f55\u540d",
  usernamePlaceholder: "\u8bf7\u8f93\u5165\u767b\u5f55\u540d",
  password: "\u5bc6\u7801",
  passwordPlaceholder: "\u8bf7\u8f93\u5165\u5bc6\u7801",
  submit: "\u767b\u5f55\u8fdb\u5165\u7cfb\u7edf",
  qrLogin: "\u626b\u7801\u767b\u5f55",
  qrRefresh: "\u5237\u65b0\u4e8c\u7ef4\u7801",
  qrHint: "\u7528\u624b\u673a\u5fae\u4fe1\u626b\u7801\uff0c\u5728\u624b\u673a\u4e0a\u8f93\u5165 ERP \u8d26\u53f7\u5bc6\u7801\u786e\u8ba4\u3002",
  qrWaiting: "\u7b49\u5f85\u624b\u673a\u786e\u8ba4...",
  qrExpired: "\u4e8c\u7ef4\u7801\u5df2\u8fc7\u671f\uff0c\u8bf7\u5237\u65b0",
  wechatLogin: "\u5fae\u4fe1\u626b\u7801\u767b\u5f55",
  wechatRetry: "\u91cd\u65b0\u626b\u7801",
  wechatBindHint: "\u5fae\u4fe1\u5df2\u9a8c\u8bc1\uff0c\u8bf7\u5148\u7528 ERP \u8d26\u53f7\u5bc6\u7801\u767b\u5f55\u4e00\u6b21\u5b8c\u6210\u7ed1\u5b9a\u3002",
  wechatUnavailable: "\u5fae\u4fe1\u767b\u5f55\u672a\u914d\u7f6e",
  welcomeBack: "\u6b22\u8fce\u56de\u6765",
  loginFailed: "\u767b\u5f55\u5931\u8d25",
  successTitle: "\u6b22\u8fce\u5927\u5356\u767b\u5f55",
  successSubtitle: "\u7206\u5355\u6570\u636e\u52a0\u8f7d\u4e2d...",
  pendingStock: "\u5f85\u5907\u8d27",
  newOrder: "\u65b0\u8ba2\u5355",
  paid: "\u5df2\u4ed8\u6b3e",
  shipping: "\u5f85\u53d1\u8d27",
  box: "\u76d2",
  order: "\u5355",
  pay: "\u4ed8",
  ship: "\u53d1",
  goods: "\u8d27",
  payment: "\u6b3e",
  warehouse: "\u4ed3"
};

const form = reactive({
  username: localStorage.getItem("loginUsername") || "",
  password: ""
});
const wechat = reactive({
  enabled: false,
  loading: false,
  bindTicket: "",
  redirect: ""
});
const qrLogin = reactive({
  visible: false,
  loading: false,
  sid: "",
  imageUrl: "",
  status: "",
  pollTimer: 0
});
let wechatStatusTimer = 0;

const themeIcon = computed(() => (appStore.theme === "dark" ? Sunny : MoonNight));
const themeLabel = computed(() => (appStore.theme === "dark" ? text.light : text.dark));

const orderCards = [
  { id: "48512721-0221-1", status: text.pendingStock, qty: "9999+", icon: text.box, tone: "blue" },
  { id: "48512721-0221-2", status: text.newOrder, qty: "386", icon: text.order, tone: "red" },
  { id: "48512721-0221-3", status: text.paid, qty: "721", icon: text.pay, tone: "green" },
  { id: "48512721-0221-4", status: text.shipping, qty: "1288", icon: text.ship, tone: "amber" },
  { id: "48512721-0221-5", status: text.pendingStock, qty: "9999+", icon: text.bao, tone: "red" },
  { id: "48512721-0221-6", status: text.newOrder, qty: "512", icon: text.goods, tone: "blue" },
  { id: "48512721-0221-7", status: text.paid, qty: "604", icon: text.payment, tone: "green" },
  { id: "48512721-0221-8", status: text.shipping, qty: "923", icon: text.warehouse, tone: "amber" }
];

function setLoginViewportState(enabled) {
  document.documentElement.classList.toggle("admin-login-open", enabled);
  document.body.classList.toggle("admin-login-open", enabled);
}

function openLoginForm() {
  loginStage.value = "form";
}

function waitForSuccessMoment() {
  return new Promise((resolve) => window.setTimeout(resolve, 120));
}

function normalizeRedirectTarget(value = "/dashboard") {
  const target = String(value || "/dashboard").trim() || "/dashboard";
  return target.startsWith("/") ? target : "/dashboard";
}

function redirectTarget() {
  return normalizeRedirectTarget(route.query.redirect || "/dashboard");
}

function shouldUseFastRedirect(target) {
  return String(target || "") !== "/dashboard";
}

async function finishLoginRedirect(target) {
  const safeTarget = normalizeRedirectTarget(target);
  if (shouldUseFastRedirect(safeTarget)) {
    sessionStorage.removeItem("baodanLoginWelcome");
    await router.replace(safeTarget);
    return;
  }
  sessionStorage.setItem("baodanLoginWelcome", "1");
  loginStage.value = "success";
  await waitForSuccessMoment();
  await router.replace(safeTarget);
}

onMounted(() => {
  setLoginViewportState(true);
  window.__hideAdminStaticLoginFallback?.();
  initializeWechatLogin();
});

onBeforeUnmount(() => {
  setLoginViewportState(false);
  window.clearTimeout(wechatStatusTimer);
  stopQrPolling();
});

async function handleSubmit() {
  try {
    const user = await authStore.login({
      username: form.username,
      password: form.password
    });
    if (wechat.bindTicket) {
      await authStore.bindWechat(wechat.bindTicket);
      wechat.bindTicket = "";
      ElMessage.success("\u5fae\u4fe1\u5df2\u7ed1\u5b9a\uff0c\u4e0b\u6b21\u53ef\u76f4\u63a5\u626b\u7801\u767b\u5f55");
    }
    localStorage.setItem("loginUsername", form.username);
    ElMessage.success(`${text.welcomeBack}\uff0c${user.name || user.username}`);
    await finishLoginRedirect(redirectTarget());
  } catch (error) {
    loginStage.value = "form";
    ElMessage.error(error.message || text.loginFailed);
    form.password = "";
  }
}

async function initializeWechatLogin() {
  const query = route.query || {};
  if (query.wechatError) {
    loginStage.value = "form";
    ElMessage.error(String(query.wechatError));
  }
  if (query.wechatBindTicket) {
    wechat.bindTicket = String(query.wechatBindTicket);
    wechat.redirect = String(query.redirect || "/dashboard");
    loginStage.value = "form";
    ElMessage.info(text.wechatBindHint);
  }
  if (query.wechatTicket) {
    loginStage.value = "success";
    try {
      const result = await authStore.completeWechatLogin(String(query.wechatTicket));
      await finishLoginRedirect(String(result.redirect || query.redirect || "/dashboard"));
      return;
    } catch (error) {
      loginStage.value = "form";
      ElMessage.error(error.message || text.loginFailed);
    }
  }
  scheduleWechatStatusCheck();
}

function scheduleWechatStatusCheck() {
  window.clearTimeout(wechatStatusTimer);
  wechatStatusTimer = window.setTimeout(async () => {
    try {
      const status = await fetchWechatStatus();
      wechat.enabled = Boolean(status.enabled && status.authUrl);
    } catch {
      wechat.enabled = false;
    }
  }, 2000);
}

async function fetchWechatStatus() {
  const target = redirectTarget();
  const response = await fetch(`/api/auth/wechat/status?redirect=${encodeURIComponent(target)}`, {
    headers: { "Content-Type": "application/json" }
  });
  if (!response.ok) throw new Error(text.wechatUnavailable);
  return await response.json();
}

async function startWechatLogin() {
  wechat.loading = true;
  try {
    const status = await fetchWechatStatus();
    if (!status.enabled || !status.authUrl) throw new Error(text.wechatUnavailable);
    window.location.href = status.authUrl;
  } catch (error) {
    ElMessage.error(error.message || text.wechatUnavailable);
    wechat.loading = false;
  }
}

async function startQrLogin() {
  loginStage.value = "form";
  qrLogin.visible = true;
  qrLogin.loading = true;
  qrLogin.status = text.qrWaiting;
  stopQrPolling();
  try {
    const target = redirectTarget();
    const response = await fetch(`/api/auth/qr/start?redirect=${encodeURIComponent(target)}`, {
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.sid) throw new Error(data.error || "二维码生成失败");
    qrLogin.sid = data.sid;
    qrLogin.imageUrl = `${data.qrImageUrl}&t=${Date.now()}`;
    qrLogin.status = text.qrWaiting;
    pollQrLogin();
    qrLogin.pollTimer = window.setInterval(pollQrLogin, 1800);
  } catch (error) {
    qrLogin.status = error.message || "二维码生成失败";
  } finally {
    qrLogin.loading = false;
  }
}

function stopQrPolling() {
  if (qrLogin.pollTimer) {
    window.clearInterval(qrLogin.pollTimer);
    qrLogin.pollTimer = 0;
  }
}

async function pollQrLogin() {
  if (!qrLogin.sid) return;
  try {
    const response = await fetch(`/api/auth/qr/status?sid=${encodeURIComponent(qrLogin.sid)}`, {
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    if (data.status === "confirmed" && data.token && data.user) {
      stopQrPolling();
      authStore.applyLoginResult(data);
      qrLogin.status = "\u5df2\u786e\u8ba4\uff0c\u6b63\u5728\u8fdb\u5165...";
      await finishLoginRedirect(String(data.redirect || route.query.redirect || "/dashboard"));
      return;
    }
    if (data.status === "expired") {
      stopQrPolling();
      qrLogin.status = text.qrExpired;
    }
  } catch {
    // Keep polling; transient network failures should not close the login flow.
  }
}
</script>

<template>
  <main class="login-page dogzon-login" :class="`is-${loginStage}`">
    <div class="login-bg-grid"></div>
    <div class="login-bg-watermark">{{ text.dogzon }}</div>
    <div class="login-glow login-glow-blue"></div>
    <div class="login-glow login-glow-red"></div>

    <button class="login-theme-toggle" type="button" @click="appStore.toggleTheme()">
      <el-icon><component :is="themeIcon" /></el-icon>
      <span>{{ themeLabel }}{{ text.mode }}</span>
    </button>

    <section class="brand-area" :aria-label="text.brandAria">
      <div class="dogzon-logo">{{ text.dogzon }}</div>
      <div class="brand-logo-sticker">
        <span class="brand-bao">{{ text.bao }}</span>
        <span class="brand-dan brand-dan-1">{{ text.dan }}</span>
        <span class="brand-dan brand-dan-2">{{ text.dan }}</span>
        <span class="brand-dan brand-dan-3">{{ text.dan }}</span>
      </div>
    </section>

    <section class="order-stage" aria-hidden="true">
      <div
        v-for="(order, index) in orderCards"
        :key="order.id"
        class="order-card"
        :class="[`order-card-${index + 1}`, `is-${order.tone}`]"
      >
        <span class="order-icon">{{ order.icon }}</span>
        <div>
          <strong>{{ order.id }}</strong>
          <span>{{ order.status }}</span>
        </div>
        <em>{{ order.qty }}</em>
      </div>

      <div class="order-count-badge">
        <span>{{ text.pendingStock }}</span>
        <strong>9999+</strong>
      </div>
    </section>

    <button
      v-if="loginStage === 'welcome'"
      class="login-start-button"
      type="button"
      @click="openLoginForm"
    >
      {{ text.login }}
    </button>

    <section v-if="loginStage === 'form'" class="login-card" :aria-label="text.systemLoginAria">
      <div class="login-card-head">
        <span>{{ text.cardIntro }}</span>
        <h1>{{ text.cardTitle }}</h1>
      </div>

      <el-form :model="form" label-position="top" class="login-form" @submit.prevent="handleSubmit">
        <el-form-item :label="text.username">
          <el-input
            v-model="form.username"
            size="large"
            :placeholder="text.usernamePlaceholder"
            autocomplete="username"
          >
            <template #prefix>
              <el-icon><User /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item :label="text.password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            size="large"
            :placeholder="text.passwordPlaceholder"
            autocomplete="current-password"
            @keyup.enter="handleSubmit"
          >
            <template #prefix>
              <el-icon><Key /></el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-button
          type="primary"
          size="large"
          class="login-submit"
          :loading="authStore.loading"
          @click="handleSubmit"
        >
          {{ text.submit }}
        </el-button>
        <section v-if="qrLogin.visible" class="qr-login-panel">
          <div class="qr-code-frame">
            <img v-if="qrLogin.imageUrl" :src="qrLogin.imageUrl" alt="扫码登录二维码">
            <span v-else>{{ qrLogin.loading ? "..." : "QR" }}</span>
          </div>
          <p>{{ text.qrHint }}</p>
          <strong>{{ qrLogin.status || text.qrWaiting }}</strong>
        </section>
        <el-button
          size="large"
          class="qr-login-button"
          :loading="qrLogin.loading"
          @click="startQrLogin"
        >
          {{ qrLogin.visible ? text.qrRefresh : text.qrLogin }}
        </el-button>
        <el-alert
          v-if="wechat.bindTicket"
          class="wechat-bind-alert"
          :title="text.wechatBindHint"
          type="success"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="wechat.enabled"
          size="large"
          class="wechat-login-button"
          :loading="wechat.loading"
          @click="startWechatLogin"
        >
          {{ wechat.bindTicket ? text.wechatRetry : text.wechatLogin }}
        </el-button>
      </el-form>
    </section>

    <section v-if="loginStage === 'success'" class="success-welcome" aria-live="polite">
      <div class="success-glow"></div>
      <h1>{{ text.successTitle }}</h1>
      <p>{{ text.successSubtitle }}</p>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 32px;
  overflow: hidden;
  color: #0f172a;
  background:
    radial-gradient(circle at 22% 22%, rgba(37, 99, 235, 0.18), transparent 28%),
    radial-gradient(circle at 82% 70%, rgba(239, 68, 68, 0.12), transparent 30%),
    linear-gradient(135deg, #f7fbff 0%, #ffffff 46%, #eaf4ff 100%);
}

.login-bg-grid {
  position: absolute;
  inset: -60px;
  background:
    linear-gradient(rgba(37, 99, 235, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(37, 99, 235, 0.12) 1px, transparent 1px);
  background-size: 42px 42px;
  mask-image: linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent);
  opacity: 0.56;
  transform: perspective(720px) rotateX(58deg) translateY(90px);
  animation: gridMove 18s linear infinite;
}

.login-bg-watermark {
  position: absolute;
  left: 50%;
  top: 47%;
  color: #0b5cff;
  font-size: clamp(120px, 22vw, 310px);
  font-weight: 950;
  letter-spacing: 0;
  opacity: 0.07;
  transform: translate(-50%, -50%) rotate(-7deg);
  white-space: nowrap;
  user-select: none;
}

.login-glow {
  position: absolute;
  width: 360px;
  height: 360px;
  border-radius: 999px;
  filter: blur(42px);
  opacity: 0.34;
}

.login-glow-blue {
  left: 14%;
  top: 13%;
  background: rgba(37, 99, 235, 0.42);
}

.login-glow-red {
  right: 12%;
  bottom: 14%;
  background: rgba(239, 68, 68, 0.22);
}

.login-theme-toggle {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 8;
  height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border: 1px solid rgba(148, 163, 184, 0.38);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
  color: #17325f;
  font: inherit;
  font-size: 13px;
  font-weight: 800;
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(16px);
  cursor: pointer;
}

.brand-area {
  position: absolute;
  top: clamp(54px, 10vh, 96px);
  left: 50%;
  z-index: 5;
  display: grid;
  justify-items: center;
  gap: 12px;
  transform: translateX(-50%);
  animation: brandDrop 0.68s cubic-bezier(0.18, 0.9, 0.24, 1.12) both;
}

.dogzon-logo {
  color: #075eea;
  font-size: clamp(38px, 7vw, 72px);
  font-weight: 950;
  line-height: 0.95;
  letter-spacing: 0;
  text-shadow: 0 12px 28px rgba(37, 99, 235, 0.18);
}

.brand-logo-sticker {
  position: relative;
  display: inline-flex;
  align-items: flex-end;
  gap: 0;
  transform: rotate(-3deg);
  filter: drop-shadow(0 10px 0 rgba(15, 23, 42, 0.18)) drop-shadow(0 24px 34px rgba(15, 23, 42, 0.18));
}

.brand-logo-sticker span {
  display: inline-block;
  font-size: clamp(35px, 6vw, 68px);
  font-weight: 950;
  line-height: 0.95;
  -webkit-text-stroke: 5px #ffffff;
  paint-order: stroke fill;
}

.brand-bao {
  color: #111827;
}

.brand-dan {
  color: #ef1f1f;
  animation: danPunch 1.6s ease-in-out infinite;
}

.brand-dan-1 {
  transform: scale(1.02) rotate(2deg);
}

.brand-dan-2 {
  transform: scale(1.15) rotate(-1deg);
  animation-delay: 0.12s;
}

.brand-dan-3 {
  transform: scale(1.32) rotate(2deg);
  animation-delay: 0.24s;
}

.order-stage {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  transition: opacity 0.25s ease, filter 0.25s ease;
}

.is-form .order-stage {
  opacity: 0.42;
  filter: saturate(0.9);
}

.is-success .order-stage {
  opacity: 0.72;
  filter: saturate(1.2);
}

.order-card {
  position: absolute;
  width: 246px;
  min-height: 76px;
  display: grid;
  grid-template-columns: 42px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 20px 54px rgba(37, 99, 235, 0.14);
  backdrop-filter: blur(16px);
  opacity: 0;
  animation: orderPop 9s ease-in-out infinite, orderFloat 3.8s ease-in-out infinite;
}

.order-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: #ffffff;
  background: linear-gradient(135deg, #2563eb, #60a5fa);
  font-weight: 900;
}

.order-card strong,
.order-card span {
  display: block;
}

.order-card strong {
  color: #0f172a;
  font-size: 12px;
}

.order-card span {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.order-card em {
  min-width: 54px;
  padding: 5px 8px;
  border-radius: 999px;
  color: #ffffff;
  background: #ef4444;
  font-style: normal;
  font-size: 12px;
  font-weight: 900;
  text-align: center;
}

.order-card.is-red .order-icon {
  background: linear-gradient(135deg, #ef4444, #fb7185);
}

.order-card.is-green .order-icon {
  background: linear-gradient(135deg, #16a34a, #4ade80);
}

.order-card.is-amber .order-icon {
  background: linear-gradient(135deg, #f59e0b, #facc15);
}

.order-card-1 {
  left: 7%;
  top: 25%;
  transform: rotate(-8deg) scale(0.96);
}

.order-card-2 {
  right: 8%;
  top: 24%;
  transform: rotate(7deg) scale(0.9);
  animation-delay: -1.2s;
}

.order-card-3 {
  left: 14%;
  bottom: 18%;
  transform: rotate(6deg) scale(0.88);
  animation-delay: -2.1s;
}

.order-card-4 {
  right: 15%;
  bottom: 19%;
  transform: rotate(-6deg) scale(0.94);
  animation-delay: -3.2s;
}

.order-card-5 {
  left: 30%;
  top: 16%;
  transform: rotate(4deg) scale(0.76);
  animation-delay: -4.1s;
}

.order-card-6 {
  right: 31%;
  top: 15%;
  transform: rotate(-5deg) scale(0.78);
  animation-delay: -5s;
}

.order-card-7 {
  left: 28%;
  bottom: 10%;
  transform: rotate(-4deg) scale(0.72);
  animation-delay: -6.2s;
}

.order-card-8 {
  right: 28%;
  bottom: 9%;
  transform: rotate(5deg) scale(0.74);
  animation-delay: -7.1s;
}

.order-count-badge {
  position: absolute;
  left: 50%;
  bottom: clamp(48px, 9vh, 92px);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 18px 45px rgba(239, 68, 68, 0.16);
  transform: translateX(-50%);
  backdrop-filter: blur(16px);
  animation: badgePulse 1.8s ease-in-out infinite;
}

.order-count-badge span {
  color: #64748b;
  font-size: 13px;
  font-weight: 800;
}

.order-count-badge strong {
  color: #ef1f1f;
  font-size: 22px;
  line-height: 1;
}

.login-start-button {
  position: relative;
  z-index: 6;
  width: min(260px, 72vw);
  height: 64px;
  margin-top: 190px;
  border: 0;
  border-radius: 999px;
  color: #ffffff;
  background: linear-gradient(135deg, #075eea, #2563eb 54%, #38bdf8);
  box-shadow: 0 16px 40px rgba(37, 99, 235, 0.28);
  font-size: 22px;
  font-weight: 950;
  cursor: pointer;
  animation: buttonPulse 1.9s ease-in-out infinite;
  transition: transform 0.18s ease, filter 0.18s ease;
}

.login-start-button:hover {
  transform: translateY(-3px);
  filter: brightness(1.04);
}

.login-card {
  position: relative;
  z-index: 7;
  width: min(420px, calc(100vw - 36px));
  padding: 30px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(18px);
  animation: fadeInUp 0.35s ease-out both;
}

.login-card-head {
  margin-bottom: 24px;
}

.login-card-head span {
  color: #2563eb;
  font-size: 13px;
  font-weight: 900;
}

.login-card-head h1 {
  margin: 7px 0 0;
  color: #0f172a;
  font-size: 28px;
  line-height: 1.16;
  letter-spacing: 0;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.login-form :deep(.el-form-item__content) {
  min-width: 0;
}

.login-form :deep(.el-form-item__label) {
  color: #1f2937;
  font-size: 13px;
  font-weight: 900;
}

.login-form :deep(.el-input) {
  width: 100%;
  font-size: 14px;
}

.login-form :deep(.el-input__wrapper) {
  width: 100%;
  min-height: 48px;
  height: 48px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  border-radius: 14px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.34) inset;
}

.login-form :deep(.el-input__inner) {
  width: 100%;
  height: 46px;
  line-height: 46px;
  border: 0;
  outline: 0;
  box-shadow: none;
  background: transparent;
  padding: 0;
  color: #0f172a;
  font-size: 14px;
}

.login-form :deep(.el-input__inner:focus) {
  border: 0;
  outline: 0;
  box-shadow: none;
}

.login-form :deep(.el-input__inner::-ms-reveal),
.login-form :deep(.el-input__inner::-ms-clear) {
  display: none;
}

.login-form :deep(input[type="password"]::-webkit-credentials-auto-fill-button),
.login-form :deep(input[type="password"]::-webkit-caps-lock-indicator),
.login-form :deep(input[type="password"]::-webkit-contacts-auto-fill-button) {
  visibility: hidden;
  display: none;
  pointer-events: none;
}

.login-form :deep(.el-input__prefix),
.login-form :deep(.el-input__suffix),
.login-form :deep(.el-input__prefix-inner),
.login-form :deep(.el-input__suffix-inner) {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.login-form :deep(.el-input__prefix) {
  margin-right: 8px;
}

.login-form :deep(.el-input__suffix) {
  margin-left: 8px;
}

.login-form :deep(.el-icon),
.login-form :deep(.el-icon svg),
.login-form :deep(.el-input__icon),
.login-form :deep(.el-input__icon svg),
.login-theme-toggle .el-icon,
.login-theme-toggle .el-icon svg {
  width: 16px;
  height: 16px;
  font-size: 16px;
  line-height: 1;
}

.login-form :deep(.el-input__password) {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.login-form :deep(.el-input__wrapper.is-focus) {
  box-shadow:
    0 0 0 1px rgba(37, 99, 235, 0.9) inset,
    0 0 0 4px rgba(37, 99, 235, 0.14);
}

.login-submit {
  width: 100%;
  min-height: 50px;
  margin-top: 4px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(135deg, #075eea, #2563eb 58%, #ef4444);
  box-shadow: 0 16px 34px rgba(37, 99, 235, 0.26);
  font-size: 15px;
  font-weight: 900;
}

.wechat-bind-alert {
  margin-top: 14px;
}

.qr-login-panel {
  display: grid;
  justify-items: center;
  gap: 9px;
  margin-top: 14px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.32);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.7);
}

.qr-code-frame {
  width: 150px;
  height: 150px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.3) inset;
}

.qr-code-frame img {
  width: 132px;
  height: 132px;
  display: block;
}

.qr-login-panel p {
  margin: 0;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  text-align: center;
}

.qr-login-panel strong {
  color: #075eea;
  font-size: 13px;
}

.qr-login-button,
.wechat-login-button {
  width: 100%;
  min-height: 46px;
  margin-top: 12px;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 900;
}

.qr-login-button {
  border-color: rgba(37, 99, 235, 0.34);
  color: #1d4ed8;
  background: rgba(239, 246, 255, 0.9);
}

.qr-login-button:hover,
.qr-login-button:focus {
  border-color: rgba(37, 99, 235, 0.72);
  color: #1e40af;
  background: #dbeafe;
}

.wechat-login-button {
  border-color: rgba(22, 163, 74, 0.34);
  color: #15803d;
  background: rgba(240, 253, 244, 0.9);
}

.wechat-login-button:hover,
.wechat-login-button:focus {
  border-color: rgba(22, 163, 74, 0.72);
  color: #166534;
  background: #dcfce7;
}

.success-welcome {
  position: relative;
  z-index: 8;
  display: grid;
  justify-items: center;
  gap: 10px;
  text-align: center;
  animation: successZoomIn 0.48s cubic-bezier(0.18, 0.9, 0.24, 1.18) both;
}

.success-glow {
  position: absolute;
  inset: -90px -120px;
  z-index: -1;
  border-radius: 999px;
  background:
    radial-gradient(circle, rgba(37, 99, 235, 0.26), transparent 58%),
    radial-gradient(circle at 72% 55%, rgba(239, 68, 68, 0.2), transparent 38%);
  filter: blur(8px);
  animation: successGlow 0.95s ease-in-out both;
}

.success-welcome h1 {
  margin: 0;
  color: #075eea;
  font-size: clamp(36px, 6vw, 52px);
  font-weight: 950;
  letter-spacing: 0;
  text-shadow: 0 10px 32px rgba(37, 99, 235, 0.2);
}

.success-welcome p {
  margin: 0;
  color: #ef4444;
  font-size: 16px;
  font-weight: 900;
}

:root[data-theme="dark"] .login-page {
  color: #e5eefc;
  background:
    radial-gradient(circle at 22% 22%, rgba(59, 130, 246, 0.22), transparent 28%),
    radial-gradient(circle at 82% 70%, rgba(239, 68, 68, 0.16), transparent 30%),
    linear-gradient(135deg, #07111f 0%, #101b2d 52%, #08111f 100%);
}

:root[data-theme="dark"] .login-bg-watermark {
  color: #60a5fa;
  opacity: 0.08;
}

:root[data-theme="dark"] .login-theme-toggle,
:root[data-theme="dark"] .order-card,
:root[data-theme="dark"] .order-count-badge,
:root[data-theme="dark"] .login-card {
  border-color: rgba(148, 163, 184, 0.28);
  background: rgba(15, 23, 42, 0.68);
}

:root[data-theme="dark"] .login-theme-toggle,
:root[data-theme="dark"] .order-card strong,
:root[data-theme="dark"] .login-card-head h1,
:root[data-theme="dark"] .login-form :deep(.el-form-item__label) {
  color: #e5eefc;
}

:root[data-theme="dark"] .order-card span {
  color: #a8b5ca;
}

:root[data-theme="dark"] .login-form :deep(.el-input__wrapper) {
  background: rgba(15, 23, 42, 0.72);
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.28) inset;
}

@keyframes gridMove {
  from {
    background-position: 0 0, 0 0;
  }
  to {
    background-position: 0 168px, 168px 0;
  }
}

@keyframes brandDrop {
  from {
    opacity: 0;
    transform: translate(-50%, -18px) scale(0.94);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }
}

@keyframes danPunch {
  0%,
  100% {
    filter: brightness(1);
  }
  50% {
    filter: brightness(1.14);
  }
}

@keyframes orderPop {
  0% {
    opacity: 0;
    translate: -36px 52px;
  }
  12%,
  72% {
    opacity: 1;
    translate: 0 0;
  }
  100% {
    opacity: 0;
    translate: 38px -42px;
  }
}

@keyframes orderFloat {
  0%,
  100% {
    margin-top: 0;
  }
  50% {
    margin-top: -12px;
  }
}

@keyframes badgePulse {
  0%,
  100% {
    transform: translateX(-50%) scale(1);
  }
  50% {
    transform: translateX(-50%) scale(1.04);
  }
}

@keyframes buttonPulse {
  0%,
  100% {
    box-shadow: 0 16px 40px rgba(37, 99, 235, 0.28);
    transform: translateY(0);
  }
  50% {
    box-shadow: 0 22px 60px rgba(37, 99, 235, 0.42);
    transform: translateY(-2px);
  }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes successZoomIn {
  from {
    opacity: 0;
    transform: scale(0.84);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes successGlow {
  from {
    opacity: 0;
    transform: scale(0.72);
  }
  to {
    opacity: 1;
    transform: scale(1.05);
  }
}

@media (max-width: 780px) {
  .login-page {
    padding: 22px;
  }

  .brand-area {
    top: 58px;
  }

  .order-card-5,
  .order-card-6,
  .order-card-7,
  .order-card-8 {
    display: none;
  }

  .order-card {
    width: 218px;
  }

  .order-card-1 {
    left: -36px;
    top: 28%;
  }

  .order-card-2 {
    right: -42px;
    top: 31%;
  }

  .order-card-3 {
    left: -48px;
    bottom: 18%;
  }

  .order-card-4 {
    right: -42px;
    bottom: 17%;
  }

  .login-start-button {
    margin-top: 168px;
  }
}

@media (max-width: 520px) {
  .login-theme-toggle {
    top: 14px;
    right: 14px;
  }

  .brand-logo-sticker span {
    -webkit-text-stroke-width: 3px;
  }

  .order-card {
    opacity: 0.5;
    transform: scale(0.78);
  }

  .order-count-badge {
    bottom: 34px;
  }

  .login-card {
    padding: 24px;
  }
}
</style>
