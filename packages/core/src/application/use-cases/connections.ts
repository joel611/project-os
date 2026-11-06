import type { ChannelType, ConnectionProvider, TicketEvent } from "@project-os/contracts";
import { Effect } from "effect";
import {
  ChannelGateway,
  KeyValueStore,
  NotConnected,
  type Person,
  ProjectSourceRepository,
  TicketRepository,
  UserConnections,
} from "../ports/index.ts";
import { channelTypeFor } from "./channels.ts";

export const PROVIDER_LABELS: Record<ConnectionProvider, string> = {
  google: "Google",
  github: "GitHub",
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The person behind a `created` or `follow_up` event, from the sender inbound stored on it. */
export const senderOf = (event: TicketEvent): Person | undefined => {
  if (event.type !== "created" && event.type !== "follow_up") return undefined;
  const payload = asRecord(event.payload);
  const sender = asRecord(payload.sender);
  if (typeof sender.id !== "string") return undefined;
  const channelType = (
    typeof payload.channelType === "string" ? payload.channelType : "discord"
  ) as ChannelType;
  return {
    channelType,
    id: sender.id,
    ...(typeof sender.name === "string" ? { name: sender.name } : {}),
  };
};

/** Discord pings by `<@id>`; elsewhere the id is the address (e.g. an email). */
const mention = (person: Person) =>
  person.channelType === "discord" ? `<@${person.id}>` : person.id;

const EVENT_SCAN = 500;

/**
 * The access token a Worker should use for `provider` on this ticket: the token of whoever
 * wrote the ticket's latest message (the requester, or the latest follow-up's author). If they
 * haven't linked the provider, asks them in the project's channel (once a day per ticket) and
 * fails with `NotConnected`.
 */
export const userTokenForTicket = (input: {
  readonly ticketId: string;
  readonly provider: ConnectionProvider;
}) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const connections = yield* UserConnections;

    const ticket = yield* tickets.get(input.ticketId);
    const events = yield* tickets.listEvents(ticket.id, EVENT_SCAN);
    const person = events.map(senderOf).findLast((p) => p !== undefined);
    if (!person) {
      return yield* new NotConnected({
        provider: input.provider,
        personId: "",
        message: "This ticket has no human requester, so there is no account to act as.",
      });
    }

    const token = yield* connections
      .accessToken(person, input.provider)
      .pipe(
        Effect.tapErrorTag("NotConnected", () =>
          askToConnect(ticket.id, ticket.projectId, ticket.title, person, input.provider),
        ),
      );
    return { ...token, person: { ...person, name: person.name ?? null } };
  });

const askToConnect = (
  ticketId: string,
  projectId: string,
  title: string,
  person: Person,
  provider: ConnectionProvider,
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const sources = yield* ProjectSourceRepository;
    const gateway = yield* ChannelGateway;

    const fresh = yield* kv.setIfAbsent(`connect-ask:${ticketId}:${provider}:${person.id}`, "1", {
      ttlSeconds: 86_400,
    });
    if (!fresh) return;
    const target = (yield* sources.listByProject(projectId)).find(
      (s) => s.isDefaultResponse && s.status === "active",
    );
    const channelType = target && channelTypeFor(target.type);
    if (!target || !channelType) return;
    const label = PROVIDER_LABELS[provider];
    yield* gateway.send({
      channelType,
      channelId: target.externalId,
      content: `${mention(person)}, I need your ${label} access for "${title}". Run \`/connect provider:${provider}\` and I'll carry on.`,
    });
  });
