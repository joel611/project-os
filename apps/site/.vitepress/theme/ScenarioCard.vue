<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ScenarioLane, { type LaneNode, type LaneStep } from "./ScenarioLane.vue";

export type LaneData = { nodes: LaneNode[]; steps: LaneStep[]; result: string };
const props = defineProps<{
  title: string;
  situation: string;
  oldWay: LaneData;
  newWay: LaneData;
}>();

const STEP_MS = 2200;
const HOLD = 3; // extra ticks to rest on the finished state before looping

const root = ref<HTMLElement | null>(null);
const t = ref(0);
const playing = ref(true);
const visible = ref(false);
const reduced = ref(false);
let timer = 0;
let observer: IntersectionObserver | undefined;

const longest = computed(() => Math.max(props.oldWay.steps.length, props.newWay.steps.length));
const lane = (data: LaneData) => {
  const last = data.steps.length - 1;
  return { step: Math.min(t.value, last), finished: t.value >= last };
};
const oldState = computed(() => lane(props.oldWay));
const newState = computed(() => lane(props.newWay));
const snap = computed(() => t.value === 0);

const advance = () => {
  t.value = (t.value + 1) % (longest.value + HOLD);
};
const sync = () => {
  window.clearInterval(timer);
  if (playing.value && visible.value && !reduced.value)
    timer = window.setInterval(advance, STEP_MS);
};
const toggle = () => {
  if (reduced.value) {
    // Reduced motion: step manually instead of auto-playing.
    advance();
    return;
  }
  playing.value = !playing.value;
  sync();
};
const replay = () => {
  t.value = 0;
  playing.value = !reduced.value;
  sync();
};

onMounted(() => {
  reduced.value = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced.value) {
    playing.value = false;
    t.value = longest.value - 1; // show the finished picture, steppable
  }
  observer = new IntersectionObserver(
    ([entry]) => {
      visible.value = !!entry?.isIntersecting;
      sync();
    },
    { threshold: 0.25 },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  observer?.disconnect();
});
</script>

<template>
  <article ref="root" class="scn">
    <header class="scn-head">
      <div>
        <h3>{{ title }}</h3>
        <p>{{ situation }}</p>
      </div>
      <div class="scn-ctl">
        <button
          type="button"
          :aria-label="reduced ? 'Next step' : playing ? 'Pause animation' : 'Play animation'"
          @click="toggle"
        >
          <svg v-if="reduced" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 5l8 7-8 7z M16 5h3v14h-3z" />
          </svg>
          <svg v-else-if="playing" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
        </button>
        <button type="button" aria-label="Replay from the start" @click="replay">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="stroke">
            <path d="M3 12a9 9 0 1 0 3-6.7 M3 4v5h5" />
          </svg>
        </button>
      </div>
    </header>
    <div class="scn-lanes">
      <ScenarioLane
        kind="old"
        heading="Old way"
        :nodes="oldWay.nodes"
        :steps="oldWay.steps"
        :step="oldState.step"
        :finished="oldState.finished"
        :result="oldWay.result"
        :snap="snap"
      />
      <ScenarioLane
        kind="new"
        heading="With project-os"
        :nodes="newWay.nodes"
        :steps="newWay.steps"
        :step="newState.step"
        :finished="newState.finished"
        :result="newWay.result"
        :snap="snap"
      />
    </div>
  </article>
</template>

<style scoped>
.scn {
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.scn + .scn {
  margin-top: 20px;
}
.scn-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
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
  gap: 8px;
  flex: none;
}
.scn-ctl button {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.scn-ctl button:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.scn-ctl button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.scn-ctl svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}
.scn-ctl svg.stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.scn-lanes {
  display: grid;
  gap: 12px;
}
@media (max-width: 640px) {
  .scn {
    padding: 14px 12px;
  }
}
</style>
