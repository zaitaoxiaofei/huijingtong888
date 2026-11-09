<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { uploadListingMedia, withImageToken } from '../../api/tools/imageCropper.js';
import WorkflowCatalogInput from './WorkflowCatalogInput.vue';
import WorkflowMaterialInput from './WorkflowMaterialInput.vue';
const props=defineProps({seed:{type:Object,default:()=>({})}}),emit=defineEmits(['saved']);
const records=ref([]),brands=ref([]),keyword=ref(''),busy=ref(false),editor=ref(false),document=ref(null),form=ref({}),identity=ref('');
const imageNode=computed(()=>({id:'key_images',type:'images',label:'适配钥匙图片',count:Math.max(2,form.value.images?.length||0),slots:Array.from({length:Math.max(2,form.value.images?.length||0)},(_,i)=>i?'补充角度（选填）':'钥匙正面')}));
async function load(){busy.value=true;try{records.value=await apiClient.get(`/api/product-workflows/key-models?keyword=${encodeURIComponent(keyword.value)}`,{noCache:true});}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}}
async function catalog(){try{brands.value=(await apiClient.get('/api/ai-variant-lab/vehicle-catalog',{noCache:true})).brands||[];}catch(e){ElMessage.warning('目录暂未加载，可直接填写品牌和型号');}}
function edit(record){document.value=record||null;form.value=record?structuredClone(record.payload):{brand:'',model:'',label:'',notes:'',images:['','']};identity.value=record?`${form.value.brand} ${form.value.model}`:props.seed.model||'';
 if(!record){const match=brands.value.flatMap(b=>(b.models||[]).map(m=>({brand:b.name,...m}))).find(m=>m.fullName===identity.value);if(match){form.value.brand=match.brand;form.value.model=match.name;}if(props.seed.images)form.value.images=[...props.seed.images];}
 editor.value=true;
}
async function upload(file,index){if(!file)return;busy.value=true;const target=form.value;try{const r=await uploadListingMedia(file,{source_module:'product_workflow_key_library',role:'compatibility'}),url=r.publishUrl||r.url||r.previewUrl;if(!url)throw new Error('上传未返回图片地址，请重试');target.images[index]=url;}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}}
async function save(){busy.value=true;try{const saved=await apiClient.post('/api/product-workflows/key-models',{id:document.value?.id,revision:document.value?.revision,payload:form.value});editor.value=false;emit('saved',saved);await load();ElMessage.success('已保存为本企业适配资料');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}}
async function archive(record){try{await ElMessageBox.confirm('停用后新任务不再自动带入，已经生成的任务保留原资料。','停用适配资料',{confirmButtonText:'停用',cancelButtonText:'取消',type:'warning'});}catch{return;}busy.value=true;try{const saved=await apiClient.post('/api/product-workflows/key-models',{id:record.id,revision:record.revision,payload:{...record.payload,archived:true}});emit('saved',saved);await load();}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}}
onMounted(async()=>{keyword.value=props.seed.model||'';await Promise.all([load(),catalog()]);if(props.seed.create)edit();});
</script>
<template>
  <div class="key-library" v-loading="busy"><div class="library-toolbar"><el-input v-model="keyword" clearable placeholder="搜索品牌、型号或钥匙类型" @keyup.enter="load" @clear="load"/><el-button @click="load">搜索</el-button><el-button type="primary" @click="edit()">新增适配资料</el-button></div><p>按品牌、型号和钥匙类型保存企业资料。一个型号可以保存多种钥匙，生产时选择实际适配的类型。</p>
    <el-empty v-if="!records.length" description="还没有适配资料，上传一次后即可反复使用"/>
    <div class="key-cards"><article v-for="record in records" :key="record.id"><el-image :src="withImageToken(record.payload.images[0])" :preview-src-list="record.payload.images.map(withImageToken)" preview-teleported fit="contain"/><div><strong>{{ record.payload.brand }} {{ record.payload.model }}</strong><p>{{ record.payload.label }}</p><small>{{ record.payload.notes||'未添加说明' }}</small><div><el-button link type="primary" @click="edit(record)">编辑</el-button><el-button link type="danger" @click="archive(record)">停用</el-button></div></div></article></div>
    <el-dialog v-model="editor" append-to-body :title="document?'编辑钥匙适配资料':'新增钥匙适配资料'" width="620px" top="5vh" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy"><el-form label-position="top"><el-form-item label="绑定品牌 / 绑定型号" required><WorkflowCatalogInput v-model="identity" :brands="brands" :disabled="busy" @identity="Object.assign(form,$event)" @reload="catalog"/></el-form-item><el-form-item label="钥匙类型" required><el-input :disabled="busy" v-model="form.label" placeholder="例如：四键菱形、三键长条" maxlength="100"/></el-form-item><el-form-item label="适配钥匙图片" required><WorkflowMaterialInput v-model="form.images" compact :node="imageNode" :disabled="busy" @upload="upload"/></el-form-item><el-form-item label="适配说明"><el-input :disabled="busy" v-model="form.notes" type="textarea" :rows="2" placeholder="记录按键数量、年份或其他需核对的差异"/></el-form-item></el-form><template #footer><el-button :disabled="busy" @click="editor=false">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存到企业资料</el-button></template></el-dialog>
  </div>
</template>
<style scoped>
.library-toolbar{display:flex;gap:10px}.library-toolbar .el-input{max-width:380px}.key-library>p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.8}.key-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;max-height:60vh;overflow:auto}.key-cards article{display:flex;gap:16px;padding:16px;border:1px solid var(--el-border-color-lighter);border-radius:8px}.key-cards .el-image{width:90px;height:120px;flex-shrink:0;background:var(--el-fill-color-light)}.key-cards p{margin:8px 0}.key-cards small{display:block;margin-bottom:12px;color:var(--el-text-color-secondary)}
</style>
