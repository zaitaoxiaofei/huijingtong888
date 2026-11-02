<script setup>
defineOptions({inheritAttrs:false});
defineProps({modelValue:Boolean,title:String,mode:{type:String,default:'form'}});
defineEmits(['update:modelValue']);
</script>
<template>
  <el-dialog v-bind="$attrs" :model-value="modelValue" :title="title" :class="['mobile-dialog',`mobile-dialog--${mode}`]" append-to-body :close-on-click-modal="false" @update:model-value="$emit('update:modelValue',$event)">
    <template v-if="$slots.header" #header="scope"><slot name="header" v-bind="scope"/></template>
    <div v-if="$slots.tools" class="mobile-dialog-tools"><slot name="tools"/></div>
    <div class="mobile-dialog-content"><slot/></div>
    <template v-if="$slots.footer" #footer><slot name="footer"/></template>
  </el-dialog>
</template>
