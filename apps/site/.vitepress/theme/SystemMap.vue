<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// Simplified home-page schematic in the dashboard's "Schematic" style: channels -> Coordinator -> workers.
// Two looping stories: a Discord question answered by a cloud worker, an email answered by a local worker.
type Hop = { id: string; rev?: boolean; label: string };
type Step = {
  caption: string;
  stage: string;
  hops: Hop[];
  nodes: string[];
  chips: string[];
  waiting: number;
  pill: string;
  ramp?: boolean;
  done?: boolean;
  tone?: "msg" | "ticket" | "reply";
};
type Scenario = {
  title: string;
  channel: "discord" | "email";
  worker: "cloud" | "local";
  ticket: string;
  steps: Step[];
};

const EDGES: Record<string, string> = {
  discord: "M158 80 C204 80 204 120 250 120",
  email: "M158 200 C204 200 204 160 250 160",
  cloud: "M510 120 C555 120 555 80 600 80",
  local: "M510 160 C555 160 555 200 600 200",
};

const story = (channel: "discord" | "email", worker: "cloud" | "local", id: string): Step[] => [
  {
    caption:
      channel === "discord"
        ? "Someone asks in a project channel on Discord."
        : "A client emails the project inbox.",
    stage: "Message received",
    hops: [{ id: channel, label: channel === "discord" ? "question" : "email" }],
    nodes: [channel, "coord"],
    chips: [],
    waiting: 0,
    pill: "idle",
    tone: "msg",
  },
  {
    caption:
      "The Coordinator classifies it and opens a ticket. It reads Project Memory for context.",
    stage: `Classified · ${id} open`,
    hops: [],
    nodes: ["coord"],
    chips: ["classify", "tickets", "memory"],
    waiting: 1,
    pill: "idle",
  },
  {
    caption:
      worker === "cloud"
        ? "A cloud worker pulls the ticket and claims it. Workers are never pushed."
        : "A teammate's local worker polls, pulls the ticket and claims it.",
    stage: `${id} claimed`,
    hops: [
      { id: worker, rev: true, label: "claim" },
      { id: worker, label: id },
    ],
    nodes: ["coord", worker],
    chips: ["tickets"],
    waiting: 1,
    pill: "claiming",
    tone: "ticket",
  },
  {
    caption: "The worker does the job and reads Project Memory through MCP.",
    stage: `${id} in progress`,
    hops: [],
    nodes: [worker],
    chips: ["memory"],
    waiting: 0,
    pill: "in_progress",
    ramp: true,
  },
  {
    caption: "It reports back. The result and new facts land in the ticket and Project Memory.",
    stage: `${id} completed`,
    hops: [{ id: worker, rev: true, label: "result" }],
    nodes: [worker, "coord"],
    chips: ["tickets", "memory"],
    waiting: 0,
    pill: "done",
    done: true,
    tone: "ticket",
  },
  {
    caption: "Only the Coordinator speaks outside: the answer goes back to the same channel.",
    stage: "Reply posted",
    hops: [{ id: channel, rev: true, label: "answer" }],
    nodes: ["coord", channel],
    chips: [],
    waiting: 0,
    pill: "idle",
    tone: "reply",
  },
];

const scenarios: Scenario[] = [
  {
    title: "A question in Discord, answered by a cloud worker",
    channel: "discord",
    worker: "cloud",
    ticket: "T-142",
    steps: story("discord", "cloud", "T-142"),
  },
  {
    title: "An email, answered by a local worker",
    channel: "email",
    worker: "local",
    ticket: "T-143",
    steps: story("email", "local", "T-143"),
  },
];

const STEP_MS = 2400;
const flat = scenarios.flatMap((s, si) => s.steps.map((step, i) => ({ step, si, i })));

const reduced = ref(false);
const playing = ref(true);
const index = ref(0);
const progress = ref(0); // 0..1 within the current step
const paths = new Map<string, SVGPathElement>();
const packet = ref<{ x: number; y: number; label: string; tone: string } | null>(null);

const current = computed(() => flat[index.value]!);
const scenario = computed(() => scenarios[current.value.si]!);
const isActive = (node: string) => current.value.step.nodes.includes(node);
const chipOn = (chip: string) => current.value.step.chips.includes(chip);
const hotEdges = computed(() => new Set(current.value.step.hops.map((h) => h.id)));

type WorkerState = { pill: string; progress: number };
const workerOf = (which: "cloud" | "local"): WorkerState => {
  if (scenario.value.worker !== which)
    return { pill: which === "local" ? "polling" : "idle", progress: 0 };
  const { step } = current.value;
  const pill = step.pill === "idle" && which === "local" ? "polling" : step.pill;
  const prog = step.done ? 1 : step.ramp ? Math.min(1, progress.value * 1.1) : 0;
  return { pill, progress: prog };
};
const cloud = computed(() => workerOf("cloud"));
const local = computed(() => workerOf("local"));

