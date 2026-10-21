<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const rows = ref([]);
let viewScope = currentApiCacheScope();

function clearChangedScope() {
  const scope = currentApiCacheScope();
  if (scope !== viewScope) { viewScope = scope; rows.value = []; }
  return scope;
}

async function load() {
  const scope = clearChangedScope();
  loading.value = true;
  try {
    const result = await apiClient.get("/api/platform/accounts", { noCache: true });
    if (scope === currentApiCacheScope()) rows.value = Array.isArray(result) ? result : [];
  } catch (error) {
    if (error?.name !== "AbortError") ElMessage.error(error.message || "平台人员加载失败");
  } finally {
    if (scope === currentApiCacheScope()) loading.value = false;
  }
}

onMounted(() => { window.addEventListener("erp:auth-scope-changed", clearChangedScope); load(); });
onBeforeUnmount(() => window.removeEventListener("erp:auth-scope-changed", clearChangedScope));
</script>

<template>
  <main class="platform-accounts-page" v-loading="loading">
    <header class="page-head"><div><h1>平台人员</h1><p>这里只显示拥有平台授权的账号。企业成员在“企业店铺 → 企业人员”中维护。</p></div><el-button @click="load">刷新</el-button></header>
    <el-table :data="rows" row-key="id" empty-text="暂无平台授权账号">
      <el-table-column prop="name" label="姓名" min-width="140" />
      <el-table-column prop="username" label="登录名" min-width="160" />
      <el-table-column label="平台授权" min-width="160"><template #default="{ row }">{{ row.platform_role === 'super_admin' ? '平台超级管理员' : row.platform_role || '-' }}</template></el-table-column>
      <el-table-column label="授权状态" width="110"><template #default="{ row }"><el-tag :type="Number(row.active) ? 'success' : 'info'">{{ Number(row.active) ? "启用" : "停用" }}</el-tag></template></el-table-column>
      <el-table-column label="账号状态" width="110"><template #default="{ row }">{{ Number(row.account_active) ? "正常" : "已停用" }}</template></el-table-column>
      <el-table-column label="更新时间（北京时间）" min-width="180"><template #default="{ row }">{{ row.updated_at ? shanghaiDateTimeText(row.updated_at, { assumeUtcWhenNaive: true }) : "-" }}</template></el-table-column>
    </el-table>
  </main>
</template>

<style scoped>
.platform-accounts-page{padding:24px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page-head h1{margin:0 0 8px}.page-head p{margin:0;color:var(--erp-text-regular, #64748b)}@media(max-width:720px){.platform-accounts-page{padding:14px}.page-head{flex-direction:column}}
</style>
