<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// Same boxes, zones and arrows as how-it-works.svg, played as two looping stories:
// a Discord question answered by a cloud sandbox, then an email answered by a local PC.
type Hop = { id: string; rev?: boolean; label: string };
type Step = { caption: string; hops: Hop[]; nodes: string[]; tone?: "msg" | "ticket" | "reply" };
type Scenario = { title: string; steps: Step[] };

const EDGES: Record<string, string> = {
  discord: "M104 112 H114 Q120 112 120 106 V106 Q120 100 126 100 H162",
  email: "M104 192 H124 Q132 192 132 184 V132 Q132 124 140 124 H162",
  clsMem: "M300 112 H366",
  clsPi: "M232 152 V198",
  piTicket: "M304 240 H366",
  ticketMem: "M444 200 V154",
  ticketCf: "M520 240 H552 Q560 240 560 232 V136 Q560 128 568 128 H574",
  ticketLocal: "M520 262 H548 Q560 262 560 270 V282 Q560 288 568 288 H598",
};

const scenarios: Scenario[] = [
  {
    title: "A question in Discord, answered by a cloud sandbox",
    steps: [
      {
        caption: "Someone asks in a project channel on Discord.",
        hops: [{ id: "discord", label: "question" }],
        nodes: ["discord", "classifier"],
        tone: "msg",
      },
      {
        caption: "The classifier reads Project Memory to find the right project and context.",
        hops: [{ id: "clsMem", label: "context" }],
        nodes: ["classifier", "memory"],
      },
      {
        caption: "Pi Durable takes over and decides what to do.",
        hops: [{ id: "clsPi", label: "intent" }],
        nodes: ["classifier", "pi"],
      },
      {
        caption: "It opens a ticket in the ticket system.",
        hops: [{ id: "piTicket", label: "T-142" }],
        nodes: ["pi", "ticket"],
        tone: "ticket",
      },
      {
        caption: "A sandbox pulls the ticket and claims it. Workers are never pushed.",
        hops: [
          { id: "ticketCf", rev: true, label: "claim" },
          { id: "ticketCf", label: "T-142" },
        ],
        nodes: ["ticket", "cloudflare"],
        tone: "ticket",
      },
      {
        caption: "The Worker finishes. The result and new facts land in Project Memory.",
        hops: [
          { id: "ticketCf", rev: true, label: "done" },
          { id: "ticketMem", label: "memory" },
        ],
        nodes: ["cloudflare", "ticket", "memory"],
      },
      {
        caption: "Only the tower speaks: the answer goes back to the same Discord channel.",
        hops: [
          { id: "piTicket", rev: true, label: "answer" },
          { id: "clsPi", rev: true, label: "answer" },
          { id: "discord", rev: true, label: "answer" },
        ],
        nodes: ["ticket", "pi", "classifier", "discord"],
        tone: "reply",
      },
    ],
  },
  {
    title: "An email, answered by a Claude Code on a local PC",
    steps: [
      {
        caption: "A client emails the project inbox.",
        hops: [{ id: "email", label: "email" }],
        nodes: ["email", "classifier"],
        tone: "msg",
      },
      {
        caption: "The classifier checks Project Memory for what we already know.",
        hops: [{ id: "clsMem", label: "context" }],
        nodes: ["classifier", "memory"],
      },
      {
        caption: "Pi Durable takes over and decides what to do.",
        hops: [{ id: "clsPi", label: "intent" }],
        nodes: ["classifier", "pi"],
      },
      {
        caption: "It opens a ticket in the ticket system.",
        hops: [{ id: "piTicket", label: "T-143" }],
        nodes: ["pi", "ticket"],
        tone: "ticket",
      },
      {
        caption: "A teammate's local PC polls, pulls the ticket and starts working.",
        hops: [
          { id: "ticketLocal", rev: true, label: "claim" },
          { id: "ticketLocal", label: "T-143" },
        ],
        nodes: ["ticket", "local"],
        tone: "ticket",
      },
      {
        caption: "Claude, Codex or pi finishes and writes what it learned to Project Memory.",
        hops: [
          { id: "ticketLocal", rev: true, label: "done" },
          { id: "ticketMem", label: "memory" },
        ],
        nodes: ["local", "ticket", "memory"],
      },
      {
        caption: "The answer is sent back to the person who emailed.",
        hops: [
          { id: "piTicket", rev: true, label: "answer" },
          { id: "clsPi", rev: true, label: "answer" },
          { id: "email", rev: true, label: "answer" },
        ],
        nodes: ["ticket", "pi", "classifier", "email"],
        tone: "reply",
      },
    ],
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
const hotEdges = computed(() => new Set(current.value.step.hops.map((h) => h.id)));

const place = () => {
  const { step } = current.value;
  const n = step.hops.length;
  const slot = Math.min(n - 1, Math.floor(progress.value * n));
  const hop = step.hops[slot]!;
  const el = paths.get(hop.id);
  if (!el) return;
  const local = Math.min(1, Math.max(0, progress.value * n - slot));
  const eased = local < 0.5 ? 2 * local * local : 1 - (-2 * local + 2) ** 2 / 2;
  const len = el.getTotalLength();
  const pt = el.getPointAtLength((hop.rev ? 1 - eased : eased) * len);
  packet.value = {
    x: pt.x,
    y: pt.y,
    label: hop.label,
    tone: hop.rev && step.tone === "reply" ? "reply" : (step.tone ?? "ping"),
  };
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
</script>

<template>
  <section class="sysmap" aria-label="How project-os works, animated">
    <div class="sysmap-frame">
      <svg viewBox="0 0 760 400" role="img" aria-labelledby="sysmap-title sysmap-desc">
        <title id="sysmap-title">How project-os works</title>
        <desc id="sysmap-desc">
          A looping story. A question arrives through the Discord or email broker, the classifier
          reads Project Memory, Pi Durable opens a ticket, a cloud sandbox or a local PC pulls the
          ticket, finishes, writes to Project Memory, and the answer goes back the way it came.
        </desc>
        <defs>
          <marker
            id="sm-head"
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 Z" class="sm-head" />
          </marker>
        </defs>
        <rect width="760" height="400" rx="8" class="sm-bg" />
        <text x="340" y="28">Project OS</text>
        <text x="664" y="28">Cloud serverless sandbox</text>
        <rect class="sm-zone" x="144" y="40" width="400" height="344" rx="10" />
        <rect class="sm-zone sm-dashed" x="576" y="40" width="176" height="176" rx="10" />
        <rect class="sm-zone sm-dashed" x="576" y="232" width="176" height="152" rx="10" />

        <path
          v-for="(d, id) in EDGES"
          :key="id"
          :ref="(el) => el && paths.set(id, el as SVGPathElement)"
          :d="d"
          class="sm-arrow"
          :class="{ hot: hotEdges.has(id) }"
          marker-end="url(#sm-head)"
        />

        <g class="sm-node" :class="{ on: isActive('discord') }">
          <rect x="8" y="88" width="96" height="48" rx="8" />
          <text x="56" y="108">Discord</text>
          <text x="56" y="126">broker</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('email') }">
          <rect x="8" y="168" width="96" height="48" rx="8" />
          <text x="56" y="188">Email</text>
          <text x="56" y="206">broker</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('classifier') }">
          <rect x="164" y="72" width="136" height="80" rx="8" />
          <text x="232" y="117">Classifier</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('memory') }">
          <rect x="368" y="72" width="152" height="80" rx="8" />
          <text x="444" y="117">Project Memory</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('pi') }">
          <rect x="164" y="200" width="140" height="80" rx="8" />
          <text x="234" y="245">Pi Durable</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('ticket') }">
          <rect x="368" y="200" width="152" height="80" rx="8" />
          <text x="444" y="245">Ticket system</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('cloudflare') }">
          <rect x="600" y="64" width="128" height="64" rx="8" />
          <text x="664" y="92">Cloudflare</text>
          <text x="664" y="110">sandbox</text>
        </g>
        <g class="sm-node">
          <rect x="600" y="144" width="128" height="48" rx="8" />
          <text x="664" y="173">Boat.dev</text>
        </g>
        <g class="sm-node" :class="{ on: isActive('local') }">
          <rect x="600" y="264" width="128" height="48" rx="8" />
          <text x="664" y="293">Local PC</text>
        </g>
        <text x="664" y="352">Claude / Codex / pi</text>

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
    14px system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  fill: var(--vp-c-text-1);
  text-anchor: middle;
}
.sm-bg {
  fill: var(--vp-c-bg-soft);
}
.sm-zone {
  fill: none;
  stroke: var(--vp-c-text-2);
  stroke-width: 1.25;
}
.sm-dashed {
  stroke-dasharray: 6 5;
}
.sm-arrow {
  fill: none;
  stroke: var(--vp-c-text-3);
  stroke-width: 1.5;
  transition: stroke 0.3s;
}
.sm-arrow.hot {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
  stroke-dasharray: 6 5;
  animation: sm-march 0.7s linear infinite;
}
.sm-head {
  fill: var(--vp-c-text-3);
}
.sm-node rect {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-text-1);
  stroke-width: 1.25;
  transition:
    stroke 0.25s,
    fill 0.25s;
}
.sm-node.on rect {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2.25;
  fill: var(--vp-c-brand-soft);
}
.sm-packet rect {
  fill: var(--vp-c-brand-1);
}
.sm-packet text {
  fill: var(--vp-c-white);
  font-size: 11px;
  font-weight: 600;
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
    stroke-dashoffset: -11;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sm-arrow.hot {
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
  text {
    font-size: 15px;
  }
  .sm-packet text {
    font-size: 12px;
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
