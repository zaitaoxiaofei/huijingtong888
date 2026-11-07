<script setup>
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import FinanceImportPanel from "../../components/finance/FinanceImportPanel.vue";
</script>
<template>
  <div class="page-stack"><el-card shadow="never"><ErpPageHeader title="报销中心" description="下载模板、填写上传、等待审批，随时查看处理结果。" /></el-card><el-card shadow="never"><FinanceImportPanel /></el-card></div>
</template>
