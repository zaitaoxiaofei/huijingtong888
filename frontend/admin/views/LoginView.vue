<script setup>
import { computed, onBeforeUnmount, onMounted, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Hide, Key, Lock, MoonNight, Sunny, User, View } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "../stores/auth";
import { useAppStore } from "../stores/app";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const appStore = useAppStore();

const form = reactive({
  username: localStorage.getItem("loginUsername") || "",
  password: ""
});

const themeIcon = computed(() => (appStore.theme === "dark" ? Sunny : MoonNight));
const themeLabel = computed(() => (appStore.theme === "dark" ? "亮色" : "暗色"));

function setLoginViewportState(enabled) {
  document.documentElement.classList.toggle("admin-login-open", enabled);
  document.body.classList.toggle("admin-login-open", enabled);
}

onMounted(() => setLoginViewportState(true));
onBeforeUnmount(() => setLoginViewportState(false));

async function handleSubmit() {
  try {
    const user = await authStore.login({
      username: form.username,
      password: form.password
    });
    localStorage.setItem("loginUsername", form.username);
    ElMessage.success(`欢迎回来，${user.name || user.username}`);
    router.replace(String(route.query.redirect || "/dashboard").split("?")[0]);
  } catch (error) {
    ElMessage.error(error.message || "登录失败");
    form.password = "";
  }
}
</script>

<template>
  <main class="login-page">
    <button class="login-theme-toggle" type="button" @click="appStore.toggleTheme()">
      <el-icon><component :is="themeIcon" /></el-icon>
      <span>{{ themeLabel }}模式</span>
    </button>

    <section class="login-stage" aria-label="Ozon ERP 登录">
      <div class="login-brand-panel">
        <div class="login-logo-row">
          <div class="login-logo-mark">OZ</div>
          <div>
            <span class="login-kicker">Ozon ERP</span>
            <h1>运营后台系统</h1>
          </div>
        </div>

        <p class="login-intro">订单、库存、采购和利润数据统一入口。</p>

        <div class="login-signal-grid">
          <div class="login-signal">
            <strong>订单</strong>
            <span>同步、异常和履约进度集中处理</span>
          </div>
          <div class="login-signal">
            <strong>库存</strong>
            <span>本地库存、平台仓和绑定关系统一维护</span>
          </div>
          <div class="login-signal">
            <strong>利润</strong>
            <span>按 SKU、店铺和订单口径跟踪收益</span>
          </div>
        </div>
      </div>

      <el-card shadow="never" class="login-card">
        <div class="login-card-head">
          <span class="login-card-eyebrow">
            <el-icon><Lock /></el-icon>
            安全登录
          </span>
          <h2>账号登录</h2>
          <p>使用 ERP 登录名进入系统。</p>
        </div>

        <el-form :model="form" label-position="top" class="login-form" @submit.prevent="handleSubmit">
          <el-form-item label="登录名">
            <el-input
              v-model="form.username"
              size="large"
              placeholder="请输入登录名"
              autocomplete="username"
            >
              <template #prefix>
                <el-icon><User /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              size="large"
              placeholder="请输入密码"
              autocomplete="current-password"
              @keyup.enter="handleSubmit"
            >
              <template #prefix>
                <el-icon><Key /></el-icon>
              </template>
              <template #password-icon="scope">
                <el-icon class="login-password-icon">
                  <component :is="scope.passwordVisible ? View : Hide" />
                </el-icon>
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
            登录系统
          </el-button>
        </el-form>
      </el-card>
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
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  color: var(--erp-text);
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.06) 0 1px, transparent 1px) 0 0 / 28px 28px,
    linear-gradient(160deg, #f5f8fc 0%, #edf3fa 48%, #e8eef7 100%);
}

.login-page::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(120deg, rgba(37, 99, 235, 0.12), transparent 34%),
    linear-gradient(300deg, rgba(15, 23, 42, 0.1), transparent 36%);
  pointer-events: none;
}

.login-theme-toggle {
  position: absolute;
  top: 24px;
  right: 24px;
  z-index: 3;
  height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border: 1px solid rgba(198, 209, 225, 0.9);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.78);
  color: var(--erp-text);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(16px);
  cursor: pointer;
}

