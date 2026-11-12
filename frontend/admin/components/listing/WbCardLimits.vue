<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { apiClient, currentApiCacheScope } from '../../utils/api.js';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const props = defineProps({ shops: { type: Array, default: () => [] }, shopId: { type: Number, default: null } });
const visible = ref(false), loading = ref(false), rows = ref([]);
let sequence = 0, timer;
const numberText = value => value === null || value === undefined ? '--' : Number(value).toLocaleString('zh-CN');
function clear() { sequence++; clearTimeout(timer); rows.value = []; loading.value = false; }
async function load() {
  clearTimeout(timer);
  const seq = ++sequence, scope = currentApiCacheScope();
  const targets = props.shops.filter(shop => !props.shopId || Number(shop.id) === props.shopId);
  rows.value = [];
  loading.value = true;
  const result = await Promise.all(targets.map(async shop => {
    try {
      const limit = await apiClient.get(`/api/wb/card-limits?shop_id=${Number(shop.id)}`, { noCache: true });
      return { shop_id: shop.id, shop_name: shop.name, limit };
    } catch (error) { return { shop_id: shop.id, shop_name: shop.name, error: error.message }; }
  }));
  if (seq !== sequence || scope !== currentApiCacheScope()) return;
  rows.value = result;
  loading.value = false;
  if (visible.value && result.some(row => row.limit?.refreshing)) timer = setTimeout(load, 3000);
}
function close() { clear(); }
function reset() { visible.value = false; clear(); }
watch(() => [props.shopId, props.shops], () => { clear(); if (visible.value) load(); });
onMounted(() => window.addEventListener('erp:auth-scope-changed', reset));
onBeforeUnmount(() => { clear(); window.removeEventListener('erp:auth-scope-changed', reset); });
</script>
<template>
  <el-popover v-model:visible="visible" placement="bottom-end" trigger="click" :width="720" @show="load" @hide="close">
    <template #reference><el-button :disabled="!shops.length">商品卡额度</el-button></template>
    <div class="limit-heading"><strong>WB 商品卡额度</strong><el-button link type="primary" :loading="loading" @click="load">刷新</el-button></div>
    <p class="limit-note">已用包含回收站商品卡。每日上新额度：接口未提供，请到 WB 卖家后台核对。数据缓存5分钟。</p>
    <el-table v-loading="loading" :data="rows" border size="small" empty-text="请选择已授权的 WB 店铺">
      <el-table-column prop="shop_name" label="店铺" min-width="130"/>
      <el-table-column label="总额度" min-width="115"><template #default="{row}">{{numberText(row.limit?.total?.limit)}}<small v-if="row.limit">免费 {{numberText(row.limit.free_limit)}} / 付费 {{numberText(row.limit.paid_limit)}}</small></template></el-table-column>
      <el-table-column label="已用 / 剩余" min-width="125"><template #default="{row}"><span v-if="row.limit?.refreshing">正在核对全部商品卡…</span><span v-else>{{numberText(row.limit?.total?.usage)}} / {{numberText(row.limit?.total?.remaining)}}</span></template></el-table-column>
      <el-table-column label="状态 / 更新（北京）" min-width="210"><template #default="{row}"><span v-if="row.error||row.limit?.usage_error" class="limit-error">{{row.error||row.limit.usage_error}}</span><span v-else-if="row.limit?.refreshing">核对中</span><span v-else>已核对</span><small v-if="row.limit">额度：{{shanghaiDateTimeText(row.limit.fetched_at)}}<br v-if="row.limit.usage_fetched_at"/><template v-if="row.limit.usage_fetched_at">数量：{{shanghaiDateTimeText(row.limit.usage_fetched_at)}}</template></small></template></el-table-column>
    </el-table>
  </el-popover>
</template>
<style scoped>
.limit-heading{display:flex;align-items:center;justify-content:space-between}.limit-note,small{color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}small{display:block}.limit-error{color:var(--el-color-danger)}
</style>
