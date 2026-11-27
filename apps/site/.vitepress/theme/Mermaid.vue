<script setup lang="ts">
import { useData } from "vitepress";
import { onMounted, ref, useId, watch } from "vue";

// `code` is the URI-encoded source of a ```mermaid fence (see config.ts).
const props = defineProps<{ code: string }>();
const { isDark } = useData();
const id = `mermaid-${useId()}`;
const svg = ref("");

// Mermaid needs a DOM, so it loads and renders in the browser only.
async function render() {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark.value ? "dark" : "neutral",
    flowchart: { wrappingWidth: 300 },
  });
  svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
}

onMounted(() => {
  watch([isDark, () => props.code], render, { immediate: true });
});
</script>

<template>
  <div v-if="svg" class="mermaid-diagram" v-html="svg" />
  <!-- The source shows until the diagram renders, and stays if rendering fails. -->
  <pre v-else class="mermaid-diagram">{{ decodeURIComponent(code) }}</pre>
</template>

<style scoped>
.mermaid-diagram {
  margin: 16px 0;
  overflow-x: auto;
  text-align: center;
}

.mermaid-diagram :deep(svg) {
  margin: 0 auto;
}

/* Mermaid measures labels outside the page, so the page's paragraph styles would clip them. */
.mermaid-diagram :deep(p) {
  margin: 0;
  line-height: inherit;
}
</style>
