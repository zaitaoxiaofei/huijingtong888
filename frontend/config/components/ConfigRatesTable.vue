<script setup>
defineProps({
  rows: { type: Array, default: () => [] }
});

const emit = defineEmits(["create"]);
</script>

<template>
  <section class="ds-card vue-config-table-card">
    <div class="ds-card-header">
      <div>
        <h2>汇率设置</h2>
      </div>
      <div class="ds-card-actions">
        <button type="button" class="ds-btn ds-btn-primary" @click="emit('create')">添加汇率</button>
      </div>
    </div>
    <div v-if="!rows.length" class="ds-empty vue-config-empty">当前没有汇率数据。</div>
    <div v-else class="ds-table-wrap">
      <table class="ds-table vue-config-table">
        <thead>
          <tr>
            <th>生效日期</th>
            <th>汇率</th>
            <th>备注</th>
            <th>记录时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id || `${row.effective_date}-${row.rate}`">
            <td>{{ row.effective_date || "-" }}</td>
            <td>
              <strong>1 RMB = {{ row.rate_text || row.rate || "-" }} RUB</strong>
              <div class="vue-config-cell-meta">{{ row.source || "-" }}</div>
            </td>
            <td>{{ row.note || "-" }}</td>
            <td>{{ row.created_at_text || row.created_at || "-" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
