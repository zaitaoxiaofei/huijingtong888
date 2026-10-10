<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { apiClient } from "../../utils/api.js";
import { commissionBandLabel } from "../../utils/rfbs-commission.js";

const props = defineProps({ selection: { type: Object, default: null }, priceRub: { type: Number, default: 0 } });
const emit = defineEmits(["select"]);
const root = ref(null);
const open = ref(false);
const query = ref("");
const catalog = ref(null);
const error = ref("");
const activeBlock = ref("");
const activeCategory = ref(null);
const brandOnly = ref(false);
const brandPattern = /Apple|Dyson|Samsung|Sony|苹果|戴森|三星|索尼/i;
const filteredRows = computed(() => (catalog.value?.rows || []).filter((row) => {
  const search = `${row.block} ${row.category} ${row.blockRu} ${row.categoryRu}`.toLocaleLowerCase();
  return (!brandOnly.value || brandPattern.test(search)) && (!query.value || search.includes(query.value.trim().toLocaleLowerCase()));
}));
const blocks = computed(() => [...new Set(filteredRows.value.map((row) => row.block))]);
const categories = computed(() => filteredRows.value.filter((row) => row.block === activeBlock.value));
const selectedLabel = computed(() => props.selection
  ? `${props.selection.category.block} / ${props.selection.category.category} / ${commissionBandLabel(props.selection.band)} (${props.selection.category.rates[props.selection.band]}%)`
  : "请选择 Ozon rFBS 类目佣金");
watch(blocks, (values) => { if (!values.includes(activeBlock.value)) activeBlock.value = values[0] || ""; }, { immediate: true });
watch(categories, (values) => { if (!values.some((row) => row.id === activeCategory.value?.id)) activeCategory.value = values[0] || null; }, { immediate: true });
function dismiss(event) { if (root.value && !root.value.contains(event.target)) open.value = false; }
function choose(row, band) { emit("select", { category: row, band, version: catalog.value.version, sourceFile: catalog.value.sourceFile }); open.value = false; query.value = ""; }
onMounted(async () => {
  document.addEventListener("pointerdown", dismiss);
  try { catalog.value = await apiClient.get("/api/tools/pricing/rfbs-marketplace", { noCache: true }); }
  catch { error.value = "佣金表加载失败，请刷新页面重试"; }
});
onUnmounted(() => document.removeEventListener("pointerdown", dismiss));
</script>

<template>
  <div ref="root" class="rfbs-picker">
    <div class="rfbs-trigger" :class="{ opened: open }" @click="open = true">
      <input :value="open ? query : selectedLabel" :placeholder="selectedLabel" @focus="open = true" @input="query = $event.target.value; open = true" @keydown.esc="open = false" />
      <span class="chevron">⌄</span>
    </div>
    <p v-if="error" class="rfbs-error">{{ error }}</p>
    <div v-if="open && catalog" class="rfbs-menu">
      <div class="rfbs-toolbar"><span>rFBS 类目 · {{ catalog.version }}</span><button type="button" @click="brandOnly = !brandOnly">{{ brandOnly ? "全部类目" : "品牌特例" }}</button></div>
      <div class="rfbs-columns">
        <div class="rfbs-column">
          <button v-for="block in blocks" :key="block" type="button" :class="{ active: activeBlock === block }" @mouseenter="activeBlock = block" @click="activeBlock = block">{{ block }} <span>›</span></button>
        </div>
        <div class="rfbs-column">
          <button v-for="row in categories" :key="row.id" type="button" :class="{ active: activeCategory?.id === row.id }" @mouseenter="activeCategory = row" @click="activeCategory = row">{{ row.category }} <span>›</span></button>
        </div>
        <div class="rfbs-column band-column">
          <button v-for="(rate, index) in activeCategory?.rates || []" :key="index" type="button" :class="{ active: selection?.category.id === activeCategory?.id && selection.band === index, recommended: priceRub > 0 && (priceRub <= 1500 ? 0 : priceRub <= 5000 ? 1 : 2) === index }" @click="choose(activeCategory, index)">{{ commissionBandLabel(index) }} <strong>{{ rate }}%</strong></button>
          <p v-if="!activeCategory">选择二级类目查看售价档</p>
        </div>
      </div>
      <div class="rfbs-footer">当前售价适用档位以卢布成交价判断；特殊品牌请先选“品牌特例”。</div>
    </div>
  </div>
</template>

<style scoped>
.rfbs-picker { width: 100%; position: relative; }
.rfbs-trigger { display: flex; align-items: center; width: 100%; min-height: 36px; border: 1px solid #d9deea; border-radius: 7px; background: #fff; }
.rfbs-trigger.opened { border-color: #7466ef; box-shadow: 0 0 0 2px #7466ef22; }
.rfbs-trigger input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 8px 10px; color: #303744; font: inherit; }
.rfbs-trigger input::placeholder { color: #a7afbd; }
.chevron { padding: 0 12px; color: #a7afbd; }
.rfbs-menu { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; width: min(760px, calc(100vw - 48px)); background: white; border: 1px solid #e3e6ef; border-radius: 8px; box-shadow: 0 12px 28px #15204722; }
.rfbs-toolbar, .rfbs-footer { display: flex; justify-content: space-between; padding: 8px 12px; color: #7b8496; font-size: 12px; }
.rfbs-toolbar button { border: 0; background: transparent; color: #6b5be8; cursor: pointer; }
.rfbs-columns { display: grid; grid-template-columns: 1fr 1fr 1fr; height: 292px; }
.rfbs-column { overflow-y: auto; border-right: 1px solid #edf0f5; padding: 5px; }
.rfbs-column:last-child { border-right: 0; }
.rfbs-column button { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; background: white; text-align: left; color: #343b49; cursor: pointer; font: inherit; font-size: 13px; }
.rfbs-column button:hover, .rfbs-column button.active { background: #f0edff; }
.rfbs-column button.recommended:not(.active) { color: #6b5be8; }
.band-column strong { white-space: nowrap; margin-left: 6px; }
.band-column p { padding: 8px; color: #8d95a4; font-size: 12px; }
.rfbs-error { margin: 4px 0 0; color: #d85050; font-size: 12px; }
@media (max-width: 700px) { .rfbs-menu { left: -140px; max-width: calc(100vw - 24px); } .rfbs-columns { height: 260px; } .rfbs-column button { font-size: 12px; padding: 7px 4px; } }
</style>
