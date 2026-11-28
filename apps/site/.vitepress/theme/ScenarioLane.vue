<script setup lang="ts">
import { computed } from "vue";

// Short tag shown in a step box for each team member who acts in it.
const WHO = { PM: "Project manager", Dev: "Developer", Head: "Team head" } as const;
export type Who = keyof typeof WHO;

// A step is: lane index, short label, caption, team members who act in it.
export type LaneStep = [at: number, label: string, caption: string, who: Who[]];
export type LaneData = { lanes: string[]; steps: LaneStep[] };

const props = defineProps<
  LaneData & {
    id: string;
    kind: "old" | "new";
    heading: string;
    title: string;
    step: number; // steps revealed so far, shared by both lanes
    playing: boolean; // false shows the complete diagram without a current step
  }
>();

const PERSON_LANES = new Set(["Client", "Project manager", "Developer", "Team head"]);
const ICON = "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
const HEAD = 72;
const ROW = 80;
const BOX_W = 72;
const BOX_H = 56;
const R = 6;

// Greedy word wrap for SVG text.
const wrap = (text: string) =>
  text.split(" ").reduce<string[]>((lines, word) => {
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length <= 11) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
    return lines;
  }, []);

const laneWidth = computed(() => (props.lanes.length > 3 ? 80 : 104));
const width = computed(() => props.lanes.length * laneWidth.value);
const height = computed(() => HEAD + props.steps.length * ROW);

const columns = computed(() =>
  props.lanes.map((name, i) => ({
    name,
    lines: wrap(name),
    x: i * laneWidth.value,
    person: PERSON_LANES.has(name),
    os: name === "ProjectOS",
  })),
);

const boxes = computed(() =>
  props.steps.map(([at, label, caption, who], i) => {
    const x = (at + 0.5) * laneWidth.value;
    const y = HEAD + i * ROW + 8;
    // One icon and tag per acting team member, centred along the bottom of the box.
    const widths = who.map((w) => 12 + w.length * 5.6);
    let left = x - (widths.reduce((a, b) => a + b, 0) + 5 * Math.max(0, who.length - 1)) / 2;
    const actors = who.map((tag, k) => {
      const actor = { tag, x: left };
      left += widths[k]! + 5;
      return actor;
    });
    return { x, y, caption, lines: wrap(label), actors };
  }),
);

// Orthogonal connector from the previous step into step i.
const link = (i: number) => {
  const from = boxes.value[i - 1]!;
  const to = boxes.value[i]!;
  const y1 = from.y + BOX_H;
  const y2 = to.y - 1;
  const mid = (y1 + y2) / 2;
  const d = Math.sign(to.x - from.x);
  if (!d) return `M${from.x} ${y1}V${y2}`;
  return `M${from.x} ${y1}V${mid - R}Q${from.x} ${mid} ${from.x + d * R} ${mid}H${to.x - d * R}Q${to.x} ${mid} ${to.x} ${mid + R}V${y2}`;
};

// A round is one step in which a team member acts.
const rounds = computed(() =>
  (Object.keys(WHO) as Who[])
    .map((key) => ({
      name: WHO[key],
      at: props.steps.flatMap((s, i) => (s[3].includes(key) ? [i + 1] : [])),
    }))
    .filter((r) => r.at.length),
);
</script>

