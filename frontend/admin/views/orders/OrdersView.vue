<script setup>
import { onMounted, ref } from "vue";
import OrdersPage from "../../../orders/OrdersPage.vue";

const ordersPageRef = ref(null);

onMounted(() => {
  ordersPageRef.value?.loadOrders?.();
});
</script>

<template>
  <OrdersPage ref="ordersPageRef" />
</template>
