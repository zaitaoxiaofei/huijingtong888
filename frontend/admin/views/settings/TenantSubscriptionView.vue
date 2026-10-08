<script setup>
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const rows = ref([]);
const selected = ref(null);
const planLabels = { trial_1d: "1 天体验", trial_7d: "7 天体验", monthly: "月租", yearly: "年租" };
const statusLabels = { active: "已开通", trial: "体验中", expired: "已到期", suspended: "已暂停" };
const selectedTitle = computed(() => selected.value?.name || "企业详情");

async function load() { loading.value = true; try { rows.value = await apiClient.get("/api/tenants"); } catch (error) { ElMessage.error(error.message || "企业列表加载失败"); } finally { loading.value = false; } }
function open(row) { selected.value = row; }
async function activate(planCode) {
  if (!selected.value) return;
  await ElMessageBox.confirm(`确认将「${selected.value.name}」设为${planLabels[planCode]}吗？`, "确认授权", { type: "warning" });
  try { await apiClient.post("/api/tenants/subscription", { tenant_id: selected.value.id, plan_code: planCode }); ElMessage.success("授权已生效"); await load(); selected.value = rows.value.find(row => row.id === selected.value.id) || null; } catch (error) { if (error !== "cancel") ElMessage.error(error.message || "授权失败"); }
}
async function suspend() { if (!selected.value) return; try { await ElMessageBox.confirm(`暂停后「${selected.value.name}」的成员将不能使用业务功能。确认继续吗？`, "暂停企业", { type: "warning", confirmButtonText: "确认暂停" }); await apiClient.post("/api/tenants/subscription", { tenant_id: selected.value.id, subscription_status: "suspended" }); ElMessage.success("企业已暂停"); await load(); selected.value = rows.value.find(row => row.id === selected.value.id) || null; } catch (error) { if (error !== "cancel") ElMessage.error(error.message || "操作失败"); } }
onMounted(load);
</script>

<template>
  <main class="tenant-page" v-loading="loading">
    <header><div><h1>企业与授权</h1><p>管理企业试用、订阅期限和使用状态。</p></div><el-button @click="load">刷新</el-button></header>
    <el-table :data="rows" @row-click="open" style="cursor:pointer"><el-table-column prop="name" label="企业" min-width="180" /><el-table-column label="套餐" width="130"><template #default="{row}">{{ planLabels[row.plan_code] || row.plan_code }}</template></el-table-column><el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="row.access_allowed ? 'success' : 'danger'">{{ statusLabels[row.subscription_status] || row.subscription_status }}</el-tag></template></el-table-column><el-table-column prop="subscription_expires_at" label="到期时间" min-width="180"><template #default="{row}">{{ row.subscription_expires_at || '长期有效' }}</template></el-table-column><el-table-column prop="member_count" label="成员" width="90" /></el-table>
    <el-drawer v-model="selected" :title="selectedTitle" size="460px"><template v-if="selected"><el-descriptions :column="1" border><el-descriptions-item label="当前套餐">{{ planLabels[selected.plan_code] || selected.plan_code }}</el-descriptions-item><el-descriptions-item label="到期时间">{{ selected.subscription_expires_at || '长期有效' }}</el-descriptions-item><el-descriptions-item label="成员数">{{ selected.member_count }}</el-descriptions-item></el-descriptions><h3>开通或续费</h3><div class="actions"><el-button @click="activate('trial_1d')">1 天体验</el-button><el-button @click="activate('trial_7d')">7 天体验</el-button><el-button type="primary" @click="activate('monthly')">月租</el-button><el-button type="primary" @click="activate('yearly')">年租</el-button><el-button type="danger" plain @click="suspend">暂停企业</el-button></div><p class="hint">授权变更立即生效；到期或暂停后，企业成员的业务操作将被系统拦截。</p></template></el-drawer>
  </main>
</template>

<style scoped>
.tenant-page{padding:24px}.tenant-page header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}.tenant-page h1{margin:0;font-size:24px}.tenant-page p{color:#64748b}.actions{display:flex;flex-wrap:wrap;gap:10px}.hint{margin-top:18px;line-height:1.7;color:#64748b}
</style>
