<script setup>
import { computed, ref, watch } from 'vue';
import PlatformBadge from './PlatformBadge.vue';
const props = defineProps({ rows: { type: Array, default: () => [] }, loading: Boolean });
const page = ref(1), platform = ref('all');
const filtered = computed(() => props.rows.filter(row => platform.value === 'all' || row.platform === platform.value));
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 3)));
const visible = computed(() => filtered.value.slice((page.value - 1) * 3, page.value * 3));
const number = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
watch(platform, () => { page.value = 1; });
watch(() => props.rows, () => { page.value = Math.min(page.value, pageCount.value); });
</script>
<template>
 <section class="overview-panel capacity-panel" aria-label="店铺上架额度">
  <header class="capacity-heading"><div><span>Listing Capacity</span><h2>店铺上架额度</h2></div><el-select v-model="platform" size="small" aria-label="额度平台筛选"><el-option label="全部平台" value="all"/><el-option label="Ozon" value="ozon"/><el-option label="WB" value="wb"/></el-select></header>
  <div class="capacity-rows" aria-live="polite">
   <article v-for="row in visible" :key="row.shop_id" class="capacity-row">
    <div class="capacity-identity"><PlatformBadge :platform="row.platform" :size="22"/><strong :title="row.shop_name">{{row.shop_name}}</strong><b v-if="row.ok">{{row.platform==='wb'?'总可用':'今日可用'}} {{number(row.platform==='wb'?row.total_available:row.today_available)}}</b><span v-else class="capacity-error">额度暂不可用</span></div>
    <div v-if="row.ok" class="capacity-meta"><span v-if="row.platform==='wb'">每日上新：接口未提供</span><span v-else>今日已用 {{number(row.today_usage)}} / {{number(row.today_limit)}}</span><span>总可用 {{row.total_available===null&&row.refreshing?'核对中':number(row.total_available)}} / {{number(row.total_limit)}}</span></div>
    <small v-if="row.error" class="capacity-error">{{row.error}}</small>
   </article>
   <el-skeleton v-if="loading&&!rows.length" :rows="3" animated/>
   <el-empty v-else-if="!visible.length" description="暂无店铺额度数据" :image-size="44"/>
  </div>
  <footer><span>共 {{filtered.length}} 家 · 每页 3 家</span><div><el-button size="small" aria-label="上一页店铺" :disabled="page<=1" @click="page--">‹</el-button><span>{{page}} / {{pageCount}}</span><el-button size="small" aria-label="下一页店铺" :disabled="page>=pageCount" @click="page++">›</el-button></div></footer>
 </section>
</template>
<style scoped>
.capacity-panel{display:flex;flex-direction:column;min-width:0;height:400px;box-sizing:border-box}.capacity-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}.capacity-heading span{font-size:11px;color:var(--dashboard-muted,var(--el-text-color-secondary))}.capacity-heading h2{font-size:16px;margin:3px 0 0}.capacity-heading .el-select{width:108px;flex:none}.capacity-rows{min-height:0;flex:1;display:grid;grid-template-rows:repeat(3,minmax(0,1fr));overflow:auto;overscroll-behavior:contain}.capacity-row{display:flex;flex-direction:column;justify-content:center;gap:7px;padding:10px 0;border-bottom:1px solid var(--el-border-color-lighter)}.capacity-identity{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.capacity-identity strong{font-size:13px;font-weight:500;min-width:0;flex:1;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.capacity-identity b{font-size:13px;font-weight:500;color:var(--el-color-primary);font-variant-numeric:tabular-nums}.capacity-meta{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--el-text-color-secondary)}.capacity-error{font-size:12px;color:var(--el-color-danger);overflow-wrap:anywhere}.capacity-panel footer{padding-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--el-text-color-secondary)}.capacity-panel footer>div{display:flex;align-items:center;gap:10px}.capacity-panel footer .el-button{margin:0;padding:4px 10px;min-width:30px}@media(max-width:600px){.capacity-panel{height:400px}.capacity-identity b{font-size:12px}.capacity-heading h2{font-size:15px}.capacity-panel footer .el-button{min-height:36px;min-width:36px}}
</style>