.login-stage {
  position: relative;
  z-index: 1;
  width: min(1040px, 100%);
  display: grid;
  grid-template-columns: minmax(0, 1fr) 430px;
  align-items: stretch;
  border: 1px solid rgba(198, 209, 225, 0.86);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 34px 90px rgba(15, 23, 42, 0.12);
  backdrop-filter: blur(20px);
  overflow: hidden;
}

.login-brand-panel {
  min-height: 520px;
  display: flex;
  flex-direction: column;
  padding: 44px;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(22, 36, 59, 0.96)),
    linear-gradient(135deg, rgba(37, 99, 235, 0.45), transparent);
  color: #f8fafc;
}

.login-logo-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.login-logo-mark {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: linear-gradient(135deg, #f8fafc, #dbeafe);
  color: #17325f;
  font-size: 24px;
  font-weight: 900;
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.24);
}

.login-kicker {
  display: block;
  margin-bottom: 5px;
  color: #93c5fd;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.login-logo-row h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.15;
  letter-spacing: 0;
}

.login-intro {
  max-width: 420px;
  margin: 72px 0 0;
  color: rgba(226, 232, 240, 0.9);
  font-size: 18px;
  line-height: 1.75;
}

.login-signal-grid {
  display: grid;
  gap: 12px;
  margin-top: auto;
}

.login-signal {
  padding: 14px 16px;
  border: 1px solid rgba(226, 232, 240, 0.12);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
}

.login-signal strong {
  display: block;
  margin-bottom: 4px;
  color: #ffffff;
  font-size: 15px;
}

.login-signal span {
  color: rgba(226, 232, 240, 0.74);
  font-size: 13px;
  line-height: 1.6;
}

.login-card {
  display: flex;
  align-items: center;
  border: 0;
  border-radius: 0;
  background: rgba(255, 255, 255, 0.96);
}

.login-card :deep(.el-card__body) {
  width: 100%;
  padding: 44px 42px;
}

.login-card-head {
  margin-bottom: 28px;
}

.login-card-eyebrow {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
  padding: 7px 11px;
  border-radius: 999px;
  background: #eef4ff;
  color: #2852a7;
  font-size: 12px;
  font-weight: 800;
}

.login-card-head h2 {
  margin: 0 0 8px;
  color: var(--erp-text);
  font-size: 30px;
  line-height: 1.15;
  letter-spacing: 0;
}

.login-card-head p {
  margin: 0;
  color: var(--erp-text-secondary);
  font-size: 14px;
  line-height: 1.6;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 20px;
}

.login-form :deep(.el-form-item__label) {
  padding-bottom: 8px;
  color: var(--erp-text);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
}

.login-form :deep(.el-input) {
  width: 100%;
  max-width: 300px;
  display: block;
}

.login-form :deep(.el-input__wrapper) {
  width: 100%;
  min-height: 50px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-radius: 12px;
  background: #f8fafc;
  box-shadow: 0 0 0 1px rgba(198, 209, 225, 0.96) inset;
  transition: box-shadow 0.16s ease, background 0.16s ease;
  overflow: hidden;
}

.login-form :deep(.el-input__wrapper:hover) {
  background: #ffffff;
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.98) inset;
}

.login-form :deep(.el-input__wrapper.is-focus) {
  background: #ffffff;
  box-shadow:
    0 0 0 1px rgba(37, 99, 235, 0.95) inset,
    0 0 0 4px rgba(37, 99, 235, 0.12);
}

.login-form :deep(.el-input__inner) {
  flex: 1 1 auto;
  width: 100% !important;
  min-width: 0;
  height: 50px;
  margin: 0;
  padding: 0 !important;
  border: 0 !important;
  outline: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  appearance: none;
  color: var(--erp-text);
  font-size: 14px;
  text-align: center;
  line-height: 50px;
}

.login-form :deep(.el-input__prefix),
.login-form :deep(.el-input__suffix),
.login-form :deep(.el-input__prefix-inner),
.login-form :deep(.el-input__suffix-inner) {
  display: flex;
  align-items: center;
  height: 50px;
  flex: none;
}

