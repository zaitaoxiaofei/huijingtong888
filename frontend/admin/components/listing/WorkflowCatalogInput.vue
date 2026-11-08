<script setup>
import { computed, ref, watch } from 'vue';
import DevelopmentCatalogEntryDialog from '../team/DevelopmentCatalogEntryDialog.vue';
const props=defineProps({modelValue:{type:String,default:''},brands:{type:Array,default:()=>[]},loading:Boolean,error:String,disabled:Boolean});
const emit=defineEmits(['update:modelValue','reload','identity']);
const brand=ref(''),model=ref(''),manual=ref(false),entry=ref(null);
const models=computed(()=>props.brands.find(b=>b.name===brand.value)?.models||[]);
const fullName=()=>[brand.value,model.value].filter(Boolean).join(' ').trim();
watch([()=>props.modelValue,()=>props.brands],([value],previous=[])=>{
  if(value===fullName()&&previous[1]===props.brands)return;
  if(!value){model.value='';return;}
  const match=props.brands.flatMap(b=>(b.models||[]).map(m=>({brand:b.name,...m}))).find(m=>m.fullName.toLocaleLowerCase()===value.toLocaleLowerCase());
  if(match){brand.value=match.brand;model.value=match.name;manual.value=false;}
  else{brand.value='';model.value=value;manual.value=true;}
},{immediate:true});
function update(){emit('update:modelValue',model.value.trim()?fullName():'');emit('identity',{brand:brand.value,model:model.value});}
function changeBrand(){model.value='';emit('update:modelValue','');emit('identity',{brand:brand.value,model:''});}
function saved(item){entry.value=null;brand.value=item.brand;model.value=item.model||'';manual.value=false;emit('reload');if(item.model)update();else emit('update:modelValue','');}
</script>
<template>
  <div class="catalog-input">
    <div v-if="!manual" class="catalog-selects">
      <div><div class="input-caption"><span>品牌</span><el-button link type="primary" :disabled="disabled" @click="entry={kind:'brand'}">＋ 新增</el-button></div><el-select v-model="brand" filterable clearable :loading="loading" :disabled="disabled" placeholder="搜索或选择品牌" aria-label="品牌" @change="changeBrand"><el-option v-for="b in brands" :key="b.name" :value="b.name" :label="[b.nameZh,b.name].filter(Boolean).join(' · ')"/></el-select></div>
      <div><div class="input-caption"><span>型号</span><el-button link type="primary" :disabled="disabled||!brand" @click="entry={kind:'model',brand}">＋ 新增</el-button></div><el-select v-model="model" filterable clearable :disabled="disabled||!brand" placeholder="搜索或选择型号" aria-label="型号" @change="update"><el-option v-for="m in models" :key="m.id||m.name" :value="m.name" :label="m.label||m.name"/></el-select></div>
    </div>
    <div v-else class="catalog-selects"><label>品牌<el-input v-model="brand" :disabled="disabled" placeholder="例如 JETOUR" aria-label="手动品牌" @input="update"/></label><label>型号<el-input v-model="model" :disabled="disabled" placeholder="填写型号或适配说明" aria-label="手动型号" @input="update"/></label></div>
    <div class="catalog-actions"><el-button link type="primary" :disabled="disabled" @click="manual=!manual">{{ manual?'返回目录选择':'找不到？直接填写' }}</el-button><span v-if="error" role="alert">目录加载失败，可直接填写 <el-button link @click="emit('reload')">重试</el-button></span></div>
    <DevelopmentCatalogEntryDialog v-if="entry" :kind="entry.kind" :brand="entry.brand||''" :brands="brands" @close="entry=null" @saved="saved"/>
  </div>
</template>
<style scoped>
.catalog-selects{display:grid;grid-template-columns:1fr 1fr;gap:16px}.catalog-selects label{display:grid;gap:8px}.input-caption{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.el-select{width:100%}.catalog-actions{display:flex;align-items:center;gap:12px;margin-top:8px;color:var(--el-text-color-secondary);font-size:12px}@media(max-width:600px){.catalog-selects{grid-template-columns:1fr}}
</style>
