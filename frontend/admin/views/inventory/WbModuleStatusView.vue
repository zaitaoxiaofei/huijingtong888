<script setup>
import {computed} from 'vue';import {useRoute} from 'vue-router';
const route=useRoute();
const info=computed(()=>route.name==='listing-publish-records'?{title:'尚无 WB 上架记录',text:'WB 商品目前保持草稿，尚未提交上架。正式发布开放后，这里展示 WB 的上架处理记录。'}:route.name==='batch-stock-update'?{title:'WB 批量改库存暂未开放',text:'WB 库存写入仍需完成店铺联调，当前不会修改平台库存。可继续在库存总览核对本地库存。'}:{title:'WB 店铺矩阵暂未接入',text:'当前店铺矩阵流程适用于 Ozon。WB 将独立适配，不会使用 Ozon 的模板或发布接口。'});
</script>
<template><el-result icon="info" :title="info.title" :sub-title="info.text"/></template>
