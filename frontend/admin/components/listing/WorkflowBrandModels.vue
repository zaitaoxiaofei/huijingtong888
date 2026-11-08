<script setup>
import { computed, onMounted, ref } from 'vue';
import { apiClient } from '../../utils/api.js';
import DevelopmentCatalogEntryDialog from '../team/DevelopmentCatalogEntryDialog.vue';
const props=defineProps({modelValue:{type:Array,default:()=>[]},disabled:Boolean,allowAll:Boolean});
const emit=defineEmits(['update:modelValue']);
const brands=ref([]),loading=ref(false),error=ref(''),entry=ref(null);
const selectedBrands=computed(()=>props.modelValue.map(b=>b.brand));
async function load(){loading.value=true;error.value='';try{brands.value=(await apiClient.get('/api/ai-variant-lab/vehicle-catalog',{noCache:true})).brands||[];}catch(e){error.value='目录暂未加载，可重试或直接填写品牌和型号';}finally{loading.value=false;}}
function setBrands(names){emit('update:modelValue',names.map(brand=>props.modelValue.find(b=>b.brand===brand)||{brand,models:[],allModels:false}));}
function models(brand){return brands.value.find(b=>b.name===brand)?.models||[];}
function update(brand,changes){emit('update:modelValue',props.modelValue.map(b=>b.brand===brand?{...b,...changes}:b));}
async function saved(value){entry.value=null;await load();const next=props.modelValue.map(b=>({...b,models:[...b.models]}));let brand=next.find(b=>b.brand===value.brand);if(!brand){brand={brand:value.brand,models:[],allModels:false};next.push(brand);}if(value.model&&!brand.models.includes(value.model))brand.models.push(value.model);emit('update:modelValue',next);}

onMounted(load);
</script>
<template><div class="brand-models"><div class="binding-caption"><strong>品牌（可多选）</strong><el-button link type="primary" :disabled="disabled" @click="entry={kind:'brand'}">＋ 新增品牌</el-button></div><el-select :model-value="selectedBrands" multiple filterable allow-create default-first-option :disabled="disabled" :loading="loading" placeholder="搜索并选择多个品牌，目录没有时可直接输入" @change="setBrands"><el-option v-for="b in brands" :key="b.name" :value="b.name" :label="[b.nameZh,b.name].filter(Boolean).join(' · ')"/></el-select><div v-for="item in modelValue" :key="item.brand" class="brand-model-row"><div class="binding-caption"><strong>{{ item.brand }} · 型号</strong><el-button link :disabled="disabled" @click="entry={kind:'model',brand:item.brand}">＋ 新增型号</el-button></div><el-select :model-value="item.models" multiple filterable allow-create default-first-option :disabled="disabled||item.allModels" placeholder="勾选这个品牌的适用型号，支持多选" @change="update(item.brand,{models:$event})"><el-option v-for="m in models(item.brand)" :key="m.id||m.name" :value="m.name" :label="m.label||m.name"/></el-select><el-checkbox v-if="allowAll" :model-value="item.allModels" :disabled="disabled" @change="update(item.brand,{allModels:$event})">该品牌全部型号通用</el-checkbox></div><small v-if="error">{{ error }} <el-button link @click="load">重试</el-button></small><DevelopmentCatalogEntryDialog v-if="entry" :kind="entry.kind" :brand="entry.brand||''" :brands="brands" @close="entry=null" @saved="saved"/></div></template>
<style scoped>.binding-caption{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px}.binding-caption strong{font-size:13px}.brand-model-row{margin-top:14px;padding:12px;background:var(--el-fill-color-light);border-radius:6px}.el-select{width:100%}small{display:block;margin-top:8px;color:var(--el-color-warning)}</style>
