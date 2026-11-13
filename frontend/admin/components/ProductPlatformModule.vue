<script setup>
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import MarketplaceSwitcher from './MarketplaceSwitcher.vue';
import {useAuthStore} from '../stores/auth.js';
import {canAccessPage} from '../../../src/shared/permissions.js';
const props=defineProps({ozon:{type:[Object,Function],required:true},wb:{type:[Object,Function],required:true},module:{type:String,required:true},wbPath:{type:String,default:'/wb/listing'}});
const route=useRoute(),router=useRouter(),auth=useAuthStore(),platform=ref(route.query.platform==='wb'?'wb':'ozon'),generation=ref(0);
const wbAllowed=computed(()=>canAccessPage(auth.user,props.wbPath));
watch([()=>route.query.platform,()=>route.query.wbDraftId],()=>{if(route.query.platform==="wb")platform.value="wb";});
function reset(){generation.value++;platform.value='ozon';}
onMounted(()=>{window.addEventListener('erp:auth-scope-changed',reset);if(route.name==='listing-automation'&&route.query.platform==='wb'&&!route.query.workbenchId)router.replace({query:{...route.query,workbenchId:crypto.randomUUID()}}).catch(()=>{});});onBeforeUnmount(()=>window.removeEventListener('erp:auth-scope-changed',reset));
</script>
<template><div class="product-platform-module"><div class="platform-tabs"><MarketplaceSwitcher v-model="platform" :label="module+'平台'"/></div><div class="platform-content"><KeepAlive :key="generation" :max="4"><component v-if="platform==='ozon'" :is="ozon" key="ozon"/><component v-else-if="wbAllowed" :is="wb" :key="'wb:'+(route.query.wbDraftId||'new')"/></KeepAlive><el-result v-if="platform==='wb'&&!wbAllowed" icon="info" title="当前账号没有此 WB 模块的访问权限" sub-title="请联系企业管理员核对岗位权限。"/></div></div></template>
<style scoped>.product-platform-module{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}.platform-tabs{flex:none;padding:0 0 12px}.platform-content{flex:1;min-height:0;overflow:auto}.platform-content>:deep(.copy-page){height:100%}</style>
