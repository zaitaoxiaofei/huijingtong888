<script setup>
import { computed, ref } from 'vue';
import { WB_LOGISTICS_VERSIONS, currentWbTariff, wbTariffVersion } from '../../../../src/shared/wb-logistics-catalog.js';
const key = ref(currentWbTariff().version);
const query = ref('');
const catalog = computed(() => wbTariffVersion(key.value));
const rows = computed(() => catalog.value.rows.filter(row => `${row.id} ${row.name} ${row.nameEn} ${row.service}`.toLowerCase().includes(query.value.trim().toLowerCase())));
</script>
<template>
  <el-card shadow="never">
    <template #header><strong>WB 揽收仓报价版本</strong></template>
    <el-alert type="info" :closable="false" title="WB 官方报价独立按版本保留，不写入 Ozon 服务商规则。更新时登记新版本和生效日期，保留历史原表及报价。" />
    <el-form inline style="margin-top: 16px">
      <el-form-item label="WB 报价版本"><el-select v-model="key" style="width: 270px"><el-option v-for="item in WB_LOGISTICS_VERSIONS" :key="item.version" :value="item.version" :label="`${item.version} 生效 · ${item.version === currentWbTariff().version ? '当前' : '历史'}`" /></el-select></el-form-item>
      <el-form-item label="仓库／渠道"><el-input v-model="query" clearable placeholder="仓库编号、城市或渠道" /></el-form-item>
    </el-form>
    <p>WB · {{ catalog.version }} · {{ catalog.rows.length }} 个仓库／渠道 · <a :href="catalog.downloadUrl" target="_blank" rel="noopener noreferrer">下载此版本官方原表</a></p>
    <el-table :data="rows" max-height="560" border empty-text="没有匹配的 WB 揽收仓">
      <el-table-column prop="id" label="WB 仓库编号" width="140" />
      <el-table-column prop="service" label="物流产品" width="150" />
      <el-table-column prop="name" label="WB 揽收仓／渠道" min-width="330" />
      <el-table-column label="≤300g：元/kg + 元/票" width="180"><template #default="{ row }">{{ row.light[0] }} + {{ row.light[1] }}</template></el-table-column>
      <el-table-column label="≥400g：元/kg + 元/票" width="180"><template #default="{ row }">{{ row.heavy[0] }} + {{ row.heavy[1] }}</template></el-table-column>
      <el-table-column label="限制" min-width="250"><template #default="{ row }">单边≤{{ row.maxSideCm }}cm，三边和≤{{ row.maxSumCm }}cm，限重 {{ row.maxWeightG / 1000 }}kg</template></el-table-column>
    </el-table>
    <small>仅供查看和历史复核。报价版本按官方原件发布，已登记的旧版本不直接覆盖；WB 实重每 100 克向上取整。</small>
  </el-card>
</template>
