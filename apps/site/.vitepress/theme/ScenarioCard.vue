<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ScenarioLane, { type LaneData } from "./ScenarioLane.vue";

const props = defineProps<{
  id: string;
  title: string;
  situation: string;
  oldWay: LaneData;
  newWay: LaneData;
}>();

const STEP_MS = 1000;

const count = computed(() => Math.max(props.oldWay.steps.length, props.newWay.steps.length));
// Server render, no-JS and reduced motion all show the complete diagrams.
const step = ref(count.value);
const playing = ref(false);
const animated = ref(false); // playback controls are available
const started = ref(false); // false until playback leaves the initial frame
let timer = 0;

const pause = () => {
  window.clearTimeout(timer);
  playing.value = false;
};
const tick = () => {
  step.value++;
  if (step.value >= count.value) pause();
  else timer = window.setTimeout(tick, STEP_MS);
};
const play = () => {
  pause();
  if (step.value >= count.value) step.value = 0;
  started.value = true;
  playing.value = true;
  timer = window.setTimeout(tick, STEP_MS);
};
const go = (next: number) => {
  pause();
  started.value = true;
  step.value = Math.max(0, Math.min(count.value, next));
};
const replay = () => {
  step.value = 0;
  play();
};
const onVisibility = () => {
  if (document.visibilityState === "hidden") pause();
};

onMounted(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  animated.value = true;
  step.value = 0;
  document.addEventListener("visibilitychange", onVisibility);
});
onBeforeUnmount(() => {
  pause();
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>

<template>
  <article class="scn">
    <header class="scn-head">
      <h3>{{ title }}</h3>
      <p>{{ situation }}</p>
    </header>
    <div v-if="animated" class="scn-ctl" role="group" :aria-label="`Playback: ${title}`">
      <button type="button" :disabled="step === 0" @click="go(step - 1)">Previous</button>
      <button type="button" :aria-pressed="playing" @click="play">Play</button>
      <button type="button" :disabled="!playing" @click="pause">Pause</button>
      <button type="button" :disabled="step === count" @click="go(step + 1)">Next</button>
      <button type="button" @click="replay">Replay</button>
      <span>Step {{ step }} of {{ count }}</span>
    </div>
    <div class="scn-lanes">
      <ScenarioLane
        v-bind="oldWay"
        :id="`${id}-old`"
        kind="old"
        heading="Old way"
        :title="title"
        :step="step"
        :playing="started && step < count"
      />
      <ScenarioLane
        v-bind="newWay"
        :id="`${id}-new`"
        kind="new"
        heading="With ProjectOS"
        :title="title"
        :step="step"
        :playing="started && step < count"
      />
    </div>
  </article>
</template>

<style scoped>
.scn {
  padding: 16px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.scn + .scn {
  margin-top: 20px;
}
.scn-head {
  margin-bottom: 12px;
}
.scn-head h3 {
  margin: 0;
  border: none;
  padding: 0;
  font-size: 18px;
  line-height: 1.35;
  letter-spacing: 0;
}
.scn-head p {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.scn-ctl {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.scn-ctl button {
  min-width: 44px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}
.scn-ctl button:hover:enabled {
  border-color: var(--vp-c-brand-1);
}
.scn-ctl button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.scn-ctl button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.scn-lanes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  gap: 12px;
}
@media (max-width: 760px) {
  .scn-lanes {
    grid-template-columns: 1fr;
  }
}
@media print {
  .scn-ctl {
    display: none;
  }
}
</style>
