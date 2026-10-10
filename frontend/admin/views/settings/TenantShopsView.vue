<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";

const loading = ref(false);
const saving = ref(false);
const rows = ref([]);
const members = ref([]);
const dialogVisible = ref(false);
const editing = ref(false);
const form = reactive(createForm());
const activeMembers = computed(() => members.value.filter((member) => Number(member.active) !== 0));

function createForm() {
  return {
    id: null,
    updated_at: null,
    name: "",
    legal_entity: "",
    user_id: null,
    ozon_client_id: "",
    ozon_seller_id: "",
    ozon_api_key: "",
    api_key_hint: "",
    performance_client_id: "",
    performance_client_secret: "",
    payout_rate: 0.33,
    status: "active"
  };
}

function resetForm() {
  Object.assign(form, createForm());
}

async function load() {
  loading.value = true;
  try {
    const [shops, tenantMembers] = await Promise.all([
      apiClient.get("/api/shops", { noCache: true }),
      apiClient.get("/api/tenants/members", { noCache: true })
    ]);
    rows.value = Array.isArray(shops) ? shops : [];
    members.value = Array.isArray(tenantMembers) ? tenantMembers : [];
  } catch (error) {
    ElMessage.error(error.message || "企业店铺加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  resetForm();
  editing.value = false;
  dialogVisible.value = true;
}

function openEdit(row) {
  resetForm();
  Object.assign(form, row, {
    user_id: Number(row.user_id || 0) || null,
    ozon_api_key: "",
    performance_client_secret: ""
  });
  editing.value = true;
  dialogVisible.value = true;
}

async function save() {
  if (!String(form.name || "").trim()) return ElMessage.warning("请填写店铺名称");
  if (!form.user_id) return ElMessage.warning("请选择本企业的店长");
  saving.value = true;
  try {
    const payload = { ...form, payout_rate: Number(form.payout_rate || 0) };
    if (editing.value) await apiClient.put(`/api/shops/${form.id}`, payload);
    else await apiClient.post("/api/shops", payload);
    dialogVisible.value = false;
    ElMessage.success(editing.value ? "店铺已更新" : "店铺已新增");
    await load();
  } catch (error) {
    ElMessage.error(error.message || "保存店铺失败");
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`停用后「${row.name}」不会出现在企业店铺列表中。确认停用吗？`, "停用店铺", { type: "warning" });
    await apiClient.delete(`/api/shops/${row.id}`);
    ElMessage.success("店铺已停用");
    await load();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "停用店铺失败");
  }
}

onMounted(load);
</script>

<template>
  <main class="tenant-shops-page" v-loading="loading">
    <header class="page-head">
      <div><h1>企业店铺</h1><p>管理当前企业自己的 Ozon 店铺和店长。其他企业的店铺不会显示在这里。</p></div>
      <el-button type="primary" @click="openCreate">新增店铺</el-button>
    </header>
    <el-table :data="rows" row-key="id" empty-text="当前企业还没有店铺">
      <el-table-column prop="name" label="店铺名称" min-width="160" />
      <el-table-column prop="user_name" label="店长" min-width="120" />
      <el-table-column prop="ozon_client_id" label="Client ID" min-width="140" />
      <el-table-column label="API Key" min-width="110"><template #default="{ row }">{{ row.ozon_api_key ? "已配置" : "未配置" }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === "active" ? "启用" : "停用" }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button><el-button link type="danger" @click="remove(row)">停用</el-button></template></el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑企业店铺' : '新增企业店铺'" width="620px" destroy-on-close>
      <el-form label-width="120px">
        <el-form-item label="店铺名称" required><el-input v-model="form.name" maxlength="255" /></el-form-item>
        <el-form-item label="店长" required><el-select v-model="form.user_id" filterable placeholder="请选择本企业成员" style="width: 100%"><el-option v-for="member in activeMembers" :key="member.person_id" :label="`${member.name}（${member.username || '未设置登录名'}）`" :value="Number(member.person_id)" /></el-select></el-form-item>
        <el-form-item label="主体名称"><el-input v-model="form.legal_entity" /></el-form-item>
        <el-form-item label="Ozon Client ID"><el-input v-model="form.ozon_client_id" /></el-form-item>
        <el-form-item label="Seller ID"><el-input v-model="form.ozon_seller_id" /></el-form-item>
        <el-form-item label="Ozon API Key"><el-input v-model="form.ozon_api_key" type="password" show-password :placeholder="editing ? '留空保持现有密钥' : '请输入店铺 API Key'" /></el-form-item>
        <el-form-item label="密钥备注"><el-input v-model="form.api_key_hint" /></el-form-item>
        <el-form-item label="广告 Client ID"><el-input v-model="form.performance_client_id" /></el-form-item>
        <el-form-item label="广告 Client Secret"><el-input v-model="form.performance_client_secret" type="password" show-password :placeholder="editing ? '留空保持现有密钥' : '选填'" /></el-form-item>
        <el-form-item label="结算比例"><el-input-number v-model="form.payout_rate" :min="0" :max="1" :step="0.01" :precision="4" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped>
.tenant-shops-page{padding:24px}.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page-head h1{margin:0 0 8px}.page-head p{margin:0;color:#64748b}@media(max-width:720px){.tenant-shops-page{padding:14px}.page-head{flex-direction:column}}
</style>
