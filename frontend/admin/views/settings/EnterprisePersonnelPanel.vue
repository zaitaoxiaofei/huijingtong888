<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { ROLE_DEFINITIONS } from "../../../../src/shared/permissions.js";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const dialogVisible = ref(false);
const editing = ref(false);
const identityEditable = ref(true);
const form = reactive(createForm());
const filters = reactive({ query: "", status: "all", page: 1, pageSize: 20 });
const businessRoleOptions = ROLE_DEFINITIONS.filter((role) => !["admin", "technical"].includes(role.value));
let viewScope = currentApiCacheScope();

function createForm() {
  return { id: null, name: "", username: "", password: "", avatar_url: "", tenant_role: "member", business_roles: ["operator"], member_active: 1 };
}

const filteredRows = computed(() => {
  const query = filters.query.trim().toLowerCase();
  return rows.value.filter((row) => {
    if (filters.status !== "all" && (Number(row.member_active) !== 0) !== (filters.status === "active")) return false;
    return !query || [row.name, row.username, businessRoleText(row)].some((value) => String(value || "").toLowerCase().includes(query));
  });
});
const pagedRows = computed(() => filteredRows.value.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize));
const legacyRoles = computed(() => form.business_roles.filter((role) => !businessRoleOptions.some((option) => option.value === role)));

function businessRoleText(row) {
  return (Array.isArray(row.business_roles) ? row.business_roles : []).map((value) => ROLE_DEFINITIONS.find((role) => role.value === value)?.label || value).join("、") || "未设置";
}

function tenantRoleText(role) {
  return { owner: "负责人", admin: "企业管理员", member: "企业成员" }[role] || "企业成员";
}

function resetOnScopeChange() {
  const scope = currentApiCacheScope();
  if (scope !== viewScope) {
    viewScope = scope;
    rows.value = [];
    dialogVisible.value = false;
    Object.assign(form, createForm());
    filters.page = 1;
    loading.value = false;
    saving.value = false;
  }
  return scope;
}

async function load() {
  const scope = resetOnScopeChange();
  loading.value = true;
  try {
    const result = await apiClient.get("/api/enterprise/people", { noCache: true });
    if (scope !== currentApiCacheScope()) return;
    rows.value = Array.isArray(result) ? result : [];
  } catch (error) {
    if (error?.name !== "AbortError") ElMessage.error(error.message || "企业人员加载失败");
  } finally {
    if (scope === currentApiCacheScope()) loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, createForm());
  editing.value = false;
  identityEditable.value = true;
  dialogVisible.value = true;
}

function openEdit(row) {
  Object.assign(form, createForm(), {
    id: Number(row.person_id || row.id), name: row.name || "", username: row.username || "", avatar_url: row.avatar_url || "",
    tenant_role: row.tenant_role || "member", business_roles: [...(row.business_roles || [])], member_active: Number(row.member_active) ? 1 : 0
  });
  editing.value = true;
  identityEditable.value = row.can_edit_identity === true || Number(row.can_edit_identity) === 1;
  dialogVisible.value = true;
}

function accountPayload() {
  const payload = { business_roles: [...form.business_roles], member_active: Number(form.member_active) ? 1 : 0 };
  if (form.tenant_role !== "owner") payload.tenant_role = form.tenant_role;
  if (!editing.value || identityEditable.value) {
    Object.assign(payload, { name: form.name.trim(), username: form.username.trim(), avatar_url: form.avatar_url.trim() });
    if (!editing.value || form.password.trim()) payload.password = form.password;
  }
  return payload;
}

async function save() {
  if (currentApiCacheScope() !== viewScope) { resetOnScopeChange(); return; }
  if ((!editing.value || identityEditable.value) && (!form.name.trim() || !form.username.trim())) return ElMessage.warning("请填写人员姓名和登录名");
  if (!editing.value && !form.password.trim()) return ElMessage.warning("请填写初始密码");
  if (!form.business_roles.length) return ElMessage.warning("请至少选择一个业务岗位");
  const scope = resetOnScopeChange();
  saving.value = true;
  try {
    const payload = accountPayload();
    if (editing.value) await apiClient.put(`/api/enterprise/people/${form.id}`, payload);
    else await apiClient.post("/api/enterprise/people", payload);
    if (scope !== currentApiCacheScope()) return;
    dialogVisible.value = false;
    ElMessage.success("企业人员已保存");
    await load();
  } catch (error) {
    if (error?.name !== "AbortError") ElMessage.error(error.message || "企业人员保存失败");
  } finally {
    if (scope === currentApiCacheScope()) saving.value = false;
  }
}

onMounted(() => { window.addEventListener("erp:auth-scope-changed", resetOnScopeChange); load(); });
onBeforeUnmount(() => window.removeEventListener("erp:auth-scope-changed", resetOnScopeChange));
</script>

