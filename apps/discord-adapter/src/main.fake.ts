import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { env, envNumber } from "@project-os/config";
import { fakeInbound, type FakeSpeaker } from "./fake.ts";
import { forwardInbound } from "./forward.ts";
import { createReplyApp } from "./reply.ts";

// Stand-in for the Discord adapter: no gateway, no token. It takes the adapter's place on
// the reply port (DISCORD_ADAPTER_URL must point here), speaks to the Coordinator's /inbound,
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

const coordinatorUrl = env("COORDINATOR_URL", "http://localhost:8080");
const port = envNumber("DISCORD_ADAPTER_PORT", 8081);
const speaker: FakeSpeaker = {
  channelId: values.channel!,
  ...(values.thread ? { threadId: values.thread } : {}),
  userId: values.user!,
  name: values.name!,
};

let onReply: () => void = () => {};
let fakeChannels = 0;
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
).listen(port);

const say = async (content: string) => {
  const inbound = fakeInbound(speaker, content, { mention: !values["no-mention"] });
  if (!inbound) return console.log("(ignored: empty message)");
  await forwardInbound(coordinatorUrl, inbound, fetch);
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
      `coordinator ${coordinatorUrl}, reply endpoint :${port}. Type a message; Ctrl-D quits.`,
  );
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim()) await say(line).catch((err) => console.error("forward failed:", err.message));
  }
  process.exit(0);
}
