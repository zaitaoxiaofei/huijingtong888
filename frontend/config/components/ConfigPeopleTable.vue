<script setup>
defineProps({
  rows: { type: Array, default: () => [] }
});

const emit = defineEmits(["create", "edit", "disable", "delete"]);
</script>

<template>
  <section class="ds-card vue-config-table-card">
    <div class="ds-card-header">
      <div>
        <h2>人员配置</h2>
      </div>
      <div class="ds-card-actions">
        <button type="button" class="ds-btn ds-btn-primary" @click="emit('create')">添加人员</button>
      </div>
    </div>
    <div v-if="!rows.length" class="ds-empty vue-config-empty">当前没有人员数据。</div>
    <div v-else class="ds-table-wrap">
      <table class="ds-table vue-config-table">
        <thead>
          <tr>
            <th>姓名</th>
            <th>登录名</th>
            <th>角色</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ row.name || "-" }}</td>
            <td>{{ row.username || "-" }}</td>
            <td>{{ row.role_name || row.role || "-" }}</td>
            <td>
              <span class="ds-badge" :class="row.active ? 'ds-badge-success' : 'ds-badge-warning'">
                {{ row.active ? "启用" : "停用" }}
              </span>
            </td>
            <td>
              <div class="vue-config-row-actions">
                <button type="button" class="ds-btn ds-btn-ghost ds-btn-small" @click="emit('edit', row.id)">编辑</button>
                <button type="button" class="ds-btn ds-btn-small" @click="emit('disable', row.id)">停用</button>
                <button type="button" class="ds-btn ds-btn-danger ds-btn-small" @click="emit('delete', row.id)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
