import {
  type PromptAnswer,
  PromptAnswerReply,
  type PromptInstruction,
} from "@project-os/contracts";
import { Schema } from "effect";
import { type CoordinatorTarget, type Fetcher, postToCoordinator } from "./forward.ts";

// Discord message components as raw API JSON (discord.js accepts it as-is):
// type 1 = action row, 2 = button, 3 = string select. Button styles: 1 primary,
// 3 success (green), 4 danger (red).

/** Every prompt component's custom id starts with this, so other interactions are left alone. */
export const PROMPT_ID_PREFIX = "prompt:";
/** At most this many options are shown as buttons (one row); more become a select menu. */
export const MAX_BUTTONS = 5;
/** Discord button labels are at most 80 characters; longer options use the select menu. */
const BUTTON_LABEL_MAX = 80;

export interface ButtonComponent {
  type: 2;
  style: 1 | 3 | 4;
  label: string;
  custom_id: string;
}
export interface SelectComponent {
  type: 3;
  custom_id: string;
  placeholder: string;
  min_values: 1;
  max_values: 1;
  options: Array<{ label: string; value: string }>;
}
export interface ActionRow {
  type: 1;
  components: Array<ButtonComponent | SelectComponent>;
}

/**
 * Approve (green) / Deny (red) buttons for an approval; one button per option for a short
 * choice; a select menu for a long one. Each button's id is `prompt:<promptId>:<index>`; the
 * select menu's is `prompt:<promptId>` with the index as the picked value.
 */
export const promptComponents = (prompt: PromptInstruction): ActionRow[] => {
  const asButtons =
    prompt.kind === "approval" ||
    (prompt.options.length <= MAX_BUTTONS &&
      prompt.options.every((o) => o.length <= BUTTON_LABEL_MAX));
  if (asButtons) {
    return [
      {
        type: 1,
        components: prompt.options.map((label, i) => ({
          type: 2,
          style: prompt.kind === "approval" ? (i === 0 ? 3 : 4) : 1,
          label,
          custom_id: `${PROMPT_ID_PREFIX}${prompt.promptId}:${i}`,
        })),
      },
    ];
  }
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `${PROMPT_ID_PREFIX}${prompt.promptId}`,
          placeholder: "Pick one",
          min_values: 1,
          max_values: 1,
          options: prompt.options.map((label, i) => ({ label, value: String(i) })),
        },
      ],
    },
  ];
};

/** Structural subset of a discord.js button or string select interaction. */
export interface DiscordComponentLike {
  id: string;
  customId: string;
  /** Set for select menus: the picked option values. */
  values?: ReadonlyArray<string>;
  channelId: string | null;
  channel: { isThread(): boolean; parentId?: string | null } | null;
  user: { id: string; username: string };
  member?: object | null;
}

const displayName = (member: object | null | undefined): string | undefined =>
  member && "displayName" in member && typeof member.displayName === "string"
    ? member.displayName
    : undefined;

/** `prompt:<promptId>:<index>`: a button's id, or a select menu's id plus the picked value. */
const CLICK = /^prompt:(.+):(\d+)$/;

/** Reads a click on one of our prompts; null for any other component. */
export const normalizePromptClick = (i: DiscordComponentLike): PromptAnswer | null => {
  const key = i.values === undefined ? i.customId : `${i.customId}:${i.values[0]}`;
  const match = CLICK.exec(key);
  if (!match || i.channelId === null) return null;
  const inThread = i.channel?.isThread() ?? false;
  return {
    channelType: "discord",
    promptId: match[1]!,
    choice: Number(match[2]),
    externalId: i.id,
    channelId: inThread ? (i.channel?.parentId ?? i.channelId) : i.channelId,
    ...(inThread ? { threadId: i.channelId } : {}),
    sender: { id: i.user.id, name: displayName(i.member) ?? i.user.username },
  };
};

const decodeReply = Schema.decodeUnknownSync(PromptAnswerReply);

/** POSTs a click to the Coordinator's /prompts/answer and returns what to show. */
export const forwardPromptAnswer = async (
  coordinator: CoordinatorTarget,
  answer: PromptAnswer,
  fetcher: Fetcher,
): Promise<PromptAnswerReply> => {
  const res = await postToCoordinator(coordinator, "/prompts/answer", answer, fetcher);
  if (!res.ok) throw new Error(`Coordinator /prompts/answer responded ${res.status}`);
  return decodeReply(await res.json());
};

/** The calls `answerPromptClick` makes on a component interaction. */
export interface PromptReplier {
  /** Acknowledges within Discord's 3 s limit without changing the message yet. */
  defer(): Promise<void>;
  /** Replaces the prompt message's text and removes its buttons. */
  close(content: string): Promise<void>;
  /** Tells only the person who clicked. */
  whisper(content: string): Promise<void>;
}

/** Defers, forwards the click, then closes the prompt or tells the clicker why not. */
export const answerPromptClick = async (
  answer: PromptAnswer,
  replier: PromptReplier,
  deps: { readonly coordinator: CoordinatorTarget; fetcher: Fetcher },
): Promise<void> => {
  await replier.defer();
  let reply: PromptAnswerReply;
  try {
    reply = await forwardPromptAnswer(deps.coordinator, answer, deps.fetcher);
  } catch (err) {
    console.error("forward prompt answer to coordinator failed", err);
    reply = {
      accepted: false,
      content: "Something went wrong reaching the Coordinator. Try again.",
    };
  }
  await (reply.accepted ? replier.close(reply.content) : replier.whisper(reply.content));
};
