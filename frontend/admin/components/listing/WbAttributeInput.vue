<script setup>
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {wbValueLabel} from '../../../../src/shared/wb-display.js';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {wbAttributeDirectory,wbTemplateOptions} from '../../../../src/shared/wb-attribute-options.js';
const props=defineProps({attribute:{type:Object,required:true},modelValue:{default:undefined},subjectId:{type:Number,default:null},shopId:{type:Number,default:null}}),emit=defineEmits(['update:modelValue']);
const options=ref([]),loading=ref(false),loaded=ref(false),text=ref(''),error=ref(''),stale=ref(false);let sequence=0;
const directory=computed(()=>wbAttributeDirectory(props.attribute)),multiple=computed(()=>Number(props.attribute.maxCount)!==1);
const selected=computed(()=>multiple.value?(Array.isArray(props.modelValue)?props.modelValue:props.modelValue?[String(props.modelValue)]:[]):Array.isArray(props.modelValue)?props.modelValue[0]||'':props.modelValue||'');
watch(selected,value=>{if(!multiple.value)text.value=String(value||'');},{immediate:true});
function reset(){sequence++;loading.value=false;loaded.value=false;error.value='';stale.value=false;options.value=wbTemplateOptions(props.attribute);text.value=multiple.value?'':String(selected.value||'');}
watch(()=>[props.subjectId,props.shopId,props.attribute.charcID],reset,{immediate:true});
async function load(open,refresh=false){if(!Number.isSafeInteger(Number(props.subjectId))||Number(props.subjectId)<=0||!open||(!refresh&&loaded.value)||loading.value||Number(props.attribute.charcType)===4)return;const id=++sequence,scope=currentApiCacheScope();loading.value=true;error.value='';try{const r=await apiClient.get(`/api/wb/catalog/options?subject_id=${props.subjectId}&attribute_id=${props.attribute.charcID}&background=1${props.shopId?`&shop_id=${props.shopId}`:''}${refresh?'&refresh=1':''}`,{noCache:true});if(id!==sequence||scope!==currentApiCacheScope())return;options.value=r.options||(r.data||[]).map(value=>({value,label:wbValueLabel(value)}));stale.value=Boolean(r.cache?.stale);loaded.value=true;}catch(e){if(id===sequence&&scope===currentApiCacheScope())error.value=e.message;}finally{if(id===sequence)loading.value=false;}}
async function suggest(query,callback){const scope=currentApiCacheScope(),identity=[props.subjectId,props.shopId,props.attribute.charcID].join(':');await load(true);if(scope!==currentApiCacheScope()||identity!==[props.subjectId,props.shopId,props.attribute.charcID].join(':'))return callback([]);const keyword=String(query).toLowerCase();callback(options.value.filter(o=>o.value.toLowerCase().includes(keyword)||o.label.toLowerCase().includes(keyword)).slice(0,50).map(o=>({value:o.value,label:o.label})));}
function commit(value=text.value){const next=String(value).trim();if(!multiple.value){emit('update:modelValue',next);return;}if(!next)return;const values=[...selected.value];if(!values.includes(next)){const max=Number(props.attribute.maxCount);if(max>0&&values.length>=max){ElMessage.warning(`此属性最多填写 ${max} 个值。`);return;}values.push(next);emit('update:modelValue',values);}text.value='';}
function remove(value){emit('update:modelValue',selected.value.filter(item=>item!==value));}
onMounted(()=>{window.addEventListener('erp:auth-scope-changed',reset);if(directory.value&&props.modelValue!==undefined&&props.modelValue!==null&&String(props.modelValue)!=='')load(true);});
onBeforeUnmount(()=>{sequence++;window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <div class="wb-attribute-input" :data-directory="directory" :data-loaded="loaded" :data-loading="loading">
 <el-input-number v-if="Number(attribute.charcType)===4" :model-value="modelValue===undefined||modelValue===''?undefined:Number(modelValue)" :controls="false" @update:model-value="emit('update:modelValue',$event)"/>
 <el-select v-else-if="directory" :model-value="selected" :multiple="multiple" :multiple-limit="Number(attribute.maxCount)||0" filterable clearable collapse-tags collapse-tags-tooltip :loading="loading" placeholder="搜索并选择" @focus="load(true)" @visible-change="load" @update:model-value="emit('update:modelValue',$event)">
  <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value"/>
  <template #empty><span class="option-hint">{{loading?'正在获取选项…':error?'选项获取失败，请重试':'当前没有可选值，请刷新核对'}}</span></template>
 </el-select>
 <template v-else>
  <div v-if="multiple&&selected.length" class="text-values"><el-tag v-for="value in selected" :key="value" closable @close="remove(value)">{{wbValueLabel(value)}}</el-tag></div>
  <el-autocomplete v-model="text" :fetch-suggestions="suggest" :debounce="250" :trigger-on-focus="true" clearable :placeholder="'请输入'+String(attribute.name).split('/')[0]" @select="item=>commit(item.value)" @keyup.enter="commit()" @blur="commit()" @clear="!multiple&&commit('')">
   <template #default="{item}"><span>{{item.label}}</span></template>
  </el-autocomplete>
  <small v-if="multiple" class="option-hint">回车添加，可填写 {{Number(attribute.maxCount)>0?'最多 '+attribute.maxCount+' 个值':'多个值'}}</small>
 </template>
 <div v-if="error" class="option-warning">{{error}} <el-button link type="primary" @click="load(true,true)">重试</el-button></div>
 <div v-else-if="stale" class="option-hint">已显示上次选项，可刷新核对。<el-button link @click="load(true,true)">刷新</el-button></div>
 </div>
</template>
<style scoped>.wb-attribute-input{width:100%;min-width:0}.wb-attribute-input :deep(.el-select),.wb-attribute-input :deep(.el-autocomplete){width:100%}.option-hint{display:block;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.option-warning{color:var(--el-color-warning);font-size:12px}.text-values{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}.text-values :deep(.el-tag){max-width:100%}.text-values :deep(.el-tag__content){overflow:hidden;text-overflow:ellipsis}</style>