.login-form :deep(.el-input__prefix) {
  margin-right: 8px;
  color: #64748b;
}

.login-form :deep(.el-input__suffix) {
  margin-left: 8px;
  color: #64748b;
  background: transparent !important;
  box-shadow: none !important;
}

.login-form :deep(.el-input__password) {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  border: 0;
  background: transparent !important;
  box-shadow: none !important;
  color: #64748b;
  line-height: 1;
}

.login-form :deep(.el-input__password:hover) {
  color: var(--erp-primary);
}

.login-password-icon,
.login-password-icon svg,
.login-form :deep(.el-input__icon),
.login-form :deep(.el-input__icon svg) {
  width: 16px;
  height: 16px;
  font-size: 16px;
}

.login-submit {
  width: 100%;
  min-height: 50px;
  margin-top: 4px;
  border: 0;
  border-radius: 12px;
  background: linear-gradient(135deg, #1d4ed8, #2563eb 58%, #3b82f6);
  box-shadow: 0 16px 30px rgba(37, 99, 235, 0.24);
  font-size: 15px;
  font-weight: 800;
}

@media (max-width: 880px) {
  .login-page {
    padding: 20px;
  }

  .login-stage {
    grid-template-columns: 1fr;
  }

  .login-brand-panel {
    min-height: auto;
    padding: 32px;
  }

  .login-intro {
    margin-top: 28px;
  }

  .login-signal-grid {
    margin-top: 28px;
  }
}

@media (max-width: 560px) {
  .login-theme-toggle {
    top: 14px;
    right: 14px;
  }

  .login-page {
    min-height: 100svh;
    padding: 72px 14px max(18px, env(safe-area-inset-bottom));
    place-items: start center;
    align-content: start;
  }

  .login-brand-panel,
  .login-card :deep(.el-card__body) {
    padding: 24px;
  }

  .login-logo-row {
    align-items: flex-start;
  }

  .login-logo-mark {
    width: 52px;
    height: 52px;
    border-radius: 15px;
    font-size: 20px;
  }

  .login-logo-row h1 {
    font-size: 26px;
  }
}

:root[data-theme="dark"] .login-page {
  background:
    linear-gradient(135deg, rgba(148, 163, 184, 0.08) 0 1px, transparent 1px) 0 0 / 28px 28px,
    linear-gradient(160deg, #08111f 0%, #0a1322 52%, #060c16 100%);
}

:root[data-theme="dark"] .login-page::before {
  background:
    linear-gradient(120deg, rgba(110, 168, 255, 0.14), transparent 34%),
    linear-gradient(300deg, rgba(0, 0, 0, 0.34), transparent 36%);
}

:root[data-theme="dark"] .login-theme-toggle {
  border-color: rgba(51, 68, 99, 0.9);
  background: rgba(16, 26, 43, 0.82);
  color: var(--erp-text);
}

:root[data-theme="dark"] .login-stage {
  border-color: rgba(51, 68, 99, 0.8);
  background: rgba(16, 26, 43, 0.74);
}

:root[data-theme="dark"] .login-brand-panel {
  background:
    linear-gradient(180deg, rgba(6, 12, 22, 0.98), rgba(10, 19, 34, 0.98)),
    linear-gradient(135deg, rgba(110, 168, 255, 0.24), transparent);
}

:root[data-theme="dark"] .login-card {
  background: rgba(16, 26, 43, 0.96);
}

:root[data-theme="dark"] .login-card-eyebrow {
  background: rgba(110, 168, 255, 0.14);
  color: #cfe0ff;
}

:root[data-theme="dark"] .login-form :deep(.el-input__wrapper) {
  background: rgba(22, 34, 53, 0.92);
  box-shadow: 0 0 0 1px rgba(51, 68, 99, 0.9) inset;
}

:root[data-theme="dark"] .login-form :deep(.el-input__wrapper:hover),
:root[data-theme="dark"] .login-form :deep(.el-input__wrapper.is-focus) {
  background: rgba(20, 32, 51, 0.98);
}
</style>
