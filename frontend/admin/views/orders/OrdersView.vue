<script setup>
import { ref } from "vue";
import OrdersPage from "../../../orders/OrdersPage.vue";

const ordersPageRef = ref(null);
</script>

<template>
  <OrdersPage ref="ordersPageRef" />
</template>