<template>
  <section class="lane" :class="kind">
    <h4 class="tag">{{ heading }}</h4>
    <ul class="rounds">
      <li v-if="!rounds.length">
        <b>0</b>
        <span>rounds<small>no team member involved</small></span>
      </li>
      <li v-for="r in rounds" :key="r.name">
        <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path :d="ICON" /></svg>
        <b>{{ r.at.length }}</b>
        <span>
          {{ r.name }}
          <small
            >{{ r.at.length === 1 ? "round · step" : "rounds · steps" }}
            {{ r.at.join(", ") }}</small
          >
        </span>
      </li>
    </ul>

    <svg
      class="swim"
      :viewBox="`0 0 ${width} ${height}`"
      :style="{ maxWidth: `${width * 1.2}px` }"
      role="img"
      :aria-labelledby="`${id}-title ${id}-desc`"
    >
      <title :id="`${id}-title`">{{ title }}: {{ heading }}</title>
      <desc :id="`${id}-desc`">{{ steps.map((s) => s[2]).join(" ") }}</desc>
      <defs>
        <marker
          :id="`${id}-arrow`"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0L8 4L0 8z" class="arrow" />
        </marker>
      </defs>

      <template v-for="(col, i) in columns" :key="col.name">
        <rect
          v-if="col.person || col.os"
          :x="col.x"
          y="0"
          :width="laneWidth"
          :height="height"
          :class="col.os ? 'band-os' : 'band-person'"
        />
        <line v-if="i" :x1="col.x" y1="0" :x2="col.x" :y2="height" class="rule" />
        <g
          v-if="col.person"
          class="ico"
          :transform="`translate(${col.x + laneWidth / 2 - 10} 8) scale(${20 / 24})`"
        >
          <path :d="ICON" />
        </g>
        <text
          v-for="(line, k) in col.lines"
          :key="k"
          :x="col.x + laneWidth / 2"
          :y="42 + k * 13"
          class="name"
          :class="{ 'name-os': col.os }"
        >
          {{ line }}
        </text>
      </template>
      <line x1="0" :y1="HEAD - 6" :x2="width" :y2="HEAD - 6" class="rule" />

      <g
        v-for="(box, i) in boxes"
        :key="i"
        class="step"
        :class="{ acts: box.actors.length, hidden: i >= step, current: playing && i === step - 1 }"
      >
        <title>{{ i + 1 }}. {{ box.caption }}</title>
        <path v-if="i" :d="link(i)" class="link" :marker-end="`url(#${id}-arrow)`" />
        <rect :x="box.x - BOX_W / 2" :y="box.y" :width="BOX_W" :height="BOX_H" rx="6" />
        <text :x="box.x" :y="box.y + 13" class="num">{{ i + 1 }}</text>
        <text
          v-for="(line, k) in box.lines"
          :key="k"
          :x="box.x"
          :y="box.y + (box.lines.length > 1 ? 24 : 28) + k * 11"
        >
          {{ line }}
        </text>
        <template v-for="actor in box.actors" :key="actor.tag">
          <g
            class="ico"
            :transform="`translate(${actor.x} ${box.y + BOX_H - 15}) scale(${10 / 24})`"
          >
            <path :d="ICON" />
          </g>
          <text :x="actor.x + 12" :y="box.y + BOX_H - 7" class="who">{{ actor.tag }}</text>
        </template>
      </g>
    </svg>

    <details>
      <summary>Step captions</summary>
      <ol>
        <li v-for="(s, i) in steps" :key="i">{{ s[2] }}</li>
      </ol>
    </details>
  </section>
</template>

<style scoped>
.lane {
  --accent: var(--vp-c-warning-1);
  min-width: 0;
  padding: 10px 4px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
}
.lane.new {
  --accent: var(--vp-c-brand-1);
}
.tag {
  margin: 0;
  padding: 0 8px 8px;
  font: 600 12px var(--vp-font-family-mono);
  text-transform: uppercase;
  color: var(--accent);
}
.rounds {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
  min-height: 50px;
  margin: 0 0 12px;
  padding: 0 8px;
  list-style: none;
}
.rounds li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1.5px solid var(--accent);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.3;
}
.rounds b {
  font-size: 24px;
  color: var(--accent);
}
.rounds small {
  display: block;
  font-size: 11px;
  color: var(--vp-c-text-2);
}
.rounds .ico {
  width: 22px;
  height: 22px;
  color: var(--accent);
}
.swim {
  display: block;
  width: 100%;
  margin: auto;
}
.swim text {
  text-anchor: middle;
}
.ico {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--vp-c-text-1);
}
.band-person {
  fill: var(--vp-c-text-1);
  fill-opacity: 0.07;
}
.band-os {
  fill: var(--vp-c-brand-1);
  fill-opacity: 0.09;
}
.rule {
  stroke: var(--vp-c-divider);
}
.name {
  font-size: 11px;
  font-weight: 600;
  fill: var(--vp-c-text-1);
}
.name-os {
  font-size: 12px;
  fill: var(--vp-c-brand-1);
}
.link {
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.25;
}
.arrow {
  fill: var(--vp-c-text-2);
}
.step {
  transition:
    opacity 0.48s,
    transform 0.48s;
}
.step.hidden {
  opacity: 0.12;
  transform: translateY(8px);
}
.step rect {
  fill: var(--vp-c-bg);
  stroke: var(--accent);
  stroke-width: 1.5;
}
.step.acts rect {
  fill: var(--accent);
}
.step.current rect {
  stroke: var(--vp-c-text-1);
  stroke-width: 3;
}
.step text {
  font: 10px var(--vp-font-family-mono);
  fill: var(--vp-c-text-1);
}
.step .num {
  font-weight: 700;
  fill: var(--accent);
}
.step.acts text {
  fill: var(--vp-c-bg);
}
.step .who {
  text-anchor: start;
  font-size: 9px;
  font-weight: 700;
}
.step.acts .ico {
  color: var(--vp-c-bg);
}
details {
  padding: 8px 8px 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
summary {
  cursor: pointer;
}
ol {
  margin: 6px 0 0;
  padding-left: 20px;
  list-style: decimal;
}
@media (max-width: 760px) {
  .rounds {
    min-height: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .step {
    transition: none;
  }
}
@media print {
  .step.hidden {
    opacity: 1;
    transform: none;
  }
}
</style>
