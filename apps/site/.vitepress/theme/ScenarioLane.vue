<script setup lang="ts">
import { computed } from "vue";

export type LaneNode = { icon: string; title: string; sub?: string };
export type LaneStep = { at: number; label: string; caption: string };

const props = defineProps<{
  kind: "old" | "new";
  heading: string;
  nodes: LaneNode[];
  steps: LaneStep[];
  step: number; // current step index, clamped by the parent
  finished: boolean;
  result: string;
  snap: boolean; // jump without transition (loop restart)
}>();

const ICON: Record<string, string> = {
  email:
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
  chat: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  brain:
    "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M12 5v13",
  cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
  terminal: "M4 17l6-6-6-6 M12 19h8",
  search: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.3-4.3",
  pr: "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  threads: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M8 9h8 M8 13h5",
};

const n = computed(() => props.nodes.length);
const current = computed(() => props.steps[props.step]!);
const visited = computed(() => {
  const seen = new Set<number>();
  for (let i = 0; i <= props.step; i++) seen.add(props.steps[i]!.at);
  return seen;
});
const left = computed(() => `${((current.value.at + 0.5) / n.value) * 100}%`);
</script>

<template>
  <div class="lane" :class="[kind, { finished }]">
    <div class="lane-head">
      <span class="lane-tag">{{ heading }}</span>
      <span class="lane-result" :class="{ on: finished }">{{ result }}</span>
    </div>
    <div class="lane-nodes" :style="{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }">
      <div
        v-for="(node, i) in nodes"
        :key="i"
        class="node"
        :class="{ on: current.at === i, seen: visited.has(i) }"
      >
        <span class="node-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path :d="ICON[node.icon]" /></svg>
        </span>
        <span class="node-title">{{ node.title }}</span>
        <span v-if="node.sub" class="node-sub">{{ node.sub }}</span>
      </div>
    </div>
    <div class="lane-track">
      <span
        v-for="(_, i) in nodes"
        :key="i"
        class="tick"
        :style="{ left: `${((i + 0.5) / n) * 100}%` }"
      />
      <span class="packet" :class="{ snap }" :style="{ left }">{{ current.label }}</span>
    </div>
    <p class="lane-caption" aria-live="off">{{ current.caption }}</p>
  </div>
</template>

<style scoped>
.lane {
  --accent: var(--vp-c-text-3);
  padding: 14px 16px 12px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}
.lane.new {
  --accent: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-soft);
}
.lane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.lane-tag {
  font:
    11px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.lane.new .lane-tag {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.lane-result {
  font-size: 12px;
  color: var(--vp-c-text-3);
  opacity: 0;
  transition: opacity 0.3s;
  text-align: right;
}
.lane-result.on {
  opacity: 1;
  color: var(--vp-c-text-2);
}
.lane.new .lane-result.on {
  color: var(--vp-c-success-1);
}
.lane-nodes {
  display: grid;
  gap: 8px;
}
.node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  text-align: center;
  transition:
    border-color 0.25s,
    background 0.25s;
}
.node.seen {
  border-color: var(--vp-c-text-3);
}
.node.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
  background: var(--vp-c-bg);
}
.node-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--vp-c-default-soft);
  transition: background 0.25s;
}
.node.on .node-icon {
  background: var(--accent);
}
.node-icon svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: var(--vp-c-text-1);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.node.on .node-icon svg {
  stroke: #fff;
}
.node-title {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--vp-c-text-1);
}
.node-sub {
  font:
    10px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  color: var(--vp-c-text-2);
  line-height: 1.2;
}
.lane-track {
  position: relative;
  height: 28px;
  margin-top: 6px;
}
.lane-track::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  border-top: 1.5px dashed var(--vp-c-divider);
}
.tick {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: var(--vp-c-text-3);
}
.packet {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  max-width: 44%;
  padding: 3px 10px;
  border-radius: 11px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: left 0.9s cubic-bezier(0.45, 0, 0.25, 1);
}
.lane.old .packet {
  background: #b9661a;
}
.packet.snap {
  transition: none;
}
.lane-caption {
  margin: 8px 0 0;
  min-height: 2.9em;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--vp-c-text-1);
}
@media (max-width: 640px) {
  .lane {
    padding: 12px 10px 10px;
  }
  .lane-nodes {
    gap: 4px;
  }
  .node {
    padding: 6px 2px;
  }
  .node-title {
    font-size: 10.5px;
  }
  .node-sub {
    display: none;
  }
  .packet {
    font-size: 10px;
    padding: 2px 7px;
    max-width: 52%;
  }
  .lane-caption {
    min-height: 4.4em;
    font-size: 13px;
  }
  .lane-head {
    flex-wrap: wrap;
    gap: 2px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .packet {
    transition: none;
  }
}
</style>