const place = () => {
  const { step } = current.value;
  const n = step.hops.length;
  if (n === 0) {
    packet.value = null;
    return;
  }
  const slot = Math.min(n - 1, Math.floor(progress.value * n));
  const hop = step.hops[slot]!;
  const el = paths.get(hop.id);
  if (!el) return;
  const part = Math.min(1, Math.max(0, progress.value * n - slot));
  const eased = part < 0.5 ? 2 * part * part : 1 - (-2 * part + 2) ** 2 / 2;
  const pt = el.getPointAtLength((hop.rev ? 1 - eased : eased) * el.getTotalLength());
  const tone = hop.rev && step.tone === "reply" ? "reply" : (step.tone ?? "ping");
  packet.value = { x: pt.x, y: pt.y, label: hop.label, tone };
};

let raf = 0;
let last = 0;
const tick = (now: number) => {
  const dt = last ? now - last : 0;
  last = now;
  if (playing.value) {
    progress.value += dt / STEP_MS;
    if (progress.value >= 1) {
      progress.value = 0;
      index.value = (index.value + 1) % flat.length;
    }
    place();
  }
  raf = requestAnimationFrame(tick);
};

const goto = (si: number, i: number) => {
  index.value = flat.findIndex((f) => f.si === si && f.i === i);
  progress.value = reduced.value ? 1 : 0;
  place();
};
const toggle = () => {
  playing.value = !playing.value;
  last = 0;
};

onMounted(() => {
  reduced.value = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced.value) {
    playing.value = false;
    progress.value = 1;
  }
  place();
  raf = requestAnimationFrame(tick);
});
onBeforeUnmount(() => cancelAnimationFrame(raf));

const ICON = {
  discord: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
  email:
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
  brain:
    "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M12 5v13",
  cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
  laptop:
    "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16",
};
const chips = [
  { id: "classify", label: "Classify", x: 266, w: 64 },
  { id: "tickets", label: "Tickets", x: 334, w: 58 },
  { id: "memory", label: "Memory", x: 396, w: 60 },
];
</script>

