import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { env, envNumber } from "@project-os/config";
import { fakeInbound, fakePromptClick, type FakeSpeaker } from "./fake.ts";
import { forwardInbound } from "./forward.ts";
import { answerPromptClick, type ActionRow } from "./prompts.ts";
import { createReplyApp } from "./reply.ts";

// Stand-in for the Discord adapter: no gateway, no token. It takes the adapter's place on
// the reply port (DISCORD_SPLIT_GATEWAY_URL must point here), speaks to the Coordinator's /inbound,
// and prints what the Coordinator would have posted to Discord.
const { values } = parseArgs({
  options: {
    channel: { type: "string", default: "fake-chan-1" },
    thread: { type: "string" },
    user: { type: "string", default: "fake-user-1" },
    name: { type: "string", default: "Fake User" },
    say: { type: "string" },
    wait: { type: "string", default: "60" },
    // Send without @mentioning the bot (the Coordinator ignores these at channel top level).
    "no-mention": { type: "boolean", default: false },
  },
});

const coordinator = {
  url: env("COORDINATOR_URL", "http://localhost:8080"),
  token: env("COORDINATOR_SERVICE_TOKEN"),
};
const port = envNumber("DISCORD_SPLIT_GATEWAY_PORT", 8081);
const speaker: FakeSpeaker = {
  channelId: values.channel!,
  ...(values.thread ? { threadId: values.thread } : {}),
  userId: values.user!,
  name: values.name!,
};

let onReply: () => void = () => {};
let fakeChannels = 0;
let fakeThreads = 0;
let fakePrompts = 0;
// The latest prompt's buttons; typing `!N` clicks option N (from 1).
let lastPrompt: ActionRow[] | undefined;
createReplyApp(
  async (target, content) => {
    const where = target.threadId ? `${target.channelId}/${target.threadId}` : target.channelId;
    console.log(`\n[bot -> #${where}] ${content}`);
    onReply();
  },
  async (name) => {
    const channelId = `fake-created-${++fakeChannels}`;
    console.log(`\n[bot created #${name} as ${channelId}]`);
    return { channelId, name };
  },
  async ({ channelId, messageId, name }) => {
    const threadId = `fake-thread-${++fakeThreads}`;
    console.log(`\n[bot opened thread "${name}" on ${channelId}/${messageId} as ${threadId}]`);
    // Keep talking in the new thread, as a person would after clicking into it.
    speaker.threadId = threadId;
    return { threadId };
  },
  async ({ channelId, threadId, messageId, emoji }) => {
    const where = threadId ? `${channelId}/${threadId}` : channelId;
    console.log(`\n[bot reacted ${emoji} to ${where}/${messageId}]`);
  },
  async (target, { content, components }) => {
    const where = target.threadId ? `${target.channelId}/${target.threadId}` : target.channelId;
    const parts = components.flatMap((row) => row.components);
    const labels = parts.flatMap((c) => (c.type === 2 ? [c.label] : c.options.map((o) => o.label)));
    console.log(`\n[bot -> #${where}] ${content}`);
    labels.forEach((label, i) => console.log(`  [!${i + 1}] ${label}`));
    lastPrompt = components;
    onReply();
    return { messageId: `fake-prompt-${++fakePrompts}` };
  },
).listen(port);

const click = async (choice: number) => {
  const answer = lastPrompt && fakePromptClick(speaker, lastPrompt, choice);
  if (!answer) return console.log("(no prompt with that option)");
  await answerPromptClick(
    answer,
    {
      defer: async () => {},
      close: async (content) => {
        lastPrompt = undefined;
        console.log(`\n[bot edited the prompt] ${content}`);
      },
      whisper: async (content) => console.log(`\n[bot -> only you] ${content}`),
    },
    { coordinator, fetcher: fetch },
  );
};

const say = async (content: string) => {
  const inbound = fakeInbound(speaker, content, { mention: !values["no-mention"] });
  if (!inbound) return console.log("(ignored: empty message)");
  await forwardInbound(coordinator, inbound, fetch);
};

if (values.say !== undefined) {
  const timeout = setTimeout(
    () => {
      console.error(`no reply within ${values.wait}s`);
      process.exit(1);
    },
    Number(values.wait) * 1000,
  );
  onReply = () => {
    clearTimeout(timeout);
    process.exit(0);
  };
  await say(values.say);
} else {
  console.log(
    `fake discord: #${speaker.channelId} as ${speaker.name} (${speaker.userId}); ` +
      `coordinator ${coordinator.url}, reply endpoint :${port}. Type a message, or !N to click option N of the latest prompt; Ctrl-D quits.`,
  );
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const pick = /^!(\d+)$/.exec(line.trim());
    const send = pick ? click(Number(pick[1]) - 1) : line.trim() ? say(line) : undefined;
    await send?.catch((err) => console.error("forward failed:", err.message));
  }
  process.exit(0);
}
