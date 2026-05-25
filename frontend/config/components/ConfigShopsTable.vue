<script setup>
defineProps({
  rows: { type: Array, default: () => [] }
});

const emit = defineEmits(["create", "edit", "delete"]);

function watermarkUrl(row) {
  if (!row?.id || !row?.watermark_path) return "";
  const token = localStorage.getItem("authToken") || "";
  const base = `/api/tools/image-cropper/shop-watermark/${encodeURIComponent(row.id)}/file`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
</script>

<template>
  <section class="ds-card vue-config-table-card">
    <div class="ds-card-header">
      <div>
        <h2>店铺配置</h2>
      </div>
      <div class="ds-card-actions">
        <button type="button" class="ds-btn ds-btn-primary" @click="emit('create')">添加店铺</button>
      </div>
    </div>
    <div v-if="!rows.length" class="ds-empty vue-config-empty">当前没有店铺数据。</div>
    <div v-else class="ds-table-wrap">
      <table class="ds-table vue-config-table">
        <thead>
          <tr>
            <th>店铺</th>
            <th>主体</th>
            <th>Client ID</th>
            <th>API Key</th>
            <th>水印</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ row.name || "-" }}</td>
            <td>{{ row.legal_entity || "-" }}</td>
            <td>{{ row.ozon_client_id || "-" }}</td>
            <td>{{ row.api_key_hint || "-" }}</td>
            <td>
              <div class="vue-config-watermark-cell">
                <img v-if="watermarkUrl(row)" :src="watermarkUrl(row)" :alt="`${row.name || '店铺'}水印`" />
                <span>{{ row.watermark_name || (row.watermark_path ? "已配置" : "未配置") }}</span>
              </div>
            </td>
            <td>
              <span class="ds-badge" :class="row.status === 'active' ? 'ds-badge-success' : 'ds-badge-warning'">
                {{ row.status === "active" ? "启用" : row.status || "停用" }}
              </span>
            </td>
            <td>
              <div class="vue-config-row-actions">
                <button type="button" class="ds-btn ds-btn-ghost ds-btn-small" @click="emit('edit', row.id)">编辑</button>
                <button type="button" class="ds-btn ds-btn-danger ds-btn-small" @click="emit('delete', row.id)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
