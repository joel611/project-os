import {
  type ChannelType,
  Prompt,
  type PromptAnswer,
  type PromptAnswerReply,
  type PromptKind,
} from "@project-os/contracts";
import { Effect, Predicate, Schema } from "effect";
import {
  answeredContent,
  NoPromptChannel,
  PromptNotFound,
  promptContent,
  promptOptions,
} from "../../domain/index.ts";
import {
  ChannelGateway,
  IdGenerator,
  KeyValueStore,
  ProjectSourceRepository,
  TicketRepository,
} from "../ports/index.ts";
import { channelTypeFor } from "./channels.ts";
import { nowIso } from "./tickets.ts";

/** Unanswered prompts are forgotten after this; a later click says the question expired. */
export const PROMPT_TTL_SECONDS = 7 * 86_400;

export const EXPIRED_PROMPT_MESSAGE = "This question has expired, so your answer wasn't recorded.";
export const UNAVAILABLE_OPTION_MESSAGE = "That option isn't available.";
export const NOT_AN_ADMIN_MESSAGE = "Not authorized: you are not on the admin list.";

const promptKey = (id: string) => `prompt:${id}`;
const answerKey = (id: string) => `prompt-answer:${id}`;
const decodePrompt = Schema.decodeUnknownOption(Schema.fromJsonString(Prompt));

export interface PromptTarget {
  readonly channelType: ChannelType;
  readonly channelId: string;
  readonly threadId?: string;
}

export interface PromptAnswerConfig {
  /** Prompts posted in this Discord channel can only be answered by `adminUserIds`. */
  readonly adminChannelId?: string;
  /** Unset: no check. Empty: nobody. */
  readonly adminUserIds?: ReadonlyArray<string>;
}

const loadPrompt = (id: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.flatMap(KeyValueStore, (kv) => kv.get(promptKey(id)));
    if (raw === undefined) return undefined;
    const decoded = decodePrompt(raw);
    return decoded._tag === "Some" ? decoded.value : undefined;
  });

const savePrompt = (prompt: Prompt) =>
  Effect.flatMap(KeyValueStore, (kv) =>
    kv.set(promptKey(prompt.id), JSON.stringify(prompt), { ttlSeconds: PROMPT_TTL_SECONDS }),
  );

/**
 * Where a ticket's conversation happens: its own thread, else the project's default response
 * source. `undefined` when it has neither.
 */
export const ticketChannel = (ticketId: string) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const sources = yield* ProjectSourceRepository;
    const ticket = yield* tickets.get(ticketId);
    const thread = yield* tickets.findThread(ticket.id);
    if (thread) {
      return {
        channelType: thread.channelType,
        channelId: thread.channelId,
        threadId: thread.threadId,
      } satisfies PromptTarget as PromptTarget;
    }
    const source = (yield* sources.listByProject(ticket.projectId)).find(
      (s) => s.isDefaultResponse && s.status === "active",
    );
    const channelType = source && channelTypeFor(source.type);
    return source && channelType
      ? ({ channelType, channelId: source.externalId } satisfies PromptTarget as PromptTarget)
      : undefined;
  });

/**
 * Posts a question people answer with a click (Approve / Deny, or one of `options`) and
 * remembers it until answered or `PROMPT_TTL_SECONDS` pass. The answer arrives through
 * `answerPrompt`.
 */
export const askPrompt = (input: {
  readonly target: PromptTarget;
  readonly kind: PromptKind;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly ticketId?: string;
}) =>
  Effect.gen(function* () {
    const options = yield* promptOptions(input.kind, input.options);
    const gateway = yield* ChannelGateway;
    const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
    const pending: Prompt = {
      id,
      ticketId: input.ticketId ?? null,
      kind: input.kind,
      question: input.question,
      options: [...options],
      status: "pending",
      answer: null,
      channelType: input.target.channelType,
      channelId: input.target.channelId,
      threadId: input.target.threadId ?? null,
      messageId: null,
      createdAt: yield* nowIso,
    };
    // Saved before posting, so a fast click always finds it.
    yield* savePrompt(pending);
    const posted = yield* gateway.ask({
      channelType: input.target.channelType,
      channelId: input.target.channelId,
      ...(input.target.threadId === undefined ? {} : { threadId: input.target.threadId }),
      promptId: id,
      kind: input.kind,
      content: promptContent(pending),
      options: pending.options,
    });
    // Don't overwrite an answer that came in while the post was in flight.
    const latest = (yield* loadPrompt(id)) ?? pending;
    const stored: Prompt = { ...latest, messageId: posted.messageId };
    yield* savePrompt(stored);
    return stored;
  });

