<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { withImageToken } from '../../api/tools/imageCropper.js';
const props=defineProps({node:{type:Object,required:true},modelValue:{default:''},category:{type:Object,default:()=>({})},disabled:Boolean});
const emit=defineEmits(['update:modelValue','upload','options']);
const loading=ref(false);
async function loadOptions(keyword='') {
  if(!props.node.dictionaryId||loading.value)return;
  loading.value=true;
  try {
    const params=new URLSearchParams({description_category_id:props.category.descriptionCategoryId,type_id:props.category.typeId,attribute_id:props.node.attributeId,limit:60,keyword});
    const rows=await apiClient.get(`/api/listing/ozon-attribute-values?${params}`,{noCache:true});
    const options=new Map((props.node.options||[]).map(x=>[x.id,x]));
    for(const row of rows){const id=Number(row.dictionary_value_id||row.id);if(id)options.set(id,{id,label:row.display_value_zh||row.value_zh||row.label||row.value||row.name});}
    emit('options',[...options.values()]);
  }catch(error){ElMessage.error(error.message);}finally{loading.value=false;}
}
function remove(index){const next=[...(props.modelValue||[])];next[index]='';emit('update:modelValue',next);}
</script>
<template>
  <div v-if="node.type==='images'" class="workflow-upload-slots">
    <div v-for="(purpose,index) in node.slots" :key="index" class="upload-slot">
      <span>{{ index+1 }}. {{ purpose }}</span>
      <el-image v-if="modelValue?.[index]" :src="withImageToken(modelValue[index])" :preview-src-list="modelValue.filter(Boolean).map(withImageToken)" preview-teleported fit="contain"/>
      <input v-if="!disabled" type="file" accept="image/*" :aria-label="`${node.label} ${purpose}`" @change="emit('upload',$event.target.files?.[0],index);$event.target.value=''"/>
      <el-button v-if="modelValue?.[index]&&!disabled" text type="danger" @click="remove(index)">移除</el-button>
    </div>
  </div>
  <el-select v-else-if="node.type==='attribute'&&node.dictionaryId" :model-value="modelValue" :multiple="node.multiple" filterable remote :remote-method="loadOptions" :loading="loading" :disabled="disabled" placeholder="选择已核实的属性值" @update:model-value="emit('update:modelValue',$event)" @visible-change="$event&&loadOptions()">
    <el-option v-for="option in node.options||[]" :key="option.id" :label="option.label" :value="option.id"/>
  </el-select>
  <el-input v-else :model-value="modelValue" :disabled="disabled" :placeholder="node.help||'填写产品信息'" @update:model-value="emit('update:modelValue',$event)"/>
</template>
<style scoped>
.workflow-upload-slots{display:flex;flex-wrap:wrap;gap:12px}.upload-slot{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:210px}.upload-slot span{font-size:12px;color:var(--el-text-color-secondary)}.upload-slot .el-image{width:84px;height:112px;background:var(--el-fill-color-light)}.upload-slot input{max-width:100%;font-size:12px}.el-select{width:100%}
</style>
