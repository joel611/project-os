<script setup lang="ts">
import ScenarioCard from "./ScenarioCard.vue";
import type { LaneData } from "./ScenarioLane.vue";

type Scenario = {
  id: string;
  title: string;
  situation: string;
  oldWay: LaneData;
  newWay: LaneData;
};

const scenarios: Scenario[] = [
  {
    id: "scn-estimate",
    title: "A client asks for a PHP upgrade estimate",
    situation: "A client emails: how long would it take to move the site to a current PHP version?",
    oldWay: {
      lanes: ["Client", "Project manager", "Developer", "Coding agent"],
      steps: [
        [0, "email", "The client emails asking for an upgrade estimate.", []],
        [1, "reads", "The project manager reads it and can't answer alone.", ["PM"]],
        [
          2,
          "ping",
          "The project manager messages a developer, who stops what they were doing.",
          ["PM", "Dev"],
        ],
        [
          3,
          "open repo",
          "The developer opens the repo and asks their coding agent for the current version and the upgrade steps.",
          ["Dev"],
        ],
        [
          2,
          "findings",
          "The agent reports back and the developer turns it into an estimate.",
          ["Dev"],
        ],
        [
          1,
          "estimate",
          "The developer sends the estimate back to the project manager, who replies to the client.",
          ["Dev", "PM"],
        ],
      ],
    },
    newWay: {
      lanes: ["Client", "ProjectOS", "Team channel"],
      steps: [
        [0, "email", "The client's email arrives in the project inbox.", []],
        [
          1,
          "reads code",
          "ProjectOS reads the email, checks the source code and writes up findings and an estimate.",
          [],
        ],
        [
          2,
          "estimate",
          "ProjectOS posts the findings and estimate in the internal project channel. Nobody was pinged.",
          [],
        ],
      ],
    },
  },
  {
    id: "scn-decision",
    title: "Months later: why was it built this way?",
    situation:
      "The PM asked for a feature, developers discussed options and made a decision. A couple of months on, the team head asks why.",
    oldWay: {
      lanes: ["Team head", "Chat search", "Old threads"],
      steps: [
        [
          0,
          "why?",
          "Months later the team head asks why the feature was built that way.",
          ["Head"],
        ],
        [1, "keyword", "They search the chat room for a keyword they hope was used.", ["Head"]],
        [2, "thread 1", "They open the first hit and read through every message.", ["Head"]],
        [2, "thread 2", "It isn't the one. They scroll through the next thread.", ["Head"]],
        [1, "new keyword", "They try another keyword.", ["Head"]],
        [2, "thread 3", "More threads, more scrolling.", ["Head"]],
        [
          0,
          "maybe…",
          "They piece together an answer, if anyone still remembers who decided.",
          ["Head"],
        ],
      ],
    },
    newWay: {
      lanes: ["Team head", "ProjectOS"],
      steps: [
        [
          1,
          "digests",
          "ProjectOS actively reads the project channel and digests it into memory points.",
          [],
        ],
        [0, "why?", "Months later the team head asks why it was built that way.", ["Head"]],
        [1, "reads memory", "ProjectOS reads its memory and locates the history.", []],
        [
          0,
          "answer",
          "ProjectOS answers back to the team head with the reason and who decided.",
          [],
        ],
      ],
    },
  },
  {
    id: "scn-copy",
    title: "A simple copy update on the marketing site",
    situation: "The project manager wants one line of text changed on the marketing site.",
    oldWay: {
      lanes: ["Project manager", "Jira ticket", "Developer", "Claude Code", "Pull request"],
      steps: [
        [0, "new copy", "The project manager wants a line of marketing copy changed.", ["PM"]],
        [
          1,
          "ticket",
          "The project manager writes a Jira ticket and assigns it to a developer.",
          ["PM"],
        ],
        [2, "picked up", "The developer receives it and checks out the latest source.", ["Dev"]],
        [
          3,
          "implement",
          "The developer asks Claude Code on their own computer to make the change.",
          ["Dev"],
        ],
        [4, "PR", "The developer submits a pull request.", ["Dev"]],
        [2, "get link", "The developer gets the preview link from the pull request.", ["Dev"]],
        [
          0,
          "preview link",
          "The developer sends the preview link back to the project manager.",
          ["Dev"],
        ],
      ],
    },
    newWay: {
      lanes: ["Project manager", "ProjectOS", "Developer"],
      steps: [
        [0, "new copy", "The project manager asks ProjectOS in the project channel.", ["PM"]],
        [
          1,
          "builds PR",
          "ProjectOS makes the change and submits a PR. The pipeline deploys a preview.",
          [],
        ],
        [0, "preview link", "ProjectOS sends the preview link back to the project manager.", []],
        [
          2,
          "review",
          "The project manager asks a developer to review. The developer reads the CI result and approves.",
          ["PM", "Dev"],
        ],
      ],
    },
  },
];
</script>

<template>
  <section class="scenarios" aria-label="Three scenarios, old way versus ProjectOS">
    <h2>Same job, two ways</h2>
    <p class="lead">
      Three everyday requests, first the way most teams handle them today, then with ProjectOS.
    </p>
    <p class="legend">
      <span class="key"></span>a team member has to act <span class="key empty"></span>no team
      member needed. A round is one step a team member has to act in. Receiving a result doesn't
      count.
    </p>
    <ScenarioCard v-for="s in scenarios" :key="s.id" v-bind="s" />
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
.legend {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.key {
  display: inline-block;
  width: 14px;
  height: 12px;
  margin: 0 6px;
  border: 2px solid var(--vp-c-text-2);
  border-radius: 3px;
  background: var(--vp-c-text-2);
}
.key:first-child {
  margin-left: 0;
}
.key.empty {
  background: none;
}
</style>
