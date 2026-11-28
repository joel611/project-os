<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import SystemMap from "./SystemMap.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-after><SystemMap /></template>
  </Layout>
</template>
