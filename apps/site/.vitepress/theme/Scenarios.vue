<script setup lang="ts">
import ScenarioCard, { type LaneData } from "./ScenarioCard.vue";

type Scenario = { title: string; situation: string; oldWay: LaneData; newWay: LaneData };

const scenarios: Scenario[] = [
  {
    title: "A client asks for a PHP upgrade estimate",
    situation: "A client emails: how long would it take to move the site to a current PHP version?",
    oldWay: {
      result: "4 hand-offs · a developer interrupted",
      nodes: [
        { icon: "email", title: "Client", sub: "email" },
        { icon: "user", title: "Project manager" },
        { icon: "user", title: "Developer" },
        { icon: "terminal", title: "Coding agent", sub: "local repo" },
      ],
      steps: [
        { at: 0, label: "email", caption: "The client emails asking for an upgrade estimate." },
        { at: 1, label: "reads", caption: "The project manager reads it and can't answer alone." },
        {
          at: 2,
          label: "ping",
          caption: "They message a developer, who stops what they were doing.",
        },
        {
          at: 3,
          label: "open repo",
          caption:
            "The developer opens the repo and asks their coding agent for the current version and the upgrade steps.",
        },
        {
          at: 2,
          label: "findings",
          caption: "The agent reports back and the developer turns it into an estimate.",
        },
        {
          at: 1,
          label: "estimate",
          caption:
            "The developer sends the estimate back to the project manager, who replies to the client.",
        },
      ],
    },
    newWay: {
      result: "0 people interrupted",
      nodes: [
        { icon: "email", title: "Client", sub: "email" },
        { icon: "brain", title: "Coordinator" },
        { icon: "cloud", title: "Worker", sub: "reads the code" },
        { icon: "chat", title: "Team channel", sub: "internal" },
      ],
      steps: [
        { at: 0, label: "email", caption: "The client's email arrives in the project inbox." },
        {
          at: 1,
          label: "ticket",
          caption: "project-os reads it, sees it needs the code, and opens a ticket.",
        },
        {
          at: 2,
          label: "reads code",
          caption:
            "A worker agent reads the source: current PHP version, deprecated calls, upgrade steps.",
        },
        {
          at: 1,
          label: "findings",
          caption: "The worker writes its findings and an estimate onto the ticket.",
        },
        {
          at: 3,
          label: "estimate",
          caption:
            "project-os posts the findings and estimate in the internal project channel. Nobody was pinged.",
        },
      ],
    },
  },
  {
    title: "Months later: why was it built this way?",
    situation:
      "The PM asked for a feature, developers discussed options and made a decision. A couple of months on, the team head asks why.",
    oldWay: {
      result: "hundreds of messages read",
      nodes: [
        { icon: "user", title: "Team head" },
        { icon: "search", title: "Chat search", sub: "keywords" },
        { icon: "threads", title: "Old threads", sub: "every message" },
      ],
      steps: [
        {
          at: 0,
          label: "why?",
          caption: "Months later the team head asks why the feature was built that way.",
        },
        {
          at: 1,
          label: "keyword",
          caption: "They search the chat room for a keyword they hope was used.",
        },
        {
          at: 2,
          label: "thread 1",
          caption: "They open the first hit and read through every message.",
        },
        {
          at: 2,
          label: "thread 2",
          caption: "It isn't the one. They scroll through the next thread.",
        },
        { at: 1, label: "new keyword", caption: "They try another keyword." },
        { at: 2, label: "thread 3", caption: "More threads, more scrolling." },
        {
          at: 0,
          label: "maybe…",
          caption: "They piece together an answer, if anyone still remembers who decided.",
        },
      ],
    },
    newWay: {
      result: "answered in seconds · cites who decided",
      nodes: [
        { icon: "chat", title: "Team channel" },
        { icon: "brain", title: "Coordinator" },
        { icon: "list", title: "Project Memory", sub: "decisions" },
      ],
      steps: [
        {
          at: 0,
          label: "discuss",
          caption:
            "The PM asks for a feature. Developers weigh solutions in the channel and decide.",
        },
        { at: 1, label: "decision", caption: "project-os notices the decision and who made it." },
        {
          at: 2,
          label: "saved",
          caption: "It saves a memory point: what was decided, why, and by whom.",
        },
        {
          at: 0,
          label: "why?",
          caption: "Months later the team head asks why it was built that way.",
        },
        { at: 1, label: "ask", caption: "The Coordinator takes the question." },
        {
          at: 2,
          label: "recall",
          caption: "It reads the memory point. No searching, no scrolling.",
        },
        { at: 1, label: "who", caption: "It has the reasoning and the person." },
        {
          at: 0,
          label: "answer",
          caption: "It replies in the channel with the reason and who decided.",
        },
      ],
    },
  },
  {
    title: "A simple copy update on the marketing site",
    situation: "The project manager wants one line of text changed on the marketing site.",
    oldWay: {
      result: "5 hand-offs · a developer's afternoon",
      nodes: [
        { icon: "user", title: "Project manager" },
        { icon: "list", title: "Jira ticket" },
        { icon: "user", title: "Developer", sub: "checks out latest" },
        { icon: "terminal", title: "Claude Code", sub: "on their laptop" },
        { icon: "pr", title: "Pull request" },
      ],
      steps: [
        {
          at: 0,
          label: "new copy",
          caption: "The project manager wants a line of marketing copy changed.",
        },
        {
          at: 1,
          label: "ticket",
          caption: "They write a Jira ticket and assign it to a developer.",
        },
        {
          at: 2,
          label: "picked up",
          caption: "The developer receives it and checks out the latest source.",
        },
        {
          at: 3,
          label: "implement",
          caption: "They ask Claude Code on their own computer to make the change.",
        },
        { at: 4, label: "PR", caption: "They submit a pull request." },
        {
          at: 0,
          label: "preview link",
          caption: "They send the preview link back to the project manager.",
        },
      ],
    },
    newWay: {
      result: "developer only reviews",
      nodes: [
        { icon: "threads", title: "Focus thread" },
        { icon: "brain", title: "Coordinator" },
        { icon: "cloud", title: "Shared worker" },
        { icon: "pr", title: "PR + preview", sub: "auto deploy" },
        { icon: "user", title: "Developer", sub: "reviews" },
      ],
      steps: [
        {
          at: 0,
          label: "new copy",
          caption: "The project manager asks the agent in the project channel.",
        },
        {
          at: 1,
          label: "classify",
          caption: "The Coordinator sees it is a development task and opens a focus thread.",
        },
        {
          at: 2,
          label: "ticket",
          caption: "It assigns the ticket to a shared worker, which makes the change.",
        },
        {
          at: 3,
          label: "PR",
          caption: "The worker submits the PR and the pipeline deploys a preview.",
        },
        {
          at: 2,
          label: "preview link",
          caption: "The worker reports the preview link back to the Coordinator.",
        },
        { at: 1, label: "preview link", caption: "The Coordinator picks it up." },
        {
          at: 0,
          label: "preview link",
          caption: "The Coordinator forwards the link to the focus thread.",
        },
        {
          at: 4,
          label: "review",
          caption:
            "The project manager asks a developer to review. They read the CI result and approve the change.",
        },
      ],
    },
  },
];
</script>

<template>
  <section class="scenarios" aria-label="Three scenarios, old way versus project-os">
    <h2>Same job, two ways</h2>
    <p class="lead">
      Three everyday requests, first the way most teams handle them today, then with project-os.
    </p>
    <ScenarioCard v-for="s in scenarios" :key="s.title" v-bind="s" />
  </section>
</template>

<style scoped>
.scenarios {
  max-width: 1152px;
  margin: 0 auto;
  padding: 24px 24px 32px;
}
h2 {
  margin: 0;
  border: none;
  padding: 0;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.lead {
  margin: 8px 0 20px;
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  .scenarios {
    padding: 16px 16px 24px;
  }
  h2 {
    font-size: 24px;
  }
}
</style>