<template>
  <main class="enterprise-people-page" v-loading="loading">
    <header class="page-head">
      <div><h1>企业人员</h1><p>管理当前企业的全部成员、企业角色和业务岗位。</p></div>
      <div class="page-actions"><el-button @click="load">刷新</el-button><el-button type="primary" @click="openCreate">新增企业人员</el-button></div>
    </header>
    <el-form inline class="filter-panel">
      <el-form-item label="关键词"><el-input v-model="filters.query" clearable placeholder="姓名 / 登录名 / 业务岗位" @input="filters.page = 1" /></el-form-item>
      <el-form-item label="企业成员状态"><el-select v-model="filters.status" style="width: 140px" @change="filters.page = 1"><el-option label="全部" value="all" /><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
    </el-form>
    <el-table :data="pagedRows" row-key="person_id" empty-text="当前企业还没有人员">
      <el-table-column label="人员信息" min-width="220"><template #default="{ row }"><div class="person-info"><el-avatar :src="row.avatar_url" :size="44">{{ String(row.name || "人员").slice(0, 1) }}</el-avatar><div><strong>{{ row.name }}</strong><span>{{ row.username || "未设置登录名" }}</span></div></div></template></el-table-column>
      <el-table-column label="企业角色" min-width="120"><template #default="{ row }">{{ tenantRoleText(row.tenant_role) }}</template></el-table-column>
      <el-table-column label="业务岗位" min-width="180"><template #default="{ row }">{{ businessRoleText(row) }}</template></el-table-column>
      <el-table-column label="成员状态" width="100"><template #default="{ row }"><el-tag :type="Number(row.member_active) ? 'success' : 'info'">{{ Number(row.member_active) ? "启用" : "停用" }}</el-tag></template></el-table-column>
      <el-table-column label="账号状态" width="100"><template #default="{ row }">{{ Number(row.account_active) ? "正常" : "已停用" }}</template></el-table-column>
      <el-table-column label="更新时间（北京时间）" min-width="180"><template #default="{ row }">{{ row.updated_at ? shanghaiDateTimeText(row.updated_at, { assumeUtcWhenNaive: true }) : "-" }}</template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button></template></el-table-column>
    </el-table>
    <PageFooterPagination :total="filteredRows.length" :page="filters.page" :page-size="filters.pageSize" :page-sizes="[10, 20, 50]" @update:page="filters.page = $event" @update:pageSize="filters.pageSize = $event; filters.page = 1" />

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑企业人员' : '新增企业人员'" width="660px" destroy-on-close>
      <el-alert v-if="editing && !identityEditable" title="此账号的身份资料由平台统一维护，本企业可以调整成员状态和业务岗位。" type="info" :closable="false" class="identity-note" />
      <el-form label-width="110px">
        <el-form-item label="人员姓名" required><el-input v-model="form.name" :disabled="!identityEditable" /></el-form-item>
        <el-form-item label="登录名" required><el-input v-model="form.username" :disabled="!identityEditable" autocomplete="off" /></el-form-item>
        <el-form-item v-if="identityEditable" label="头像地址"><el-input v-model="form.avatar_url" placeholder="选填" /></el-form-item>
        <el-form-item label="企业角色"><el-select v-model="form.tenant_role" :disabled="form.tenant_role === 'owner'"><el-option v-if="form.tenant_role === 'owner'" label="负责人" value="owner" /><el-option label="企业管理员" value="admin" /><el-option label="企业成员" value="member" /></el-select></el-form-item>
        <el-form-item label="业务岗位" required><el-checkbox-group v-model="form.business_roles"><el-checkbox v-for="role in businessRoleOptions" :key="role.value" :value="role.value">{{ role.label }}</el-checkbox></el-checkbox-group><span v-if="legacyRoles.length" class="legacy-note">历史岗位保留：{{ legacyRoles.map(role => ROLE_DEFINITIONS.find(item => item.value === role)?.label || role).join('、') }}</span></el-form-item>
        <el-form-item label="成员状态"><el-select v-model="form.member_active" :disabled="form.tenant_role === 'owner'"><el-option label="启用" :value="1" /><el-option label="停用" :value="0" /></el-select></el-form-item>
        <el-form-item v-if="identityEditable" label="密码" :required="!editing"><el-input v-model="form.password" type="password" show-password autocomplete="new-password" :placeholder="editing ? '留空保持现有密码' : '请输入初始密码'" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped>
.enterprise-people-page{padding:24px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page-head h1{margin:0 0 8px}.page-head p,.person-info span,.legacy-note{color:var(--erp-text-regular, #64748b)}.page-actions,.person-info{display:flex;align-items:center;gap:12px}.person-info>div{display:flex;flex-direction:column;gap:4px}.identity-note{margin-bottom:18px}.legacy-note{display:block;width:100%;font-size:12px}@media(max-width:720px){.enterprise-people-page{padding:14px}.page-head{flex-direction:column}}
</style>
