<script setup>
import { computed, reactive } from "vue";
import { useRoute, useRouter } from "vue-router";
import { MoonNight, Sunny } from "@element-plus/icons-vue";
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
  <div class="login-page">
    <div class="login-page-orb login-page-orb-a"></div>
    <div class="login-page-orb login-page-orb-b"></div>

    <div class="login-theme-bar">
      <el-button round class="login-theme-toggle" @click="appStore.toggleTheme()">
        <el-icon><component :is="themeIcon" /></el-icon>
        <span>{{ themeLabel }}主题</span>
      </el-button>
    </div>

    <div class="login-panel">
      <div class="login-brand">
        <div class="login-badge">OZ</div>
        <div>
          <h1>Ozon ERP 新后台</h1>
          <p>统一的 Vue 3 + Element Plus 中后台壳，用于逐步迁移订单、库存、采购和系统设置页面。</p>
        </div>
      </div>

      <el-card shadow="never" class="login-card">
        <template #header>
          <div class="login-card-header">
            <strong>账号登录</strong>
            <span>使用现有 ERP 账号进入系统</span>
          </div>
        </template>

        <el-form :model="form" label-position="top" class="login-form" @submit.prevent="handleSubmit">
          <el-form-item label="登录名">
            <el-input v-model="form.username" size="large" placeholder="请输入登录名" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              type="password"
              show-password
              size="large"
              placeholder="请输入密码"
              @keyup.enter="handleSubmit"
            />
          </el-form-item>
          <el-button type="primary" size="large" class="login-submit" :loading="authStore.loading" @click="handleSubmit">
            登录
          </el-button>
        </el-form>
      </el-card>
    </div>
  </div>
</template>