/**
 * A Worker asks the people behind a ticket to confirm something or pick an option. It's
 * posted in the ticket's thread (else the project's default channel) and logged on the
 * ticket; the answer is added to the ticket as a `follow_up` event.
 */
export const askOnTicket = (input: {
  readonly ticketId: string;
  readonly kind: PromptKind;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const target = yield* ticketChannel(input.ticketId);
    if (!target) {
      return yield* new NoPromptChannel({
        ticketId: input.ticketId,
        message: "The ticket has no thread and its project has no default response channel.",
      });
    }
    const prompt = yield* askPrompt({ ...input, target });
    const tickets = yield* TicketRepository;
    yield* tickets.appendEvent({
      id: yield* Effect.flatMap(IdGenerator, (g) => g.next),
      ticketId: input.ticketId,
      type: "comment",
      actor: "worker",
      actorId: null,
      body: `Asked: ${prompt.question} (${prompt.options.join(" / ")})`,
      payload: { promptId: prompt.id, kind: prompt.kind, options: prompt.options },
      createdAt: prompt.createdAt,
    });
    return prompt;
  });

export const getPrompt = (input: { readonly promptId: string }) =>
  Effect.filterOrFail(
    loadPrompt(input.promptId),
    Predicate.isNotNullish,
    () => new PromptNotFound(input),
  );

/**
 * Records a click on a prompt. The first valid answer wins; later clicks are told who
 * answered. Prompts in the admin channel only take answers from admins. A ticket's prompt
 * adds the answer to the ticket as a `follow_up`, which its Worker reads with `ticket_get`.
 */
export const answerPrompt = (answer: PromptAnswer, config: PromptAnswerConfig = {}) =>
  Effect.gen(function* () {
    const reject = (content: string): PromptAnswerReply => ({ accepted: false, content });
    const prompt = yield* loadPrompt(answer.promptId);
    if (
      !prompt ||
      prompt.channelType !== answer.channelType ||
      prompt.channelId !== answer.channelId
    ) {
      return reject(EXPIRED_PROMPT_MESSAGE);
    }
    if (prompt.answer) return reject(`Already answered.\n${answeredContent(prompt)}`);

    const inAdminChannel =
      prompt.channelType === "discord" && prompt.channelId === config.adminChannelId;
    if (inAdminChannel && config.adminUserIds && !config.adminUserIds.includes(answer.sender.id)) {
      return reject(NOT_AN_ADMIN_MESSAGE);
    }
    const label = prompt.options[answer.choice];
    if (!Number.isInteger(answer.choice) || label === undefined) {
      return reject(UNAVAILABLE_OPTION_MESSAGE);
    }

    const kv = yield* KeyValueStore;
    const first = yield* kv.setIfAbsent(answerKey(prompt.id), answer.externalId, {
      ttlSeconds: PROMPT_TTL_SECONDS,
    });
    // Someone else's click got there in the same instant.
    if (!first) return reject("Someone else answered first.");

    const at = yield* nowIso;
    const answered: Prompt = {
      ...prompt,
      status: "answered",
      answer: {
        choice: answer.choice,
        label,
        by: { id: answer.sender.id, name: answer.sender.name ?? null },
        at,
      },
    };
    yield* savePrompt(answered);

    if (prompt.ticketId !== null) {
      const tickets = yield* TicketRepository;
      const ids = yield* IdGenerator;
      yield* tickets
        .appendEvent({
          id: yield* ids.next,
          ticketId: prompt.ticketId,
          type: "follow_up",
          actor: "coordinator",
          actorId: answer.sender.id,
          body: `Answer to "${prompt.question}": ${label}`,
          payload: {
            promptId: prompt.id,
            kind: prompt.kind,
            choice: answer.choice,
            label,
            sender: answer.sender,
            channelType: answer.channelType,
          },
          createdAt: at,
        })
        .pipe(
          Effect.catchTag("TicketNotFound", () =>
            Effect.logWarning(`prompt ${prompt.id} answered for a missing ticket`),
          ),
        );
    }
    return { accepted: true, content: answeredContent(answered) } satisfies PromptAnswerReply;
  });
