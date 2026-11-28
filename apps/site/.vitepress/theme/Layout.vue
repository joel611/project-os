<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import SystemMap from "./SystemMap.vue";
import Scenarios from "./Scenarios.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-after><SystemMap /><Scenarios /></template>
  </Layout>
</template>
