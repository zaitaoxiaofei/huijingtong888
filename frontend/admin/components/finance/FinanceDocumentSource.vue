<script setup>
import {computed} from 'vue';
import {financeDocumentLocation} from '../../../../src/shared/finance-document-locations.js';
const props=defineProps({document:{type:Object,required:true}});
const location=computed(()=>props.document.source_location?.path?props.document.source_location:financeDocumentLocation(props.document));
</script>
<template><div class="document-location" :title="[location.method,location.document_id?'平台单据 '+location.document_id:''].filter(Boolean).join(' · ')">{{location.path}}</div></template>
<style scoped>.document-location{white-space:normal;overflow-wrap:anywhere;line-height:1.5;font-size:12px;color:var(--el-text-color-regular);}.document-location small{display:block;color:var(--el-text-color-secondary);}</style>
