<script setup>
defineProps({ name: { type: String, required: true } });
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g v-if="name === 'calculator'">
      <rect x="4" y="2" width="16" height="20" rx="3" /><path d="M7 6h10v4H7zM8 14h1m6 0h1m-8 4h1m6 0h1" />
    </g>
    <g v-else-if="name === 'exchange'">
      <path d="M3 7h17l-4-4M21 17H4l4 4M7 11l3 3 3-3m-3 3v4m-3-2h6" />
    </g>
    <g v-else-if="name === 'profit'">
      <path d="M3 20V5m0 15h18M7 15l5-5 4 3 5-7m-5 0h5v5" />
    </g>
    <g v-else-if="name === 'pricing'">
      <path d="M3 4h8l10 10-7 7L3 10V4Z" /><circle cx="7" cy="8" r="1" /><path d="m12 10 4 4m-5-1 2 2m0-5 3 3" />
    </g>
    <g v-else-if="name === 'appearance'">
      <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3c-.8-.9-.1-2.7 1.2-2.7H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z" /><circle cx="7.5" cy="10" r=".8" /><circle cx="11" cy="6.8" r=".8" /><circle cx="15.5" cy="7.8" r=".8" /><circle cx="6.8" cy="14.5" r=".8" />
    </g>
    <g v-else-if="name === 'messages'">
      <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 1.5-6A8 8 0 1 1 21 11Z" /><path d="M7 9h9m-9 4h6" />
    </g>
  </svg>
</template>