<template>
  <section class="sysmap" aria-label="How project-os works, animated">
    <div class="sysmap-frame">
      <svg viewBox="0 0 760 290" role="img" aria-labelledby="sysmap-title sysmap-desc">
        <title id="sysmap-title">How project-os works</title>
        <desc id="sysmap-desc">
          A looping story. A question arrives from Discord or email. The Coordinator classifies it,
          opens a ticket and reads Project Memory. A cloud worker or a local worker pulls the
          ticket, does the job and reports back. The Coordinator sends the answer to the same
          channel.
        </desc>
        <defs>
          <pattern id="sm-dots" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" class="sm-dot" />
          </pattern>
        </defs>
        <rect width="760" height="290" class="sm-bg" />
        <rect width="760" height="290" fill="url(#sm-dots)" />

        <path
          v-for="(d, id) in EDGES"
          :key="id"
          :ref="(el) => el && paths.set(id, el as SVGPathElement)"
          :d="d"
          class="sm-edge"
          :class="{ hot: hotEdges.has(id) }"
        />

        <!-- Channels -->
        <g class="sm-card" :class="{ on: isActive('discord') }">
          <rect x="8" y="48" width="150" height="64" rx="10" />
          <rect x="20" y="64" width="32" height="32" rx="8" class="sm-tile discord" />
          <g class="sm-icon white" transform="translate(27 71) scale(0.75)">
            <path :d="ICON.discord" />
          </g>
          <text x="64" y="77" class="sm-title">Discord</text>
          <text x="64" y="93" class="sm-sub">channels</text>
        </g>
        <g class="sm-card" :class="{ on: isActive('email') }">
          <rect x="8" y="168" width="150" height="64" rx="10" />
          <rect x="20" y="184" width="32" height="32" rx="8" class="sm-tile email" />
          <g class="sm-icon white" transform="translate(27 191) scale(0.75)">
            <path :d="ICON.email" />
          </g>
          <text x="64" y="197" class="sm-title">Email</text>
          <text x="64" y="213" class="sm-sub">inbox</text>
        </g>

        <!-- Coordinator -->
        <g class="sm-card coord" :class="{ on: isActive('coord') }">
          <rect x="250" y="40" width="260" height="200" rx="14" />
          <rect x="266" y="56" width="36" height="36" rx="9" class="sm-tile accent" />
          <g class="sm-icon white" transform="translate(275 65) scale(0.75)">
            <path :d="ICON.brain" />
          </g>
          <text x="312" y="72" class="sm-title big">Coordinator</text>
          <text x="312" y="88" class="sm-sub">speaks to the outside</text>
          <g v-for="c in chips" :key="c.id">
            <rect
              :x="c.x"
              y="108"
              :width="c.w"
              height="22"
              rx="6"
              class="sm-chip"
              :class="{ on: chipOn(c.id) }"
            />
            <text :x="c.x + c.w / 2" y="123" class="sm-chiptext" :class="{ on: chipOn(c.id) }">
              {{ c.label }}
            </text>
          </g>
          <line x1="266" x2="494" y1="146" y2="146" class="sm-rule" />
          <text x="266" y="170" class="sm-stage">{{ current.step.stage }}</text>
          <text x="266" y="192" class="sm-sub">{{ current.step.waiting }} waiting for pull</text>
        </g>
        <g v-if="current.step.waiting" class="sm-queue">
          <rect x="250" y="252" width="62" height="22" rx="6" />
          <text x="281" y="267">{{ scenario.ticket }}</text>
        </g>

        <!-- Workers -->
        <g class="sm-card" :class="{ on: isActive('cloud') }">
          <rect x="600" y="30" width="152" height="100" rx="10" />
          <rect x="612" y="42" width="30" height="30" rx="8" class="sm-tile soft" />
          <g class="sm-icon" transform="translate(618.5 48.5) scale(0.7)">
            <path :d="ICON.cloud" />
          </g>
          <text x="652" y="61" class="sm-title">Cloud worker</text>
          <text x="612" y="88" class="sm-sub">Cloudflare / Boat.dev</text>
          <rect
            x="612"
            y="96"
            width="80"
            height="18"
            rx="9"
            class="sm-pill"
            :class="`st-${cloud.pill}`"
          />
          <text x="652" y="109" class="sm-pilltext" :class="`st-${cloud.pill}`">
            {{ cloud.pill }}
          </text>
          <rect x="612" y="120" width="128" height="4" rx="2" class="sm-track" />
          <rect x="612" y="120" :width="128 * cloud.progress" height="4" rx="2" class="sm-prog" />
        </g>
        <g class="sm-card" :class="{ on: isActive('local') }">
          <rect x="600" y="150" width="152" height="100" rx="10" />
          <rect x="612" y="162" width="30" height="30" rx="8" class="sm-tile soft" />
          <g class="sm-icon" transform="translate(618.5 168.5) scale(0.7)">
            <path :d="ICON.laptop" />
          </g>
          <text x="652" y="181" class="sm-title">Local worker</text>
          <text x="612" y="208" class="sm-sub">Claude / Codex / pi</text>
          <rect
            x="612"
            y="216"
            width="80"
            height="18"
            rx="9"
            class="sm-pill"
            :class="`st-${local.pill}`"
          />
          <text x="652" y="229" class="sm-pilltext" :class="`st-${local.pill}`">
            {{ local.pill }}
          </text>
          <rect x="612" y="240" width="128" height="4" rx="2" class="sm-track" />
          <rect x="612" y="240" :width="128 * local.progress" height="4" rx="2" class="sm-prog" />
        </g>

        <g
          v-if="packet"
          class="sm-packet"
          :class="`tone-${packet.tone}`"
          :transform="`translate(${packet.x} ${packet.y})`"
        >
          <rect x="-26" y="-11" width="52" height="22" rx="11" />
          <text y="4">{{ packet.label }}</text>
        </g>
      </svg>
    </div>

    <div class="sysmap-caption">
      <button
        class="sysmap-play"
        type="button"
        :aria-label="playing ? 'Pause animation' : 'Play animation'"
        @click="toggle"
      >
        <svg v-if="playing" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
      </button>
      <div class="sysmap-text">
        <span class="sysmap-kicker">{{ scenario.title }}</span>
        <p aria-live="off">{{ current.step.caption }}</p>
      </div>
      <ol class="sysmap-dots" aria-label="Steps">
        <li v-for="(_, i) in scenario.steps" :key="i">
          <button
            type="button"
            :class="{ on: i === current.i, done: i < current.i }"
            :aria-label="`Step ${i + 1}`"
            :aria-current="i === current.i"
            @click="goto(current.si, i)"
          />
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.sysmap {
  max-width: 1152px;
  margin: 0 auto;
  padding: 8px 24px 32px;
}
.sysmap-frame {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
svg {
  display: block;
  width: 100%;
  height: auto;
  max-width: 880px;
  margin: 0 auto;
}
text {
  font:
    13px system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  fill: var(--vp-c-text-1);
}
.sm-bg {
  fill: var(--vp-c-bg-soft);
}
.sm-dot {
  fill: var(--vp-c-divider);
}
.sm-edge {
  fill: none;
  stroke: var(--vp-c-text-3);
  stroke-width: 1.5;
  opacity: 0.6;
  transition: stroke 0.3s;
}
.sm-edge.hot {
  stroke: var(--vp-c-brand-1);
  opacity: 1;
  stroke-width: 2;
  stroke-dasharray: 5 5;
  animation: sm-march 0.7s linear infinite;
}
.sm-card > rect:first-child {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-divider);
  stroke-width: 1;
  transition:
    stroke 0.25s,
    stroke-width 0.25s;
}
.sm-card.on > rect:first-child {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
}
.sm-card.coord > rect:first-child {
  stroke-width: 1.5;
}
.sm-title {
  font-size: 13.5px;
  font-weight: 600;
}
.sm-title.big {
  font-size: 16px;
}
.sm-sub {
  font:
    10.5px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  fill: var(--vp-c-text-2);
}
.sm-stage {
  font:
    12px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  fill: var(--vp-c-text-1);
}
.sm-tile {
  stroke: none;
}
.sm-tile.discord {
  fill: #5865d8;
}
.sm-tile.email {
  fill: #b9661a;
}
.sm-tile.accent {
  fill: var(--vp-c-brand-1);
}
.sm-tile.soft {
  fill: var(--vp-c-default-soft);
}
.sm-icon path {
  fill: none;
  stroke: var(--vp-c-text-1);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sm-icon.white path {
  stroke: #fff;
}
.sm-chip {
  fill: var(--vp-c-default-soft);
  transition: fill 0.2s;
}
.sm-chip.on {
  fill: var(--vp-c-brand-1);
}
.sm-chiptext {
  font:
    10.5px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  fill: var(--vp-c-text-2);
  text-anchor: middle;
}
.sm-chiptext.on {
  fill: var(--vp-c-white);
}
.sm-rule {
  stroke: var(--vp-c-divider);
}
.sm-queue rect {
  fill: none;
  stroke: #1d8fa3;
  stroke-dasharray: 3 2;
}
.sm-queue text {
  font:
    10.5px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  fill: #1d8fa3;
  text-anchor: middle;
}
.sm-pill {
  fill: none;
  stroke: var(--vp-c-text-3);
  stroke-width: 1;
}
.sm-pilltext {
  font:
    10.5px ui-monospace,
    "SF Mono",
    Menlo,
    monospace;
  fill: var(--vp-c-text-2);
  text-anchor: middle;
}
.sm-pill.st-in_progress,
.sm-pill.st-claiming {
  stroke: var(--vp-c-warning-1);
}
.sm-pilltext.st-in_progress,
.sm-pilltext.st-claiming {
  fill: var(--vp-c-warning-1);
}
.sm-pill.st-done {
  stroke: var(--vp-c-success-1);
}
.sm-pilltext.st-done {
  fill: var(--vp-c-success-1);
}
.sm-track {
  fill: var(--vp-c-default-soft);
}
.sm-prog {
  fill: var(--vp-c-warning-1);
}
.sm-packet rect {
  fill: var(--vp-c-brand-1);
}
.sm-packet text {
  fill: var(--vp-c-white);
  font-size: 11px;
  font-weight: 600;
  text-anchor: middle;
}
.sm-packet.tone-ticket rect {
  fill: #1d8fa3;
}
.sm-packet.tone-reply rect {
  fill: #2e9b5f;
}
.sm-packet.tone-msg rect {
  fill: #5865d8;
}
@keyframes sm-march {
  to {
    stroke-dashoffset: -10;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sm-edge.hot {
    animation: none;
  }
}

.sysmap-caption {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}
.sysmap-play {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.sysmap-play:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.sysmap-play svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}
.sysmap-text {
  flex: 1;
  min-width: 0;
}
.sysmap-kicker {
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.sysmap-text p {
  margin: 2px 0 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  min-height: 3em;
}
.sysmap-dots {
  display: flex;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.sysmap-dots button {
  width: 10px;
  height: 10px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--vp-c-text-3);
  background: transparent;
  cursor: pointer;
}
.sysmap-dots button.done {
  background: var(--vp-c-text-3);
}
.sysmap-dots button.on {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .sysmap {
    padding: 4px 16px 24px;
  }
  .sysmap-caption {
    flex-wrap: wrap;
  }
  .sysmap-dots {
    width: 100%;
    justify-content: center;
  }
}
</style>
